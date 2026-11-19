# Astra Gemini（星空双子座）v0.1.0

零外部依赖（仅 Node.js 标准库）的本地 MCP 桥接器：让网页端或 CLI 的 AI 通过 MCP 协议读取本机项目代码、应用 unified diff 补丁、在权限沙箱中跑验证脚本。支持增量哈希去重同步、补丁完整性校验与乐观锁、传输自动 gzip 压缩，以及多机树状组网（优先点对点直连、失败自动回退中继）。

**需要 Node.js ≥ 25**：`exec_verify` 脚本在 `node --permission` 权限模型沙箱中运行，Node 25 起该模型才支持网络限制（`--allow-net`），更早版本无法保证沙箱断网，因此整体要求 ≥ 25。

典型场景：把一台或多台机器上的代码仓库暴露给 Claude.ai、ChatGPT 或其他 MCP 客户端——AI 拉快照、打补丁、跑白名单验证命令。

## 快速开始

1. 克隆或解压本仓库到任意目录。
2. 右键 `install.ps1` → **使用 PowerShell 运行**：检查 Node/Git、生成两个 Token 文件、运行完整测试套件、创建桌面快捷方式。
3. 双击桌面「Astra Gemini」（或目录内 `Start-AstraGemini.vbs`）：托盘驻留并自动打开控制台 `http://127.0.0.1:3939/ui`（仅本机可访问）。

安装目录下会生成两个 Token 文件（均已 gitignore）：

| 文件 | 用途 |
| --- | --- |
| `token.txt` | **客户端 Token**：`/mcp` 的 Bearer 凭据，同时是 OAuth 授权页的登录口令 |
| `join-token.txt` | **入网 Token**：仅供子节点通过 `wss://…/ws/tree` 挂载到本节点 |

控制台五个页签：SDK 能力开关 / 本地项目 / 星图组网 / 备份回滚 / 自检与日志。托盘菜单可复制本机 MCP 地址、客户端 Token、入网 Token。

也可不用托盘直接启动：`HOST=127.0.0.1 PORT=3939 AUTH_MODE=bearer ASTRA_TOKEN=… ASTRA_JOIN_TOKEN=… node src/server.mjs`（`AUTH_MODE=none` 完全免鉴权，仅限本机测试）。

## MCP 接口与工具

- `POST /mcp`：JSON-RPC 2.0，单请求单响应（无 SSE）。认证为 `Authorization: Bearer <客户端 Token>` 或 OAuth access token；未带凭据返回 401 并附 `WWW-Authenticate: Bearer resource_metadata=…`。
- `WS /ws/tree`：子节点入网（仅入网 Token）。`WS /ws/direct`：节点间点对点直连（15 秒一次性票据）。`GET /health`：存活探测。
- 项目寻址支持多级路径：本机项目写 `my-app`，子树项目写 `<节点Id>/<项目>`（更深层 `<a>/<b>/<项目>`），平级兄弟项目写 `../<兄弟节点>/<项目>`（需上级授权，见「兄弟节点互访」）。

| 工具 | 作用 | 关键参数 | 关键返回 |
| --- | --- | --- | --- |
| `list_projects` | 列出本机及全部在线子树项目 | 无 | `project, mode, sdks, allowedScripts, exists, description` |
| `pull_snapshot` | 拉取过滤后的文本代码快照 | `project*`、`paths[]`（glob 过滤）、`knownHashes`（去重）、`includeContent`（默认 true）、`maxFiles`（默认 200）、`maxTotalBytes`（默认 2000000） | `files[{path,bytes,sha256,content}]`、`unchangedPaths`、`deleted`、`skipped`、`bundleSha256`、`truncated` |
| `apply_patch` | 校验、备份并应用 unified diff | `project*`、`patch*`、`patchSha256`、`expectedHashes`、`dryRun` | `backupId`、`patchSha256`、`files`、`postHashes` |
| `list_sdks` | 列出项目当前生效的 SDK | `project*` | `sdks[{name,title,description,functions}]` |
| `exec_verify` | 在权限沙箱内执行异步 JS 验证脚本 | `project*`、`script*`、`timeoutMs`（1s–120s，默认 30s）、`maxOutputBytes`（默认 8192） | `ok`、`result`、`logs`、`durationMs`、`truncated` |

