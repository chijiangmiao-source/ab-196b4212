// 严格语义化版本（Semantic Versioning 2.0.0）解析与比较。
// 仅接受 X.Y.Z 核心版本，可带 -prerelease 与 +build 元数据；拒绝 "v1"、"2.0" 等。

const VERSION_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

const IDENT_RE = /^[0-9A-Za-z-]+$/;

export class VersionError extends Error {
  constructor(message, token) {
    super(message);
    this.name = 'VersionError';
    this.token = token;
  }
}

export function parseVersion(text) {
  const token = String(text ?? '');
  const m = VERSION_RE.exec(token);
  if (!m) {
    throw new VersionError(`非法语义化版本: "${token}"（应为 X.Y.Z 形式）`, token);
  }
  const prerelease = m[4]
    ? m[4].split('.').map((id) => {
        if (!IDENT_RE.test(id) || /^0\d+$/.test(id)) {
          throw new VersionError(`非法的先行版本标识符: "${id}"`, token);
        }
        return /^\d+$/.test(id) ? Number(id) : id;
      })
    : null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease,
    raw: token,
  };
}

export function formatVersion(v) {
  const core = `${v.major}.${v.minor}.${v.patch}`;
  if (!v.prerelease) return core;
  return `${core}-${v.prerelease.join('.')}`;
}

// 先行版本标识符比较：数字按数值，字符串按 ASCII；数字标识符优先级低于字符串标识符。
function comparePrereleaseId(a, b) {
  const an = typeof a === 'number';
  const bn = typeof b === 'number';
  if (an && bn) return a === b ? 0 : a < b ? -1 : 1;
  if (an) return -1;
  if (bn) return 1;
  return a === b ? 0 : a < b ? -1 : 1;
}

export function compareVersions(a, b) {
  const va = typeof a === 'string' ? parseVersion(a) : a;
  const vb = typeof b === 'string' ? parseVersion(b) : b;
  const core = [va.major - vb.major, va.minor - vb.minor, va.patch - vb.patch];
  for (const d of core) {
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  // 无先行版本的优先级高于有先行版本。
  if (!va.prerelease && !vb.prerelease) return 0;
  if (!va.prerelease) return 1;
  if (!vb.prerelease) return -1;
  const len = Math.max(va.prerelease.length, vb.prerelease.length);
  for (let i = 0; i < len; i += 1) {
    if (i >= va.prerelease.length) return -1;
    if (i >= vb.prerelease.length) return 1;
    const c = comparePrereleaseId(va.prerelease[i], vb.prerelease[i]);
    if (c !== 0) return c;
  }
  return 0;
}
