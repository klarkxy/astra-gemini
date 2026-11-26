# AGENTS.md

## 构建与测试

- Docker：`docker compose build` 构建 `astra-gemini:local`（`node:26-bookworm-slim` + git）；`docker compose up -d` 启动（宿主端口由 `.env` 的 `ASTRA_HOST_PORT` 控制，默认 3939，数据卷 `/data`）。冒烟：`docker exec astra-gemini node /app/docker/verify.mjs http://127.0.0.1:3939/mcp <Token> demo`。

- 运行时测试：`npm test`（`node --test test/bridge.test.mjs`，零依赖）。
- 控制台构建：`cd web && npm install && npm run build`（先 `tsc --noEmit` 再用 Vite 打包为单文件）。产物覆盖 `src/ui.html`，该文件随仓库提交。
- 控制台开发：`cd web && npm run dev`；需要一个 `AUTH_MODE=none` 的服务端实例（`$env:HOST="127.0.0.1"; $env:PORT="3940"; $env:AUTH_MODE="none"; node src/server.mjs`）。开发服务器只绑定 127.0.0.1，不要用 `--host` 对外暴露（代理会剥离 Origin/Sec-Fetch-Site 校验头）。
- 管理 `/api/*`：`AUTH_MODE=bearer` 时要求 `X-Astra-Admin` 头（未设 `ASTRA_ADMIN_KEY` 则回退为客户端 Token）；`AUTH_MODE=none` 跳过校验，开发环境无需密钥。
- Linux VPS：用覆盖文件启动 `docker compose -f docker-compose.yml -f docker-compose.host.yml up -d`（host 网络，绑定 127.0.0.1，端口 `ASTRA_HOST_PORT`）；控制台经 SSH 隧道访问 `ssh -L 3939:127.0.0.1:3939 <host>` → http://127.0.0.1:3939/ui，管理密钥在 `/data/admin-key.txt`。
- 公网控制台：`ASTRA_PUBLIC_CONSOLE=1` 且已配置公网地址（`ASTRA_PUBLIC_URL`）时，`/ui` 与 `/api/*` 对公网 Host 请求放开（`/remote/*` 仍仅本机）。
- `/mcp` 接受 Bearer 客户端 Token（代码工具直连）；`/mcp/<mcpPathToken>` 是 Gemini 专用 Capability URL（无 OAuth/Authorization，错误密钥或 `mcpPathEnabled=false` 一律 404）。密钥文件为 `mcp-path.txt`，Docker entrypoint、install.ps1 与 tray.ps1 首启生成。`/mcp` 与密钥路径对浏览器 `Origin` 启用白名单（Gemini Web origin、`publicUrl` origin、`ASTRA_MCP_ALLOWED_ORIGINS`），非白名单 403；不支持的 `MCP-Protocol-Version` 一律 400。
- 一键部署：`node deploy/vps.mjs --host <ssh> [--dry-run]` 本机构建 → 传输 → 远端 compose（沿用 VPS 现有文件）→ 健康检查 → 冒烟。共享状态存 `deploy/local.json`（gitignore，勿提交）。
- 控制台修改的设置优先于环境变量：`ASTRA_PUBLIC_URL`/`ASTRA_PUBLIC_CONSOLE` 仅回退，`ASTRA_NODE_ID`/`ASTRA_UPSTREAM_*` 仅 Docker 首启播种；密钥可在控制台轮换（仅当来自密钥文件时）。

## 约定

- 根 `package.json` 与运行时保持零依赖；前端依赖全部放在 `web/` 内，版本锁定为精确版本号。
- `src/ui.html` 是唯一对外的控制台页面，由 `web/` 构建生成；不要在 `src/` 下生成其他静态资源。
