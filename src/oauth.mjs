import crypto from "node:crypto";
import dns from "node:dns";
import fs from "node:fs";
import https from "node:https";
import net from "node:net";
import { writeSecretFile } from "./secure-file.mjs";

const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000;
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const CODE_TTL_MS = 60 * 1000;
const FAIL_WINDOW_MS = 10 * 60 * 1000;
const FAIL_LIMIT = 10;
const CIMD_CACHE_TTL_MS = 10 * 60 * 1000;
const CIMD_NEG_CACHE_TTL_MS = 60 * 1000;
const CIMD_MAX_BYTES = 64 * 1024;
const CIMD_TIMEOUT_MS = 5000;

function sha256hex(value) {
  return crypto.createHash("sha256").update(String(value), "utf8").digest("hex");
}

function timingSafeEqualStr(a, b) {
  const ba = Buffer.from(String(a ?? ""), "utf8");
  const bb = Buffer.from(String(b ?? ""), "utf8");
  if (ba.length !== bb.length || ba.length === 0) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[c]));
}

function stripTrailingSlash(s) {
  return String(s || "").replace(/\/+$/, "");
}

function isLoopbackHttp(u) {
  return u.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(u.hostname);
}

function isAllowedRedirectUri(uri) {
  try {
    const u = new URL(uri);
    if (u.protocol === "https:") return true;
    return isLoopbackHttp(u) && ["localhost", "127.0.0.1"].includes(u.hostname);
  } catch {
    return false;
  }
}

function redirectMatches(registered, candidate) {
  if (registered === candidate) return true;
  try {
    const a = new URL(registered);
    const b = new URL(candidate);
    if (isLoopbackHttp(a) && isLoopbackHttp(b)) {
      return a.hostname === b.hostname && a.pathname === b.pathname && a.search === b.search;
    }
  } catch {
    // fall through
  }
  return false;
}

// OAuth Client ID Metadata Document: client_id is an https URL that hosts the
// client metadata (redirect_uris, ...). Used by Gemini Connected Apps.
function isClientIdUrl(s) {
  try {
    const u = new URL(String(s || ""));
    return u.protocol === "https:" && u.pathname !== "/" && !u.username && !u.password;
  } catch {
    return false;
  }
}

function isPublicIp(ip) {
  if (net.isIPv4(ip)) {
    const p = ip.split(".").map(Number);
    return !(
      p[0] === 0 || p[0] === 10 || p[0] === 127 ||
      (p[0] === 169 && p[1] === 254) ||
      (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
      (p[0] === 192 && p[1] === 168) ||
      (p[0] === 100 && p[1] >= 64 && p[1] <= 127) ||
      (p[0] === 192 && p[1] === 0 && p[2] === 0) ||
      (p[0] === 192 && p[1] === 0 && p[2] === 2) ||
      (p[0] === 198 && (p[1] === 18 || p[1] === 19)) ||
      (p[0] === 198 && p[1] === 51 && p[2] === 100) ||
      (p[0] === 203 && p[1] === 0 && p[2] === 113) ||
      p[0] >= 224
    );
  }
  if (net.isIPv6(ip)) {
    const low = ip.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(low);
    if (mapped) return isPublicIp(mapped[1]);
    const first = parseInt(low.split(":")[0] || "0", 16);
    // ::/8（含 loopback/unspecified）、fc00::/7 (ULA)、fe80::/9（含 link-local fe80::/10 与已废弃 site-local）、ff00::/8 (multicast)
    if (first === 0 || (first & 0xfe00) === 0xfc00 || (first & 0xff80) === 0xfe80 || (first & 0xff00) === 0xff00) {
      return false;
    }
    return true;
  }
  return false;
}

async function defaultFetchClientMetadata(clientIdUrl) {
  const u = new URL(clientIdUrl);
  if (u.port && u.port !== "443") throw new Error("client_id URL 必须使用 443 端口");
  const addrs = await dns.promises.lookup(u.hostname, { all: true });
  if (!addrs.length || addrs.some((a) => !isPublicIp(a.address))) {
    throw new Error("client_id URL 解析到非公网地址");
  }
  // 固定 DNS 解析结果，防 DNS rebinding（TOCTOU）。
  const lookup = (hostname, options, cb) => {
    if (hostname !== u.hostname) return cb(new Error("blocked hostname re-resolution"));
    if (options && options.all) return cb(null, addrs);
    cb(null, addrs[0].address, addrs[0].family);
  };
  const body = await new Promise((resolve, reject) => {
    const req = https.get(
      u,
      { lookup, timeout: CIMD_TIMEOUT_MS, headers: { accept: "application/json" } },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`客户端元数据请求返回 HTTP ${res.statusCode}`));
          return;
        }
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (c) => {
          data += c;
          if (data.length > CIMD_MAX_BYTES) req.destroy(new Error("客户端元数据过大"));
        });
        res.on("end", () => resolve(data));
        res.on("error", reject);
      }
    );
    req.on("timeout", () => req.destroy(new Error("客户端元数据请求超时")));
    req.on("error", reject);
  });
  try {
    return JSON.parse(body);
  } catch {
    throw new Error("客户端元数据不是合法 JSON");
  }
}

