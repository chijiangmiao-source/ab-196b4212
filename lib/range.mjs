// 依赖范围解析。
// 范围是若干比较条件的合取（空格分隔），比较符仅支持：= 、>= 、<。
// 例：">=2.0.0 <3.0.0"、"=1.2.3"。

import { compareVersions, parseVersion } from './version.mjs';

const COMPARATORS = new Set(['=', '>=', '<']);
const TOKEN_RE = /^(>=|<=|>|<|=)(.+)$/;

/**
 * 解析范围字符串为条件列表（合取）。
 * @param {string} raw
 * @returns {{op:string, version:string}[]}
 * @throws {Error} 非法范围时抛出，错误消息以 `范围非法` 开头
 */
export function parseRange(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new Error('范围非法：范围不能为空（合法示例：>=2.0.0 <3.0.0）');
  }
  const tokens = raw.trim().split(/\s+/);
  const clauses = [];
  for (const token of tokens) {
    const m = TOKEN_RE.exec(token);
    if (!m) {
      throw new Error(
        `范围非法：${token}（条件须以 = 、>= 、< 开头，后接 MAJOR.MINOR.PATCH）`,
      );
    }
    const [, op, verText] = m;
    if (!COMPARATORS.has(op)) {
      throw new Error(`范围非法：${token}（仅支持 = 、>= 、< 三种比较符）`);
    }
    // 借版本解析校验版本形式（抛出的错误改写为“范围非法”前缀）。
    try {
      parseVersion(verText);
    } catch (err) {
      throw new Error(`范围非法：${token}（${err.message}）`);
    }
    clauses.push({ op, version: verText.trim() });
  }
  // 合取本身不可满足（如 =1.0.0 >=2.0.0）应尽早识别。
  if (!isSatisfiable(clauses)) {
    throw new Error(`范围非法：${raw}（各条件互相矛盾，无任何版本可满足）`);
  }
  return clauses;
}

/** 单个候选版本是否满足全部条件。 */
export function satisfies(version, clauses) {
  return clauses.every(({ op, version: bound }) => {
    const c = compareVersions(version, bound);
    if (op === '=') return c === 0;
    if (op === '>=') return c >= 0;
    // '<'
    return c < 0;
  });
}

/** 合取条件是否存在被满足的可能（基于数值边界检查）。 */
function isSatisfiable(clauses) {
  let lower = null; // {version, inclusive}
  let upper = null; // {version, inclusive}
  let eq = null;
  for (const { op, version } of clauses) {
    if (op === '=') {
      if (eq !== null && compareVersions(eq, version) !== 0) return false;
      eq = version;
    } else if (op === '>=') {
      if (!lower || compareVersions(version, lower.version) > 0) {
        lower = { version, inclusive: true };
      }
    } else {
      // '<'
      if (!upper || compareVersions(version, upper.version) < 0) {
        upper = { version, inclusive: false };
      }
    }
  }
  if (eq !== null) {
    if (lower && compareVersions(eq, lower.version) < 0) return false;
    if (upper && compareVersions(eq, upper.version) >= 0) return false;
    return true;
  }
  if (lower && upper) {
    const c = compareVersions(lower.version, upper.version);
    // lower 为闭区间、upper 为开区间：下界须严格小于上界。
    return c < 0;
  }
  return true;
}
