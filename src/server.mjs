import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { deleteProject, getProject, listProjects, upsertProject } from "./registry.mjs";
import { pullSnapshot } from "./snapshot.mjs";
import { applyPatch, listBackups, rollbackBackup } from "./patch.mjs";
import { execVerify, listGlobalSdkCatalog, listSdks } from "./sdk-loader.mjs";
import { loadSettings, saveSettings } from "./settings.mjs";
import { checkEnvironment, createTunnelManager } from "./tunnel.mjs";
import { createTreeManager, PROTOCOL_VERSION } from "./tree.mjs";
import { createOAuthServer } from "./oauth.mjs";
import { loadIdentity } from "./identity.mjs";
import { createRemoteManager } from "./remote.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_BRIDGE_ROOT = path.resolve(__dirname, "..");
const UI_HTML_PATH = path.join(__dirname, "ui.html");

const MCP_PROTOCOL_VERSION = "2025-03-26";
const SERVER_INFO = { name: "astra-gemini", version: "0.1.0" };

const TOOLS = [
  {
    name: "list_projects",
    description: "List all registered local projects and online subtree projects across connected Astra Gemini nodes.",
    annotations: { readOnlyHint: true },
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "pull_snapshot",
    description: "Pull a filtered text code snapshot with bundleSha256 and optional incremental deduplication via knownHashes (SHA-256 or MD5).",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      required: ["project"],
      properties: {
        project: { type: "string", description: "Project alias (or '<childNode>/<project>' for subtree nodes)." },
        paths: { type: "array", items: { type: "string" }, description: "Optional glob/path filters for incremental pull." },
        knownHashes: {
          type: "object",
          description: "Optional map of { relPath: sha256OrMd5Hex } already cached by caller; unchanged files are skipped and removed files are reported in `deleted`."
        },
        includeContent: { type: "boolean", description: "Include file contents (default true; set false to list paths/hashes only)." },
        maxFiles: { type: "number", description: "Max files to return (default 200)." },
        maxTotalBytes: { type: "number", description: "Max total UTF-8 bytes to return (default 2000000)." }
      }
    }
  },
  {
    name: "apply_patch",
    description: "Validate (optional patchSha256 + expectedHashes optimistic lock + git apply --check), auto-backup, apply a unified diff patch, and return postHashes.",
    annotations: { readOnlyHint: false, destructiveHint: true },
    inputSchema: {
      type: "object",
      required: ["project", "patch"],
      properties: {
        project: { type: "string", description: "Project alias (or '<childNode>/<project>' for subtree nodes)." },
        patch: { type: "string", description: "Unified diff patch content." },
        patchSha256: { type: "string", description: "Optional SHA-256 (or MD5) checksum of the patch text to verify transport integrity." },
        expectedHashes: {
          type: "object",
          description: "Optional optimistic lock map { relPath: sha256OrMd5Hex | null }; rejects patch if local files diverged."
        },
        dryRun: { type: "boolean", description: "If true, only validate without modifying files." }
      }
    }
  },
  {
    name: "list_sdks",
    description: "Hot-reload and list all verification SDKs currently enabled for a local or subtree project.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      required: ["project"],
      properties: {
        project: { type: "string", description: "Project alias (or '<childNode>/<project>' for subtree nodes)." }
      }
    }
  },
  {
    name: "exec_verify",
    description: "Execute a short async JS verification script in a permission-sandboxed process on the target node with ONLY its enabled `sdk` namespace. Every `sdk.*` call crosses an IPC boundary and returns a Promise, so all calls must be awaited.",
    annotations: { readOnlyHint: false },
    inputSchema: {
      type: "object",
      required: ["project", "script"],
      properties: {
        project: { type: "string", description: "Project alias (or '<childNode>/<project>' for subtree nodes)." },
        script: { type: "string", description: "Async JS body using `await sdk.<name>.<fn>(...)` (all sdk calls return Promises) and returning a compact summary." },
        timeoutMs: { type: "number", description: "Execution timeout in ms (default 30000, max 120000)." },
        maxOutputBytes: { type: "number", description: "Output/log cap in bytes (default 8192)." }
      }
    }
  }
];

