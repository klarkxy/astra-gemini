import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { REPO_ROOT, SSH_OPTS, fail, info, loadLocal, parseArgs, run, runInherit, saveLocal, step } from "./lib.mjs";

// 部署 Cloudflare 网关：KV 就绪 → wrangler deploy → secrets → 注册地址到节点 → OAuth 冒烟。
// 密钥（UPSTREAM_TOKEN / ACCESS_PASSWORD / client_secret）只进 stdin 与 deploy/local.json，绝不打印。

const GATEWAY_DIR = path.join(REPO_ROOT, "gateway", "cloudflare");
const WRANGLER_JSONC = path.join(GATEWAY_DIR, "wrangler.jsonc");

const args = parseArgs(process.argv.slice(2));
const local = loadLocal();
const host = args.host || local.vps?.host || "";
const dryRun = Boolean(args["dry-run"]);
const secretsOnly = Boolean(args["secrets-only"]);

const wrangler = (wargs, opts = {}) => run("npx", ["wrangler", ...wargs], { cwd: GATEWAY_DIR, timeoutMs: 300000, ...opts });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

step("预检");
if (!fs.existsSync(path.join(GATEWAY_DIR, "node_modules"))) {
  if (dryRun) {
    info("node_modules 缺失 → 将运行 npm ci");
  } else {
    info("node_modules 缺失，运行 npm ci ...");
    const code = await runInherit("npm", ["ci"], { cwd: GATEWAY_DIR });
    if (code !== 0) fail(`npm ci 退出码 ${code}`);
  }
}

const who = await wrangler(["whoami"], { timeoutMs: 60000 });
if (who.code !== 0 || /not authenticated/i.test(who.stdout + who.stderr)) fail("未登录 Cloudflare：在 gateway/cloudflare 下运行 npx wrangler login 后重试。", 3);
info("wrangler 已登录");

if (host) {
  const ssh = await run("ssh", [...SSH_OPTS, host, "docker exec astra-gemini test -f /data/token.txt"], { timeoutMs: 30000 });
  if (ssh.code !== 0) {
    if (dryRun) info(`警告：ssh ${host} 不可达或容器未运行（${ssh.stderr.trim() || "无输出"}）`);
    else fail(`无法经 ssh 读取 ${host} 的 /data/token.txt：${ssh.stderr.trim() || "连接失败"}`);
  } else {
    info(`上游节点 ${host} 可达`);
  }
} else {
  info("未配置 --host / deploy/local.json vps.host：UPSTREAM_TOKEN 将无法读取");
}

const jsoncText0 = fs.readFileSync(WRANGLER_JSONC, "utf8");
const needsKv = jsoncText0.includes("REPLACE_WITH_KV_ID");
const upstreamVar = /"UPSTREAM_MCP_URL":\s*"([^"]*)"/.exec(jsoncText0)?.[1] || "";
const publicOrigin = /"PUBLIC_ORIGIN":\s*"([^"]*)"/.exec(jsoncText0)?.[1] || "";
info(`wrangler.jsonc：KV ${needsKv ? "待创建/回填" : "已配置"}；UPSTREAM_MCP_URL=${upstreamVar || "(空)"}${publicOrigin ? `；PUBLIC_ORIGIN=${publicOrigin}` : ""}`);

local.gateway = { ...(local.gateway || {}) };

if (dryRun) {
  step("计划（dry-run，不做任何变更）");
  if (secretsOnly) {
    info("--secrets-only：跳过 KV 与部署");
  } else {
    if (needsKv) info("KV：列出命名空间复用 OAUTH_KV，不存在则创建并回填 wrangler.jsonc");
    if (args.upstream) info(`UPSTREAM_MCP_URL → ${args.upstream}`);
    info("npx wrangler deploy → 解析部署地址写入 deploy/local.json gateway.url");
  }
  info(`secrets：UPSTREAM_TOKEN 经 ssh ${host || "<未配置>"} 读取容器 /data/token.txt（不打印）`);
  info(`secrets：ACCESS_PASSWORD ${local.gateway.accessPassword && !args["rotate-password"] ? "复用 local.json 中已保存口令" : "生成新口令并保存到 deploy/local.json"}（不打印）`);
  info(`注册网关地址到节点：${local.gateway.url || "（部署后自动写入）"}`);
  info(args["no-smoke"]
    ? "跳过冒烟（--no-smoke）"
    : "冒烟：discovery → /mcp 401 → OAuth(PKCE+口令) → token 交换 → MCP initialize/tools/list");
  process.exit(0);
}