function clientFromMetadataDoc(clientIdUrl, doc) {
  if (!doc || typeof doc !== "object") throw new Error("客户端元数据格式非法");
  if (doc.client_id !== clientIdUrl) throw new Error("元数据中的 client_id 与 URL 不一致");
  const uris = Array.isArray(doc.redirect_uris) ? doc.redirect_uris : [];
  if (!uris.length || uris.some((r) => typeof r !== "string" || !isAllowedRedirectUri(r))) {
    throw new Error("客户端元数据缺少合法 redirect_uris");
  }
  const method = doc.token_endpoint_auth_method || "none";
  if (method !== "none") throw new Error(`不支持的客户端认证方式: ${method}`);
  return {
    client_id: clientIdUrl,
    client_secret_hash: null,
    client_name: typeof doc.client_name === "string" ? doc.client_name.slice(0, 120) : clientIdUrl,
    redirect_uris: uris.slice(0, 20),
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    metadataDocument: true
  };
}

function sendJson(res, status, obj, extraHeaders = {}) {
  const buf = Buffer.from(JSON.stringify(obj), "utf8");
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": buf.length,
    "Cache-Control": "no-store",
    ...extraHeaders
  });
  res.end(buf);
}

const PAGE_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": "frame-ancestors 'none'; default-src 'self'; style-src 'unsafe-inline'",
  "Cache-Control": "no-store"
};

function sendHtml(res, status, html) {
  const buf = Buffer.from(html, "utf8");
  res.writeHead(status, { ...PAGE_HEADERS, "Content-Length": buf.length });
  res.end(buf);
}