function sendJson(req, res, status, obj, extraHeaders = {}) {
  const rawBuf = Buffer.from(JSON.stringify(obj), "utf8");
  const acceptEnc = String(req?.headers?.["accept-encoding"] || "");
  if (rawBuf.length > 1024 && /\bgzip\b/i.test(acceptEnc)) {
    const gz = zlib.gzipSync(rawBuf, { level: 6 });
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Encoding": "gzip",
      Vary: "Accept-Encoding",
      "Content-Length": gz.length,
      ...extraHeaders
    });
    res.end(gz);
    return;
  }
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": rawBuf.length,
    ...extraHeaders
  });
  res.end(rawBuf);
}

function sendRaw(req, res, status, bodyText, extraHeaders = {}) {
  const rawBuf = Buffer.from(String(bodyText), "utf8");
  const acceptEnc = String(req?.headers?.["accept-encoding"] || "");
  if (rawBuf.length > 1024 && /\bgzip\b/i.test(acceptEnc)) {
    const gz = zlib.gzipSync(rawBuf, { level: 6 });
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Encoding": "gzip",
      Vary: "Accept-Encoding",
      "Content-Length": gz.length,
      ...extraHeaders
    });
    res.end(gz);
    return;
  }
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": rawBuf.length,
    ...extraHeaders
  });
  res.end(rawBuf);
}

async function readBody(req, maxBytes = 10 * 1024 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) throw new Error("Request body too large.");
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks);
  if (/gzip/i.test(String(req.headers["content-encoding"] || ""))) {
    return zlib.gunzipSync(raw).toString("utf8");
  }
  return raw.toString("utf8");
}

function isDirectLocalhost(req) {
  if (req.headers["cf-connecting-ip"] || req.headers["x-forwarded-for"] || req.headers["cf-ray"]) {
    return false;
  }
  const addr = req.socket?.remoteAddress || "";
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

function adminHostName(hostHeader) {
  const host = String(hostHeader || "").trim();
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    return end === -1 ? "" : host.slice(1, end);
  }
  if (host.indexOf(":") !== host.lastIndexOf(":")) return host;
  return host.split(":")[0];
}