补充说明：

- `pull_snapshot` 的 `knownHashes` 传 `{相对路径: sha256或md5}`：哈希一致的文件只进 `unchangedPaths` 不重传内容；已消失的文件列入 `deleted`；`bundleSha256` 是全部纳入清单文件的确定性指纹。文件枚举优先走 git 清单，非 git 目录回退目录遍历，全程套用 deny 规则。
- `apply_patch` 流程：可选校验 `patchSha256`（SHA-256 或 MD5，防传输截断）→ `expectedHashes` 乐观锁（值为 `null` 表示该文件必须不存在；32 位十六进制按 MD5、否则按 SHA-256 比对现网文件）→ `git apply --check` → 自动备份触及文件到 `.bridge-backup/<项目>/<backupId>` → `git apply`。成功后返回 `postHashes`（SHA-256，`null` 表示文件已删）可直接刷新缓存。补丁以 `git -c core.autocrlf=false apply` 应用，LF 内容逐字节落盘。`dryRun: true` 只校验不写入。
- `exec_verify` 在独立的 `node --permission` 子进程中执行：仅被授予读自身文件权限，无网络、写盘、子进程、Worker、原生扩展权限。脚本内仅暴露 `sdk` 命名空间、受限 console 与定时器；**所有 `sdk.*` 调用跨 IPC 边界、返回 Promise，必须 await**。示例：

  ```js
  const br = await sdk.git.branches();
  const t = await sdk.npm.run("test");
  return { branch: br.current, testsOk: t.ok };
  ```

## 内置 SDK

| SDK | 函数 | 限制 |
| --- | --- | --- |
| `git` | `status`、`diff({statOnly,maxChars})`、`log(limit≤30)`、`branches`、`rollback(backupId)` | 只读查询 + 补丁备份回滚 |
| `npm` | `listScripts`、`run(scriptName,{tailLines≤120})` | 仅 `allowedScripts` 白名单脚本（默认 `test/lint/typecheck/check/build/verify`） |
| `pnpm` | `listScripts`、`listWorkspaces`、`run(scriptName,{filter,tailLines})` | 同上；`filter` 仅允许 `^[a-zA-Z0-9@/_.*-]+$` |
| `python` | `info`、`pytest(target,{keyword,tailLines})`、`compileCheck(target)` | 优先使用项目内 `.venv`/`venv` 解释器 |
| `http` | `probePort(port,timeoutMs≤5000)`、`request(url,{method,headers,body,maxChars})` | 仅允许访问 `127.0.0.1`/`localhost`/`::1` |
| `fs_read` | `stat`、`tail(relPath,lines≤200)`、`grep(pattern,subdir,maxMatches≤40)` | 项目内只读，遵守 deny 规则 |
| `worktree` | `list`、`create(name,ref)`、`remove(name)` | 默认关闭；在 `.bridge-worktrees/<项目>/<name>` 建隔离工作树，名称限 `^[a-zA-Z0-9_-]{1,48}$` |

SDK 生效 = 全局开关（`settings.globalSdkEnabled`，控制台页签热生效）∩ 项目 `sdks` 白名单（`"*"` 表示全部全局启用的 SDK）。SDK 目录：`sdks/global/*.mjs` 全局生效，`sdks/projects/<项目别名>/*.mjs` 仅对该项目生效；新文件丢入后经 `list_sdks` / 控制台刷新即被发现。

## projects.json

```json
{
  "my-app": {
    "root": "C:\\path\\to\\my-app",
    "mode": "direct",
    "sdks": ["git", "pnpm", "npm", "http", "fs_read"],
    "allowedScripts": ["test", "lint", "build"],
    "deny": ["docs/private/**"],
    "description": "备注"
  }
}
```

- 项目别名：`^[a-zA-Z0-9_-]{1,64}$`；`root` 必填且必须已存在。
- `mode`：`direct`（默认，允许打补丁）或 `readonly`（拒绝 `apply_patch`）。
- `sdks`：缺省为 `["git","pnpm","npm","python","http","fs_read"]`（不含 `worktree`）；`"*"` 表示全部全局启用的 SDK。
- `allowedScripts`：缺省为内置白名单 `test/lint/typecheck/check/build/verify`。
- `deny`：追加屏蔽规则。**默认 deny 不可关闭**，对所有文件读取/快照/补丁生效：`.env*`、`**/*.pem|key|p12|pfx`、`**/*secret*`、`**/id_rsa*|id_ed25519*`、`.git/**`、`node_modules/**`、`.bridge-backup/**`。
- 也可在控制台「本地项目」页签可视化编辑。