function renderErrorPage(title, detail = "") {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"/><title>${escapeHtml(title)}</title>
<style>body{font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;background:#f6f7fb;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}.card{background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:28px;max-width:380px;width:90%}h1{font-size:18px;margin:0 0 8px}.sub{font-size:13px;color:#64748b;margin:0}</style></head>
<body><div class="card"><h1>${escapeHtml(title)}</h1><p class="sub">${escapeHtml(detail)}</p></div></body></html>`;
}

function renderAuthorizePage({ client, redirectHost, hidden, error = "" }) {
  const fields = Object.entries(hidden)
    .map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}" />`)
    .join("\n");
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"/><title>Astra Gemini 授权</title>
<style>body{font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;background:#f6f7fb;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}.card{background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:28px;max-width:380px;width:90%}h1{font-size:18px;margin:0 0 6px}.sub{font-size:13px;color:#64748b;margin:0 0 18px}input[type=password]{width:100%;padding:9px 11px;border:1px solid #e2e8f0;border-radius:8px;font-size:14px;box-sizing:border-box}button{margin-top:14px;width:100%;padding:10px;background:#4f46e5;color:#fff;border:0;border-radius:8px;font-size:14px;cursor:pointer}.err{color:#dc2626;font-size:13px;margin:10px 0 0}</style></head>
<body><form class="card" method="post" action="/oauth/authorize">
<h1>授权 ${escapeHtml(client.client_name || client.client_id)}</h1>
<p class="sub">该客户端请求访问你的 Astra Gemini 代码桥（回调地址：${escapeHtml(redirectHost)}）。</p>
${fields}
<input type="password" name="password" placeholder="访问口令 (客户端 Token)" required autofocus />
<button type="submit">授权并继续</button>
${error ? `<p class="err">${escapeHtml(error)}</p>` : ""}
</form></body></html>`;
}

async function readBody(req, maxBytes = 64 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) throw new Error("Request body too large.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function createOAuthServer({
  getIssuer,
  statePath,
  verifyPassword,
  maxClients = 200,
  registerLimit = 20,
  registerWindowMs = 60 * 60 * 1000,
  fetchClientMetadata = defaultFetchClientMetadata
}) {
  const codes = new Map();
  const authFailures = [];
  const registerAttempts = [];
  const cimdCache = new Map();
  let lockoutUntil = 0;

  let state;
  function loadState() {
    const empty = { clients: [], accessTokens: {}, refreshTokens: {} };
    try {
      const raw = JSON.parse(fs.readFileSync(statePath, "utf8"));
      const s = {
        clients: Array.isArray(raw.clients) ? raw.clients : [],
        accessTokens: raw.accessTokens && typeof raw.accessTokens === "object" ? raw.accessTokens : {},
        refreshTokens: raw.refreshTokens && typeof raw.refreshTokens === "object" ? raw.refreshTokens : {}
      };
      prune(s);
      return s;
    } catch {
      return empty;
    }
  }
  state = loadState();

  function prune(s = state) {
    const now = Date.now();
    for (const [h, t] of Object.entries(s.accessTokens)) {
      if (!t || !t.exp || t.exp < now) delete s.accessTokens[h];
    }
    for (const [h, t] of Object.entries(s.refreshTokens)) {
      if (!t || !t.exp || t.exp < now) delete s.refreshTokens[h];
    }
  }

  function save() {
    prune();
    try {
      writeSecretFile(statePath, JSON.stringify(state, null, 2) + "\n");
    } catch {
      // ignore
    }
  }

  function isAccessTokenValid(token) {
    const entry = state.accessTokens[sha256hex(token)];
    return Boolean(entry && entry.exp > Date.now());
  }

  function listClients() {
    const now = Date.now();
    return state.clients.map((c) => ({
      client_id: c.client_id,
      client_name: c.client_name,
      created_at: c.created_at,
      token_endpoint_auth_method: c.token_endpoint_auth_method,
      redirect_uris: c.redirect_uris,
      activeTokens:
        Object.values(state.accessTokens).filter((t) => t.client_id === c.client_id && t.exp > now).length +
        Object.values(state.refreshTokens).filter((t) => t.client_id === c.client_id && t.exp > now).length
    }));
  }

  function revokeAll({ dropClients = false } = {}) {
    state.accessTokens = {};
    state.refreshTokens = {};
    if (dropClients) state.clients = [];
    save();
  }

  function issueTokens(clientId) {
    const access = crypto.randomBytes(32).toString("base64url");
    const refresh = crypto.randomBytes(32).toString("base64url");
    const now = Date.now();
    state.accessTokens[sha256hex(access)] = { client_id: clientId, exp: now + ACCESS_TOKEN_TTL_MS, scope: "mcp" };
    state.refreshTokens[sha256hex(refresh)] = { client_id: clientId, exp: now + REFRESH_TOKEN_TTL_MS };
    save();
    return {
      access_token: access,
      token_type: "Bearer",
      expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
      refresh_token: refresh,
      scope: "mcp"
    };
  }

  function findClient(clientId) {
    return state.clients.find((c) => c.client_id === clientId) || null;
  }

  // 解析 client_id：先查已注册客户端，再按 Client ID Metadata Document 拉取元数据。
  async function resolveClient(clientId) {
    const registered = findClient(clientId);
    if (registered) return registered;
    if (!isClientIdUrl(clientId)) return null;
    const cached = cimdCache.get(clientId);
    if (cached && cached.exp > Date.now()) {
      if (cached.client) return cached.client;
      throw cached.error;
    }
    try {
      const doc = await fetchClientMetadata(clientId);
      const client = clientFromMetadataDoc(clientId, doc);
      if (cimdCache.size > 100) cimdCache.clear();
      cimdCache.set(clientId, { client, exp: Date.now() + CIMD_CACHE_TTL_MS });
      return client;
    } catch (err) {
      cimdCache.set(clientId, { error: err, exp: Date.now() + CIMD_NEG_CACHE_TTL_MS });
      throw err;
    }
  }

  function hasActiveTokens(clientId) {
    const now = Date.now();
    return (
      Object.values(state.accessTokens).some((t) => t.client_id === clientId && t.exp > now) ||
      Object.values(state.refreshTokens).some((t) => t.client_id === clientId && t.exp > now)
    );
  }

  async function authenticateClient(req, params) {
    let clientId = params.get("client_id") || "";
    let secret = params.get("client_secret") || "";
    const auth = String(req.headers.authorization || "");
    const m = /^Basic\s+(.+)$/i.exec(auth);
    if (m) {
      const decoded = Buffer.from(m[1], "base64").toString("utf8");
      const idx = decoded.indexOf(":");
      if (idx !== -1) {
        clientId = decodeURIComponent(decoded.slice(0, idx));
        secret = decodeURIComponent(decoded.slice(idx + 1));
      }
    }
    const client = await resolveClient(clientId).catch(() => null);
    if (!client) {
      return { status: 401, body: { error: "invalid_client", error_description: "Unknown client_id." } };
    }
    if (client.token_endpoint_auth_method !== "none") {
      if (!client.client_secret_hash || !timingSafeEqualStr(sha256hex(secret), client.client_secret_hash)) {
        return {
          status: 401,
          body: { error: "invalid_client", error_description: "Client authentication failed." },
          headers: { "WWW-Authenticate": 'Basic realm="astra-gemini-oauth"' }
        };
      }
    }
    return { client };
  }

  function hiddenParams(params) {
    const hidden = {};
    for (const k of ["client_id", "redirect_uri", "response_type", "code_challenge", "code_challenge_method", "state", "scope", "resource"]) {
      const v = params.get(k);
      if (v) hidden[k] = v;
    }
    return hidden;
  }

  async function handleAuthorize(req, res, url) {
    const issuer = getIssuer(req);
    const resource = `${issuer}/mcp`;
    const params = url.searchParams;

    const failPage = (title, detail) => {
      sendHtml(res, 400, renderErrorPage(title, detail));
      return true;
    };

    const clientId = params.get("client_id") || "";
    let client;
    try {
      client = await resolveClient(clientId);
    } catch (err) {
      return failPage("授权失败", `客户端元数据校验失败：${err.message}`);
    }
    if (!client) return failPage("授权失败", "未知的 client_id。");
    const redirectUri = params.get("redirect_uri") || "";
    if (!redirectUri || !client.redirect_uris.some((r) => redirectMatches(r, redirectUri))) {
      return failPage("授权失败", "redirect_uri 未注册或不合法。");
    }

    const redirectWithError = (code, desc = "") => {
      const target = new URL(redirectUri);
      target.searchParams.set("error", code);
      if (desc) target.searchParams.set("error_description", desc);
      const st = params.get("state");
      if (st) target.searchParams.set("state", st);
      res.writeHead(302, { Location: target.toString() });
      res.end();
      return true;
    };

    if (params.get("response_type") !== "code") {
      return redirectWithError("unsupported_response_type");
    }
    const codeChallenge = params.get("code_challenge") || "";
    if (!codeChallenge || (params.get("code_challenge_method") || "") !== "S256") {
      return redirectWithError("invalid_request", "PKCE S256 code_challenge required.");
    }
    const resourceParam = params.get("resource");
    if (resourceParam && stripTrailingSlash(resourceParam) !== stripTrailingSlash(resource)) {
      return redirectWithError("invalid_target", "resource mismatch.");
    }

    const redirectHost = (() => {
      try {
        return new URL(redirectUri).host;
      } catch {
        return redirectUri;
      }
    })();

    sendHtml(
      res,
      200,
      renderAuthorizePage({
        client,
        redirectHost,
        hidden: hiddenParams(params)
      })
    );
    return true;
  }

  async function handleAuthorizePost(req, res) {
    const issuer = getIssuer(req);
    const resource = `${issuer}/mcp`;
    let params;
    try {
      params = new URLSearchParams(await readBody(req));
    } catch {
      sendHtml(res, 400, renderErrorPage("授权失败", "请求体解析失败。"));
      return true;
    }
    const get = (k) => params.get(k) || "";

    let client;
    try {
      client = await resolveClient(get("client_id"));
    } catch (err) {
      sendHtml(res, 400, renderErrorPage("授权失败", `客户端元数据校验失败：${err.message}`));
      return true;
    }
    if (!client) {
      sendHtml(res, 400, renderErrorPage("授权失败", "未知的 client_id。"));
      return true;
    }
    const redirectUri = get("redirect_uri");
    if (!redirectUri || !client.redirect_uris.some((r) => redirectMatches(r, redirectUri))) {
      sendHtml(res, 400, renderErrorPage("授权失败", "redirect_uri 未注册或不合法。"));
      return true;
    }
    const codeChallenge = get("code_challenge");
    if (!codeChallenge || get("code_challenge_method") !== "S256") {
      sendHtml(res, 400, renderErrorPage("授权失败", "缺少 PKCE code_challenge。"));
      return true;
    }
    const resourceParam = get("resource");
    if (resourceParam && stripTrailingSlash(resourceParam) !== stripTrailingSlash(resource)) {
      sendHtml(res, 400, renderErrorPage("授权失败", "resource 不匹配。"));
      return true;
    }

    if (Date.now() < lockoutUntil) {
      sendHtml(res, 429, renderErrorPage("请求过于频繁", "口令错误次数过多，请 10 分钟后再试。"));
      return true;
    }

    const page = (error) =>
      renderAuthorizePage({
        client,
        redirectHost: (() => {
          try {
            return new URL(redirectUri).host;
          } catch {
            return redirectUri;
          }
        })(),
        hidden: hiddenParams(params),
        error
      });

    if (!verifyPassword(get("password"))) {
      const now = Date.now();
      authFailures.push(now);
      while (authFailures.length && authFailures[0] < now - FAIL_WINDOW_MS) authFailures.shift();
      if (authFailures.length > FAIL_LIMIT) {
        authFailures.length = 0;
        lockoutUntil = now + FAIL_WINDOW_MS;
        sendHtml(res, 429, renderErrorPage("请求过于频繁", "口令错误次数过多，请 10 分钟后再试。"));
        return true;
      }
      sendHtml(res, 401, page("访问口令错误，请重试。"));
      return true;
    }

    const code = crypto.randomBytes(24).toString("base64url");
    codes.set(code, {
      clientId: client.client_id,
      redirectUri,
      codeChallenge,
      resource: stripTrailingSlash(resourceParam) || stripTrailingSlash(resource),
      expiresAt: Date.now() + CODE_TTL_MS
    });
    for (const [k, v] of codes) {
      if (v.expiresAt < Date.now()) codes.delete(k);
    }

    const target = new URL(redirectUri);
    target.searchParams.set("code", code);
    const st = get("state");
    if (st) target.searchParams.set("state", st);
    res.writeHead(302, { Location: target.toString() });
    res.end();
    return true;
  }

  async function handleToken(req, res) {
    let params;
    try {
      params = new URLSearchParams(await readBody(req));
    } catch {
      sendJson(res, 400, { error: "invalid_request" });
      return true;
    }

    const auth = await authenticateClient(req, params);
    if (!auth.client) {
      sendJson(res, auth.status, auth.body, auth.headers || {});
      return true;
    }
    const client = auth.client;
    const grantType = params.get("grant_type") || "";

    if (grantType === "authorization_code") {
      const code = params.get("code") || "";
      const verifier = params.get("code_verifier") || "";
      const redirectUri = params.get("redirect_uri") || "";
      const entry = codes.get(code);
      const invalid = () => {
        sendJson(res, 400, { error: "invalid_grant", error_description: "Authorization code is invalid or expired." });
        return true;
      };
      if (!entry) return invalid();
      if (entry.expiresAt < Date.now()) {
        codes.delete(code);
        return invalid();
      }
      if (entry.clientId !== client.client_id) return invalid();
      if (entry.redirectUri !== redirectUri) return invalid();
      const computed = crypto.createHash("sha256").update(verifier, "utf8").digest("base64url");
      if (computed !== entry.codeChallenge) return invalid();
      codes.delete(code);
      sendJson(res, 200, issueTokens(client.client_id));
      return true;
    }

    if (grantType === "refresh_token") {
      const hash = sha256hex(params.get("refresh_token") || "");
      const entry = state.refreshTokens[hash];
      if (!entry || entry.exp < Date.now() || entry.client_id !== client.client_id) {
        sendJson(res, 400, { error: "invalid_grant", error_description: "Refresh token is invalid or expired." });
        return true;
      }
      delete state.refreshTokens[hash];
      sendJson(res, 200, issueTokens(client.client_id));
      return true;
    }

    sendJson(res, 400, { error: "unsupported_grant_type", error_description: grantType ? `Unsupported grant_type: ${grantType}` : "Missing grant_type." });
    return true;
  }

  async function handleRequest(req, res, url) {
    const p = url.pathname;
    const issuer = getIssuer(req);
    const resource = `${issuer}/mcp`;

    if (
      req.method === "GET" &&
      (p === "/.well-known/oauth-protected-resource" || p === "/.well-known/oauth-protected-resource/mcp")
    ) {
      sendJson(res, 200, {
        resource,
        authorization_servers: [issuer],
        scopes_supported: ["mcp"],
        bearer_methods_supported: ["header"]
      });
      return true;
    }

    if (
      req.method === "GET" &&
      (p === "/.well-known/oauth-authorization-server" || p === "/.well-known/openid-configuration")
    ) {
      sendJson(res, 200, {
        issuer,
        authorization_endpoint: `${issuer}/oauth/authorize`,
        token_endpoint: `${issuer}/oauth/token`,
        registration_endpoint: `${issuer}/oauth/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
        client_id_metadata_document_supported: true,
        scopes_supported: ["mcp"]
      });
      return true;
    }

    if (req.method === "POST" && p === "/oauth/register") {
      const now = Date.now();
      while (registerAttempts.length && registerAttempts[0] <= now - registerWindowMs) {
        registerAttempts.shift();
      }
      if (registerAttempts.length >= registerLimit) {
        sendJson(res, 429, {
          error: "temporarily_unavailable",
          error_description: "Too many registration requests, please try again later."
        });
        return true;
      }
      registerAttempts.push(now);

      let body;
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        sendJson(res, 400, { error: "invalid_client_metadata", error_description: "Invalid JSON body." });
        return true;
      }
      const uris = Array.isArray(body?.redirect_uris) ? body.redirect_uris : [];
      if (!uris.length || uris.some((u) => typeof u !== "string" || !isAllowedRedirectUri(u))) {
        sendJson(res, 400, {
          error: "invalid_redirect_uri",
          error_description: "redirect_uris must be https:// or http://localhost|127.0.0.1."
        });
        return true;
      }
      const method = ["none", "client_secret_post", "client_secret_basic"].includes(body.token_endpoint_auth_method)
        ? body.token_endpoint_auth_method
        : "client_secret_basic";
      const clientId = `mcp_${crypto.randomBytes(16).toString("hex")}`;
      const clientSecret = method === "none" ? null : crypto.randomBytes(24).toString("base64url");
      const client = {
        client_id: clientId,
        client_secret_hash: clientSecret ? sha256hex(clientSecret) : null,
        client_name: typeof body.client_name === "string" ? body.client_name.slice(0, 120) : "",
        redirect_uris: uris.slice(0, 20),
        token_endpoint_auth_method: method,
        grant_types: ["authorization_code", "refresh_token"],
        created_at: Date.now()
      };
      if (state.clients.length >= maxClients) {
        const victimIdx = state.clients.findIndex((c) => !hasActiveTokens(c.client_id));
        if (victimIdx === -1) {
          sendJson(res, 429, {
            error: "temporarily_unavailable",
            error_description: "Client registry is full and all clients hold active tokens."
          });
          return true;
        }
        state.clients.splice(victimIdx, 1);
      }
      state.clients.push(client);
      save();
      sendJson(res, 201, {
        client_id: clientId,
        ...(clientSecret ? { client_secret: clientSecret } : {}),
        client_id_issued_at: Math.floor(client.created_at / 1000),
        client_secret_expires_at: 0,
        redirect_uris: client.redirect_uris,
        token_endpoint_auth_method: method,
        grant_types: client.grant_types,
        response_types: ["code"],
        client_name: client.client_name
      });
      return true;
    }

    if (req.method === "GET" && p === "/oauth/authorize") {
      return handleAuthorize(req, res, url);
    }
    if (req.method === "POST" && p === "/oauth/authorize") {
      return handleAuthorizePost(req, res);
    }
    if (req.method === "POST" && p === "/oauth/token") {
      return handleToken(req, res);
    }
    return false;
  }

  return { handleRequest, isAccessTokenValid, listClients, revokeAll };
}
