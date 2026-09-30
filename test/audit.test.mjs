import { test } from 'node:test';
import assert from 'node:assert/strict';
import { audit, validateModel, ValidationError, reachableComponents, LIMITS } from '../lib/audit.mjs';

const camNavInput = {
  roots: ['CAM'],
  components: [
    { id: 'CAM', versions: ['1.0.0'], dependencies: { NAV: '>=2.0.0 <3.0.0' } },
    { id: 'NAV', versions: ['1.0.0', '2.0.0'], dependencies: {} },
  ],
};

test('CAM 1.0 + NAV 范围：选出 NAV 2.0.0 并给出满足依据', () => {
  const res = audit(camNavInput);
  assert.equal(res.status, 'satisfiable');
  const nav = res.assignment.find((a) => a.component === 'NAV');
  assert.equal(nav.selectedVersion, '2.0.0');
  assert.deepEqual(nav.acceptableVersions, ['2.0.0']);
  assert.equal(nav.evidence.length, 1);
  assert.equal(nav.evidence[0].from, 'CAM');
  assert.equal(nav.evidence[0].range, '>=2.0.0 <3.0.0');
  assert.ok(nav.evidence[0].checks.every((c) => c.holds));
  // 每个可达组件恰好选定一个版本
  const ids = res.assignment.map((a) => a.component).sort();
  assert.deepEqual(ids, ['CAM', 'NAV']);
});

test('CAM 场景中 NAV 1.0.0 不满足 >=2.0.0（规则代码直接断言）', () => {
  const res = audit(camNavInput);
  const nav = res.assignment.find((a) => a.component === 'NAV');
  assert.equal(nav.acceptableVersions.includes('1.0.0'), false);
});

test('多解时按组件标识 ASCII 顺序、各自取较高版本，且结果可重复', () => {
  const input = {
    roots: ['ROOT'],
    components: [
      { id: 'ROOT', versions: ['1.0.0'], dependencies: { ZEB: '>=1.0.0', ALPHA: '>=1.0.0' } },
      { id: 'ZEB', versions: ['1.0.0', '1.2.0', '1.1.0'], dependencies: {} },
      { id: 'ALPHA', versions: ['3.0.0', '2.9.9'], dependencies: {} },
    ],
  };
  const pick = () => audit(input).assignment.map((a) => [a.component, a.selectedVersion]);
  const first = pick();
  assert.deepEqual(first, [
    ['ALPHA', '3.0.0'],
    ['ROOT', '1.0.0'],
    ['ZEB', '1.2.0'],
  ]);
  // 重复提交结果一致
  assert.deepEqual(pick(), first);
  assert.deepEqual(pick(), first);
});

test('两个根组件对 BUS 互斥要求：冲突树覆盖 BUS 全部候选版本', () => {
  const input = {
    roots: ['ROOT_A', 'ROOT_B'],
    components: [
      { id: 'ROOT_A', versions: ['1.0.0'], dependencies: { BUS: '>=2.0.0' } },
      { id: 'ROOT_B', versions: ['1.0.0'], dependencies: { BUS: '<2.0.0' } },
      { id: 'BUS', versions: ['1.0.0', '2.0.0', '3.0.0'], dependencies: {} },
    ],
  };
  const res = audit(input);
  assert.equal(res.status, 'conflict');
  assert.equal(res.tree.conflicts.length, 1);
  const bus = res.tree.conflicts[0];
  assert.equal(bus.component, 'BUS');
  assert.deepEqual(bus.candidates.map((c) => c.version), ['3.0.0', '2.0.0', '1.0.0']);
  // 每个候选都必须被至少一条上游要求否决
  for (const cand of bus.candidates) {
    assert.ok(cand.rejectedBy.length > 0, `${cand.version} 应有否决依据`);
  }
  const byVersion = Object.fromEntries(bus.candidates.map((c) => [c.version, c]));
  assert.deepEqual(byVersion['1.0.0'].rejectedBy.map((r) => r.from), ['ROOT_A']);
  assert.deepEqual(byVersion['3.0.0'].rejectedBy.map((r) => r.from), ['ROOT_B']);
  // 2.0.0：>=2.0.0 成立，但 <2.0.0 不成立
  assert.deepEqual(byVersion['2.0.0'].rejectedBy.map((r) => r.from), ['ROOT_B']);
  assert.equal(byVersion['2.0.0'].rejectedBy[0].failedClauses[0].expected, '<2.0.0');
  // 冲突树稳定：重复审计序列化结果一致
  assert.equal(JSON.stringify(audit(input)), JSON.stringify(audit(input)));
});

