# 星载载荷版本兼容审计：页面构建期需要 devDependencies（vite），运行期仅用 Node 内置模块。
FROM node:20-bookworm-slim

WORKDIR /app

# 先装依赖以利用构建缓存（显式包含 devDependencies：构建页面需要 vite）
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund --include=dev

# 拷贝源码并在镜像构建阶段产出 dist/
COPY lib ./lib
COPY server ./server
COPY web ./web
COPY scripts ./scripts
COPY test ./test
COPY vite.config.js ./
RUN npm run build

ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0

EXPOSE 8080
CMD ["node", "server/server.mjs"]
