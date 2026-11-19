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
import { createTreeManager } from "./tree.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_BRIDGE_ROOT = path.resolve(__dirname, "..");
const UI_HTML_PATH = path.join(__dirname, "ui.html");

const MCP_PROTOCOL_VERSION = "2025-03-26";
const SERVER_INFO = { name: "astra-gemini", version: "0.1.0" };

const TOOLS = [
  {
    name: "list_projects",
    description: "List all registered local projects and online subtree projects across connected Astra Gemini nodes.",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "pull_snapshot",
    description: "Pull a filtered text code snapshot with bundleSha256 and optional incremental deduplication via knownHashes (SHA-256 or MD5).",
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
    description: "Execute a short async JS verification script in an isolated process on the target node with ONLY its enabled `sdk` namespace.",
    inputSchema: {
      type: "object",
      required: ["project", "script"],
      properties: {
        project: { type: "string", description: "Project alias (or '<childNode>/<project>' for subtree nodes)." },
        script: { type: "string", description: "Async JS body using `sdk.<name>.<fn>(...)` and returning a compact summary." },
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
  const fixedNodeId = options.nodeId || process.env.ASTRA_NODE_ID || null;
  const startedAt = Date.now();
  const recentLogs = [];
  const tunnel = createTunnelManager(port);

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

  function isAuthorized(req) {
    if (authMode === "none") return true;
    const header = req.headers.authorization || "";
    const match = /^Bearer\s+(.+)$/i.exec(header);
    if (!match) return false;
    const expected = Buffer.from(authToken);
    const actual = Buffer.from(match[1]);
    if (expected.length !== actual.length) return false;
    return crypto.timingSafeEqual(expected, actual);
  }

  let serverRef = null;

  const tree = createTreeManager({
    getNodeId: () => fixedNodeId || loadSettings(bridgeRoot).nodeId,
    getLocalProjects: (opts) => listProjects(projectsConfigPath, opts),
    executeLocalTool: (tool, args) => executeLocalTool(bridgeRoot, projectsConfigPath, tool, args),
    directTimeoutMs: options.directTimeoutMs ?? 1500,
    directRetryCooldownMs: options.directRetryCooldownMs ?? 60_000,
    getDirectCandidates: () => {
      if (Array.isArray(options.directCandidates)) return options.directCandidates;
      const list = [];
      const actualPort = serverRef?.address?.()?.port || port;
      const tStatus = tunnel.status();
      if (tStatus.publicUrl) {
        list.push(tStatus.publicUrl.replace(/^https:\/\//i, "wss://") + "/ws/direct");
      }
      list.push(...tree.listLocalLanCandidates(actualPort));
      return list;
    },
    onLog: recordLog
  });

  const initialUpstream = options.upstream || loadSettings(bridgeRoot).upstream;
  if (initialUpstream?.enabled && initialUpstream?.url) {
    tree.connectUpstream(initialUpstream);
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    if (req.method === "GET" && url.pathname === "/health") {
      sendJson(req, res, 200, {
        ok: true,
        ...SERVER_INFO,
        nodeId: fixedNodeId || loadSettings(bridgeRoot).nodeId,
        authMode,
        uptimeSec: Math.floor((Date.now() - startedAt) / 1000)
      });
      return;
    }

    if (url.pathname === "/" || url.pathname === "/ui" || url.pathname.startsWith("/api/")) {
      if (!isDirectLocalhost(req)) {
        sendJson(req, res, 403, { error: "管理控制台仅允许本机 (127.0.0.1) 访问，已拦截外部隧道请求。" });
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
          sendJson(req, res, 200, {
            ok: true,
            server: SERVER_INFO,
            localMcpUrl: `http://127.0.0.1:${port}/mcp`,
            localWsUrl: `ws://127.0.0.1:${port}/ws/tree`,
            authMode,
            authToken,
            uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
            settings,
            projects: listProjects(projectsConfigPath, { includeRoot: true }),
            sdks: catalog.sdks || [],
            backups: listBackups(bridgeRoot),
            tunnel: tunnel.status(),
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

    if (!isAuthorized(req)) {
      sendJson(req, res, 401, { error: "Unauthorized" }, { "WWW-Authenticate": 'Bearer realm="astra-gemini"' });
      return;
    }

    if (req.method !== "POST") {
      sendJson(req, res, 405, { error: "Method not allowed. Use POST /mcp." });
      return;
    }

    let msg;
    try {
      const raw = await readBody(req);
      msg = JSON.parse(raw);
    } catch (err) {
      sendJson(req, res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: err.message } });
      return;
    }

    const { id = null, method, params } = msg || {};

    if (method === "notifications/initialized" || (id === null && method?.startsWith("notifications/"))) {
      res.writeHead(202);
      res.end();
      return;
    }

    try {
      if (method === "initialize") {
        recordLog("MCP 握手", "客户端已连接");
        sendJson(req, res, 200, {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: SERVER_INFO
          }
        });
        return;
      }

      if (method === "ping") {
        sendJson(req, res, 200, { jsonrpc: "2.0", id, result: {} });
        return;
      }

      if (method === "tools/list") {
        sendJson(req, res, 200, { jsonrpc: "2.0", id, result: { tools: TOOLS } });
        return;
      }

      if (method === "tools/call") {
        const toolName = params?.name;
        const toolArgs = params?.arguments || {};
        recordLog("MCP 调用", `${toolName}${toolArgs.project ? ` (${toolArgs.project})` : ""}`);
        try {
          const data = await tree.routeToolCall(toolName, toolArgs);
          sendJson(req, res, 200, {
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
          sendJson(req, res, 200, {
            jsonrpc: "2.0",
            id,
            result: {
              content: [{ type: "text", text: JSON.stringify({ ok: false, error: toolErr.message }) }],
              isError: true
            }
          });
        }
        return;
      }

      sendJson(req, res, 200, {
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Method not found: ${method}` }
      });
    } catch (err) {
      sendJson(req, res, 500, {
        jsonrpc: "2.0",
        id,
        error: { code: -32603, message: err.message }
      });
    }
  });

  serverRef = server;

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    if (url.pathname === "/ws/direct") {
      tree.handleDirectUpgrade(req, socket, head);
      return;
    }
    if (url.pathname !== "/ws/tree") {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }
    if (!isAuthorized(req)) {
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
