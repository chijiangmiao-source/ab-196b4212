// 输入模型校验与规范化。
// 输入结构：
// {
//   components: [{ id, versions: [{ version, dependencies: { 组件: "范围" } }] }],
//   roots: [{ id: "CAM", dependencies: { "NAV": ">=2.0.0 <3.0.0" } }]
// }
// 根组件本身也必须在 components 中登记至少一个版本；根级 dependencies 无论选中
// 根组件的哪个版本都持续生效。
import { parseRange, RangeError } from './range.mjs';
import { parseVersion, VersionError, compareVersions, formatVersion } from './semver.mjs';

export const MAX_COMPONENTS = 16;
export const MAX_VERSIONS = 6;

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function validateModel(input) {
  const errors = [];
  const push = (code, message, loc = {}) => errors.push({ code, message, ...loc });

  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    push('BAD_INPUT', '请求体必须是 JSON 对象');
    return { errors, model: null };
  }
  const { components, roots } = input;

  if (!Array.isArray(components)) {
    push('MISSING_COMPONENTS', '缺少 components 数组');
    return { errors, model: null };
  }
  if (components.length === 0) push('NO_COMPONENTS', '至少需要一个组件');
  if (components.length > MAX_COMPONENTS) {
    push('TOO_MANY_COMPONENTS', `组件数量 ${components.length} 超过上限 ${MAX_COMPONENTS}`);
  }
  if (!Array.isArray(roots)) {
    push('MISSING_ROOTS', '缺少 roots 数组');
  } else if (roots.length === 0) {
    push('NO_ROOTS', '至少需要一个根组件');
  }

  const byId = new Map();
  components.forEach((comp, ci) => {
    const loc = { componentIndex: ci };
    if (!comp || typeof comp !== 'object' || Array.isArray(comp)) {
      push('BAD_COMPONENT', '组件项必须是对象', loc);
      return;
    }
    const { id } = comp;
    if (typeof id !== 'string' || !ID_RE.test(id ?? '')) {
      push(
        'BAD_COMPONENT_ID',
        `非法组件标识 "${id ?? ''}"（仅限 ASCII 字母、数字、. _ -，且以字母或数字开头）`,
        loc,
      );
      return;
    }
    if (byId.has(id)) {
      push('DUPLICATE_COMPONENT', `组件标识重复: ${id}`, { ...loc, component: id });
      return;
    }
    const norm = { id, versions: [] };
    byId.set(id, norm);

    if (!Array.isArray(comp.versions)) {
      push('MISSING_VERSIONS', `组件 ${id} 缺少 versions 数组`, { ...loc, component: id });
      return;
    }
    if (comp.versions.length === 0) {
      push('EMPTY_CANDIDATES', `组件 ${id} 的候选版本为空`, { ...loc, component: id });
      return;
    }
    if (comp.versions.length > MAX_VERSIONS) {
      push(
        'TOO_MANY_VERSIONS',
        `组件 ${id} 有 ${comp.versions.length} 个版本，超过上限 ${MAX_VERSIONS}`,
        { ...loc, component: id },
      );
    }

    const seenVersions = new Set();
    comp.versions.forEach((entry, vi) => {
      const vloc = { ...loc, component: id, versionIndex: vi };
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        push('BAD_VERSION_ENTRY', '版本项必须是对象', vloc);
        return;
      }
      const versionText = typeof entry.version === 'string' ? entry.version : String(entry.version ?? '');
      let parsed;
      try {
        parsed = parseVersion(versionText);
      } catch (err) {
        if (err instanceof VersionError) {
          push('BAD_VERSION', err.message, { ...vloc, version: versionText });
          return;
        }
        throw err;
      }
      const canonical = formatVersion(parsed);
      if (seenVersions.has(canonical)) {
        push('DUPLICATE_VERSION', `组件 ${id} 的版本 ${canonical} 重复`, {
          ...vloc,
          version: canonical,
        });
        return;
      }
      seenVersions.add(canonical);

      const deps = {};
      const rawDeps = entry.dependencies ?? {};
      if (typeof rawDeps !== 'object' || rawDeps === null || Array.isArray(rawDeps)) {
        push('BAD_DEPENDENCIES', `版本 ${id}@${canonical} 的 dependencies 必须是对象`, vloc);
      } else {
        for (const [depId, rangeText] of Object.entries(rawDeps)) {
          const dloc = { ...vloc, dependency: depId };
          if (typeof rangeText !== 'string') {
            push('BAD_RANGE', `依赖 ${id}@${canonical} -> ${depId} 的范围必须是字符串`, dloc);
            continue;
          }
          try {
            deps[depId] = { text: rangeText, parsed: parseRange(rangeText) };
          } catch (err) {
            if (err instanceof RangeError) {
              push('BAD_RANGE', `依赖 ${id}@${canonical} -> ${depId} 的范围非法: ${err.message}`, {
                ...dloc,
                range: rangeText,
                offset: err.offset,
                length: err.length,
              });
            } else {
              throw err;
            }
          }
        }
      }
      norm.versions.push({ version: parsed, raw: canonical, dependencies: deps });
    });
  });

  // 未知 / 非法依赖标识（待全部 id 登记后统一检查）。
  components.forEach((comp, ci) => {
    if (!comp || typeof comp !== 'object') return;
    const norm = byId.get(comp.id);
    if (!norm || !Array.isArray(comp.versions)) return;
    comp.versions.forEach((entry, vi) => {
      if (!entry || typeof entry !== 'object') return;
      const rawDeps = entry.dependencies ?? {};
      if (typeof rawDeps !== 'object' || rawDeps === null || Array.isArray(rawDeps)) return;
      for (const depId of Object.keys(rawDeps)) {
        const loc = { component: comp.id, versionIndex: vi, dependency: depId };
        if (!ID_RE.test(depId ?? '')) {
          push('BAD_DEPENDENCY_ID', `非法依赖标识 "${depId ?? ''}"（位于 ${comp.id} 的版本 #${vi}）`, loc);
        } else if (!byId.has(depId)) {
          push(
            'UNKNOWN_COMPONENT',
            `未知组件: ${comp.id} 的版本 #${vi} 依赖的 ${depId} 未在组件清单中登记`,
            loc,
          );
        }
      }
    });
  });

  const rootList = [];
  if (Array.isArray(roots)) {
    const seen = new Set();
    roots.forEach((root, ri) => {
      const loc = { rootIndex: ri };
      if (!root || typeof root !== 'object' || Array.isArray(root)) {
        push('BAD_ROOT', `根组件 #${ri} 必须是对象 { id, dependencies }`, loc);
        return;
      }
      const { id } = root;
      if (typeof id !== 'string' || !ID_RE.test(id ?? '')) {
        push('BAD_ROOT_ID', `非法根组件标识: "${id ?? ''}"`, loc);
        return;
      }
      if (!byId.has(id)) {
        push('UNKNOWN_ROOT', `根组件未登记: ${id}`, { ...loc, component: id });
        return;
      }
      if (seen.has(id)) {
        push('DUPLICATE_ROOT', `根组件重复: ${id}`, { ...loc, component: id });
        return;
      }
      seen.add(id);
      const dependencies = {};
      const rawDeps = root.dependencies ?? {};
      if (typeof rawDeps !== 'object' || rawDeps === null || Array.isArray(rawDeps)) {
        push('BAD_ROOT_DEPENDENCIES', `根组件 ${id} 的 dependencies 必须是对象`, {
          ...loc,
          component: id,
        });
      } else {
        for (const [depId, rangeText] of Object.entries(rawDeps)) {
          const dloc = { ...loc, component: id, dependency: depId };
          if (!ID_RE.test(depId ?? '')) {
            push('BAD_DEPENDENCY_ID', `非法依赖标识 "${depId ?? ''}"（位于根组件 ${id}）`, dloc);
          } else if (!byId.has(depId)) {
            push(
              'UNKNOWN_COMPONENT',
              `未知组件: 根组件 ${id} 依赖的 ${depId} 未在组件清单中登记`,
              dloc,
            );
          }
          if (typeof rangeText !== 'string') {
            push('BAD_RANGE', `根组件 ${id} -> ${depId} 的范围必须是字符串`, dloc);
            continue;
          }
          try {
            dependencies[depId] = { text: rangeText, parsed: parseRange(rangeText) };
          } catch (err) {
            if (err instanceof RangeError) {
              push('BAD_RANGE', `根组件 ${id} -> ${depId} 的范围非法: ${err.message}`, {
                ...dloc,
                range: rangeText,
                offset: err.offset,
                length: err.length,
              });
            } else {
              throw err;
            }
          }
        }
      }
      rootList.push({ id, dependencies });
    });
  }

  if (errors.length > 0) return { errors, model: null };

  // 版本统一按从高到低排序，求解与展示都基于该顺序。
  for (const norm of byId.values()) {
    norm.versions.sort((a, b) => compareVersions(b.version, a.version));
  }
  rootList.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { errors: [], model: { byId, roots: rootList } };
}
