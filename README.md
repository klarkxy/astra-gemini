# Astra Gemini（星空双子座）v0.1.0

零外部依赖、小白友好、支持**增量哈希去重同步 + 整包/补丁完整性校验 + 乐观锁 + gzip 传输压缩 + 优先直连/自动回退树状组网**的极简本地代码与验证桥接器。**需要 Node.js ≥ 25**（`exec_verify` 沙箱基于 Node 权限模型）。

## 小白三步上手

1. **克隆或解压**到任意目录（例如 `H:\Code\astra-gemini`）。
2. 右键 `install.ps1` → **使用 PowerShell 运行**（自动检查环境、生成随机 Token、跑全套自检，并在桌面创建「Astra Gemini」快捷方式）。
3. 双击桌面 **「Astra Gemini」**（或 `Start-AstraGemini.vbs`），无黑框驻留右下角托盘并打开中文控制台。

## 完整性与省流量机制

- **增量去重同步（`knownHashes`）**：调用 `pull_snapshot` 时传入已缓存文件的 SHA-256 或 MD5，未改动文件自动跳过不重传，已删除文件会在 `deleted` 中明确列出，同时附带整包确定性指纹 `bundleSha256`。
- **补丁整包校验 + 乐观锁（`patchSha256` + `expectedHashes`）**：打补丁前先验补丁本身哈希（防传输截断），再核对目标文件当前哈希（防本地并发修改被覆盖），成功后自动回传 `postHashes` 供云端直接更新缓存，省掉一次二次拉取。
- **全链路自动 gzip 压缩**：HTTP `/mcp` 接口自动响应 `Accept-Encoding: gzip`（也支持 gzip 请求体），节点间 WebSocket 载荷超过 4 KB 自动走二进制 gzip 帧透明压缩。

## 多端树状组网与安全边界

- **优先直连 + 自动回退 Relay**：通过树状信令交换 15 秒一次性单用票据与可达候选地址，竞速 1.5 秒尝试点对点 `/ws/direct`，建不通则无感回退树状 `/ws/tree` 中继。
- **7 个热插拔开发 SDK**：`git`、`pnpm`、`npm`、`python`、`http`（仅回环）、`fs_read`、`worktree`（默认关闭），控制台滑动开关即刻生效。
- **管理控制台隔离**：`/ui` 与 `/api/*` 强制仅允许本机 `127.0.0.1` 访问（含 Host/Origin/Sec-Fetch-Site 校验，防 DNS rebinding 与跨站提交），外部隧道请求一律 `403`。
- **双 Token 与 OAuth 2.1**：`token.txt` 是「客户端 Token」（`/mcp` Bearer + OAuth 登录口令），`join-token.txt` 是「入网 Token」（仅 `/ws/tree` 子节点入网）。网页 AI 连接器（Claude/ChatGPT）走标准 OAuth 2.1（DCR + PKCE S256）登录，`exec_verify` 在 `node --permission` 沙箱内执行。
- **节点绑定防冒充（TOFU）**：子节点首次注册时按 `nodeId → sha256(nodeSecret)` 落盘 `nodes.json`，之后同名不同密的连接直接 `1008` 关闭；控制台可一键「移除/重置」重新绑定。

## 上公网：VPS 固定域名 或 Cloudflare 命名隧道

### 方案 A：Linux VPS + Caddy（推荐，延迟低）

1. VPS 上安装 Node.js ≥ 25 与 Caddy，克隆本仓库到 `/opt/astra-gemini`。
2. 写 `/etc/astra-gemini.env`：

   ```ini
   HOST=127.0.0.1
   PORT=3939
   ASTRA_TOKEN=<你的客户端Token>
   ASTRA_JOIN_TOKEN=<你的入网Token>
   ASTRA_PUBLIC_URL=https://astra.example.com
   ```
3. `sudo cp deploy/astra-gemini.service /etc/systemd/system/ && sudo systemctl enable --now astra-gemini`。
4. `deploy/Caddyfile` 改为你的域名放进 Caddy（`reverse_proxy 127.0.0.1:3939`，WebSocket 自动支持），`sudo systemctl reload caddy`。
5. 控制台访问：本机跑 `ssh -L 3939:127.0.0.1:3939 user@vps`，浏览器开 `http://127.0.0.1:3939/ui`（管理面只认 localhost）。

### 方案 B：Cloudflare 命名隧道（免 VPS）

1. Cloudflare Zero Trust → Networks → Tunnels 新建隧道绑定固定域名，拿到 Tunnel Token。
2. 控制台顶部隧道区选「命名隧道」，粘贴 Token 与固定域名（`https://xxx.example.com`）保存，点启动。
3. 该固定域名自动成为 OAuth issuer 与公网 MCP 地址。注意 Cloudflare 免费版单条 HTTP 请求 ~100 秒会断开，超长 `exec_verify`（>90s）请走 VPS 或局域网直连。

### 连接网页 AI 客户端（Claude.ai / ChatGPT）

- MCP 地址填 `<公网地址>/mcp`，认证方式选 **OAuth**：浏览器会弹出中文授权页，输入「客户端 Token」（token.txt）完成授权即可。

### 子节点入网

- 子节点「上游父节点」填 `wss://<公网地址>/ws/tree` + 「入网 Token」（join-token.txt），保存即自动连入并出现在父节点控制台。
