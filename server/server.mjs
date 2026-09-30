// 审计 Web 服务：静态页面 + /api/audit + /healthz，仅使用 Node 内置模块。

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { audit, ValidationError } from '../lib/audit.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_DIR = path.resolve(__dirname, '..', 'dist');
const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const MAX_BODY = 1024 * 256;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('请求体超过 256KB 上限'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function serveStatic(req, res) {
  const url = new URL(req.url, 'http://localhost');
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  // 防路径穿越
  const filePath = path.normalize(path.join(DIST_DIR, rel));
  if (!filePath.startsWith(DIST_DIR + path.sep) && filePath !== DIST_DIR) {
    res.writeHead(403);
    res.end('forbidden');
    return;
  }
  try {
    await readFile(filePath);
  } catch {
    // 非 API 路径统一回退入口页（前端为单页）
    if (!url.pathname.startsWith('/api/')) {
      res.writeHead(200, { 'content-type': MIME['.html'] });
      createReadStream(path.join(DIST_DIR, 'index.html')).pipe(res);
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
    return;
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(filePath)] || 'application/octet-stream' });
  createReadStream(filePath).pipe(res);
}

export function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');

    if (req.method === 'GET' && url.pathname === '/healthz') {
      sendJson(res, 200, { status: 'ok', uptime: Math.round(process.uptime()), time: new Date().toISOString() });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/audit') {
      let input;
      try {
        const raw = await readBody(req);
        try {
          input = JSON.parse(raw);
        } catch {
          sendJson(res, 400, { ok: false, errors: [{ code: 'MALFORMED_JSON', message: '请求体不是合法 JSON' }] });
          return;
        }
        const result = audit(input);
        sendJson(res, 200, { ok: true, result });
      } catch (e) {
        if (e instanceof ValidationError) {
          sendJson(res, 400, { ok: false, errors: e.errors });
          return;
        }
        if (e?.status === 413) {
          sendJson(res, 413, { ok: false, errors: [{ code: 'PAYLOAD_TOO_LARGE', message: e.message }] });
          return;
        }
        sendJson(res, 500, { ok: false, errors: [{ code: 'INTERNAL', message: String(e?.message || e) }] });
      }
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/sample') {
      sendJson(res, 200, { ok: true, samples: SAMPLES });
      return;
    }

    if (req.method === 'GET') {
      await serveStatic(req, res);
      return;
    }

    res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('method not allowed');
  });
}

const SAMPLES = {
  camNav: {
    roots: ['CAM'],
    components: [
      { id: 'CAM', versions: ['1.0.0'], dependencies: { NAV: '>=2.0.0 <3.0.0' } },
      { id: 'NAV', versions: ['1.0.0', '2.0.0'], dependencies: {} },
    ],
  },
  busConflict: {
    roots: ['ROOT_A', 'ROOT_B'],
    components: [
      { id: 'ROOT_A', versions: ['1.0.0'], dependencies: { BUS: '>=2.0.0' } },
      { id: 'ROOT_B', versions: ['1.0.0'], dependencies: { BUS: '<2.0.0' } },
      { id: 'BUS', versions: ['1.0.0', '2.0.0', '3.0.0'], dependencies: {} },
    ],
  },
};

// 直接运行时启动；被 verify 以模块方式导入时不自动监听。
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  createServer().listen(PORT, HOST, () => {
    console.log(`[audit-web] http://${HOST}:${PORT}  (dist: ${DIST_DIR})`);
  });
}
