import { createApp } from './app.mjs';

const port = Number(process.env.PORT ?? process.env.AUDIT_PORT ?? 8080);
const host = process.env.HOST ?? '0.0.0.0';

const server = createApp();
server.listen(port, host, () => {
  console.log(`[payload-dependency-audit] listening on http://${host}:${port}`);
});

function shutdown(signal) {
  console.log(`[payload-dependency-audit] received ${signal}, shutting down`);
  server.close(() => process.exit(0));
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
