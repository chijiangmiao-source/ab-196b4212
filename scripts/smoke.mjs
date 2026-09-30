// HTTP/API 冒烟：
//  - AUDIT_BASE_URL 已设置时直接对该地址冒烟（compose verify 指向 web 服务）；
//  - 否则在本机临时拉起 server/server.mjs，冒烟结束后关闭。

import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = process.env.SMOKE_PORT || process.env.PORT || '8099';
const BASE = process.env.AUDIT_BASE_URL || `http://127.0.0.1:${PORT}`;

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) {
    console.log(`  ✔ ${name}`);
  } else {
    failures += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function waitHealthy(url, deadlineMs = 15000) {
  const deadline = Date.now() + deadlineMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/healthz`);
      if (res.ok) return;
    } catch (e) { lastErr = e; }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`服务在 ${deadlineMs}ms 内未就绪：${url}（${lastErr?.message || 'not ok'}）`);
}

async function postAudit(body) {
  const res = await fetch(`${BASE}/api/audit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* 调用方按状态码处理 */ }
  return { status: res.status, json };
}

const CAM_NAV = {
  roots: ['CAM'],
  components: [
    { id: 'CAM', versions: ['1.0.0'], dependencies: { NAV: '>=2.0.0 <3.0.0' } },
    { id: 'NAV', versions: ['1.0.0', '2.0.0'], dependencies: {} },
  ],
};

const BUS = {
  roots: ['ROOT_A', 'ROOT_B'],
  components: [
    { id: 'ROOT_A', versions: ['1.0.0'], dependencies: { BUS: '>=2.0.0' } },
    { id: 'ROOT_B', versions: ['1.0.0'], dependencies: { BUS: '<2.0.0' } },
    { id: 'BUS', versions: ['1.0.0', '2.0.0', '3.0.0'], dependencies: {} },
  ],
};

