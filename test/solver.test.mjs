import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateModel, MAX_COMPONENTS, MAX_VERSIONS } from '../src/solver/model.mjs';
import { solve } from '../src/solver/solver.mjs';

const v = (version, dependencies = {}) => ({ version, dependencies });

test('CAM 1.0 依赖 NAV >=2.0.0 <3.0.0：选出 NAV 2.0.0 并给出满足依据', () => {
  const input = {
    components: [
      { id: 'CAM', versions: [v('1.0.0', { NAV: '>=2.0.0 <3.0.0' })] },
      { id: 'NAV', versions: [v('1.0.0'), v('2.0.0')] },
    ],
    roots: [{ id: 'CAM' }],
  };
  const { errors, model } = validateModel(input);
  assert.deepEqual(errors, []);
  const result = solve(model);
  assert.equal(result.status, 'sat');
  assert.equal(result.selection.NAV, '2.0.0');
  assert.equal(result.selection.CAM, '1.0.0');
  const navEv = result.evidence.NAV;
  assert.ok(navEv.constraints.some((c) => c.constraint.startsWith('>=2.0.0') && c.satisfied));
  assert.ok(navEv.constraints.some((c) => c.constraint.startsWith('<3.0.0') && c.satisfied));
  const camEv = result.evidence.CAM;
  assert.ok(camEv.requires.some((r) => r.target === 'NAV' && r.satisfiedVersion === '2.0.0' && r.satisfied));
});

test('多解时按组件 ASCII 顺序且每组件优先较高版本，重复提交一致', () => {
  const input = {
    components: [
      { id: 'ZETA', versions: [v('1.0.0'), v('3.0.0'), v('2.0.0')] },
      { id: 'ALPHA', versions: [v('0.9.0'), v('1.5.0')] },
    ],
    roots: [{ id: 'ZETA' }, { id: 'ALPHA' }],
  };
  const { model } = validateModel(input);
  const r1 = solve(model);
  const r2 = solve(model);
  assert.deepEqual(r1.selection, { ALPHA: '1.5.0', ZETA: '3.0.0' });
  assert.deepEqual(r1.reachable, ['ALPHA', 'ZETA']);
  assert.deepEqual(r1, r2);
});

test('两个根分别要求 BUS >=2.0.0 与 <2.0.0：冲突树覆盖 BUS 全部候选', () => {
  const input = {
    components: [
      { id: 'BUS', versions: ['1.0.0', '1.9.0', '2.0.0', '2.1.0'].map((x) => v(x)) },
      { id: 'CTRL', versions: [v('1.0.0', { BUS: '>=2.0.0' })] },
      { id: 'PWR', versions: [v('1.0.0', { BUS: '<2.0.0' })] },
    ],
    roots: [{ id: 'CTRL' }, { id: 'PWR' }],
  };
  const { model } = validateModel(input);
  const result = solve(model);
  assert.equal(result.status, 'unsat');
  assert.equal(result.tree.deadComponent, 'BUS');
  // 证明树自根（CTRL）沿依赖传播方向展开，最深死节点为 BUS。
  let dead = result.tree.node;
  while (dead.component !== 'BUS') {
    assert.ok(dead.expanded, '应继续展开到下一层证明');
    dead = dead.expanded.child;
  }
  const node = dead;
  assert.equal(node.candidateCount, 4);
  assert.equal(node.viableCount, 0);
  for (const c of node.candidates) {
    assert.equal(c.rejected, true, `候选 ${c.version} 应被至少一条约束直接否决`);
    const sources = c.violated.map((x) => x.source).join(' ');
    assert.match(sources, /CTRL|PWR/);
  }
  // 2.x 被 PWR 的 <2.0.0 否决，1.x 被 CTRL 的 >=2.0.0 否决。
  const byVersion = Object.fromEntries(node.candidates.map((c) => [c.version, c]));
  assert.ok(byVersion['2.0.0'].violated.some((x) => x.source.includes('PWR')));
  assert.ok(byVersion['1.9.0'].violated.some((x) => x.source.includes('CTRL')));
});

test('根级依赖范围同样参与冲突判定（根版本无关的持续约束）', () => {
  const input = {
    components: [
      { id: 'BUS', versions: ['1.0.0', '2.0.0'].map((x) => v(x)) },
      { id: 'CTRL', versions: [v('1.0.0')] },
      { id: 'PWR', versions: [v('1.0.0')] },
    ],
    roots: [
      { id: 'CTRL', dependencies: { BUS: '>=2.0.0' } },
      { id: 'PWR', dependencies: { BUS: '<2.0.0' } },
    ],
  };
  const { model } = validateModel(input);
  assert.equal(solve(model).status, 'unsat');
});

test('冲突树稳定：重复求解深度相等', () => {
  const input = {
    components: [
      { id: 'BUS', versions: ['1.0.0', '1.5.0', '2.0.0', '2.1.0'].map((x) => v(x)) },
      { id: 'CTRL', versions: [v('1.0.0', { BUS: '>=2.0.0' })] },
      { id: 'PWR', versions: [v('1.0.0', { BUS: '<2.0.0' })] },
    ],
    roots: [{ id: 'CTRL' }, { id: 'PWR' }],
  };
  const { model } = validateModel(input);
  assert.deepEqual(solve(model).tree, solve(model).tree);
});

