---
name: astra-deploy
description: 部署 astra-gemini：把本机代码构建成镜像推送到 VPS 并重启容器，然后做端到端冒烟。用于"部署 / 重新部署 / 更新 VPS / 发布 astra-gemini"等请求。Gemini 接入使用内置 /mcp/<mcpPathToken> 免 OAuth 密钥路径，不需要 Cloudflare 网关。
---

# astra-deploy

`deploy/vps.mjs` 是零依赖部署脚本，SSH 状态保存在 `deploy/local.json`（已 gitignore，勿提交）。

## 命令

| 场景 | 命令 |
|---|---|
| 服务端代码或控制台改动后更新 VPS | `node deploy/vps.mjs` |
| 先查看预检与计划，不做变更 | `node deploy/vps.mjs --dry-run` |

## 流程

1. 先跑 `--dry-run` 看预检与计划；它不做任何变更。
2. 若 `web/` 有改动：`cd web && npm run build`（vps.mjs 会检测 `src/ui.html` 是否过期并拒绝部署）。
3. 部署前跑 `npm test`。
4. 执行正式命令，确认结尾出现 `部署完成`（含 `VERIFY PASS`）。
5. 向用户报告结果，并提醒 Gemini 使用控制台「接入客户端」里的 `https://<域名>/mcp/<64位路径密钥>` Capability URL。

## deploy/vps.mjs

参数：`--host <ssh别名>`（首次必填，之后缓存）、`--dir`（默认 `/opt/astra-gemini`）、`--dry-run`、`--skip-web-check`、`--no-smoke`、`--verify-project`（默认 demo）。

行为：本机 `docker build` → 镜像 Id 相同则跳过传输，否则 `save | gzip | ssh docker load` → 用容器 label 上记录的 compose 文件 `up -d --no-build` → 等 healthy → 容器内 `verify.mjs` 冒烟。

- 绝不覆盖 VPS 上的 compose 文件和 `.env`（VPS 版本是手工调整过的）。需要改 VPS 环境变量时，先向用户说明要改什么，确认后再通过 ssh 修改。
- `deploy/local.json` 没有 host 时问用户 SSH 别名，不要猜。

## Gemini 接入

- Gemini 不需要 OAuth、Cloudflare Worker 或 Advanced 配置。
- 部署完成后，在控制台「接入客户端」复制 `https://<域名>/mcp/<64位路径密钥>`，填入 Gemini `Settings → Connected Apps → Add custom app`。
- 反向代理必须转发 `POST /mcp/*`，并避免把完整密钥路径写入访问日志；仓库示例见 `deploy/Caddyfile`。

## 安全约束

- 永远不要在输出、聊天或命令行参数中显示 token、管理密钥或完整 Gemini Capability URL；需要时只告诉用户文件位置或控制台位置。
- 不要 `docker image prune` 或删除 VPS 上的其他容器/卷（这台 VPS 上还跑着别的服务）。

## 排障

- VPS 冒烟失败：`ssh <host> docker logs --tail 100 astra-gemini`。
- 镜像部署后健康检查失败：先确认 `.env` 的端口、`ASTRA_PUBLIC_URL` 与容器日志，不要直接覆盖 VPS compose 配置。
- Gemini 不显示 Connected Apps 或工具不加载：确认英文界面、美国出口、Gemini Apps Activity 已开启，以及 publicUrl 是公网 HTTPS 地址。
