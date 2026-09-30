import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRange, satisfies } from '../lib/range.mjs';

test('parseRange 解析 = 、>= 、< 的合取', () => {
  assert.deepEqual(parseRange('=1.2.3'), [{ op: '=', version: '1.2.3' }]);
  assert.deepEqual(parseRange(' >=2.0.0  <3.0.0 '), [
    { op: '>=', version: '2.0.0' },
    { op: '<', version: '3.0.0' },
  ]);
});

test('parseRange 拒绝不支持的比较符与非法语法', () => {
  for (const bad of ['', '   ', '>1.0.0', '<=2.0.0', '^1.0.0', '~1.2.3', '1.0.0', '>= 1.0.0', '>=1.2', '>=v1.0.0']) {
    assert.throws(() => parseRange(bad), /范围非法/, `应拒绝: ${JSON.stringify(bad)}`);
  }
});

test('parseRange 拒绝自相矛盾的合取', () => {
  assert.throws(() => parseRange('=1.0.0 >=2.0.0'), /矛盾/);
  assert.throws(() => parseRange('>=2.0.0 <2.0.0'), /矛盾/);
  assert.throws(() => parseRange('=2.0.0 <2.0.0'), /矛盾/);
});

test('satisfies 按合取判定候选版本', () => {
  const r = parseRange('>=2.0.0 <3.0.0');
  assert.equal(satisfies('1.9.9', r), false);
  assert.equal(satisfies('2.0.0', r), true);
  assert.equal(satisfies('2.5.3', r), true);
  assert.equal(satisfies('3.0.0', r), false);

  const eq = parseRange('=2.0.0');
  assert.equal(satisfies('2.0.0', eq), true);
  assert.equal(satisfies('2.0.1', eq), false);
});