async function executeLocalTool(bridgeRoot, projectsConfigPath, name, args = {}) {
  if (name === "list_projects") {
    return listProjects(projectsConfigPath);
  }
  const projectCfg = getProject(projectsConfigPath, args.project);
  switch (name) {
    case "pull_snapshot":
      return pullSnapshot(projectCfg, args);
    case "apply_patch":
      return applyPatch(bridgeRoot, projectCfg, args);
    case "list_sdks":
      return listSdks(bridgeRoot, projectCfg);
    case "exec_verify":
      return execVerify(bridgeRoot, projectCfg, args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export function createBridgeServer(options = {}) {
  const bridgeRoot = path.resolve(options.bridgeRoot || process.env.ASTRA_BRIDGE_ROOT || process.env.KIMI_BRIDGE_ROOT || DEFAULT_BRIDGE_ROOT);
  const projectsConfigPath = path.resolve(
    options.projectsConfigPath || process.env.ASTRA_PROJECTS_CONFIG || process.env.KIMI_PROJECTS_CONFIG || path.join(bridgeRoot, "projects.json")
  );
  const port = Number(options.port || process.env.PORT || 3939);
  const authMode = options.authMode ?? process.env.AUTH_MODE ?? "bearer";
  const authToken = options.authToken ?? process.env.ASTRA_TOKEN ?? process.env.KIMI_BRIDGE_TOKEN ?? "";
  const joinToken = options.joinToken ?? process.env.ASTRA_JOIN_TOKEN ?? "";
  const fixedNodeId = options.nodeId || process.env.ASTRA_NODE_ID || null;
  const startedAt = Date.now();
  const recentLogs = [];
  const tunnel = createTunnelManager(port, () => loadSettings(bridgeRoot).tunnel);

  if (authMode === "bearer" && !authToken) {
    throw new Error("AUTH_MODE=bearer requires ASTRA_TOKEN (or KIMI_BRIDGE_TOKEN) to be set.");
  }

  function recordLog(event, detail = "") {
    recentLogs.unshift({
      time: new Date().toLocaleTimeString("zh-CN", { hour12: false }),
      event,
      detail: String(detail).slice(0, 200)
    });
    if (recentLogs.length > 60) recentLogs.length = 60;
  }

  const nodesFilePath = path.join(bridgeRoot, "nodes.json");
  function loadNodeBindings() {
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(nodesFilePath, "utf8"));
    } catch {
      return {};
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const out = {};
    let migrated = false;
    for (const [k, v] of Object.entries(raw)) {
      if (typeof v === "string") {
        out[k] = { secretHash: v };
        migrated = true;
      } else if (v && typeof v === "object" && typeof v.secretHash === "string") {
        out[k] = { secretHash: v.secretHash };
      }
    }
    if (migrated) {
      try {
        fs.writeFileSync(nodesFilePath, JSON.stringify(out, null, 2) + "\n", "utf8");
      } catch {
        // ignore
      }
    }
    return out;
  }
  function saveNodeBindings(all) {
    fs.writeFileSync(nodesFilePath, JSON.stringify(all, null, 2) + "\n", "utf8");
  }
  const nodeStore = {
    get(nodeId) {
      return loadNodeBindings()[nodeId] || null;
    },
    set(nodeId, hash) {
      const all = loadNodeBindings();
      all[nodeId] = { secretHash: hash };
      saveNodeBindings(all);
    },
    delete(nodeId) {
      const all = loadNodeBindings();
      if (Object.hasOwn(all, nodeId)) {
        delete all[nodeId];
        saveNodeBindings(all);
      }
    }
  };

  function getIssuer(req) {
    const s = loadSettings(bridgeRoot);
    const configured =
      options.publicUrl ||
      process.env.ASTRA_PUBLIC_URL ||
      s.publicUrl ||
      (s.tunnel && s.tunnel.mode === "named" ? s.tunnel.publicUrl : "") ||
      "";
    if (configured) return configured.replace(/\/+$/, "");
    const host = String(req?.headers?.host || "localhost");
    const fwd = String(req?.headers?.["x-forwarded-proto"] || "").split(",")[0].trim().toLowerCase();
    let proto = fwd === "http" || fwd === "https" ? fwd : null;
    if (!proto && (req?.headers?.["cf-ray"] || req?.headers?.["cf-visitor"])) {
      proto = "https";
    }
    if (!proto) proto = "http";
    const hostName = adminHostName(host).toLowerCase();
    if (!warnedIssuerFallback && !["127.0.0.1", "localhost", "::1"].includes(hostName)) {
      warnedIssuerFallback = true;
      recordLog("未配置 publicUrl", "OAuth issuer 由请求 Host 推断，请在设置中配置公网地址");
    }
    return `${proto}://${host}`;
  }

  const oauth = createOAuthServer({
    getIssuer,
    statePath: path.join(bridgeRoot, "oauth-state.json"),
    verifyPassword: (pw) => tokenEqual(authToken, pw),
    maxClients: options.oauthMaxClients,
    registerLimit: options.oauthRegisterLimit,
    registerWindowMs: options.oauthRegisterWindowMs
  });

  function tokenEqual(expected, actual) {
    const a = Buffer.from(String(expected ?? ""), "utf8");
    const b = Buffer.from(String(actual ?? ""), "utf8");
    return a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  function bearerToken(req) {
    const match = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || "");
    return match ? match[1] : null;
  }

  function isClientAuthorized(req) {
    if (authMode === "none") return true;
    const token = bearerToken(req);
    if (!token) return false;
    if (tokenEqual(authToken, token)) return true;
    return oauth.isAccessTokenValid(token);
  }

  function isJoinAuthorized(req) {
    if (authMode === "none") return true;
    const token = bearerToken(req);
    if (!token || !joinToken) return false;
    return tokenEqual(joinToken, token);
  }

  let serverRef = null;
  let warnedNoJoinToken = false;
  let warnedIssuerFallback = false;

  const tree = createTreeManager({
    getNodeId: () => fixedNodeId || loadSettings(bridgeRoot).nodeId,
    getLocalProjects: (opts) => listProjects(projectsConfigPath, opts),
    executeLocalTool: (tool, args) => executeLocalTool(bridgeRoot, projectsConfigPath, tool, args),
    getNodeSecret: () => loadSettings(bridgeRoot).nodeSecret,
    isDirectEnabled: () => (options.directEnabled ?? loadSettings(bridgeRoot).directEnabled) !== false,
    nodeStore,
    protocolVersion: options.protocolVersion ?? PROTOCOL_VERSION,
    heartbeatIntervalMs: options.heartbeatIntervalMs ?? 25_000,
    directTimeoutMs: options.directTimeoutMs ?? 1500,
    directRetryCooldownMs: options.directRetryCooldownMs ?? 60_000,
    relayBaseTimeoutMs: options.relayBaseTimeoutMs ?? 60_000,
    getDirectCandidates: () => {
      if (Array.isArray(options.directCandidates)) return options.directCandidates;
      const list = [];
      const actualPort = serverRef?.address?.()?.port || port;
      const tStatus = tunnel.status();
      if (tStatus.publicUrl) {
        list.push(tStatus.publicUrl.replace(/^https:\/\//i, "wss://") + "/ws/direct");
      }
      if ((options.advertiseLan ?? loadSettings(bridgeRoot).advertiseLan) !== false) {
        list.push(...tree.listLocalLanCandidates(actualPort));
      }
      return list;
    },
    onLog: recordLog
  });

  const initialUpstream = options.upstream || loadSettings(bridgeRoot).upstream;
  if (initialUpstream?.enabled && initialUpstream?.url) {
    tree.connectUpstream(initialUpstream);
  }

  async function handleMcp({ headers = {}, bodyText = "" } = {}) {
    const respond = (status, obj, extraHeaders = {}) => ({
      status,
      headers: extraHeaders,
      bodyText: JSON.stringify(obj)
    });
    if (!isClientAuthorized({ headers })) {
      return respond(401, { error: "Unauthorized" }, {
        "WWW-Authenticate": `Bearer resource_metadata="${getIssuer({ headers })}/.well-known/oauth-protected-resource/mcp"`
      });
    }
    let msg;
    try {
      msg = JSON.parse(bodyText);
    } catch (err) {
      return respond(400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: err.message } });
    }
    const { id = null, method, params } = msg || {};
    if (method === "notifications/initialized" || (id === null && method?.startsWith("notifications/"))) {
      return { status: 202, headers: {}, bodyText: "" };
    }
    try {
      if (method === "initialize") {
        recordLog("MCP 握手", "客户端已连接");
        return respond(200, {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: SERVER_INFO
          }
        });
      }
      if (method === "ping") {
        return respond(200, { jsonrpc: "2.0", id, result: {} });
      }
      if (method === "tools/list") {
        return respond(200, { jsonrpc: "2.0", id, result: { tools: TOOLS } });
      }
      if (method === "tools/call") {
        const toolName = params?.name;
        const toolArgs = params?.arguments || {};
        recordLog("MCP 调用", `${toolName}${toolArgs.project ? ` (${toolArgs.project})` : ""}`);
        try {
          const data = await tree.routeToolCall(toolName, toolArgs);
          return respond(200, {
            jsonrpc: "2.0",
            id,
            result: {
              content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
              structuredContent: data,
              isError: data?.ok === false
            }
          });
        } catch (toolErr) {
          recordLog("调用失败", `${toolName}: ${toolErr.message}`);
          return respond(200, {
            jsonrpc: "2.0",
            id,
            result: {
              content: [{ type: "text", text: JSON.stringify({ ok: false, error: toolErr.message }) }],
              isError: true
            }
          });
        }
      }
      return respond(200, {
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Method not found: ${method}` }
      });
    } catch (err) {
      return respond(500, {
        jsonrpc: "2.0",
        id,
        error: { code: -32603, message: err.message }
      });
    }
  }

  const server = http.createServer(async (req, res) => {
    let url;
    try {
      url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    } catch {
      url = new URL(req.url || "/", "http://localhost");
    }

    if (req.method === "GET" && url.pathname === "/health") {
      sendJson(req, res, 200, {
        ok: true,
        ...SERVER_INFO,
        nodeId: fixedNodeId || loadSettings(bridgeRoot).nodeId,
        authMode,
        protocolVersion: options.protocolVersion ?? PROTOCOL_VERSION,
        uptimeSec: Math.floor((Date.now() - startedAt) / 1000)
      });
      return;
    }

    if (url.pathname.startsWith("/.well-known/") || url.pathname.startsWith("/oauth/")) {
      const handled = await oauth.handleRequest(req, res, url);
      if (!handled) {
        sendJson(req, res, 404, { error: "Not found." });
      }
      return;
    }

    if (
      url.pathname === "/" ||
      url.pathname === "/ui" ||
      url.pathname.startsWith("/api/") ||
      url.pathname.startsWith("/remote/")
    ) {
      if (!isDirectLocalhost(req)) {
        sendJson(req, res, 403, { error: "管理控制台仅允许本机 (127.0.0.1) 访问，已拦截外部隧道请求。" });
        return;
      }

      const hostHeader = String(req.headers.host || "");
      const hostName = adminHostName(hostHeader).toLowerCase();
      if (!["127.0.0.1", "localhost", "::1"].includes(hostName)) {
        sendJson(req, res, 403, { error: "管理控制台仅允许本机 (127.0.0.1) 访问，已拦截非法 Host 请求。" });
        return;
      }
      if (req.headers.origin !== undefined && req.headers.origin !== `http://${hostHeader}`) {
        sendJson(req, res, 403, { error: "管理控制台已拦截跨站请求 (Origin 校验失败)。" });
        return;
      }
      if (req.headers["sec-fetch-site"] === "cross-site") {
        sendJson(req, res, 403, { error: "管理控制台已拦截跨站请求 (Sec-Fetch-Site: cross-site)。" });
        return;
      }

      if (url.pathname.startsWith("/remote/")) {
        if (req.method !== "POST") {
          sendJson(req, res, 405, { error: "Method not allowed. Use POST /remote/<target>/mcp." });
          return;
        }
        const targetMatch = /^\/remote\/([^/]+)\/mcp\/?$/.exec(url.pathname);
        if (!targetMatch) {
          sendJson(req, res, 404, { error: "Not found. Use POST /remote/<target>/mcp." });
          return;
        }
        let remoteBody;
        try {
          remoteBody = await readBody(req);
        } catch (err) {
          sendJson(req, res, 400, { error: err.message });
          return;
        }
        const fwdHeaders = {};
        for (const h of ["authorization", "content-type", "accept", "mcp-protocol-version"]) {
          if (req.headers[h] !== undefined) fwdHeaders[h] = req.headers[h];
        }
        const remoteRes = await remote.proxyRequest(decodeURIComponent(targetMatch[1]), fwdHeaders, remoteBody);
        sendRaw(req, res, remoteRes.status, remoteRes.bodyText, remoteRes.headers);
        return;
      }

      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/ui")) {
        if (!fs.existsSync(UI_HTML_PATH)) {
          sendJson(req, res, 404, { error: "UI page not found." });
          return;
        }
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(fs.readFileSync(UI_HTML_PATH, "utf8"));
        return;
      }

      try {
        if (req.method === "GET" && url.pathname === "/api/status") {
          const catalog = await listGlobalSdkCatalog(bridgeRoot);
          const settings = loadSettings(bridgeRoot);
          const safeSettings = {
            ...settings,
            nodeSecret: undefined,
            tunnel: {
              mode: settings.tunnel?.mode || "quick",
              publicUrl: settings.tunnel?.publicUrl || "",
              hasToken: Boolean(settings.tunnel?.token)
            }
          };
          sendJson(req, res, 200, {
            ok: true,
            server: SERVER_INFO,
            localMcpUrl: `http://127.0.0.1:${port}/mcp`,
            localWsUrl: `ws://127.0.0.1:${port}/ws/tree`,
            authMode,
            authToken,
            joinToken,
            hasJoinToken: Boolean(joinToken) || authMode === "none",
            publicUrl: getIssuer(req),
            uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
            settings: safeSettings,
            projects: listProjects(projectsConfigPath, { includeRoot: true }),
            sdks: catalog.sdks || [],
            backups: listBackups(bridgeRoot),
            tunnel: { ...tunnel.status(), hasToken: Boolean(settings.tunnel?.token) },
            tree: tree.getTreeStatus(),
            logs: recentLogs
          });
          return;
        }

        if (req.method === "GET" && url.pathname === "/api/env") {
          sendJson(req, res, 200, { ok: true, env: checkEnvironment() });
          return;
        }

        if (req.method === "POST" && url.pathname === "/api/sdks/toggle") {
          const body = JSON.parse(await readBody(req));
          const { name, enabled } = body || {};
          if (!name || typeof enabled !== "boolean") {
            sendJson(req, res, 400, { ok: false, error: "需要 name 和 enabled(boolean)。" });
            return;
          }
          const updated = saveSettings(bridgeRoot, { globalSdkEnabled: { [name]: enabled } });
          recordLog("SDK 开关", `${name} -> ${enabled ? "已开启" : "已关闭"}`);
          sendJson(req, res, 200, { ok: true, settings: updated });
          return;
        }

        if (req.method === "POST" && url.pathname === "/api/projects") {
          const body = JSON.parse(await readBody(req));
          const saved = upsertProject(projectsConfigPath, body.project, body);
          recordLog("保存项目", `${body.project} (${saved.mode})`);
          tree.pushRegistrationToUpstream();
          sendJson(req, res, 200, { ok: true, project: body.project, entry: saved });
          return;
        }

        if (req.method === "DELETE" && url.pathname.startsWith("/api/projects/")) {
          const pid = decodeURIComponent(url.pathname.slice("/api/projects/".length));
          const removed = deleteProject(projectsConfigPath, pid);
          recordLog("移除项目", pid);
          tree.pushRegistrationToUpstream();
          sendJson(req, res, 200, { ok: true, removed });
          return;
        }

        if (req.method === "POST" && url.pathname === "/api/backups/rollback") {
          const body = JSON.parse(await readBody(req));
          const projectCfg = getProject(projectsConfigPath, body.project);
          const result = rollbackBackup(bridgeRoot, projectCfg, body.backupId);
          recordLog("一键还原", `${body.project} <- ${body.backupId}`);
          sendJson(req, res, 200, result);
          return;
        }

        if (req.method === "DELETE" && url.pathname.startsWith("/api/tree/children/")) {
          const nid = decodeURIComponent(url.pathname.slice("/api/tree/children/".length));
          const removed = tree.removeChild(nid);
          recordLog("移除子节点", nid);
          sendJson(req, res, 200, { ok: true, removed });
          return;
        }

        if (req.method === "GET" && url.pathname === "/api/oauth") {
          sendJson(req, res, 200, { ok: true, issuer: getIssuer(req), clients: oauth.listClients() });
          return;
        }

        if (req.method === "POST" && url.pathname === "/api/oauth/revoke-all") {
          let body = {};
          try {
            body = JSON.parse(await readBody(req));
          } catch {
            body = {};
          }
          oauth.revokeAll({ dropClients: Boolean(body?.dropClients) });
          recordLog("OAuth 撤销", body?.dropClients ? "已清空全部令牌与客户端" : "已撤销全部访问令牌");
          sendJson(req, res, 200, { ok: true });
          return;
        }

        if (req.method === "POST" && url.pathname === "/api/tunnel/config") {
          const body = JSON.parse(await readBody(req));
          const mode = body.mode === "named" ? "named" : "quick";
          const prevTunnel = loadSettings(bridgeRoot).tunnel || {};
          const tunnelCfg = {
            mode,
            token: typeof body.token === "string" ? body.token.trim() : prevTunnel.token || "",
            publicUrl: typeof body.publicUrl === "string" ? body.publicUrl.trim() : prevTunnel.publicUrl || ""
          };
          saveSettings(bridgeRoot, { tunnel: tunnelCfg });
          recordLog("隧道配置", `模式=${mode}${tunnelCfg.publicUrl ? ` (${tunnelCfg.publicUrl})` : ""}`);
          sendJson(req, res, 200, {
            ok: true,
            tunnel: { mode, publicUrl: tunnelCfg.publicUrl, hasToken: Boolean(tunnelCfg.token) }
          });
          return;
        }

        if (req.method === "POST" && url.pathname === "/api/settings") {
          const body = JSON.parse(await readBody(req));
          const patch = {};
          if (typeof body.directEnabled === "boolean") patch.directEnabled = body.directEnabled;
          if (typeof body.advertiseLan === "boolean") patch.advertiseLan = body.advertiseLan;
          if (typeof body.publicUrl === "string") patch.publicUrl = body.publicUrl.trim();
          if (body.p2p && typeof body.p2p === "object") {
            const p2p = { ...(loadSettings(bridgeRoot).p2p || {}) };
            if (typeof body.p2p.enabled === "boolean") p2p.enabled = body.p2p.enabled;
            if (typeof body.p2p.upnp === "boolean") p2p.upnp = body.p2p.upnp;
            patch.p2p = p2p;
          }
          if (Object.keys(patch).length) {
            saveSettings(bridgeRoot, patch);
            recordLog("设置更新", Object.keys(patch).join(", "));
          }
          sendJson(req, res, 200, { ok: true });
          return;
        }

        if (req.method === "POST" && url.pathname === "/api/tree/upstream") {
          const body = JSON.parse(await readBody(req));
          const nextNodeId = typeof body.nodeId === "string" && body.nodeId.trim()
            ? body.nodeId.trim()
            : loadSettings(bridgeRoot).nodeId;
          if (!/^[a-zA-Z0-9_-]{1,48}$/.test(nextNodeId)) {
            sendJson(req, res, 400, { ok: false, error: "节点名只能包含字母、数字、短横线或下划线。" });
            return;
          }
          const upstream = {
            enabled: Boolean(body.enabled),
            url: typeof body.url === "string" ? body.url.trim() : "",
            token: typeof body.token === "string" ? body.token.trim() : ""
          };
          saveSettings(bridgeRoot, { nodeId: nextNodeId, upstream });
          if (upstream.enabled && upstream.url) {
            tree.connectUpstream(upstream);
            recordLog("连接上游", `${nextNodeId} -> ${upstream.url}`);
          } else {
            tree.disconnectUpstream();
            recordLog("断开上游", "已转为独立节点");
          }
          sendJson(req, res, 200, { ok: true, tree: tree.getTreeStatus() });
          return;
        }

        if (req.method === "POST" && url.pathname === "/api/tunnel/start") {
          const resStart = tunnel.start();
          recordLog("隧道启动", resStart.ok ? "正在拉起 cloudflared" : resStart.error);
          sendJson(req, res, 200, resStart);
          return;
        }

        if (req.method === "POST" && url.pathname === "/api/tunnel/stop") {
          const resStop = tunnel.stop();
          recordLog("隧道停止", "已关闭 cloudflared");
          sendJson(req, res, 200, { ok: true, ...resStop });
          return;
        }

        if (req.method === "GET" && url.pathname === "/api/remote") {
          sendJson(req, res, 200, remote.getStatus());
          return;
        }

        if (req.method === "POST" && url.pathname === "/api/rendezvous") {
          const body = JSON.parse(await readBody(req));
          const current = loadSettings(bridgeRoot).rendezvous || {};
          const rendezvous = {
            enabled: Boolean(body.enabled),
            url: typeof body.url === "string" ? body.url.trim() : current.url,
            token: typeof body.token === "string" ? body.token.trim() : current.token
          };
          saveSettings(bridgeRoot, { rendezvous });
          remote.reconnectRendezvous();
          recordLog("牵线服务", rendezvous.enabled && rendezvous.url ? `已连接配置 ${rendezvous.url}` : "已停用");
          sendJson(req, res, 200, { ok: true, hasToken: !!rendezvous.token, remote: remote.getStatus().rendezvous });
          return;
        }

        if (req.method === "POST" && url.pathname === "/api/remote/aliases") {
          const body = JSON.parse(await readBody(req));
          const alias = String(body.alias || "").trim();
          if (!/^[a-zA-Z0-9_-]{1,48}$/.test(alias)) {
            sendJson(req, res, 400, { ok: false, error: "别名只能包含字母、数字、短横线或下划线（1-48 字符）。" });
            return;
          }
          const remotes = { ...(loadSettings(bridgeRoot).remotes || {}) };
          if (body.address == null || body.address === "") {
            delete remotes[alias];
          } else {
            const addr = String(body.address).trim();
            if (!/^ag1-[a-z2-7]{32}$/.test(addr)) {
              sendJson(req, res, 400, { ok: false, error: "节点地址格式应为 ag1- 开头的 32 位 base32。" });
              return;
            }
            remotes[alias] = addr;
          }
          saveSettings(bridgeRoot, { remotes });
          sendJson(req, res, 200, { ok: true, remotes });
          return;
        }

        if (req.method === "POST" && url.pathname === "/api/remote/allow") {
          const body = JSON.parse(await readBody(req));
          const list = Array.isArray(body.addresses) ? body.addresses.map(String) : null;
          if (!list || list.some((a) => !/^ag1-[a-z2-7]{32}$/.test(a))) {
            sendJson(req, res, 400, { ok: false, error: "地址列表每项都应为 ag1- 节点地址。" });
            return;
          }
          saveSettings(bridgeRoot, { remoteAllowFrom: list });
          sendJson(req, res, 200, { ok: true, remoteAllowFrom: list });
          return;
        }

        sendJson(req, res, 404, { ok: false, error: "Unknown admin API route." });
      } catch (err) {
        sendJson(req, res, 400, { ok: false, error: err.message });
      }
      return;
    }

    if (url.pathname !== "/mcp") {
      sendJson(req, res, 404, { error: "Not found. Use POST /mcp, WS /ws/tree, WS /ws/direct, GET /health, or open /ui on localhost." });
      return;
    }

    if (!isClientAuthorized(req)) {
      sendJson(req, res, 401, { error: "Unauthorized" }, {
        "WWW-Authenticate": `Bearer resource_metadata="${getIssuer(req)}/.well-known/oauth-protected-resource/mcp"`
      });
      return;
    }

    if (req.method !== "POST") {
      sendJson(req, res, 405, { error: "Method not allowed. Use POST /mcp." });
      return;
    }

    let mcpBody;
    try {
      mcpBody = await readBody(req);
    } catch (err) {
      sendJson(req, res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: err.message } });
      return;
    }
    const mcpRes = await handleMcp({ headers: req.headers, bodyText: mcpBody });
    sendRaw(req, res, mcpRes.status, mcpRes.bodyText, mcpRes.headers);
  });

  serverRef = server;

  const remote = createRemoteManager({
    identity: loadIdentity(bridgeRoot),
    handleMcp,
    onLog: recordLog,
    getRendezvous: () => loadSettings(bridgeRoot).rendezvous,
    getP2p: () => loadSettings(bridgeRoot).p2p,
    getRemotes: () => loadSettings(bridgeRoot).remotes || {},
    getRemoteAllowFrom: () => loadSettings(bridgeRoot).remoteAllowFrom || [],
    getAuthMode: () => authMode,
    p2pPort: options.p2pPort ?? null,
    p2pCandidates: options.p2pCandidates ?? null,
    upnp: options.upnp ?? true,
    p2pDirectWindowMs: options.p2pDirectWindowMs ?? 2000,
    channelIdleMs: options.channelIdleMs ?? 300_000,
    channelPingMs: options.channelPingMs ?? null,
    idleSweepMs: options.idleSweepMs ?? 60_000,
    rendezvous: options.rendezvous ?? null
  });
  server.on("close", () => remote.shutdown());

  server.on("upgrade", (req, socket, head) => {
    let url;
    try {
      url = new URL(req.url || "/", "http://localhost");
    } catch {
      socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
      socket.destroy();
      return;
    }
    if (url.pathname === "/ws/direct") {
      tree.handleDirectUpgrade(req, socket, head);
      return;
    }
    if (url.pathname !== "/ws/tree") {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }
    if (!isJoinAuthorized(req)) {
      if (!joinToken && authMode !== "none" && !warnedNoJoinToken) {
        warnedNoJoinToken = true;
        recordLog("入网关闭", "未配置 ASTRA_JOIN_TOKEN，/ws/tree 已拒绝全部连接");
      }
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    tree.handleChildUpgrade(req, socket, head);
  });

  const origClose = server.close.bind(server);
  server.close = (...args) => {
    tunnel.stop();
    tree.shutdown();
    const res = origClose(...args);
    if (typeof server.closeAllConnections === "function") {
      server.closeAllConnections();
    }
    return res;
  };

  server.tree = tree;
  return server;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const host = process.env.HOST || "127.0.0.1";
  const port = Number(process.env.PORT || 3939);
  const server = createBridgeServer({ port });
  server.listen(port, host, () => {
    console.log(`[astra-gemini] MCP: http://${host}:${port}/mcp | WS Tree: ws://${host}:${port}/ws/tree | GUI: http://${host}:${port}/ui`);
  });
}
