import { defineConfig } from 'vite';

// 页面源码在 web/，构建产物输出到 dist/ 供 Node 静态服务托管。
export default defineConfig({
  root: 'web',
  build: {
    outDir: '../dist',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:8080',
      '/healthz': 'http://localhost:8080',
    },
  },
});
