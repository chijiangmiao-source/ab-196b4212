// 求解器：为每个可达组件精确选定一个版本，使全部根约束与依赖约束同时成立。
//
// 确定性规则（重复提交结果一致）：
//   1. 组件按标识 ASCII 顺序依次赋值；
//   2. 每个组件的候选版本从高到低尝试；
//   3. 找到的第一个解即规范解；无解时生成稳定的冲突树。
import { atomHolds, explainFailure } from "./range.mjs";

// 可达组件：从根出发，取各版本声明依赖与根级依赖的并集（校验阶段已保证均已登记）。
export function reachableComponents(model) {
  const { byId, roots } = model;
  const seen = new Set(roots.map((r) => r.id));
  const queue = roots.map((r) => r.id);
  while (queue.length) {
    const id = queue.shift();
    const root = roots.find((r) => r.id === id);
    const collect = (depMap) => {
      for (const depId of Object.keys(depMap)) {
        if (!seen.has(depId)) {
          seen.add(depId);
          queue.push(depId);
        }
      }
    };
    for (const ver of byId.get(id).versions) collect(ver.dependencies);
    if (root) collect(root.dependencies);
  }
  return [...seen].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

// 冲突树专用遍历顺序：按依赖传播层级（根在前），同层内按 ASCII 排序。
// 这样两个根 CTRL/PWR 共同施压时，BUS 作为被依赖目标出现在其后，
// 冲突树自然以“全部候选均被否决”的 BUS 节点收尾。
function dependencyOrder(model) {
  const { byId, roots } = model;
  const seen = new Set();
  const order = [];
  let frontier = roots.map((r) => r.id).sort((a, b) => (a < b ? -1 : 1));
  for (const r of frontier) {
    seen.add(r);
    order.push(r);
  }
  while (frontier.length) {
    const nextSet = new Set();
    for (const id of frontier) {
      const root = roots.find((r) => r.id === id);
      const addDeps = (depMap) => {
        for (const depId of Object.keys(depMap)) {
          if (!seen.has(depId)) nextSet.add(depId);
        }
      };
      for (const ver of byId.get(id).versions) addDeps(ver.dependencies);
      if (root) addDeps(root.dependencies);
    }
    const next = [...nextSet].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    for (const id of next) {
      seen.add(id);
      order.push(id);
    }
    frontier = next;
  }
  return order;
}

// 已赋值前缀 assignment: Map<id, versionIndex>。
// 返回候选版本 entry 在当前前缀下违反的全部约束：
//   A. 入约束：根级范围 + 已选组件对 id 的依赖范围；
//   B. 出约束：entry 对“已选定版本”的组件的依赖范围。
function violationsFor(model, id, entry, assignment) {
  const violated = [];

  // A. 根级范围
  for (const root of model.roots) {
    const dep = root.dependencies[id];
    if (dep) {
      for (const atom of dep.parsed.atoms) {
        if (!atomHolds(entry.version, atom)) {
          violated.push({
            direction: 'incoming',
            constraint: atom.raw,
            source: `根组件 ${root.id}`,
            sourceType: 'root',
            sourceComponent: root.id,
            sourceVersion: null,
            reason: explainFailure(entry.version, atom),
          });
        }
      }
    }
  }
  // A. 已选组件声明的入约束
  for (const [fromId, vi] of assignment) {
    const fromEntry = model.byId.get(fromId).versions[vi];
    const dep = fromEntry.dependencies[id];
    if (dep) {
      for (const atom of dep.parsed.atoms) {
        if (!atomHolds(entry.version, atom)) {
          violated.push({
            direction: 'incoming',
            constraint: atom.raw,
            source: `依赖 ${fromId}@${fromEntry.raw}`,
            sourceType: 'dependency',
            sourceComponent: fromId,
            sourceVersion: fromEntry.raw,
            reason: explainFailure(entry.version, atom),
          });
        }
      }
    }
  }
  // B. entry 对已选组件声明的出约束
  for (const [toId, vi] of assignment) {
    const dep = entry.dependencies[toId];
    if (dep) {
      const toEntry = model.byId.get(toId).versions[vi];
      for (const atom of dep.parsed.atoms) {
        if (!atomHolds(toEntry.version, atom)) {
          violated.push({
            direction: 'outgoing',
            constraint: atom.raw,
            source: `本版本对 ${toId}@${toEntry.raw} 的要求`,
            sourceType: 'self-dependency',
            sourceComponent: toId,
            sourceVersion: toEntry.raw,
            reason: explainFailure(toEntry.version, atom),
          });
        }
      }
    }
  }

  violated.sort(compareViolation);
  return violated;
}

function compareViolation(a, b) {
  const keys = [
    [a.source, b.source],
    [a.constraint, b.constraint],
    [a.reason, b.reason],
  ];
  for (const [x, y] of keys) {
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

export function solve(model) {
  const order = reachableComponents(model);
  const assignment = new Map();
  const failed = new Set();

  function stateKey(k) {
    let key = `${k}:`;
    for (let i = 0; i < k; i += 1) key += `${assignment.get(order[i])},`;
    return key;
  }

  function dfs(k) {
    if (k === order.length) return true;
    const key = stateKey(k);
    if (failed.has(key)) return false;

    const id = order[k];
    const versions = model.byId.get(id).versions; // 高 -> 低
    for (let vi = 0; vi < versions.length; vi += 1) {
      const entry = versions[vi];
      if (violationsFor(model, id, entry, assignment).length === 0) {
        assignment.set(id, vi);
        if (dfs(k + 1)) return true;
        assignment.delete(id);
      }
    }
    failed.add(key);
    return false;
  }

  if (dfs(0)) {
    const selection = {};
    for (const id of order) {
      selection[id] = model.byId.get(id).versions[assignment.get(id)].raw;
    }
    return { status: 'sat', reachable: order, selection, evidence: buildEvidence(model, assignment, order) };
  }
  return { status: 'unsat', reachable: order, tree: buildConflictTree(model, order) };
}

function buildEvidence(model, assignment, order) {
  const evidence = {};
  for (const target of order) {
    const selected = model.byId.get(target).versions[assignment.get(target)];
    const constraints = [];
    for (const root of model.roots) {
      const dep = root.dependencies[target];
      if (dep) {
        for (const atom of dep.parsed.atoms) {
          constraints.push({
            source: `根组件 ${root.id}`,
            sourceType: 'root',
            constraint: atom.raw,
            satisfied: atomHolds(selected.version, atom),
          });
        }
      }
    }
    for (const [fromId, vi] of assignment) {
      const fromEntry = model.byId.get(fromId).versions[vi];
      const dep = fromEntry.dependencies[target];
      if (dep) {
        for (const atom of dep.parsed.atoms) {
          constraints.push({
            source: `依赖 ${fromId}@${fromEntry.raw}`,
            sourceType: 'dependency',
            constraint: atom.raw,
            satisfied: atomHolds(selected.version, atom),
          });
        }
      }
    }
    constraints.sort((a, b) => (a.source === b.source ? (a.constraint < b.constraint ? -1 : 1) : a.source < b.source ? -1 : 1));
    const requires = Object.entries(selected.dependencies)
      .map(([depId, dep]) => {
        const chosenEntry = model.byId.get(depId).versions[assignment.get(depId)];
        return {
          target: depId,
          range: dep.text,
          satisfiedVersion: chosenEntry ? chosenEntry.raw : null,
          satisfied: chosenEntry ? dep.parsed.atoms.every((atom) => atomHolds(chosenEntry.version, atom)) : false,
        };
      })
      .sort((a, b) => (a.target < b.target ? -1 : a.target > b.target ? 1 : 0));
    evidence[target] = { selected: selected.raw, constraints, requires };
  }
  return evidence;
}

// ---------------------------------------------------------------------------
// 稳定冲突树（证明树）：
//   遍历顺序采用依赖传播层级（根在前，被依赖组件在其后，同层 ASCII 排序），
//   因而两个根 CTRL/PWR 共同施压时，死锁节点 BUS 出现在链尾并覆盖其全部候选。
//
//   每个组件节点列出全部候选版本（高 -> 低）：
//     - 直接被约束否决的候选：附全部违反约束与理由；
//     - 未被直接否决的候选：用与 solve 同一套精确 DFS（带失败记忆）判定可行性；
//       取其中“最高的不可行候选”展开下一层证明链，其余标记为回溯亦无解。
//   deadComponent 取证明链上最深、且“全部候选均被直接否决”的节点。
// ---------------------------------------------------------------------------
function buildConflictTree(model, reachable) {
  const asciiOrder = reachable;
  const propOrder = dependencyOrder(model);

  // 精确可行性：在 forced 赋值前缀下，按 ASCII 顺序做带回溯的 DFS。
  function canSolve(forced) {
    const assignment = new Map(forced);
    const failed = new Set();
    function stateKey(k) {
      let key = `${k}:`;
      for (let i = 0; i < k; i += 1) key += `${assignment.get(asciiOrder[i]) ?? '*'},`;
      return key;
    }
    function dfs(k) {
      if (k === asciiOrder.length) return true;
      const id = asciiOrder[k];
      if (assignment.has(id)) return dfs(k + 1);
      const key = stateKey(k);
      if (failed.has(key)) return false;
      const versions = model.byId.get(id).versions;
      for (let vi = 0; vi < versions.length; vi += 1) {
        const entry = versions[vi];
        if (violationsFor(model, id, entry, assignment).length === 0) {
          assignment.set(id, vi);
          if (dfs(k + 1)) return true;
          assignment.delete(id);
        }
      }
      failed.add(key);
      return false;
    }
    return dfs(0);
  }

  function incomingEdges(id, forced) {
    const edges = [];
    for (const root of model.roots) {
      const dep = root.dependencies[id];
      if (dep) edges.push({ source: `根组件 ${root.id}`, range: dep.text });
    }
    for (const [fromId, vi] of forced) {
      const fromEntry = model.byId.get(fromId).versions[vi];
      const dep = fromEntry.dependencies[id];
      if (dep) edges.push({ source: `${fromId}@${fromEntry.raw}`, range: dep.text });
    }
    return edges.sort((a, b) => (a.source === b.source ? (a.range < b.range ? -1 : 1) : a.source < b.source ? -1 : 1));
  }

  function proof(k, forced) {
    const id = propOrder[k];
    const comp = model.byId.get(id);
    const candidates = comp.versions.map((entry, vi) => {
      const violated = violationsFor(model, id, entry, forced);
      return { version: entry.raw, versionIndex: vi, violated, verdict: violated.length ? 'rejected' : 'unknown' };
    });
    let expanded = null;
    let directDead = null;
    for (const cand of candidates) {
      if (cand.verdict !== 'unknown') continue;
      const next = new Map(forced);
      next.set(id, comp.versions.findIndex((e) => e.raw === cand.version));
      const feasible = canSolve(next);
      cand.verdict = feasible ? 'feasible' : 'dead-branch';
      if (!feasible && expanded === null && k + 1 < propOrder.length) {
        const child = proof(k + 1, next);
        expanded = { version: cand.version, child: child.node };
        directDead = child.directDead;
      }
    }
    const node = {
      component: id,
      candidateCount: candidates.length,
      viableCount: candidates.filter((c) => c.verdict === 'feasible').length,
      incoming: incomingEdges(id, forced),
      candidates: candidates.map(({ version, violated, verdict }) => ({
        version,
        violated,
        rejected: verdict === 'rejected',
        deadBranch: verdict === 'dead-branch' && expanded?.version !== version,
      })),
      expanded,
    };
    if (!directDead && node.candidates.every((c) => c.rejected)) directDead = node;
    return { node, directDead };
  }

  const { node, directDead } = proof(0, new Map());
  const deadNode = directDead ?? node;
  const title = `组件 ${deadNode.component} 的全部 ${deadNode.candidateCount} 个候选版本均不可行`;
  return {
    title,
    deadComponent: deadNode.component,
    roots: model.roots.map((r) => r.id),
    node,
  };
}
