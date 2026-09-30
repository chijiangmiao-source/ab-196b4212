// 依赖范围：仅支持 =、>=、< 三种原子以空白合取，例如 ">=2.0.0 <3.0.0"、"=1.2.3"。
import { compareVersions, parseVersion } from './semver.mjs';

export class RangeError extends Error {
  constructor(message, offset, length) {
    super(message);
    this.name = 'RangeError';
    this.offset = offset; // 出错子串在原范围文本中的字符偏移，用于“定位错误”
    this.length = length;
  }
}

const ALLOWED_OPS = new Set(['=', '>=', '<']);

function skipSpaces(s, i) {
  let j = i;
  while (j < s.length && /\s/.test(s[j])) j += 1;
  return j;
}

// 返回 { atoms:[{op, version(对象), raw, opOffset, versionOffset}] }
// 允许 ">=" 与版本号之间有空白：">= 2.0.0 <3.0.0"。
export function parseRange(text) {
  const s = String(text ?? '');
  if (!s.trim()) {
    throw new RangeError('范围为空（合取条件至少需要一个约束）', 0, s.length);
  }
  const atoms = [];
  let i = skipSpaces(s, 0);
  while (i < s.length) {
    const opMatch = /^(>=|<=|=|>|<)/.exec(s.slice(i));
    if (!opMatch) {
      let end = i;
      while (end < s.length && !/\s/.test(s[end])) end += 1;
      throw new RangeError(
        `无法识别的范围运算符: "${s.slice(i, end)}"（仅支持 =、>=、<）`,
        i,
        Math.max(end - i, 1),
      );
    }
    const op = opMatch[0];
    const opOffset = i;
    if (!ALLOWED_OPS.has(op)) {
      throw new RangeError(
        `不支持的范围运算符 "${op}"（仅支持 =、>=、<）`,
        opOffset,
        op.length,
      );
    }
    let j = skipSpaces(s, i + op.length);
    const versionStart = j;
    let versionEnd = j;
    while (versionEnd < s.length && !/\s/.test(s[versionEnd])) versionEnd += 1;
    if (versionStart === versionEnd) {
      throw new RangeError(`运算符 "${op}" 后缺少版本号`, opOffset, op.length);
    }
    const versionText = s.slice(versionStart, versionEnd);
    let version;
    try {
      version = parseVersion(versionText);
    } catch (err) {
      throw new RangeError(err.message, versionStart, versionText.length);
    }
    atoms.push({
      op,
      version,
      raw: `${op}${versionText}`,
      opOffset,
      versionOffset: versionStart,
    });
    i = skipSpaces(s, versionEnd);
  }
  return { atoms };
}

export function atomHolds(version, atom) {
  const c = compareVersions(version, atom.version);
  switch (atom.op) {
    case '=':
      return c === 0;
    case '>=':
      return c >= 0;
    case '<':
      return c < 0;
    default:
      return false;
  }
}

export function satisfies(version, parsedRange) {
  return parsedRange.atoms.every((atom) => atomHolds(version, atom));
}

// 解释某个原子为何对某版本不成立，供“满足依据 / 冲突树”展示。
export function explainFailure(version, atom) {
  const target = atom.version.raw;
  const v = typeof version === 'string' ? version : version.raw;
  switch (atom.op) {
    case '=':
      return `${v} 不等于 ${target}`;
    case '>=':
      return `${v} 小于 ${target}，不满足 >=${target}`;
    case '<':
      return `${v} 大于或等于 ${target}，不满足 <${target}`;
    default:
      return `不满足 ${atom.raw}`;
  }
}
