// 一次性验收服务 verify：
//   1. 实际运行求解规则代码测试（node --test）；
//   2. 构建页面（node scripts/build.mjs）；
//   3. 启动真实 HTTP 服务（src/server/index.mjs，与 Compose 同一入口）；
//   4. 对健康响应与可解/冲突/非法审计进行 API/HTTP 冒烟；
//   5. 以退出码报告结果：0 全部通过，非零存在失败。执行后立即退出，不常驻。
//
// 用法：node verify.mjs [--port 端口]   默认端口 0（由操作系统分配空闲端口），
//       亦可通过环境变量 PORT / AUDIT_PORT 指定（与部署时的可配置宿主端口一致）。
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const argvPort = (() => {
  const i = process.argv.indexOf('--port');
  return i >= 0 ? Number(process.argv[i + 1]) : NaN;
})();
const PORT = Number.isFinite(argvPort) ? argvPort : Number(process.env.PORT ?? process.env.AUDIT_PORT ?? 0);
const HOST = '127.0.0.1';

const results = [];
function check(name, cond, detail = '') {
  results.push({ name, ok: Boolean(cond), detail });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

async function runStep(label, args) {
  console.log(`\n=== ${label} ===`);
  const child = spawn(process.execPath, args, { cwd: root, stdio: 'inherit' });
  const [code] = await once(child, 'exit');
  check(label, code === 0, `退出码 ${code}`);
  return code === 0;
}

function waitForFreePort(wanted) {
  return new Promise((resolve, reject) => {
    if (wanted > 0) return resolve(wanted);
    const srv = net.createServer();
    srv.listen(0, HOST, () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
    srv.on('error', reject);
  });
}

async function waitHealthy(baseUrl, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/healthz`);
      if (res.ok) return true;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw lastErr ?? new Error('health check timeout');
}

async function main() {
  // 1 & 2：规则测试 + 页面构建
  const testsOk = await runStep('求解规则代码测试 (node --test)', ['--test', 'test/']);
  const buildOk = await runStep('构建页面 (scripts/build.mjs)', ['scripts/build.mjs']);
  if (!testsOk || !buildOk) {
    finish(1);
    return;
  }

  // 3：启动真实服务
  const port = await waitForFreePort(PORT);
  const baseUrl = `http://${HOST}:${port}`;
  console.log(`\n=== 启动审计服务 ${baseUrl} ===`);
  const server = spawn(process.execPath, ['src/server/index.mjs'], {
    cwd: root,
    env: { ...process.env, PORT: String(port), HOST },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  server.stdout.on('data', (d) => (serverLog += d));
  server.stderr.on('data', (d) => (serverLog += d));

  let smokeFailed = false;
  try {
    await waitHealthy(baseUrl);

    // 4a：健康响应
    console.log('\n=== HTTP/API 冒烟 ===');
    {
      const res = await fetch(`${baseUrl}/healthz`);
      const body = await res.json();
      check('GET /healthz 返回 200', res.status === 200, `status=${res.status}`);
      check('健康响应体 status=ok', body.status === 'ok', JSON.stringify(body).slice(0, 120));
    }

    // 4b：页面与构建产物可访问
    {
      const res = await fetch(`${baseUrl}/`);
      const html = await res.text();
      check('GET / 审计页面返回 200', res.status === 200);
      check('页面包含审计标题与挂载脚本', html.includes('依赖兼容版本审计') && html.includes('/app.bundle.js'));
      const js = await fetch(`${baseUrl}/app.bundle.js`);
      check('GET /app.bundle.js 构建产物返回 200', js.status === 200);
      const css = await fetch(`${baseUrl}/styles.css`);
      check('GET /styles.css 返回 200', css.status === 200);
    }

    // 4c：题设可解用例 CAM 1.0 -> NAV >=2.0.0 <3.0.0
    {
      const payload = {
        components: [
          { id: 'CAM', versions: [{ version: '1.0.0', dependencies: { NAV: '>=2.0.0 <3.0.0' } }] },
          { id: 'NAV', versions: [{ version: '1.0.0' }, { version: '2.0.0' }] },
        ],
        roots: [{ id: 'CAM' }],
      };
      const res = await fetch(`${baseUrl}/api/audit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = await res.json();
      check('可解审计返回 200 且 status=sat', res.status === 200 && body.status === 'sat', `status=${res.status}`);
      check('精确选定 NAV=2.0.0（而非 1.0.0）', body?.selection?.NAV === '2.0.0', JSON.stringify(body?.selection));
      const ev = body?.evidence?.NAV;
      check(
        '返回满足依据：>=2.0.0 与 <3.0.0 均满足',
        ev && ev.constraints.every((c) => c.satisfied) && ev.constraints.length === 2,
        JSON.stringify(ev?.constraints),
      );
    }

    // 4d：题设冲突用例 双根 -> BUS，冲突树覆盖全部候选
    {
      const payload = {
        components: [
          { id: 'BUS', versions: ['1.0.0', '1.5.0', '2.0.0', '2.1.0'].map((x) => ({ version: x })) },
          { id: 'CTRL', versions: [{ version: '1.0.0', dependencies: { BUS: '>=2.0.0' } }] },
          { id: 'PWR', versions: [{ version: '1.0.0', dependencies: { BUS: '<2.0.0' } }] },
        ],
        roots: [{ id: 'CTRL' }, { id: 'PWR' }],
      };
      const res = await fetch(`${baseUrl}/api/audit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = await res.json();
      check('冲突审计返回 status=unsat', body.status === 'unsat');
      // 证明树自首个根沿依赖传播方向展开，最深死节点即 BUS。
      let dead = body?.tree?.node;
      let guard = 0;
      while (dead && dead.component !== body?.tree?.deadComponent && guard < 20) {
        dead = dead.expanded?.child;
        guard += 1;
      }
      check('冲突树死锁组件为 BUS 且覆盖全部 4 个候选',
        body?.tree?.deadComponent === 'BUS' && dead?.component === 'BUS' &&
          dead?.candidateCount === 4 && dead?.viableCount === 0,
        `dead=${body?.tree?.deadComponent}, count=${dead?.candidateCount}`);
      const rejectedByBothRoots = dead?.candidates?.every((c) => c.rejected && c.violated.length > 0);
      check('BUS 每个候选版本都被至少一条约束直接否决', rejectedByBothRoots === true);
    }

    // 4e：错误输入立即定位、无旧结论
    {
      const payload = {
        components: [
          { id: 'A', versions: [{ version: '1.0.0', dependencies: { B: '^1.0.0' } }] },
          { id: 'B', versions: [] },
        ],
        roots: [{ id: 'GHOST' }],
      };
      const res = await fetch(`${baseUrl}/api/audit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = await res.json();
      check('非法输入返回 422 invalid', res.status === 422 && body.status === 'invalid');
      const codes = new Set((body.errors ?? []).map((e) => e.code));
      check('定位未知根 UNKNOWN_ROOT', codes.has('UNKNOWN_ROOT'));
      check('定位非法范围 BAD_RANGE 且带字符偏移',
        body.errors?.some((e) => e.code === 'BAD_RANGE' && typeof e.offset === 'number'));
      check('定位空候选 EMPTY_CANDIDATES', codes.has('EMPTY_CANDIDATES'));
      check('非法响应不含任何旧结论字段', body.selection === undefined && body.tree === undefined && body.evidence === undefined);
    }

    // 4f：坏 JSON
    {
      const res = await fetch(`${baseUrl}/api/audit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{ not json',
      });
      check('非 JSON 请求体返回 400 BAD_JSON', res.status === 400);
    }
    smokeFailed = results.some((r) => !r.ok);
  } catch (err) {
    console.error('冒烟过程异常:', err);
    smokeFailed = true;
  } finally {
    server.kill('SIGTERM');
    await once(server, 'exit').catch(() => {});
    if (process.env.VERIFY_DEBUG) console.log(serverLog);
  }

  finish(smokeFailed ? 1 : 0);
}

function finish(code) {
  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  console.log(`\n=== 验收汇总：${passed} 通过 / ${failed} 失败 ===`);
  if (code === 0) console.log('ACCEPTED: verify 全部通过');
  else console.log('REJECTED: verify 存在失败项');
  process.exit(code);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
