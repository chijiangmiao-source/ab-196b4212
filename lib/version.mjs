// 语义化版本解析与比较（核心 X.Y.Z 形式）。
// 为星载载荷审计场景，版本仅接受非负整数构成的三段式 MAJOR.MINOR.PATCH。

const NUM = '0|[1-9]\\d*';
const RE = new RegExp(`^(${NUM})\\.(${NUM})\\.(${NUM})$`);

/**
 * 解析版本字符串。
 * @param {string} raw
 * @returns {{major:number, minor:number, patch:number, raw:string}}
 * @throws {Error} 形式非法时抛出，错误消息以 `版本格式非法` 开头
 */
export function parseVersion(raw) {
  if (typeof raw !== 'string') {
    throw new Error(`版本格式非法：${String(raw)}（应为 MAJOR.MINOR.PATCH）`);
  }
  const text = raw.trim();
  const m = RE.exec(text);
  if (!m) {
    throw new Error(`版本格式非法：${raw}（应为 MAJOR.MINOR.PATCH，如 2.0.0）`);
  }
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    raw: text,
  };
}

/**
 * 比较两个版本。
 * @returns {-1|0|1} a 低于/等于/高于 b
 */
export function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  for (const key of ['major', 'minor', 'patch']) {
    if (pa[key] < pb[key]) return -1;
    if (pa[key] > pb[key]) return 1;
  }
  return 0;
}

/**
 * @returns {string} 规范化后的版本字符串
 */
export function normalizeVersion(raw) {
  const v = parseVersion(raw);
  return `${v.major}.${v.minor}.${v.patch}`;
}