test('未知组件：依赖目标与根组件均能定位', () => {
  try {
    audit({ roots: ['GHOST'], components: [{ id: 'A', versions: ['1.0.0'], dependencies: { MISSING: '=1.0.0' } }] });
    assert.fail('应抛出 ValidationError');
  } catch (e) {
    assert.ok(e instanceof ValidationError);
    const codes = e.errors.map((x) => x.code);
    assert.ok(codes.includes('UNKNOWN_COMPONENT'));
    const targets = e.errors.filter((x) => x.code === 'UNKNOWN_COMPONENT').map((x) => x.target);
    assert.deepEqual(targets.sort(), ['GHOST', 'MISSING']);
  }
});

test('非法范围错误被定位', () => {
  assert.throws(
    () => audit({ roots: ['A'], components: [{ id: 'A', versions: ['1.0.0'], dependencies: { B: '^1.0.0' } }, { id: 'B', versions: ['1.0.0'] }] }),
    (e) => e instanceof ValidationError && e.errors.some((x) => x.code === 'INVALID_RANGE' && x.to === 'B'),
  );
});

test('空候选被定位为 EMPTY_CANDIDATES', () => {
  assert.throws(
    () => audit({ roots: ['A'], components: [{ id: 'A', versions: [] }] }),
    (e) => e instanceof ValidationError && e.errors[0].code === 'EMPTY_CANDIDATES' && e.errors[0].component === 'A',
  );
});

test('不可达组件不参与选版但给出告警', () => {
  const res = audit({
    roots: ['A'],
    components: [
      { id: 'A', versions: ['1.0.0'] },
      { id: 'ORPHAN', versions: ['1.0.0'] },
    ],
  });
  assert.equal(res.status, 'satisfiable');
  assert.deepEqual(res.assignment.map((x) => x.component), ['A']);
  assert.deepEqual(res.warnings[0].components, ['ORPHAN']);
});

test('上限：>16 组件 或 >6 版本 被拒绝', () => {
  const tooMany = { roots: ['C0'], components: Array.from({ length: LIMITS.MAX_COMPONENTS + 1 }, (_, i) => ({ id: `C${i}`, versions: ['1.0.0'] })) };
  assert.throws(() => validateModel(tooMany), (e) => e.errors.some((x) => x.code === 'TOO_MANY_COMPONENTS'));
  const tooManyV = { roots: ['C'], components: [{ id: 'C', versions: ['1.0.0', '2.0.0', '3.0.0', '4.0.0', '5.0.0', '6.0.0', '7.0.0'] }] };
  assert.throws(() => validateModel(tooManyV), (e) => e.errors.some((x) => x.code === 'TOO_MANY_VERSIONS'));
});

test('边界：恰好 16 个组件、每组件 6 个版本可求解', () => {
  const components = Array.from({ length: LIMITS.MAX_COMPONENTS }, (_, i) => ({
    id: `C${String(i).padStart(2, '0')}`,
    versions: ['1.0.0', '2.0.0', '3.0.0', '4.0.0', '5.0.0', '6.0.0'],
  }));
  const res = audit({ roots: ['C00'], components });
  assert.equal(res.status, 'satisfiable');
  // 仅根可达
  assert.equal(res.assignment.length, 1);
  assert.equal(res.assignment[0].selectedVersion, '6.0.0');
});

test('可达性沿依赖边传播', () => {
  const model = validateModel({
    roots: ['A'],
    components: [
      { id: 'A', versions: ['1.0.0'], dependencies: { B: '=1.0.0' } },
      { id: 'B', versions: ['1.0.0'], dependencies: { C: '=1.0.0' } },
      { id: 'C', versions: ['1.0.0'] },
      { id: 'D', versions: ['1.0.0'] },
    ],
  });
  assert.deepEqual([...reachableComponents(model)].sort(), ['A', 'B', 'C']);
});

test('多条入边范围取合取：任一不满足即排除该候选', () => {
  const res = audit({
    roots: ['A', 'B'],
    components: [
      { id: 'A', versions: ['1.0.0'], dependencies: { X: '>=2.0.0' } },
      { id: 'B', versions: ['1.0.0'], dependencies: { X: '<3.0.0' } },
      { id: 'X', versions: ['1.0.0', '2.5.0', '3.0.0'] },
    ],
  });
  assert.equal(res.status, 'satisfiable');
  const x = res.assignment.find((a) => a.component === 'X');
  assert.equal(x.selectedVersion, '2.5.0');
  assert.deepEqual(x.acceptableVersions, ['2.5.0']);
});
