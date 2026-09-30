import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseVersion, compareVersions } from '../src/solver/semver.mjs';
import { parseRange, satisfies, RangeError } from '../src/solver/range.mjs';

test('语义化版本解析：核心三段', () => {
  const v = parseVersion('2.0.0');
  assert.deepEqual([v.major, v.minor, v.patch], [2, 0, 0]);
  assert.equal(v.prerelease, null);
});

test('非法版本被拒绝：v 前缀 / 两段 / 非数字 / 前导零', () => {
  for (const bad of ['v1.0.0', '1.0', '1', '1.0.x', '01.0.0', '1.0.0.0', '', '1.2.3-']) {
    assert.throws(() => parseVersion(bad), /非法/, `应拒绝: ${bad}`);
  }
});

test('版本比较含先行版本优先级', () => {
  const ordered = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-rc.1', '1.0.0'];
  for (let i = 1; i < ordered.length; i += 1) {
    assert.equal(compareVersions(ordered[i - 1], ordered[i]), -1, `${ordered[i - 1]} < ${ordered[i]}`);
  }
  assert.equal(compareVersions('2.1.0', '2.0.9'), 1);
  assert.equal(compareVersions('10.0.0', '9.9.9'), 1);
});

test('范围解析：合取 = >= <', () => {
  const r = parseRange('>=2.0.0 <3.0.0');
  assert.equal(r.atoms.length, 2);
  assert.equal(satisfies(parseVersion('2.0.0'), r), true);
  assert.equal(satisfies(parseVersion('2.9.9'), r), true);
  assert.equal(satisfies(parseVersion('3.0.0'), r), false);
  assert.equal(satisfies(parseVersion('1.9.9'), r), false);
});

test('范围解析：运算符与版本间允许空白', () => {
  assert.equal(satisfies(parseVersion('2.0.0'), parseRange('>= 2.0.0')), true);
  assert.equal(satisfies(parseVersion('1.0.0'), parseRange('= 1.0.0')), true);
});

test('范围解析：仅支持 = >= <，其余运算符拒绝', () => {
  for (const bad of ['', '   ', '<=2.0.0', '>1.0.0', '^1.0.0', '~1.0.0', '1.x', '>=2.0.0 && <3.0.0']) {
    assert.throws(() => parseRange(bad), RangeError, `应拒绝: "${bad}"`);
  }
});

test('范围错误带字符偏移，便于定位', () => {
  try {
    parseRange('>=2.0.0 <=3.0.0');
    assert.fail('应抛出');
  } catch (err) {
    assert.ok(err instanceof RangeError);
    assert.equal(err.offset, '>=2.0.0 '.length);
    assert.equal(err.length, 2);
  }
  try {
    parseRange('>= 2.0');
    assert.fail('应抛出');
  } catch (err) {
    assert.equal(err.offset, '>= '.length);
  }
});