async function main() {
  let child = null;
  if (!process.env.AUDIT_BASE_URL) {
    console.log(`[smoke] 未设置 AUDIT_BASE_URL，本机临时启动服务（端口 ${PORT}）`);
    child = spawn(process.execPath, ['server/server.mjs'], {
      cwd: ROOT,
      env: { ...process.env, PORT, HOST: '127.0.0.1' },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
  } else {
    console.log(`[smoke] 对既有服务冒烟：${BASE}`);
  }

  try {
    await waitHealthy(BASE);

    console.log('[smoke] 健康响应 GET /healthz');
    const h = await fetch(`${BASE}/healthz`);
    check('返回 200', h.status === 200, `status=${h.status}`);
    const hj = await h.json();
    check('status=ok', hj.status === 'ok', JSON.stringify(hj));

    console.log('[smoke] 页面 GET /');
    const idx = await fetch(`${BASE}/`);
    check('返回 200', idx.status === 200);
    const html = await idx.text();
    check('包含审计页标题', html.includes('根软件包版本兼容审计'));
    const assetMatch = html.match(/<script[^>]+src="([^"]+)"/);
    check('入口引用构建产物脚本', Boolean(assetMatch), html.slice(0, 200));
    if (assetMatch) {
      const asset = await fetch(`${BASE}${assetMatch[1]}`);
      check('构建产物脚本可访问 200', asset.status === 200, assetMatch[1]);
    }

    console.log('[smoke] 可解审计：CAM 1.0 要求 NAV >=2.0.0 <3.0.0');
    const r1 = await postAudit(CAM_NAV);
    check('HTTP 200', r1.status === 200);
    check('ok=true', r1.json?.ok === true);
    const nav = r1.json?.result?.assignment?.find((a) => a.component === 'NAV');
    check('精确选出 NAV 2.0.0', nav?.selectedVersion === '2.0.0', JSON.stringify(nav));
    check('NAV 1.0.0 不在可接受候选中', Array.isArray(nav?.acceptableVersions) && !nav.acceptableVersions.includes('1.0.0'));
    check('展示满足依据（CAM 两条比较均成立）',
      nav?.evidence?.[0]?.from === 'CAM' &&
      nav.evidence[0].range === '>=2.0.0 <3.0.0' &&
      nav.evidence[0].checks.length === 2 &&
      nav.evidence[0].checks.every((c) => c.holds));
    const cam = r1.json?.result?.assignment?.find((a) => a.component === 'CAM');
    check('每个可达组件恰好一个版本（CAM + NAV）',
      r1.json.result.assignment.length === 2 && cam?.selectedVersion === '1.0.0');

    console.log('[smoke] 重复提交结果一致（确定性）');
    const r1b = await postAudit(CAM_NAV);
    check('两次响应正文逐字节相同', JSON.stringify(r1b.json) === JSON.stringify(r1.json));

    console.log('[smoke] 互斥冲突：两根对 BUS 的 >=2.0.0 与 <2.0.0');
    const r2 = await postAudit(BUS);
    check('HTTP 200', r2.status === 200);
    check('result.status=conflict', r2.json?.result?.status === 'conflict');
    const busNode = r2.json?.result?.tree?.conflicts?.find((c) => c.component === 'BUS');
    check('存在 BUS 冲突节点', Boolean(busNode));
    check('冲突树覆盖 BUS 全部 3 个候选版本',
      JSON.stringify(busNode?.candidates?.map((c) => c.version).sort()) === JSON.stringify(['1.0.0', '2.0.0', '3.0.0']),
      JSON.stringify(busNode?.candidates?.map((c) => c.version)));
    check('每个候选均给出否决依据',
      busNode?.candidates?.every((c) => c.rejectedBy.length > 0));
    check('1.0.0 被 ROOT_A(>=2.0.0) 否决',
      busNode?.candidates.find((c) => c.version === '1.0.0')?.rejectedBy?.[0]?.from === 'ROOT_A');
    check('3.0.0 被 ROOT_B(<2.0.0) 否决',
      busNode?.candidates.find((c) => c.version === '3.0.0')?.rejectedBy?.[0]?.from === 'ROOT_B');
    check('冲突树稳定可重复',
      JSON.stringify((await postAudit(BUS)).json) === JSON.stringify(r2.json));

    console.log('[smoke] 输入错误定位：未知组件 / 非法范围 / 空候选');
    const bad = {
      roots: ['CAM', 'GHOST_ROOT'],
      components: [
        { id: 'CAM', versions: [], dependencies: { NAV: '^1.0.0', GHOST: '=1.0.0' } },
      ],
    };
    const r3 = await postAudit(bad);
    check('错误请求返回 400（旧结论由前端立即清除，服务端不产出结论）', r3.status === 400);
    check('ok=false 且不包含 result', r3.json?.ok === false && r3.json?.result === undefined);
    const codes = (r3.json?.errors || []).map((e) => e.code);
    check('定位 EMPTY_CANDIDATES', codes.includes('EMPTY_CANDIDATES'));
    check('定位 INVALID_RANGE（^1.0.0）', codes.includes('INVALID_RANGE'));
    check('定位未知依赖组件 GHOST', r3.json.errors.some((e) => e.code === 'UNKNOWN_COMPONENT' && e.target === 'GHOST'));
    check('定位未知根组件 GHOST_ROOT', r3.json.errors.some((e) => e.code === 'UNKNOWN_COMPONENT' && e.target === 'GHOST_ROOT'));
    check('错误携带 path 定位信息', r3.json.errors.every((e) => typeof e.path === 'string' && e.path.length > 0));
  } finally {
    if (child) {
      child.kill('SIGTERM');
      await new Promise((r) => child.on('exit', r));
    }
  }

  if (failures > 0) {
    console.error(`\n[smoke] 失败 ${failures} 项`);
    process.exitCode = 1;
  } else {
    console.log('\n[smoke] 全部冒烟检查通过');
  }
}

main().catch((e) => {
  console.error('[smoke] 异常终止：', e);
  process.exit(1);
});
