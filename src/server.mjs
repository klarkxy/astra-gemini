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
import { loadIdentity } from "./identity.mjs";
import { createRemoteManager } from "./remote.mjs";
import { hardenSecretFiles, writeSecretFile } from "./secure-file.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_BRIDGE_ROOT = path.resolve(__dirname, "..");
const UI_HTML_PATH = path.join(__dirname, "ui.html");

const MCP_PROTOCOL_VERSION = "2025-03-26";
const SERVER_INFO = { name: "astra-gemini", version: "0.1.0" };
const ADMIN_WINDOW_MS = 10 * 60 * 1000;
const ADMIN_FAIL_LIMIT = 10;
const PUBLIC_UI_HEADERS = {
  "Content-Security-Policy": "frame-ancestors 'none'",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store"
};

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
  let authToken = options.authToken ?? process.env.ASTRA_TOKEN ?? process.env.KIMI_BRIDGE_TOKEN ?? "";
  let joinToken = options.joinToken ?? process.env.ASTRA_JOIN_TOKEN ?? "";
  let adminKey = options.adminKey ?? process.env.ASTRA_ADMIN_KEY ?? "";
  const fixedNodeId = options.nodeId || null;
  hardenSecretFiles(bridgeRoot);
  const startedAt = Date.now();
  const recentLogs = [];
  const adminFailures = [];
  let adminLockUntil = 0;
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
        writeSecretFile(nodesFilePath, JSON.stringify(out, null, 2) + "\n");
      } catch {
        // ignore
      }
    }
    return out;
  }
  function saveNodeBindings(all) {
    writeSecretFile(nodesFilePath, JSON.stringify(all, null, 2) + "\n");
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

  function configuredPublicUrl() {
    const s = loadSettings(bridgeRoot);
    const configured =
      options.publicUrl ||
      s.publicUrl ||
      process.env.ASTRA_PUBLIC_URL ||
      (s.tunnel && s.tunnel.mode === "named" ? s.tunnel.publicUrl : "") ||
      "";
    return configured ? configured.replace(/\/+$/, "") : "";
  }

  // 公网控制台：options 优先，settings.publicConsole 次之，最后回退 ASTRA_PUBLIC_CONSOLE=1；
  // 同时需已配置公网地址。
  function publicConsoleUrl() {
    const s = loadSettings(bridgeRoot);
    const enabled =
      options.publicConsole ??
      (typeof s.publicConsole === "boolean" ? s.publicConsole : process.env.ASTRA_PUBLIC_CONSOLE === "1");
    if (!enabled || authMode === "none") return null;
    const pub = configuredPublicUrl();
    if (!pub) return null;
    try {
      return new URL(pub);
    } catch {
      return null;
    }
  }

  function effectiveAdminKey() {
    return adminKey || (authMode === "bearer" ? authToken : "");
  }

  // 仅当密钥来自 bridgeRoot 下的文件（docker entrypoint / tray.ps1 注入）时才允许轮换；
  // 由环境变量直接固定的值须改环境变量后重启。
  const SECRET_ROTATION = {
    client: { file: "token.txt", needsBearer: true, current: () => authToken, set: (v) => { authToken = v; } },
    join: { file: "join-token.txt", needsBearer: false, current: () => joinToken, set: (v) => { joinToken = v; } },
    admin: { file: "admin-key.txt", needsBearer: true, current: () => effectiveAdminKey(), set: (v) => { adminKey = v; } }
  };

  function secretRotatable(kind) {
    const spec = SECRET_ROTATION[kind];
    if (!spec) return false;
    if (spec.needsBearer && authMode !== "bearer") return false;
    try {
      return fs.readFileSync(path.join(bridgeRoot, spec.file), "utf8").trim() === spec.current();
    } catch {
      return false;
    }
  }

  function getPublicBase(req) {
    const configured = configuredPublicUrl();
    if (configured) return configured;
    const host = String(req?.headers?.host || "localhost");
    const fwd = String(req?.headers?.["x-forwarded-proto"] || "").split(",")[0].trim().toLowerCase();
    let proto = fwd === "http" || fwd === "https" ? fwd : null;
    if (!proto && (req?.headers?.["cf-ray"] || req?.headers?.["cf-visitor"])) {
      proto = "https";
    }
    if (!proto) proto = "http";
    const hostName = adminHostName(host).toLowerCase();
    if (!warnedPublicBaseFallback && !["127.0.0.1", "localhost", "::1"].includes(hostName)) {
      warnedPublicBaseFallback = true;
      recordLog("未配置 publicUrl", "对外地址由请求 Host 推断，请在设置中配置公网地址");
    }
    return `${proto}://${host}`;
  }

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
    return tokenEqual(authToken, token);
  }

  function isJoinAuthorized(req) {
    if (authMode === "none") return true;
    const token = bearerToken(req);
    if (!token || !joinToken) return false;
    return tokenEqual(joinToken, token);
  }

  let serverRef = null;
  let warnedNoJoinToken = false;
  let warnedPublicBaseFallback = false;

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
        "WWW-Authenticate": `Bearer realm="astra-gemini"`
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

    if (
      url.pathname === "/" ||
      url.pathname === "/ui" ||
      url.pathname.startsWith("/api/") ||
      url.pathname.startsWith("/remote/")
    ) {
      const localReq = isDirectLocalhost(req);
      const isPublicReq = !localReq;
      if (isPublicReq) {
        const pubUrl = publicConsoleUrl();
        const allowed =
          pubUrl !== null &&
          !url.pathname.startsWith("/remote/") &&
          String(req.headers.host || "").toLowerCase() === pubUrl.host.toLowerCase() &&
          (req.headers.origin === undefined || String(req.headers.origin) === pubUrl.origin) &&
          req.headers["sec-fetch-site"] !== "cross-site";
        if (!allowed) {
          sendJson(req, res, 403, { error: "管理控制台仅允许本机 (127.0.0.1) 访问，已拦截外部隧道请求。" });
          return;
        }
      } else {
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
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          ...(isPublicReq ? PUBLIC_UI_HEADERS : {})
        });
        res.end(fs.readFileSync(UI_HTML_PATH, "utf8"));
        return;
      }

      if (authMode !== "none") {
        if (isPublicReq && Date.now() < adminLockUntil) {
          sendJson(req, res, 429, {
            ok: false,
            code: "admin_locked",
            error: "管理密钥错误次数过多，请 10 分钟后再试。"
          });
          return;
        }
        if (!tokenEqual(effectiveAdminKey(), req.headers["x-astra-admin"])) {
          if (isPublicReq && req.headers["x-astra-admin"] !== undefined) {
            const now = Date.now();
            adminFailures.push(now);
            while (adminFailures.length && adminFailures[0] < now - ADMIN_WINDOW_MS) adminFailures.shift();
            if (adminFailures.length > ADMIN_FAIL_LIMIT) {
              adminFailures.length = 0;
              adminLockUntil = now + ADMIN_WINDOW_MS;
            }
          }
          sendJson(req, res, 401, {
            ok: false,
            code: "admin_auth_required",
            error: "需要管理密钥：粘贴 admin-key.txt 中的密钥（Docker 部署在 /data/admin-key.txt）。"
          });
          return;
        }
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
            publicUrl: getPublicBase(req),
            publicMcpUrl: configuredPublicUrl() ? `${configuredPublicUrl()}/mcp` : null,
            publicConsole: Boolean(publicConsoleUrl()),
            rotatable: {
              client: secretRotatable("client"),
              join: secretRotatable("join"),
              admin: secretRotatable("admin")
            },
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

        if (req.method === "POST" && url.pathname === "/api/secrets/rotate") {
          const body = JSON.parse(await readBody(req));
          const kind = String(body?.kind || "");
          const spec = SECRET_ROTATION[kind];
          if (!spec) {
            sendJson(req, res, 400, { ok: false, error: "未知密钥类型，应为 client/join/admin。" });
            return;
          }
          if (!secretRotatable(kind)) {
            sendJson(req, res, 409, { ok: false, error: "该值由环境变量固定，请修改环境变量后重启。" });
            return;
          }
          const value = crypto.randomBytes(32).toString("hex");
          writeSecretFile(path.join(bridgeRoot, spec.file), value);
          spec.set(value);
          recordLog("密钥轮换", kind);
          sendJson(req, res, 200, { ok: true, kind, value });
          return;
        }

        if (req.method === "POST" && url.pathname === "/api/gateway/check") {
          const body = JSON.parse(await readBody(req));
          const raw = typeof body?.url === "string" && body.url.trim()
            ? body.url
            : loadSettings(bridgeRoot).gatewayUrl || "";
          const base = String(raw).trim().replace(/\/+$/, "").replace(/\/mcp$/i, "").replace(/\/+$/, "");
          let parsed = null;
          try {
            parsed = base ? new URL(base) : null;
          } catch {
            parsed = null;
          }
          const isLocal = parsed && (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1");
          if (!parsed || (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLocal))) {
            sendJson(req, res, 400, { ok: false, error: "网关地址无效：需 https:// 地址（仅本机测试可用 http://127.0.0.1）。" });
            return;
          }
          const checks = [];
          const gwFetch = (u, init = {}) => fetch(u, { ...init, redirect: "manual", signal: AbortSignal.timeout(8000) });
          const push = (name, ok, detail) => checks.push({ name, ok, detail });
          try {
            const r = await gwFetch(`${base}/.well-known/oauth-authorization-server`);
            if (r.status !== 200) {
              push("授权服务发现", false, `HTTP ${r.status}`);
            } else {
              const doc = await r.json().catch(() => null);
              const okMeta = doc && doc.authorization_endpoint && doc.token_endpoint;
              push("授权服务发现", Boolean(okMeta), okMeta ? "HTTP 200，端点齐全" : "响应缺少 authorization_endpoint/token_endpoint");
            }
          } catch (err) {
            push("授权服务发现", false, `网络错误：${err.message}`);
          }
          try {
            const r = await gwFetch(`${base}/.well-known/oauth-protected-resource/mcp`);
            if (r.status !== 200) {
              push("受保护资源元数据", false, `HTTP ${r.status}`);
            } else {
              const doc = await r.json().catch(() => null);
              const expected = `${base}/mcp`;
              const okMeta = doc && doc.resource === expected;
              push("受保护资源元数据", Boolean(okMeta), okMeta ? `HTTP 200，resource=${expected}` : `resource 不匹配：${doc?.resource ?? "(缺失)"}`);
            }
          } catch (err) {
            push("受保护资源元数据", false, `网络错误：${err.message}`);
          }
          try {
            const r = await gwFetch(`${base}/mcp`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
            });
            push("MCP 需鉴权", r.status === 401, r.status === 401 ? "HTTP 401" : `期望 401，实际 HTTP ${r.status}`);
          } catch (err) {
            push("MCP 需鉴权", false, `网络错误：${err.message}`);
          }
          sendJson(req, res, 200, { ok: checks.every((c) => c.ok), base, checks });
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
          if (typeof body.publicConsole === "boolean") patch.publicConsole = body.publicConsole;
          if (typeof body.gatewayUrl === "string") patch.gatewayUrl = body.gatewayUrl.trim();
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
        "WWW-Authenticate": `Bearer realm="astra-gemini"`
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
