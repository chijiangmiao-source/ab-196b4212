# 星载载荷 · 根软件包版本兼容审计

在星载载荷升级前，审计一组根软件包能否共同选定兼容的语义化版本，避免间接驱动依赖在
**装载后**才暴露互斥要求。

- 录入至多 **16** 个组件，每组件至多 **6** 个语义化版本（`MAJOR.MINOR.PATCH`）
- 依赖范围仅支持 `=`、`>=`、`<` 组成的**合取**（如 `>=2.0.0 <3.0.0`）
- 系统为从根组件出发的**每个可达组件精确选定一个版本**，使全部依赖同时成立
- 多解时：按组件标识 **ASCII 升序**依次处理，每个组件在满足全部入边范围的候选中取
  **最高版本**；规则纯函数化，重复提交结果逐字节一致
- 无法选版时展示可展开的**稳定冲突树**，覆盖该组件全部候选版本并逐条标注否决依据
- 未知组件、非法范围、空候选等错误一次性聚合，并给出 `path` 定位；前端在任何新提交时
  **立即清除旧结论**

## 目录

```
lib/        求解规则核心（零依赖 ESM）：版本、范围、审计/冲突树
server/     Node 内置 http 服务：静态页面 + /api/audit + /healthz
web/        Vite 前端源码（原生 ESM）
test/       node:test 求解规则测试（20 例）
scripts/    verify.mjs（一次性验收编排）、smoke.mjs（API/HTTP 冒烟）
compose.yaml  web 常驻服务 + verify 一次性验收服务
```

## 本机运行（无需 Docker）

```bash
npm ci --include=dev      # 或 npm install
npm test                  # 仅运行求解规则测试
npm run build             # 构建页面到 dist/
HOST_PORT=8080 npm start  # 启动页面服务（PORT 环境变量指定监听端口）
# 浏览器访问 http://localhost:8080 ；健康检查 http://localhost:8080/healthz
```

## Compose 运行

宿主端口可通过 `HOST_PORT` 配置（默认 8080）：

```bash
HOST_PORT=9090 docker compose up -d --build web
curl -s http://localhost:9090/healthz
```

### verify：一次性验收服务

`verify` 是执行后退出的一次性服务，按顺序：实际运行求解规则代码测试 → 构建页面 →
对可解审计页面与健康响应进行 API/HTTP 冒烟，最后**以退出码报告结果**（0 = PASS）。

```bash
docker compose run --build --rm verify; echo "exit=$?"
```

本机等价方式（冒烟时自动临时拉起服务，结束即关闭）：

```bash
npm run verify; echo "exit=$?"
```

## HTTP 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/healthz` | 健康响应 `{status:"ok",...}` |
| GET | `/` | 审计页面 |
| POST | `/api/audit` | 提交审计模型，返回选版依据或冲突树 |
| GET | `/api/sample` | 内置示例（CAM→NAV、BUS 双根互斥） |

请求体示例：

```json
{
  "roots": ["CAM"],
  "components": [
    { "id": "CAM", "versions": ["1.0.0"], "dependencies": { "NAV": ">=2.0.0 <3.0.0" } },
    { "id": "NAV", "versions": ["1.0.0", "2.0.0"], "dependencies": {} }
  ]
}
```

该输入将精确选出 **NAV 2.0.0**，响应中 `evidence` 给出 `2.0.0 等于 2.0.0`（满足
`>=2.0.0`）与 `2.0.0 低于 3.0.0`（满足 `<3.0.0`）两条依据。

错误响应形如 `{"ok":false,"errors":[{"code":"INVALID_RANGE","message":"...","path":"components[0].dependencies['NAV']"}]}`，
错误代码包括 `UNKNOWN_COMPONENT`、`INVALID_RANGE`、`EMPTY_CANDIDATES`、
`INVALID_VERSION`、`TOO_MANY_COMPONENTS`、`TOO_MANY_VERSIONS` 等。
