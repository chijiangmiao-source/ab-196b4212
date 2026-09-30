import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseVersion, compareVersions, normalizeVersion } from '../lib/version.mjs';

test('parseVersion 解析三段式非负整数版本', () => {
  assert.deepEqual(parseVersion('2.0.0'), { major: 2, minor: 0, patch: 0, raw: '2.0.0' });
  assert.deepEqual(parseVersion(' 10.20.30 '), { major: 10, minor: 20, patch: 30, raw: '10.20.30' });
});

test('parseVersion 拒绝非法形式', () => {
  for (const bad of ['1', '1.2', '1.2.3.4', 'v1.2.3', '1.2.x', '', 'a.b.c', '1.2.-1', '01.0.0']) {
    assert.throws(() => parseVersion(bad), /版本格式非法/);
  }
});

test('compareVersions 按 major/minor/patch 顺序比较', () => {
  assert.equal(compareVersions('1.0.0', '2.0.0'), -1);
  assert.equal(compareVersions('2.0.1', '2.0.0'), 1);
  assert.equal(compareVersions('2.1.0', '2.0.9'), 1);
  assert.equal(compareVersions('1.10.0', '1.9.0'), 1);
  assert.equal(compareVersions('3.0.0', '3.0.0'), 0);
});

test('normalizeVersion 去空白并规范化', () => {
  assert.equal(normalizeVersion(' 2.0.0 '), '2.0.0');
});
