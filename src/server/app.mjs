import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { validateModel } from '../solver/model.mjs';
import { solve } from '../solver/solver.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, '../../public');

export function runSolver(input) {
  const { errors, model } = validateModel(input);
  if (errors.length > 0) {
    // 定位错误时不带任何结论：调用方负责“立即清除旧结论”。
    return { ok: false, status: 'invalid', errors };
  }
  try {
    const result = solve(model);
    return { ok: true, ...result };
  } catch (err) {
    return {
      ok: false,
      status: 'error',
      errors: [{ code: 'SOLVER_ERROR', message: `求解失败: ${err.message}` }],
    };
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function readBody(req, limit = 1_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('BODY_TOO_LARGE');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

export function createApp() {
  return createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const route = `${req.method} ${url.pathname}`;

    if (route === 'GET /healthz' || route === 'GET /health') {
      sendJson(res, 200, { status: 'ok', service: 'payload-dependency-audit', time: new Date().toISOString() });
      return;
    }

    if (route === 'POST /api/audit') {
      let raw;
      try {
        raw = await readBody(req);
      } catch {
        sendJson(res, 413, { ok: false, status: 'invalid', errors: [{ code: 'BODY_TOO_LARGE', message: '请求体过大' }] });
        return;
      }
      let input;
      try {
        input = JSON.parse(raw);
      } catch {
        sendJson(res, 400, {
          ok: false,
          status: 'invalid',
          errors: [{ code: 'BAD_JSON', message: '请求体不是合法 JSON' }],
        });
        return;
      }
      const result = runSolver(input);
      sendJson(res, result.ok ? 200 : 422, result);
      return;
    }

    if (route === 'GET /api/sample') {
      sendJson(res, 200, { sample: SAMPLE_INPUT });
      return;
    }

    // 静态资源
    let rel = url.pathname === '/' ? '/index.html' : url.pathname;
    const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
    if (!filePath.startsWith(PUBLIC_DIR)) {
      sendJson(res, 403, { error: 'forbidden' });
      return;
    }
    try {
      const data = await readFile(filePath);
      res.writeHead(200, { 'content-type': MIME[path.extname(filePath)] ?? 'application/octet-stream' });
      res.end(data);
    } catch {
      sendJson(res, 404, { error: 'not found' });
    }
  });
}

export const SAMPLE_INPUT = {
  components: [
    {
      id: 'CAM',
      versions: [{ version: '1.0.0', dependencies: { NAV: '>=2.0.0 <3.0.0' } }],
    },
    { id: 'NAV', versions: [{ version: '1.0.0' }, { version: '2.0.0' }] },
  ],
  roots: [{ id: 'CAM' }],
};

export const CONFLICT_SAMPLE = {
  components: [
    { id: 'BUS', versions: ['1.0.0', '1.5.0', '2.0.0', '2.1.0'].map((v) => ({ version: v })) },
    { id: 'CTRL', versions: [{ version: '1.0.0', dependencies: { BUS: '>=2.0.0' } }] },
    { id: 'PWR', versions: [{ version: '1.0.0', dependencies: { BUS: '<2.0.0' } }] },
  ],
  roots: [{ id: 'CTRL' }, { id: 'PWR' }],
};
