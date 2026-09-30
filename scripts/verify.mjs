// 一次性验收：执行后退出，以进程退出码报告结果。
//   步骤 1：实际运行求解规则代码测试（node --test）
//   步骤 2：构建审计页面（vite build）
//   步骤 3：对可解审计页面与健康响应做 API/HTTP 冒烟
// 设置 AUDIT_BASE_URL 时（compose verify 服务）对容器内 web 服务冒烟；
// 否则冒烟脚本会本机临时拉起服务，无需 Docker。

import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const steps = [
  {
    name: '求解规则代码测试 (node --test)',
    cmd: process.execPath,
    args: ['--test', 'test/'],
  },
  {
    name: '构建审计页面 (vite build)',
    cmd: process.execPath,
    args: [path.join('node_modules', 'vite', 'bin', 'vite.js'), 'build'],
    optional: false,
  },
  {
    name: 'API/HTTP 冒烟（可解审计页面 + 健康响应）',
    cmd: process.execPath,
    args: ['scripts/smoke.mjs'],
  },
];

function run(step) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(step.cmd, step.args, {
      cwd: ROOT,
      env: process.env,
      stdio: 'inherit',
    });
    child.on('error', (e) => resolve({ ok: false, code: -1, ms: Date.now() - started, detail: e.message }));
    child.on('exit', (code, signal) => {
      resolve({ ok: code === 0, code: code ?? signal, ms: Date.now() - started });
    });
  });
}

async function main() {
  console.log('══════════════════════════════════════════════════');
  console.log(' 星载载荷版本兼容审计 · 一次性验收 verify');
  console.log(` AUDIT_BASE_URL=${process.env.AUDIT_BASE_URL || '(未设置，冒烟将本机自启服务)'}`);
  console.log('══════════════════════════════════════════════════');

  const results = [];
  for (const step of steps) {
    console.log(`\n▶ 步骤 ${results.length + 1}/${steps.length}：${step.name}`);
    const r = await run(step);
    results.push({ ...step, ...r });
    console.log(r.ok ? `  ↳ 通过（${r.ms}ms）` : `  ↳ 失败（exit=${r.code}，${r.ms}ms）`);
    if (!r.ok) break; // 任一阶段失败即终止并以非零码退出
  }

  const failed = results.filter((r) => !r.ok);
  console.log('\n──────────────────────────────────────────────────');
  for (const r of results) {
    console.log(`${r.ok ? '✔' : '✗'} ${r.name}${r.ok ? '' : `  [exit=${r.code}]`}`);
  }
  console.log('──────────────────────────────────────────────────');
  if (failed.length === 0 && results.length === steps.length) {
    console.log('VERIFY 结果：PASS（规则测试、页面构建、API/HTTP 冒烟全部通过）');
    process.exit(0);
  }
  console.error(`VERIFY 结果：FAIL（${failed.length}/${steps.length} 个阶段未通过或未执行）`);
  process.exit(1);
}

main();
