---
name: astra-deploy
description: 部署 astra-gemini：把本机代码构建成镜像推送到 VPS 并重启容器，部署/更新 Cloudflare Gemini 网关（KV、secrets、Worker），并做端到端冒烟。用于"部署 / 重新部署 / 更新 VPS / 部署网关 / 轮换 Token 后同步网关 / Gemini 接入"等请求。
---

# astra-deploy

两个零依赖脚本完成全部部署，状态保存在 `deploy/local.json`（已 gitignore，含网关口令，权限受限）。

## 何时用哪个

| 场景 | 命令 |
|---|---|
| 服务端代码或控制台改动后更新 VPS | `node deploy/vps.mjs` |
| 首次部署或更新 Gemini 网关 | `node deploy/gateway.mjs` |
| 控制台里轮换了客户端 Token 后 | `node deploy/gateway.mjs --secrets-only` |
| 网关口令泄露/想换 | `node deploy/gateway.mjs --secrets-only --rotate-password` |

改了 VPS 又要动网关时，先 VPS 后网关（网关的 `UPSTREAM_TOKEN` 从运行中的容器读取，冒烟也依赖上游）。

## 流程

1. 先跑 `--dry-run` 看预检与计划；它不做任何变更。
2. 若 `web/` 有改动：`cd web && npm run build`（vps.mjs 会检测 `src/ui.html` 是否过期并拒绝部署）。
3. 部署前跑 `npm test`。
4. 执行正式命令，确认结尾出现 `部署完成`（含 `VERIFY PASS`）或 `GATEWAY PASS`。
5. 向用户报告结果；网关首次部署后告诉用户 Gemini 地址（脚本最后一行）以及口令位置：`deploy/local.json` 的 `gateway.accessPassword`。

## deploy/vps.mjs

参数：`--host <ssh别名>`（首次必填，之后缓存）、`--dir`（默认 `/opt/astra-gemini`）、`--dry-run`、`--skip-web-check`、`--no-smoke`、`--verify-project`（默认 demo）。

行为：本机 `docker build` → 镜像 Id 相同则跳过传输，否则 `save | gzip | ssh docker load` → 用容器 label 上记录的 compose 文件 `up -d --no-build` → 等 healthy → 容器内 `verify.mjs` 冒烟。

- 绝不覆盖 VPS 上的 compose 文件和 `.env`（VPS 版本是手工调整过的）。需要改 VPS 环境变量时，先向用户说明要改什么，确认后再通过 ssh 修改。
- `deploy/local.json` 没有 host 时问用户 SSH 别名，不要猜。

## deploy/gateway.mjs

参数：`--host`（读上游 token，默认取 local.json）、`--upstream <公网 MCP URL>`、`--secrets-only`、`--rotate-password`、`--no-smoke`、`--dry-run`。

行为：`npm ci`（如缺）→ 检查 wrangler 登录 → KV 复用/创建并回填 `wrangler.jsonc` → `wrangler deploy` → 写入 `UPSTREAM_TOKEN`（ssh 读容器 `/data/token.txt`）和 `ACCESS_PASSWORD`（自动生成并保存）→ 把网关地址写进节点控制台 → OAuth 全链路冒烟。

## 只能由用户完成的步骤

- **退出码 3 / "未登录 Cloudflare"**：请用户在 `gateway/cloudflare` 下运行 `npx wrangler login` 并在浏览器授权，完成后重试。不要尝试替用户登录或索要 API Token。
- **Gemini App 中添加连接**：设置 → Connected Apps → Add custom app，填 `<网关>/mcp`，Advanced 留空，授权页输入口令。

## 安全约束

- 永远不要在输出、聊天或命令行参数中显示 token、管理密钥、网关口令、client secret；需要时只告诉用户文件位置。
- 冒烟出现 `429` 说明网关口令被锁定（10 次失败锁 10 分钟），停下等待，不要反复重试。
- 不要 `docker image prune` 或删除 VPS 上的其他容器/卷（这台 VPS 上还跑着别的服务）。
- `wrangler.jsonc` 回填的 KV id 不是机密，可以提交。

## 排障

- 国内网络下 `*.workers.dev` 被 DNS 污染/阻断：网关冒烟报「授权服务发现 30s 内未返回 200」时，带代理重跑 `--secrets-only`，并设置环境变量 `NODE_USE_ENV_PROXY=1`、`HTTPS_PROXY=http://127.0.0.1:7897`（本机 Clash 端口，先确认在运行）。VPS 同样访问不到 workers.dev，所以控制台的网关自检在 VPS 上必然失败，这不代表网关有问题。
- 新注册的 workers.dev 子域名要等几分钟才能签发证书，期间 TLS 握手会失败，等一会儿再试。
- 账号没有 workers.dev 子域名时，wrangler 在非交互模式下会直接报错退出。请用户在自己的终端里运行一次 `cd gateway/cloudflare && npx wrangler deploy`，按提示注册子域名。

- VPS 冒烟失败：`ssh <host> docker logs --tail 100 astra-gemini`。
- 网关冒烟 `initialize` 非 200：通常是 `UPSTREAM_TOKEN` 过期（Token 被轮换），跑 `--secrets-only`；或 `UPSTREAM_MCP_URL` 不对，用 `--upstream` 修正。
- 控制台「接入客户端 → Gemini → 自检」可随时检查网关的发现端点、PRM 与 401。