async function ensureKvId() {
  const list = await wrangler(["kv", "namespace", "list"], { timeoutMs: 60000 });
  if (list.code === 0) {
    try {
      const nss = JSON.parse(list.stdout);
      const found = Array.isArray(nss)
        ? nss.find((n) => n.title === "OAUTH_KV" || n.title === "astra-gemini-gateway-OAUTH_KV")
        : null;
      if (found?.id) {
        info(`复用 KV 命名空间 ${found.title}`);
        return found.id;
      }
    } catch {
      // 落到创建分支
    }
  }
  const created = await wrangler(["kv", "namespace", "create", "OAUTH_KV"], { timeoutMs: 60000 });
  const id = /"id"\s*:\s*"([0-9a-f]{32})"/i.exec(created.stdout)?.[1];
  if (created.code !== 0 || !id) {
    fail(`创建 KV 命名空间失败：${created.stderr.trim() || created.stdout.trim()}`);
  }
  info("已创建 KV 命名空间 OAUTH_KV");
  return id;
}

if (!secretsOnly) {
  step("准备 KV 与 wrangler.jsonc");
  let text = fs.readFileSync(WRANGLER_JSONC, "utf8");
  if (text.includes("REPLACE_WITH_KV_ID")) {
    const kvId = await ensureKvId();
    fs.writeFileSync(WRANGLER_JSONC, text.replace("REPLACE_WITH_KV_ID", kvId));
    info("已回填 wrangler.jsonc KV id");
  }
  if (args.upstream) {
    text = fs.readFileSync(WRANGLER_JSONC, "utf8");
    const next = text.replace(/("UPSTREAM_MCP_URL":\s*")[^"]*(")/, `$1${args.upstream}$2`);
    if (next === text) fail("wrangler.jsonc 中未找到 UPSTREAM_MCP_URL 配置项");
    fs.writeFileSync(WRANGLER_JSONC, next);
    info(`UPSTREAM_MCP_URL → ${args.upstream}`);
  }

  step("wrangler deploy");
  const dep = await wrangler(["deploy"], { timeoutMs: 300000 });
  process.stdout.write(dep.stdout);
  process.stderr.write(dep.stderr);
  if (dep.code !== 0) fail(`wrangler deploy 退出码 ${dep.code}`);
  let url = publicOrigin.replace(/\/+$/, "");
  if (!url) {
    const m = dep.stdout.match(/https:\/\/[a-zA-Z0-9.-]*workers\.dev/) || dep.stdout.match(/https:\/\/[^\s'"]+/);
    if (m) url = m[0].replace(/\/+$/, "");
  }
  if (!url) fail("未能从 wrangler deploy 输出解析部署地址");
  local.gateway.url = url;
  saveLocal(local);
  info(`网关地址 ${url}`);
}

step("写入 Worker secrets");
if (!host) fail("缺少 --host（或 deploy/local.json vps.host）：无法读取上游 /data/token.txt");
const tok = await run("ssh", [...SSH_OPTS, host, "docker exec astra-gemini cat /data/token.txt"], { timeoutMs: 30000 });
const upstreamToken = tok.stdout.trim();
if (tok.code !== 0 || !upstreamToken) fail(`读取上游 token 失败：${tok.stderr.trim() || "空响应"}`);

if (!local.gateway.accessPassword || args["rotate-password"]) {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  let chars = "";
  for (let i = 0; i < 24; i++) chars += alphabet[crypto.randomInt(alphabet.length)];
  local.gateway.accessPassword = chars.match(/.{4}/g).join("-");
  saveLocal(local); // 先落盘再 wrangler put，避免失败丢口令
}

const putSecret = async (name, value) => {
  const res = await wrangler(["secret", "put", name], { input: value, timeoutMs: 60000 });
  if (res.code !== 0) fail(`写入 secret ${name} 失败：${res.stderr.trim() || res.stdout.trim()}`);
  info(`secret ${name} 已写入`);
};
await putSecret("UPSTREAM_TOKEN", upstreamToken);
await putSecret("ACCESS_PASSWORD", local.gateway.accessPassword);

const gwUrl = (local.gateway.url || "").replace(/\/+$/, "");
if (gwUrl && host) {
  step("注册网关地址到节点");
  const script =
    'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{' +
    'const k=require("fs").readFileSync("/data/admin-key.txt","utf8").trim();' +
    'fetch("http://127.0.0.1:"+(process.env.PORT||3939)+"/api/settings",{method:"POST",' +
    'headers:{"Content-Type":"application/json","X-Astra-Admin":k},' +
    'body:JSON.stringify({gatewayUrl:d.trim()})}).then(r=>r.json()).then(j=>{' +
    'if(!j.ok)throw new Error(j.error||"api error");console.log("registered")}).catch(e=>{' +
    'console.error(String(e&&e.message||e));process.exit(1)})})';
  const reg = await run("ssh", [...SSH_OPTS, host, `docker exec -i astra-gemini node -e '${script}'`], { input: gwUrl, timeoutMs: 30000 });
  if (reg.code === 0 && /registered/.test(reg.stdout)) {
    info("已写入节点 settings.gatewayUrl");
  } else {
    info(`警告：注册 gatewayUrl 失败（旧容器可能无该接口，可稍后在控制台手填）：${(reg.stderr || reg.stdout).trim()}`);
  }
} else if (!gwUrl) {
  info("警告：未记录网关地址，跳过注册（部署完成后 local.json gateway.url 会自动补上）");
}

if (args["no-smoke"] || !gwUrl) {
  step(args["no-smoke"] ? "完成（跳过冒烟）" : "完成（无网关地址，跳过冒烟）");
  process.exit(0);
}

step("网关冒烟（OAuth 全链路）");

const b64url = (buf) => Buffer.from(buf).toString("base64url");
const gfetch = (u, init = {}) => fetch(u, { redirect: "manual", ...init });
const cookiesFrom = (res) => res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
const field = (html, name) => {
  const m = html.match(new RegExp(`name="${name}" value="([^"]*)"`));
  return m ? m[1].replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))) : "";
};
const redirectUri = "https://oauth-redirect.googleusercontent.com/r/astra-deploy-smoke";

const createClient = async () => {
  const r = await gfetch(`${gwUrl}/admin/clients`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${local.gateway.accessPassword}` },
    body: JSON.stringify({ redirect_uris: [redirectUri], client_name: "astra-deploy-smoke" })
  });
  if (r.status !== 201) fail(`创建冒烟客户端失败：HTTP ${r.status}`);
  const c = await r.json();
  local.gateway.smokeClient = { id: c.client_id, secret: c.client_secret };
  saveLocal(local);
  info("已创建冒烟客户端 astra-deploy-smoke");
};

// PKCE 授权 → 口令同意页 → 授权码 → token 交换；口令只提交 local.json 中保存的值
async function oauthFlow() {
  const client = local.gateway.smokeClient;
  const verifier = b64url(crypto.randomBytes(48));
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
  const q = new URLSearchParams({
    client_id: client.id,
    redirect_uri: redirectUri,
    response_type: "code",
    code_challenge: challenge,
    code_challenge_method: "S256",
    scope: "mcp",
    resource: `${gwUrl}/mcp`,
    state: "deploy-smoke"
  });
  let code = "";
  // 最多 4 次：secret 传播有延迟，401 时稍候重试（网关 10 次失败即锁定）
  for (let i = 0; i < 4 && !code; i++) {
    if (i) await sleep(6000);
    const res = await gfetch(`${gwUrl}/authorize?${q}`);
    const html = await res.text();
    if (res.status !== 200 || !field(html, "handle")) {
      const err = new Error(`/authorize 返回 ${res.status}`);
      const loc = res.headers.get("location") || "";
      err.invalidClient = /invalid_client/.test(loc) || res.status === 400;
      throw err;
    }
    const post = await gfetch(`${gwUrl}/authorize`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: cookiesFrom(res) },
      body: new URLSearchParams({
        handle: field(html, "handle"),
        return: field(html, "return"),
        decision: "approve",
        password: local.gateway.accessPassword
      })
    });
    if (post.status === 302) {
      const loc = post.headers.get("location") || "";
      code = loc ? new URL(loc).searchParams.get("code") || "" : "";
      if (!code) throw new Error(`302 但无授权码：${loc.slice(0, 120)}`);
      break;
    }
    if (post.status === 401) continue;
    if (post.status === 429) throw new Error("口令锁定（429）：稍后再试");
    throw new Error(`授权提交返回 ${post.status}`);
  }
  if (!code) throw new Error("多次尝试未获得授权码");
  const tokRes = await gfetch(`${gwUrl}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: client.id,
      client_secret: client.secret,
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
      resource: `${gwUrl}/mcp`
    })
  });
  const tokText = await tokRes.text();
  if (tokRes.status !== 200) {
    const err = new Error(`token 交换 ${tokRes.status}：${tokText.slice(0, 150)}`);
    err.invalidClient = /invalid_client/i.test(tokText);
    throw err;
  }
  const accessToken = JSON.parse(tokText).access_token;
  if (!accessToken) throw new Error("token 响应缺少 access_token");
  return accessToken;
}

