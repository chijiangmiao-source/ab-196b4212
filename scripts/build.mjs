// 一次性页面构建：
//   1. 对全部服务端 / 求解器 / Web 源文件执行 node --check 语法校验；
//   2. 将零依赖的前端入口 web/app.mjs 打包为 public/app.bundle.js（附构建信息头）。
// 任一步失败即以非零码退出。
import { spawnSync } from 'node:child_process';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function listJs(dir) {
  const base = path.join(root, dir);
  const out = [];
  async function walk(d) {
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const full = path.join(d, ent.name);
      if (ent.isDirectory()) await walk(full);
      else if (ent.name.endsWith('.mjs')) out.push(full);
    }
  }
  await walk(base);
  return out.sort();
}

const files = [...(await listJs('src')), ...(await listJs('web')), ...(await listJs('scripts'))];
let failed = 0;
for (const file of files) {
  const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf-8' });
  if (r.status !== 0) {
    console.error(`语法校验失败: ${path.relative(root, file)}`);
    console.error(r.stderr || r.stdout);
    failed += 1;
  }
}
if (failed) process.exit(1);
console.log(`语法校验通过（${files.length} 个文件）`);

const entry = await readFile(path.join(root, 'web/app.mjs'), 'utf-8');
const banner = `// 由 scripts/build.mjs 生成于 ${new Date().toISOString()}，源文件 web/app.mjs\n`;
await mkdir(path.join(root, 'public'), { recursive: true });
await writeFile(path.join(root, 'public/app.bundle.js'), banner + entry, 'utf-8');
console.log('页面打包完成: public/app.bundle.js');