## 安全模型

- **两类凭据权限边界**：客户端 Token → `/mcp` 全部工具 + OAuth 登录口令；入网 Token → 仅 `/ws/tree` 注册。两者互不相通（交叉使用均 401），比较均使用恒定时算法。
- **重要**：拿到客户端 Token（或完成 OAuth 授权）的调用方，对每个 `mode: "direct"` 项目约等于拥有本机用户的代码执行能力——可先 `apply_patch` 修改 `package.json`，再 `exec_verify` 调 `sdk.npm.run` 执行。只给受信任的 AI/节点授权。
- `readonly` 仅阻止 `apply_patch` 写盘，**不阻止 `exec_verify`**（其后果取决于启用的 SDK，如 `npm run build` 仍会写产物）。需要严格只读时，请同时把项目 `sdks` 收缩为 `["fs_read"]` 等纯读集合。
- 上级节点的 `/mcp` 凭据持有者可对整棵子树（含全部后代节点的项目）发起工具调用；入网 Token 只决定谁能挂载上来，不约束上级的调用能力。兄弟节点默认互不可见：`../` 平级访问必须经上级按 `canCallTree` 授权逐跳放行（`authMode=none` 不豁免此项），被授权节点由此获得与上级同级的调用面。
- `exec_verify` 沙箱边界：独立 `node --permission` 子进程，仅 `--allow-fs-read` 自身文件；SDK 调用经宿主端白名单校验的 IPC 代理，返回值 JSON 序列化。已知残余风险：`process.kill`/`process.abort` 不受权限模型管控（脚本可终止自身或信号同用户进程）；CPU/内存仅靠超时兜底（默认 30s、上限 120s）。
- 管理控制台（`/ui`、`/api/*`）只接受本机 socket，且校验 Host（仅 `127.0.0.1`/`localhost`/`::1`）、Origin 必须同源、拒绝 `Sec-Fetch-Site: cross-site`（防 DNS rebinding 与跨站提交）。经公网入口到达的管理请求一律 403。
- OAuth 防护：强制 PKCE S256；授权码 60 秒一次性；refresh token 轮换（旧值立即失效）；access token 1 小时、refresh token 30 天；授权口令 10 分钟内失败超 10 次锁定 10 分钟；`/oauth/register` 限流（默认每小时 20 次、客户端上限 200，超限时优先驱逐无活跃令牌的客户端）。
- 节点 TOFU 绑定：子节点首次注册将 `nodeId → sha256(nodeSecret)` 落盘 `nodes.json`；此后同名不同密的连接被 `1008` 拒绝且不顶替现有连接，控制台「星图组网」可一键移除重置。
- 直连票据 15 秒一次性单用；心跳每 25 秒一次、超过 75 秒无应答断开并自动重连（退避重试，成功即重置）。

## 上公网

`publicUrl`（设置项或 `ASTRA_PUBLIC_URL`）决定 OAuth issuer 与对外 MCP 地址，生产环境务必显式配置；未配置时按请求 `Host` + `x-forwarded-proto`/`cf-ray` 推断并记日志提醒。注意不同入口下项目路径前缀不同：经 VPS 父节点访问家中电脑项目写 `home/my-app`，直连家中电脑自己的入口写 `my-app`。

### 方案 A：Linux VPS + Caddy（固定域名、低延迟）

1. VPS 安装 Node.js ≥ 25 与 Caddy，克隆本仓库到 `/opt/astra-gemini`。
2. 写 `/etc/astra-gemini.env`：

   ```ini
   HOST=127.0.0.1
   PORT=3939
   ASTRA_TOKEN=<客户端Token>
   ASTRA_JOIN_TOKEN=<入网Token>
   ASTRA_PUBLIC_URL=https://astra.example.com
   ```
