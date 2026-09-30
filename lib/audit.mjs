// 审计主逻辑：输入校验 → 可达性分析 → 约束合取求解 → 结论与依据/冲突树。
//
// 输入模型（JSON）：
// {
//   roots: ["CAM"],
//   components: [
//     { id: "CAM", versions: ["1.0.0"], dependencies: { NAV: ">=2.0.0 <3.0.0" } },
//     { id: "NAV", versions: ["1.0.0", "2.0.0"], dependencies: {} }
//   ]
// }
//
// 约束：组件至多 16 个；每组件版本至多 6 个；范围仅允许 = 、>= 、< 的合取。
// 依赖按组件声明（与具体版本无关），故全部可达边恒成立，每个可达组件须在
// 其所有入边范围的合取下选出恰好一个版本。

import { compareVersions, normalizeVersion, parseVersion } from './version.mjs';
import { parseRange, satisfies } from './range.mjs';

export const LIMITS = Object.freeze({
  MAX_COMPONENTS: 16,
  MAX_VERSIONS: 6,
});

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

/** 聚合全部输入错误（一次性定位所有问题）。 */
export class ValidationError extends Error {
  constructor(errors) {
    super(`输入校验失败，共 ${errors.length} 处错误`);
    this.name = 'ValidationError';
    this.errors = errors;
  }
}

const err = (code, message, extra = {}) => ({ code, message, ...extra });

/**
 * 校验并规范化输入。
 * @returns {{roots:string[], components:Map<string, {id:string, versions:string[], deps:Map<string,{raw:string, clauses:[]}>}>}}
 * @throws {ValidationError}
 */