// 1. discovery（等 deploy/secret 传播，≤30s）
let ready = false;
const deadline = Date.now() + 30000;
while (Date.now() < deadline) {
  try {
    const r = await gfetch(`${gwUrl}/.well-known/oauth-authorization-server`, { signal: AbortSignal.timeout(8000) });
    if (r.status === 200) { ready = true; break; }
  } catch {
    // 未就绪
  }
  await sleep(2500);
}
if (!ready) fail("冒烟失败：授权服务发现 30s 内未返回 200");
info("discovery 200");

// 2. /mcp 未授权 → 401
const unauth = await gfetch(`${gwUrl}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
if (unauth.status !== 401) fail(`冒烟失败：/mcp 未授权返回 ${unauth.status}，期望 401`);
info("/mcp 未授权 → 401");

// 3. OAuth 全链路（客户端失效则重建一次）
if (!local.gateway.smokeClient?.id || !local.gateway.smokeClient?.secret) await createClient();
let accessToken = "";
for (let round = 0; round < 2 && !accessToken; round++) {
  try {
    accessToken = await oauthFlow();
  } catch (err) {
    if (err.invalidClient && round === 0) {
      info("冒烟客户端已失效，重建后重试");
      await createClient();
      continue;
    }
    fail(`冒烟失败：${err.message}`);
  }
}
if (!accessToken) fail("冒烟失败：未取得访问令牌");
info("OAuth 授权 → token OK");

// 4. 经网关访问上游 MCP
const mcp = (body) => gfetch(`${gwUrl}/mcp`, {
  method: "POST",
  headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${accessToken}` },
  body: JSON.stringify(body)
});
const init = await mcp({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
if (init.status !== 200) fail(`冒烟失败：initialize 返回 ${init.status}`);
const tools = await mcp({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
if (tools.status !== 200) fail(`冒烟失败：tools/list 返回 ${tools.status}`);

console.log("GATEWAY PASS");
console.log(`Gemini MCP 地址：${gwUrl}/mcp`);
