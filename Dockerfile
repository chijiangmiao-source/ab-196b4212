FROM node:20-alpine

WORKDIR /app

# 零运行时依赖：仅复制源码与静态资源（无需 npm install 即可启动）
COPY package.json ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts
COPY test ./test
COPY verify.mjs ./verify.mjs

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8080
EXPOSE 8080

# 启动前构建页面产物（语法校验 + 打包），随后启动服务
CMD ["sh", "-c", "node scripts/build.mjs && node src/server/index.mjs"]
