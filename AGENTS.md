# AGENTS.md

## 构建与测试

- 运行时测试：`npm test`（`node --test test/bridge.test.mjs`，零依赖）。
- 控制台构建：`cd web && npm install && npm run build`（先 `tsc --noEmit` 再用 Vite 打包为单文件）。产物覆盖 `src/ui.html`，该文件随仓库提交。
- 控制台开发：`cd web && npm run dev`；需要一个 `AUTH_MODE=none` 的服务端实例（`$env:HOST="127.0.0.1"; $env:PORT="3940"; $env:AUTH_MODE="none"; node src/server.mjs`）。开发服务器只绑定 127.0.0.1，不要用 `--host` 对外暴露（代理会剥离 Origin/Sec-Fetch-Site 校验头）。
- 管理 `/api/*`：`AUTH_MODE=bearer` 时要求 `X-Astra-Admin` 头（未设 `ASTRA_ADMIN_KEY` 则回退为客户端 Token）；`AUTH_MODE=none` 跳过校验，开发环境无需密钥。

## 约定

- 根 `package.json` 与运行时保持零依赖；前端依赖全部放在 `web/` 内，版本锁定为精确版本号。
- `src/ui.html` 是唯一对外的控制台页面，由 `web/` 构建生成；不要在 `src/` 下生成其他静态资源。