export function validateModel(input) {
  const errors = [];
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new ValidationError([
      err('MALFORMED_INPUT', '请求体必须是 JSON 对象，包含 roots 与 components 字段'),
    ]);
  }

  const { roots, components } = input;

  // ---- 组件列表 -----------------------------------------------------------
  if (!Array.isArray(components)) {
    errors.push(err('MALFORMED_INPUT', 'components 必须是组件对象数组', { path: 'components' }));
  }
  const normalized = new Map();
  if (Array.isArray(components)) {
    if (components.length > LIMITS.MAX_COMPONENTS) {
      errors.push(
        err(
          'TOO_MANY_COMPONENTS',
          `组件数量 ${components.length} 超过上限 ${LIMITS.MAX_COMPONENTS}`,
          { path: 'components', limit: LIMITS.MAX_COMPONENTS, actual: components.length },
        ),
      );
    }
    components.forEach((comp, i) => {
      const path = `components[${i}]`;
      if (comp === null || typeof comp !== 'object' || Array.isArray(comp)) {
        errors.push(err('MALFORMED_INPUT', '组件必须是对象', { path }));
        return;
      }
      const id = comp.id;
      if (typeof id !== 'string' || !ID_RE.test(id.trim())) {
        errors.push(
          err('INVALID_ID', `组件标识非法：${String(id)}（限 1-64 位字母、数字、_ . -，且以字母数字开头）`, {
            path: `${path}.id`,
          }),
        );
        return;
      }
      const normId = id.trim();
      if (normalized.has(normId)) {
        errors.push(err('DUPLICATE_COMPONENT', `组件标识重复：${normId}`, { path: `${path}.id`, component: normId }));
        return;
      }

      // ---- 候选版本 -------------------------------------------------------
      const versionTokens = [];
      if (!Array.isArray(comp.versions)) {
        errors.push(err('MALFORMED_INPUT', 'versions 必须是版本字符串数组', { path: `${path}.versions`, component: normId }));
      } else {
        if (comp.versions.length === 0) {
          errors.push(err('EMPTY_CANDIDATES', `组件 ${normId} 的候选版本为空，至少需要一个版本`, {
            path: `${path}.versions`,
            component: normId,
          }));
        }
        if (comp.versions.length > LIMITS.MAX_VERSIONS) {
          errors.push(
            err('TOO_MANY_VERSIONS',
              `组件 ${normId} 的版本数 ${comp.versions.length} 超过上限 ${LIMITS.MAX_VERSIONS}`,
              { path: `${path}.versions`, component: normId, limit: LIMITS.MAX_VERSIONS, actual: comp.versions.length }),
          );
        }
        const seen = new Set();
        for (const v of comp.versions.slice(0, LIMITS.MAX_VERSIONS)) {
          let norm;
          try {
            norm = normalizeVersion(v);
          } catch (e) {
            errors.push(err('INVALID_VERSION', e.message, { path: `${path}.versions`, component: normId, value: String(v) }));
            continue;
          }
          if (seen.has(norm)) {
            errors.push(err('DUPLICATE_VERSION', `组件 ${normId} 的候选版本重复：${norm}`, {
              path: `${path}.versions`, component: normId, value: norm,
            }));
            continue;
          }
          seen.add(norm);
          versionTokens.push(norm);
        }
      }

      // ---- 依赖 -----------------------------------------------------------
      const deps = new Map();
      const rawDeps = comp.dependencies;
      if (rawDeps !== undefined && (rawDeps === null || typeof rawDeps !== 'object' || Array.isArray(rawDeps))) {
        errors.push(err('MALFORMED_INPUT', 'dependencies 必须是 { 目标组件: 范围 } 对象', {
          path: `${path}.dependencies`, component: normId,
        }));
      } else if (rawDeps) {
        for (const [target, rawRange] of Object.entries(rawDeps)) {
          const dpath = `${path}.dependencies['${target}']`;
          if (!ID_RE.test(target)) {
            errors.push(err('INVALID_ID', `依赖目标标识非法：${target}`, { path: dpath, from: normId, target }));
            continue;
          }
          if (typeof rawRange !== 'string') {
            errors.push(err('INVALID_RANGE', `依赖范围必须是字符串：${String(rawRange)}`, {
              path: dpath, from: normId, to: target, range: String(rawRange),
            }));
            continue;
          }
          try {
            const clauses = parseRange(rawRange);
            deps.set(target, { raw: rawRange.trim(), clauses });
          } catch (e) {
            errors.push(err('INVALID_RANGE', e.message, { path: dpath, from: normId, to: target, range: rawRange }));
          }
        }
      }

      normalized.set(normId, { id: normId, versionTokens, deps });
    });
  }

  // 未知组件引用（依赖目标）
  for (const [id, rec] of normalized) {
    for (const target of [...rec.deps.keys()]) {
      if (!normalized.has(target)) {
        rec.deps.delete(target); // 移除坏边，避免后续分析误用
        errors.push(err('UNKNOWN_COMPONENT',
          `组件 ${id} 依赖了未知组件 ${target}（请先在组件列表中录入 ${target}）`,
          { path: `components['${id}'].dependencies['${target}']`, from: id, target }));
      }
    }
  }

  // ---- 根组件 -------------------------------------------------------------
  const normRoots = [];
  if (!Array.isArray(roots) || roots.length === 0) {
    errors.push(err('EMPTY_ROOTS', '根组件列表 roots 为空，至少指定一个根组件', { path: 'roots' }));
  } else if (Array.isArray(roots)) {
    const seenRoot = new Set();
    roots.forEach((r, i) => {
      if (typeof r !== 'string' || !ID_RE.test(r.trim())) {
        errors.push(err('INVALID_ID', `根组件标识非法：${String(r)}`, { path: `roots[${i}]` }));
        return;
      }
      const id = r.trim();
      if (seenRoot.has(id)) return;
      seenRoot.add(id);
      if (!normalized.has(id)) {
        errors.push(err('UNKNOWN_COMPONENT', `根组件 ${id} 未在组件列表中录入`, { path: `roots[${i}]`, target: id }));
        return;
      }
      normRoots.push(id);
    });
  }

  if (errors.length > 0) {
    throw new ValidationError(errors);
  }

  // 组装规范化模型：版本按从高到低排序，保证选择“优先较高版本”。
  const model = { roots: normRoots, components: new Map() };
  for (const [id, rec] of normalized) {
    const versions = rec.versionTokens.slice().sort(compareVersions).reverse();
    model.components.set(id, { id, versions, deps: rec.deps });
  }
  return model;
}