3. `sudo cp deploy/astra-gemini.service /etc/systemd/system/ && sudo systemctl enable --now astra-gemini`。
4. `deploy/Caddyfile` 改为你的域名放入 Caddy（`reverse_proxy 127.0.0.1:3939`，WebSocket 自动透传），`sudo systemctl reload caddy`。
5. 控制台访问：本机 `ssh -L 3939:127.0.0.1:3939 user@vps`，浏览器开 `http://127.0.0.1:3939/ui`（管理面只认 localhost）。

### 方案 B：Cloudflare 命名隧道（免 VPS）

1. Cloudflare Zero Trust → Networks → Tunnels 新建隧道并绑定固定域名，取得 Tunnel Token。
2. 控制台隧道区选「命名隧道」，填入 Token 与固定域名（`https://xxx.example.com`）保存后启动（Token 经环境变量传入，不出现在命令行参数）。
3. 该固定域名自动成为 OAuth issuer 与公网 MCP 地址。注意 Cloudflare 单条 HTTP 请求约 100 秒即被切断，`timeoutMs` 超过 ~90 秒的 `exec_verify` 请走 VPS 或局域网直连。

另有「临时隧道」模式（随机 `*.trycloudflare.com` 域名）适合临时演示；随机域名下 OAuth issuer 每次重启都会变化，不建议用于正式接入。

### 连接网页 AI 客户端（Claude.ai / ChatGPT）

MCP 地址填 `<公网地址>/mcp`，认证方式选 **OAuth**：跳出的中文授权页输入客户端 Token（`token.txt`）即完成授权（DCR 自动注册 + PKCE S256 + 授权码 + refresh token 轮换）。

### 子节点入网

子节点控制台「上游父节点」填 `wss://<公网地址>/ws/tree` + 入网 Token（`join-token.txt`），保存即自动连入并出现在父节点「星图组网」页签。协议版本不匹配、`nodeSecret` 不匹配等策略性关闭（`1008`）不会自动重连，修正后需重新保存上游；被父节点「移除/重置」（`1000`）则会自动重连并以全新绑定重新注册。

### 兄弟节点互访（`../` 寻址）

子节点可以经共同上级中转访问平级节点或上级自身的项目：项目路径以 `../` 开头即「交给上级解析」，例如 `../<兄弟节点>/<项目>`、`../<上级本地项目>`，多级向上写 `../../<…>`。`..` 只允许出现在路径开头，`a/../b` 会被拒绝。

这需要上级在「星图组网」页签为该子节点打开「允许调用整棵树」开关（`canCallTree`，持久化在 `nodes.json`，**默认关闭**）：被授权节点经上级中转后可调用的范围等同于上级客户端本身（整棵树），授权面很大，只应对可信节点开启。未授权时 `../` 调用返回未授权错误，`list_projects` 也不会列出 `../` 条目；上级回答 `list_projects` 时会自动剔除调用方自己的子树条目，避免重复。

示例：节点 A 上的 Claude Code 连本机 `/mcp`，对 `../B/my-app` 调用 `pull_snapshot` / `apply_patch` —— 请求经上级 R 中继到兄弟节点 B 执行（R 到 B 之间仍可能自动升级为直连隧道）。

## 本地状态文件

均位于桥接器安装目录，全部已加入 `.gitignore`，**勿提交**：

| 文件/目录 | 内容 |
| --- | --- |
| `settings.json` | `nodeId`、`nodeSecret`、上游/隧道 Token、`publicUrl`、SDK 与直连开关（含敏感信息） |
| `projects.json` | 项目注册表（见上文） |
| `token.txt` / `join-token.txt` | 客户端 Token / 入网 Token |
| `nodes.json` | 子节点 TOFU 绑定（`nodeId → sha256(nodeSecret)`） |
| `oauth-state.json` | OAuth 客户端与令牌哈希（不存明文令牌） |
| `.bridge-backup/` | `apply_patch` 自动备份，供回滚 |
| `.bridge-worktrees/` | `worktree` SDK 创建的隔离工作树 |

## 开发与测试

`npm test`（即 `node --test test/bridge.test.mjs`，node:test 零依赖）覆盖：单节点工具链与项目防火墙、快照去重与补丁完整性/gzip、沙箱逃逸防护、直连升级与中继回退、Token 隔离、TOFU 劫持与重置、OAuth 全流程、心跳重连、跨节点超时。

## 许可证

Apache License 2.0，详见 `LICENSE` 与 `NOTICE`。
