# 星载载荷依赖兼容版本审计

为一组**根软件包**及其依赖图精确选定兼容的语义化版本：为每个可达组件选定恰好一个版本，
使全部根约束与依赖范围同时成立；无解时给出覆盖全部候选版本的稳定冲突树。

## 规则

- 组件上限 16 个，每组件至多 6 个版本；
- 依赖范围仅支持由 `=`、`>=`、`<` 组成的**合取**条件，如 `>=2.0.0 <3.0.0`、`=1.2.3`；
- 版本号遵循 Semantic Versioning 2.0.0（含先行版本优先级，如 `1.0.0-rc.1 < 1.0.0`）；
- 仅从**根组件可达**的组件参与选定，每个可达组件精确选定一个版本；
- 选定规则确定性：组件按标识 **ASCII 顺序**依次赋值，候选版本**从高到低**尝试，
  取首个完整可行解；重复提交结果一致；
- 非法输入（未知组件、非法范围、空候选、根未登记等）按组件/版本/依赖与字符偏移定位，
  且响应不含任何旧结论（页面同步立即清除旧结论）。

## 本地运行（零运行时依赖，需 Node.js >= 20）

```bash
node scripts/build.mjs          # 语法校验 + 打包页面到 public/app.bundle.js
PORT=8080 node src/server/index.mjs
# 打开 http://localhost:8080/ ；健康检查 http://localhost:8080/healthz
```

端口与监听地址由环境变量配置：`PORT`（或 `AUDIT_PORT`，默认 8080）、`HOST`（默认 0.0.0.0）。

## 用 Docker Compose 运行（可配置宿主端口）

```bash
AUDIT_HOST_PORT=9090 docker compose up --build
# 打开 http://localhost:9090/ ；不设置 AUDIT_HOST_PORT 时默认映射宿主 8080
```

容器内固定监听 8080，宿主端口由 `AUDIT_HOST_PORT`（compose 变量）决定，Compose 内含健康检查。

## 一次性验收 verify

`verify` 是**执行后退出**的一次性验收服务：运行求解规则测试 → 构建页面 → 启动真实 HTTP
服务（与 Compose 相同入口）→ 对健康响应与可解/冲突/非法审计执行 API/HTTP 冒烟 →
以退出码报告结果（0 通过，非零失败），随后立即退出，不常驻。

```bash
node verify.mjs                 # 默认使用操作系统分配的空闲端口
node verify.mjs --port 8090     # 或 PORT=8090 node verify.mjs
```

## HTTP API

| 方法 & 路径 | 说明 |
| --- | --- |
| `GET /healthz`（或 `/health`） | 健康响应 `{ "status": "ok", ... }` |
| `GET /` | 审计页面 |
| `POST /api/audit` | 提交审计，返回 `sat` / `unsat` / `invalid` |
| `GET /api/sample` | 题设 CAM→NAV 示例 |

请求体：

```json
{
  "components": [
    { "id": "CAM", "versions": [
      { "version": "1.0.0", "dependencies": { "NAV": ">=2.0.0 <3.0.0" } }
    ]},
    { "id": "NAV", "versions": [ { "version": "1.0.0" }, { "version": "2.0.0" } ] }
  ],
  "roots": [ { "id": "CAM", "dependencies": {} } ]
}
```

- `sat`：`selection`（每组件一个版本）+ `evidence`（逐条入约束与本版本依赖的满足依据）；
- `unsat`：`tree` 为可展开的稳定冲突证明树，沿依赖传播方向展开，最深死节点列出该组件
  全部候选版本各自被哪条来源约束否决（例如 BUS 同时被 `>=2.0.0` 与 `<2.0.0` 夹击）；
- `invalid`：`errors` 数组，每项带定位信息（`component`、`versionIndex`、`dependency`、
  `rootIndex`、范围字符串内的 `offset`/`length` 等），且不携带任何结论字段。

根组件自身必须在 `components` 中登记至少一个版本；根级 `dependencies` 为可选的、
无论选中根组件哪个版本都持续生效的附加范围。

## 目录结构

```
src/solver/      semver、范围解析、模型校验、确定性求解器与冲突树
src/server/      零依赖 Node HTTP 服务（API + 静态页面 + 健康响应）
web/ public/     前端源码与静态资源（构建产物 public/app.bundle.js）
scripts/build.mjs 页面构建（语法校验 + 打包）
test/            node --test 求解规则测试
verify.mjs       一次性验收服务
Dockerfile docker-compose.yml  容器化部署
```