/** 从根出发沿依赖边计算可达组件集合。 */
export function reachableComponents(model) {
  const seen = new Set();
  const stack = model.roots.slice();
  while (stack.length) {
    const id = stack.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    const rec = model.components.get(id);
    if (rec) for (const dep of rec.deps.keys()) stack.push(dep);
  }
  return seen;
}

const byAscii = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** 单条比较条件是否成立的可读描述。 */
function describeClause(version, clause) {
  const c = compareVersions(version, clause.version);
  const holds = clause.op === '=' ? c === 0 : clause.op === '>=' ? c >= 0 : c < 0;
  const relation = c === 0 ? '等于' : c < 0 ? '低于' : '高于';
  return {
    expected: `${clause.op}${clause.version}`,
    actual: version,
    comparison: `${version} ${relation} ${clause.version}`,
    holds,
  };
}

/**
 * 执行审计。
 * @returns 可解：{status:'satisfiable', assignment, evidence, warnings}
 *          冲突：{status:'conflict', tree}
 */
export function audit(input) {
  const model = validateModel(input);
  const reachable = reachableComponents(model);

  // 汇总每个可达组件承受到的入边约束（全部可达边恒成立）。
  const requirements = new Map();
  for (const id of reachable) {
    const rec = model.components.get(id);
    for (const [target, range] of rec.deps) {
      if (!requirements.has(target)) requirements.set(target, []);
      requirements.get(target).push({ from: id, range: range.raw, clauses: range.clauses });
    }
  }
  for (const list of requirements.values()) {
    list.sort((a, b) => byAscii(a.from, b.from) || byAscii(a.range, b.range));
  }

  const conflicts = [];
  const assignment = [];
  const reachableSorted = [...reachable].sort(byAscii);

  for (const id of reachableSorted) {
    const rec = model.components.get(id);
    const reqs = requirements.get(id) ?? [];
    const acceptable = rec.versions.filter((v) =>
      reqs.every((r) => satisfies(v, r.clauses)));

    if (acceptable.length === 0) {
      // 稳定冲突树节点：覆盖该组件全部候选版本，逐一标注否决依据。
      conflicts.push({
        component: id,
        requirements: reqs.map((r) => ({ from: r.from, range: r.range })),
        candidates: rec.versions.map((v) => ({
          version: v,
          rejectedBy: reqs
            .map((r) => {
              const failedClauses = r.clauses
                .map((c) => describeClause(v, c))
                .filter((d) => !d.holds);
              return failedClauses.length
                ? { from: r.from, range: r.range, failedClauses }
                : null;
            })
            .filter(Boolean),
        })),
      });
      continue;
    }

    // 版本已按高到低排序，取首个即“优先较高版本”。
    const selected = acceptable[0];
    assignment.push({
      component: id,
      selectedVersion: selected,
      acceptableVersions: acceptable,
      isRoot: model.roots.includes(id),
      evidence: reqs.map((r) => ({
        from: r.from,
        range: r.range,
        checks: r.clauses.map((c) => ({ clause: `${c.op}${c.version}`, ...describeClause(selected, c) })),
      })),
    });
  }

  if (conflicts.length > 0) {
    conflicts.sort((a, b) => byAscii(a.component, b.component));
    return {
      status: 'conflict',
      tree: {
        summary: `共 ${conflicts.length} 个组件的全部候选版本均被上游约束排除`,
        conflicts,
      },
    };
  }

  const unreachable = [...model.components.keys()]
    .filter((id) => !reachable.has(id))
    .sort(byAscii);

  return {
    status: 'satisfiable',
    assignment,
    warnings: unreachable.length
      ? [{ code: 'UNREACHABLE', message: '以下组件不由任何根组件可达，未参与选版', components: unreachable }]
      : [],
  };
}

export { parseVersion };