test('间接依赖的互斥要求可被发现（后置组件反向否决前置选择，需回溯）', () => {
  const input = {
    components: [
      // ALPHA@2 要求 BETA=1；BETA@2 要求 GAMMA=2，GAMMA@2 要求 ALPHA=1。
      { id: 'ALPHA', versions: [v('1.0.0'), v('2.0.0', { BETA: '=1.0.0' })] },
      { id: 'BETA', versions: [v('1.0.0', { GAMMA: '=1.0.0' }), v('2.0.0', { GAMMA: '=2.0.0' })] },
      { id: 'GAMMA', versions: [v('1.0.0'), v('2.0.0', { ALPHA: '=1.0.0' })] },
    ],
    roots: [{ id: 'ALPHA' }],
  };
  const { model } = validateModel(input);
  const result = solve(model);
  // 存在解且按“高版本优先”：ALPHA=2 要求 BETA=1 -> GAMMA=1（GAMMA@1 不反向要求 ALPHA），
  // 该链全部成立，故优先于 ALPHA=1 下的 BETA=2 链。
  assert.equal(result.status, 'sat');
  assert.equal(result.selection.ALPHA, '2.0.0');
  assert.equal(result.selection.BETA, '1.0.0');
  assert.equal(result.selection.GAMMA, '1.0.0');

  // 若根强制 ALPHA=2，则 BETA 必须为 1，GAMMA 必须为 1，链路仍可解；
  // 再令 GAMMA@1 不存在可行场景：构造真正无解的环。
  const unsatInput = {
    components: [
      { id: 'ALPHA', versions: [v('2.0.0', { BETA: '=1.0.0' })] },
      { id: 'BETA', versions: [v('1.0.0', { GAMMA: '=2.0.0' })] },
      { id: 'GAMMA', versions: [v('1.0.0'), v('2.0.0', { ALPHA: '=1.0.0' })] },
    ],
    roots: [{ id: 'ALPHA' }],
  };
  const u = validateModel(unsatInput);
  assert.equal(solve(u.model).status, 'unsat');
});

test('仅可达组件参与选定，不可达组件不影响结果', () => {
  const input = {
    components: [
      { id: 'APP', versions: [v('1.0.0', { LIB: '>=1.0.0' })] },
      { id: 'LIB', versions: [v('1.0.0'), v('2.0.0')] },
      { id: 'UNUSED', versions: [v('1.0.0', { GHOST: '>=1.0.0' })] },
      { id: 'GHOST', versions: [v('0.9.0')] },
    ],
    roots: [{ id: 'APP' }],
  };
  const { model } = validateModel(input);
  const result = solve(model);
  assert.equal(result.status, 'sat');
  assert.deepEqual(result.reachable.sort(), ['APP', 'LIB']);
  assert.equal(result.selection.LIB, '2.0.0');
});

test('错误定位：未知组件 / 非法范围 / 空候选 / 根未登记', () => {
  let r = validateModel({
    components: [{ id: 'A', versions: [v('1.0.0', { MISSING: '>=1.0.0' })] }],
    roots: [{ id: 'A' }],
  });
  assert.ok(r.errors.some((e) => e.code === 'UNKNOWN_COMPONENT' && e.dependency === 'MISSING' && e.component === 'A'));

  r = validateModel({
    components: [
      { id: 'A', versions: [v('1.0.0', { B: '^1.0.0' })] },
      { id: 'B', versions: [v('1.0.0')] },
    ],
    roots: [{ id: 'A' }],
  });
  const badRange = r.errors.find((e) => e.code === 'BAD_RANGE');
  assert.ok(badRange);
  assert.equal(badRange.dependency, 'B');
  assert.equal(typeof badRange.offset, 'number');

  r = validateModel({ components: [{ id: 'A', versions: [] }], roots: [{ id: 'A' }] });
  assert.ok(r.errors.some((e) => e.code === 'EMPTY_CANDIDATES' && e.component === 'A'));

  r = validateModel({ components: [{ id: 'A', versions: [v('1.0.0')] }], roots: [{ id: 'NOPE' }] });
  assert.ok(r.errors.some((e) => e.code === 'UNKNOWN_ROOT' && e.component === 'NOPE'));
});

test('上限：至多 16 个组件、每组件至多 6 个版本', () => {
  assert.equal(MAX_COMPONENTS, 16);
  assert.equal(MAX_VERSIONS, 6);
  const mk = (n) => ({
    components: Array.from({ length: n }, (_, i) => ({ id: `C${i}`, versions: [v('1.0.0')] })),
    roots: [{ id: 'C0' }],
  });
  assert.equal(validateModel(mk(16)).errors.length, 0);
  assert.ok(validateModel(mk(17)).errors.some((e) => e.code === 'TOO_MANY_COMPONENTS'));

  const seven = {
    components: [{ id: 'A', versions: Array.from({ length: 7 }, (_, i) => v(`${i + 1}.0.0`)) }],
    roots: [{ id: 'A' }],
  };
  assert.ok(validateModel(seven).errors.some((e) => e.code === 'TOO_MANY_VERSIONS'));
});

test('精确选定一个版本：等号约束锁定', () => {
  const input = {
    components: [
      { id: 'APP', versions: [v('1.0.0', { LIB: '=1.2.3' })] },
      { id: 'LIB', versions: ['1.2.2', '1.2.3', '1.2.4', '2.0.0'].map((x) => v(x)) },
    ],
    roots: [{ id: 'APP' }],
  };
  const { model } = validateModel(input);
  const result = solve(model);
  assert.equal(result.status, 'sat');
  assert.equal(result.selection.LIB, '1.2.3');
});

test('服务层：校验失败时返回 invalid 且不产出任何选择结论', async () => {
  const { runSolver } = await import('../src/server/app.mjs');
  const out = runSolver({ components: [{ id: 'A', versions: [v('1.0.0', { X: '>=1.0.0' })] }], roots: [{ id: 'A' }] });
  assert.equal(out.status, 'invalid');
  assert.equal(out.selection, undefined);
  assert.equal(out.tree, undefined);
  assert.ok(out.errors.some((e) => e.code === 'UNKNOWN_COMPONENT'));
});
