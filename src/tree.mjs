import crypto from "node:crypto";
import os from "node:os";
import { acceptWebSocketUpgrade, connectWebSocket } from "./ws.mjs";

export const PROTOCOL_VERSION = 1;

export function createTreeManager({
  getNodeId,
  getLocalProjects,
  executeLocalTool,
  getDirectCandidates = () => [],
  getNodeSecret = () => "",
  isDirectEnabled = () => true,
  nodeStore = null,
  protocolVersion = PROTOCOL_VERSION,
  heartbeatIntervalMs = 25_000,
  directTimeoutMs = 1500,
  directRetryCooldownMs = 60_000,
  relayBaseTimeoutMs = 60_000,
  onLog = () => {}
}) {
  const children = new Map();
  const pendingCalls = new Map();
  const directTunnels = new Map();
  const directCooldownUntil = new Map();
  const directTickets = new Map();
  const incomingDirectSockets = new Set();

  const directStats = {
    directCalls: 0,
    relayCalls: 0,
    directUpgrades: 0,
    directFallbacks: 0
  };

  let upstreamCfg = { enabled: false, url: "", token: "" };
  let upstreamWs = null;
  let upstreamStatus = { connected: false, url: "", lastError: null, connectedAt: null };
  let lastUpstreamAckAt = 0;
  let reconnectTimer = null;
  let heartbeatTimer = null;
  let stopped = false;

  const childSweepTimer = setInterval(() => {
    const now = Date.now();
    for (const c of children.values()) {
      if (c.online && c.ws && !c.ws.closed && now - (c.lastSeen || 0) > heartbeatIntervalMs * 3) {
        onLog("心跳超时", `${c.nodeId} 超过 ${heartbeatIntervalMs * 3}ms 未收到心跳，已断开`);
        try {
          c.ws.terminate();
        } catch {
          // ignore
        }
      }
    }
  }, heartbeatIntervalMs);

  function sanitizeNodeId(id) {
    if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,48}$/.test(id)) {
      throw new Error(`Invalid nodeId: ${id}`);
    }
    return id;
  }

  function listLocalLanCandidates(port) {
    const urls = [];
    if (!port) return urls;
    const ifaces = os.networkInterfaces();
    for (const entries of Object.values(ifaces)) {
      for (const info of entries || []) {
        if (info.family === "IPv4" && !info.internal && info.address) {
          urls.push(`ws://${info.address}:${port}/ws/direct`);
        }
      }
    }
    return urls;
  }

  function getAggregatedProjects({ includeRoot = false } = {}) {
    const local = getLocalProjects({ includeRoot }).map((p) => ({
      ...p,
      node: getNodeId(),
      via: "local",
      online: true
    }));

    const remote = [];
    for (const child of children.values()) {
      for (const p of child.projects || []) {
        remote.push({
          ...p,
          project: `${child.nodeId}/${p.project}`,
          node: p.node || child.nodeId,
          via: child.nodeId,
          online: child.online
        });
      }
    }
    return [...local, ...remote];
  }

  function pushRegistrationToUpstream() {
    if (!upstreamWs || upstreamWs.closed) return;
    const allProjects = getAggregatedProjects({ includeRoot: false }).map((p) => ({
      project: p.project,
      mode: p.mode,
      sdks: p.sdks,
      exists: p.exists,
      online: p.online,
      node: p.node,
      description: p.description || ""
    }));
    try {
      upstreamWs.sendJson({
        type: "node/register",
        nodeId: getNodeId(),
        nodeSecret: getNodeSecret(),
        protocolVersion,
        projects: allProjects
      });
    } catch {
      // ignore if closing
    }
  }

  function sendDownwardFrame(childNodeId, frame, timeoutMs = 60_000) {
    const child = children.get(childNodeId);
    if (!child || !child.online || !child.ws || child.ws.closed) {
      return Promise.reject(new Error(`子节点 "${childNodeId}" 当前离线或未连接。`));
    }
    const id = frame.id || crypto.randomBytes(8).toString("hex");
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingCalls.delete(id);
        reject(new Error(`调用子节点 "${childNodeId}" 超时 (${timeoutMs}ms)。`));
      }, timeoutMs);

      pendingCalls.set(id, { resolve, reject, timer });
      try {
        child.ws.sendJson({ ...frame, id });
      } catch (err) {
        pendingCalls.delete(id);
        clearTimeout(timer);
        reject(err);
      }
    });
  }

  function sendUpstreamCall(frame, timeoutMs = 60_000) {
    if (!upstreamWs || upstreamWs.closed || !upstreamStatus.connected) {
      return Promise.reject(new Error("当前节点未连接上游，无法访问 ../ 路径。"));
    }
    const id = crypto.randomBytes(8).toString("hex");
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingCalls.delete(id);
        reject(new Error(`调用上游节点超时 (${timeoutMs}ms)。`));
      }, timeoutMs);

      pendingCalls.set(id, { resolve, reject, timer });
      try {
        upstreamWs.sendJson({ ...frame, id });
      } catch (err) {
        pendingCalls.delete(id);
        clearTimeout(timer);
        reject(err);
      }
    });
  }

  function sendDirectRpc(targetPath, toolName, args, timeoutMs = 60_000) {
    const tunnel = directTunnels.get(targetPath);
    if (!tunnel || !tunnel.ws || tunnel.ws.closed) {
      directTunnels.delete(targetPath);
      return Promise.reject(new Error("Direct tunnel closed."));
    }
    const id = crypto.randomBytes(8).toString("hex");
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingCalls.delete(id);
        reject(new Error(`直连隧道调用 "${targetPath}" 超时 (${timeoutMs}ms)。`));
      }, timeoutMs);

      pendingCalls.set(id, { resolve, reject, timer });
      try {
        tunnel.ws.sendJson({ type: "rpc/call", id, tool: toolName, args });
      } catch (err) {
        pendingCalls.delete(id);
        clearTimeout(timer);
        reject(err);
      }
    });
  }

  function issueDirectTicket(fromNode = "parent") {
    const now = Date.now();
    for (const [k, v] of directTickets.entries()) {
      if (v.expiresAt < now) directTickets.delete(k);
    }
    const ticket = crypto.randomBytes(24).toString("hex");
    directTickets.set(ticket, { expiresAt: now + 15_000, fromNode });
    return ticket;
  }

  function consumeDirectTicket(ticket) {
    if (!ticket || typeof ticket !== "string") return false;
    const entry = directTickets.get(ticket);
    if (!entry) return false;
    directTickets.delete(ticket);
    return entry.expiresAt >= Date.now();
  }

  function handleDirectUpgrade(req, socket, head) {
    const ticket = req.headers["x-astra-ticket"];
    if (!consumeDirectTicket(ticket)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    const ws = acceptWebSocketUpgrade(req, socket, head);
    if (!ws) return;

    incomingDirectSockets.add(ws);
    onLog("直连隧道接入", "已完成一次性票据校验");

    ws.on("message", async (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      if (msg.type === "rpc/call" && msg.id) {
        try {
          const result = await executeLocalTool(msg.tool, msg.args || {});
          ws.sendJson({ type: "rpc/response", id: msg.id, result });
        } catch (err) {
          ws.sendJson({ type: "rpc/response", id: msg.id, error: err?.message || String(err) });
        }
      }
    });

    ws.on("close", () => {
      incomingDirectSockets.delete(ws);
    });
    ws.on("error", () => {});
  }

  async function tryEstablishDirectTunnel(targetPath) {
    const existing = directTunnels.get(targetPath);
    if (existing && existing.ws && !existing.ws.closed) {
      return existing;
    }
    const cooldown = directCooldownUntil.get(targetPath) || 0;
    if (Date.now() < cooldown) {
      return null;
    }

    const segments = targetPath.split("/");
    const firstHop = segments[0];
    const remaining = segments.slice(1).join("/");

    let answer;
    try {
      answer = await sendDownwardFrame(
        firstHop,
        {
          type: "tunnel/offer",
          targetRemaining: remaining,
          fromNode: getNodeId()
        },
        Math.max(directTimeoutMs + 1500, 3000)
      );
    } catch {
      directCooldownUntil.set(targetPath, Date.now() + directRetryCooldownMs);
      directStats.directFallbacks += 1;
      return null;
    }

    const candidates = Array.isArray(answer?.candidates) ? answer.candidates.filter(Boolean) : [];
    const ticket = answer?.ticket;
    if (!ticket || candidates.length === 0) {
      directCooldownUntil.set(targetPath, Date.now() + directRetryCooldownMs);
      directStats.directFallbacks += 1;
      return null;
    }

    const attempts = candidates.map((url) =>
      connectWebSocket(url, {
        headers: { "X-Astra-Ticket": ticket },
        timeoutMs: directTimeoutMs
      }).then((ws) => ({ ws, url }))
    );

    try {
      const winner = await Promise.any(attempts);
      attempts.forEach((p) => {
        p.then((res) => {
          if (res.ws !== winner.ws && !res.ws.closed) {
            try {
              res.ws.close(1000, "Slower candidate");
            } catch {
              // ignore
            }
          }
        }).catch(() => {});
      });

      const ws = winner.ws;
      ws.on("message", (raw) => {
        let msg;
        try {
          msg = JSON.parse(raw);
        } catch {
          return;
        }
        if (msg.type === "rpc/response" && msg.id && pendingCalls.has(msg.id)) {
          const entry = pendingCalls.get(msg.id);
          pendingCalls.delete(msg.id);
          clearTimeout(entry.timer);
          if (msg.error) entry.reject(new Error(msg.error));
          else entry.resolve(msg.result);
        }
      });

      ws.on("close", () => {
        const cur = directTunnels.get(targetPath);
        if (cur && cur.ws === ws) {
          directTunnels.delete(targetPath);
          onLog("直连断开", targetPath);
        }
      });
      ws.on("error", () => {});

      const record = { ws, url: winner.url, connectedAt: new Date().toISOString() };
      directTunnels.set(targetPath, record);
      directCooldownUntil.delete(targetPath);
      directStats.directUpgrades += 1;
      onLog("直连建立", `${targetPath} -> ${winner.url}`);
      return record;
    } catch {
      directCooldownUntil.set(targetPath, Date.now() + directRetryCooldownMs);
      directStats.directFallbacks += 1;
      onLog("回退中继", `${targetPath} 直连不可达，自动走树状 Relay`);
      return null;
    }
  }

  async function handleIncomingTunnelOffer(msg) {
    const remaining = msg.targetRemaining || "";
    if (!remaining) {
      const candidates = getDirectCandidates();
      const ticket = candidates.length > 0 ? issueDirectTicket(msg.fromNode) : null;
      return { ok: true, nodeId: getNodeId(), ticket, candidates };
    }
    const parts = remaining.split("/");
    const nextHop = parts[0];
    const nextRemaining = parts.slice(1).join("/");
    return sendDownwardFrame(
      nextHop,
      {
        type: "tunnel/offer",
        targetRemaining: nextRemaining,
        fromNode: msg.fromNode
      },
      Math.max(directTimeoutMs + 1500, 3000)
    );
  }

  function handleChildUpgrade(req, socket, head) {
    const ws = acceptWebSocketUpgrade(req, socket, head);
    if (!ws) return;

    let registeredNodeId = null;

    ws.on("message", async (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }

      if (msg.type === "node/register") {
        let nid;
        try {
          nid = sanitizeNodeId(msg.nodeId);
        } catch (err) {
          ws.close(1008, err.message);
          return;
        }
        if (msg.protocolVersion !== protocolVersion) {
          onLog("节点被拒", `${nid} 协议版本不匹配 (parent=${protocolVersion} child=${msg.protocolVersion ?? "missing"})`);
          ws.close(1008, `protocol version mismatch: parent=${protocolVersion} child=${msg.protocolVersion ?? "missing"}`);
          return;
        }
        const nodeSecret = typeof msg.nodeSecret === "string" ? msg.nodeSecret : "";
        if (!/^[0-9a-f]{64}$/i.test(nodeSecret)) {
          onLog("节点被拒", `${nid} 缺少有效 nodeSecret`);
          ws.close(1008, "Missing nodeSecret.");
          return;
        }
        const secretHash = crypto.createHash("sha256").update(nodeSecret, "utf8").digest("hex");
        const binding = nodeStore ? nodeStore.get(nid) : null;
        if (binding && binding.secretHash !== secretHash) {
          onLog("节点劫持拦截", `${nid} nodeSecret 不匹配，已拒绝冒充连接`);
          ws.close(1008, "nodeId secret mismatch.");
          return;
        }
        if (!binding && nodeStore) {
          nodeStore.set(nid, secretHash);
        }
        registeredNodeId = nid;
        const prev = children.get(nid);
        if (prev && prev.ws && prev.ws !== ws && !prev.ws.closed) {
          prev.ws.close(1000, "Replaced by newer connection");
        }
        children.set(nid, {
          nodeId: nid,
          ws,
          projects: Array.isArray(msg.projects) ? msg.projects : [],
          canCallTree: Boolean(binding && binding.canCallTree),
          connectedAt: new Date().toISOString(),
          lastSeen: Date.now(),
          online: true
        });
        onLog("节点上线", `${nid} (${(msg.projects || []).length} 个项目)`);
        ws.sendJson({ type: "node/registered", ok: true, parentNodeId: getNodeId(), protocolVersion });
        pushRegistrationToUpstream();
        return;
      }

      if (msg.type === "node/heartbeat") {
        if (registeredNodeId && children.has(registeredNodeId)) {
          children.get(registeredNodeId).lastSeen = Date.now();
        }
        ws.sendJson({ type: "node/heartbeat_ack", ts: Date.now() });
        return;
      }

      if (msg.type === "rpc/upcall" && msg.id) {
        try {
          const child = registeredNodeId ? children.get(registeredNodeId) : null;
          if (!child) {
            throw new Error("未注册的节点。");
          }
          if (!child.canCallTree) {
            throw new Error(`节点 ${registeredNodeId} 未被授权调用上级（需在上级控制台开启「允许调用整棵树」）`);
          }
          const result = await routeToolCall(msg.tool, msg.args || {}, { excludeNodeId: registeredNodeId });
          ws.sendJson({ type: "rpc/upresponse", id: msg.id, result });
        } catch (err) {
          ws.sendJson({ type: "rpc/upresponse", id: msg.id, error: err?.message || String(err) });
        }
        return;
      }

      if ((msg.type === "rpc/response" || msg.type === "tunnel/answer") && msg.id && pendingCalls.has(msg.id)) {
        const entry = pendingCalls.get(msg.id);
        pendingCalls.delete(msg.id);
        clearTimeout(entry.timer);
        if (msg.error) entry.reject(new Error(msg.error));
        else entry.resolve(msg.result);
      }
    });

    ws.on("close", () => {
      if (registeredNodeId && children.has(registeredNodeId)) {
        const entry = children.get(registeredNodeId);
        if (entry.ws === ws) {
          entry.online = false;
          entry.ws = null;
          for (const [k, t] of directTunnels.entries()) {
            if (k === registeredNodeId || k.startsWith(`${registeredNodeId}/`)) {
              try {
                t.ws.close(1000, "Subtree offline");
              } catch {
                // ignore
              }
              directTunnels.delete(k);
            }
          }
          onLog("节点离线", registeredNodeId);
          pushRegistrationToUpstream();
        }
      }
    });

    ws.on("error", () => {});
  }

  async function getProjectsWithUpstream() {
    const aggregated = getAggregatedProjects({ includeRoot: false });
    if (!upstreamWs || upstreamWs.closed || !upstreamStatus.connected) {
      return aggregated;
    }
    try {
      const up = await sendUpstreamCall({ type: "rpc/upcall", tool: "list_projects", args: {} }, 5_000);
      for (const p of Array.isArray(up) ? up : []) {
        aggregated.push({ ...p, project: `../${p.project}`, via: "upstream" });
      }
    } catch {
      // ignore
    }
    return aggregated;
  }

  async function routeToolCall(toolName, args = {}, { allowDirectUpgrade = true, excludeNodeId = null } = {}) {
    if (toolName === "list_projects") {
      const aggregated = await getProjectsWithUpstream();
      if (!excludeNodeId) return aggregated;
      return aggregated.filter(
        (p) =>
          p.via !== excludeNodeId &&
          p.project !== excludeNodeId &&
          !(typeof p.project === "string" && p.project.startsWith(`${excludeNodeId}/`))
      );
    }

    const projectRef = args.project;
    if (typeof projectRef === "string" && projectRef.split("/").includes("..")) {
      const parts = projectRef.split("/");
      if (parts[0] !== "..") {
        throw new Error(`非法的项目路径 "${projectRef}"：".." 只能作为开头的一段或多段使用。`);
      }
      const toolTimeout =
        toolName === "exec_verify"
          ? Math.max(1000, Math.min(Number(args.timeoutMs) || 30_000, 120_000))
          : relayBaseTimeoutMs;
      const callTimeoutMs = toolTimeout + 10_000 + 5_000 * parts.length;
      directStats.relayCalls += 1;
      return sendUpstreamCall(
        { type: "rpc/upcall", tool: toolName, args: { ...args, project: parts.slice(1).join("/") } },
        callTimeoutMs
      );
    }

    if (typeof projectRef === "string" && projectRef.includes("/")) {
      const parts = projectRef.split("/");
      const targetNodePath = parts.slice(0, -1).join("/");
      const leafProjectName = parts[parts.length - 1];

      const hopsRemaining = Math.max(0, parts.length - 2);
      const toolTimeout =
        toolName === "exec_verify"
          ? Math.max(1000, Math.min(Number(args.timeoutMs) || 30_000, 120_000))
          : relayBaseTimeoutMs;
      const callTimeoutMs = toolTimeout + 10_000 + 5_000 * hopsRemaining;

      if (allowDirectUpgrade && isDirectEnabled()) {
        const direct = await tryEstablishDirectTunnel(targetNodePath);
        if (direct) {
          try {
            directStats.directCalls += 1;
            return await sendDirectRpc(targetNodePath, toolName, { ...args, project: leafProjectName }, callTimeoutMs);
          } catch {
            directTunnels.delete(targetNodePath);
            directStats.directFallbacks += 1;
          }
        }
      }

      directStats.relayCalls += 1;
      const firstHop = parts[0];
      const subProject = parts.slice(1).join("/");
      return sendDownwardFrame(
        firstHop,
        {
          type: "rpc/call",
          tool: toolName,
          args: { ...args, project: subProject }
        },
        callTimeoutMs
      );
    }

    return executeLocalTool(toolName, args);
  }

  function clearUpstreamTimers() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  function disconnectUpstream() {
    clearUpstreamTimers();
    upstreamCfg = { enabled: false, url: "", token: "" };
    if (upstreamWs) {
      try {
        upstreamWs.close(1000, "Disconnected by user");
      } catch {
        // ignore
      }
      upstreamWs = null;
    }
    upstreamStatus = { connected: false, url: "", lastError: null, connectedAt: null };
  }

  function connectUpstream({ url, token, enabled = true }, attempt = 0) {
    clearUpstreamTimers();
    if (upstreamWs) {
      try {
        upstreamWs.close(1000, "Reconnecting");
      } catch {
        // ignore
      }
      upstreamWs = null;
    }

    upstreamCfg = { enabled: Boolean(enabled), url: (url || "").trim(), token: (token || "").trim() };
    if (!upstreamCfg.enabled || !upstreamCfg.url) {
      upstreamStatus = { connected: false, url: "", lastError: null, connectedAt: null };
      return;
    }

    const wsUrl = upstreamCfg.url.replace(/^http:\/\//i, "ws://").replace(/^https:\/\//i, "wss://");
    upstreamStatus = { connected: false, url: wsUrl, lastError: null, connectedAt: null };

    const headers = upstreamCfg.token ? { Authorization: `Bearer ${upstreamCfg.token}` } : {};
    connectWebSocket(wsUrl, { headers, timeoutMs: 10_000 })
      .then((ws) => {
        if (stopped || !upstreamCfg.enabled) {
          ws.close(1000, "Stopped");
          return;
        }
        upstreamWs = ws;
        attempt = 0;
        lastUpstreamAckAt = Date.now();
        upstreamStatus = {
          connected: true,
          url: wsUrl,
          lastError: null,
          connectedAt: new Date().toISOString()
        };
        onLog("上游已连", wsUrl);
        pushRegistrationToUpstream();

        heartbeatTimer = setInterval(() => {
          if (!upstreamWs || upstreamWs.closed) return;
          if (Date.now() - lastUpstreamAckAt > heartbeatIntervalMs * 3) {
            onLog("上游心跳超时", "未收到 heartbeat_ack，正在断开重连");
            try {
              upstreamWs.terminate();
            } catch {
              // ignore
            }
            return;
          }
          try {
            upstreamWs.sendJson({ type: "node/heartbeat", nodeId: getNodeId() });
          } catch {
            // ignore
          }
        }, heartbeatIntervalMs);

        ws.on("message", async (raw) => {
          let msg;
          try {
            msg = JSON.parse(raw);
          } catch {
            return;
          }
          if (msg.type === "node/heartbeat_ack") {
            lastUpstreamAckAt = Date.now();
            return;
          }
          if (msg.type === "rpc/upresponse" && msg.id && pendingCalls.has(msg.id)) {
            const entry = pendingCalls.get(msg.id);
            pendingCalls.delete(msg.id);
            clearTimeout(entry.timer);
            if (msg.error) entry.reject(new Error(msg.error));
            else entry.resolve(msg.result);
            return;
          }
          if (msg.type === "rpc/call" && msg.id) {
            try {
              const result = await routeToolCall(msg.tool, msg.args || {}, { allowDirectUpgrade: false });
              ws.sendJson({ type: "rpc/response", id: msg.id, result });
            } catch (err) {
              ws.sendJson({ type: "rpc/response", id: msg.id, error: err?.message || String(err) });
            }
            return;
          }
          if (msg.type === "tunnel/offer" && msg.id) {
            try {
              const result = await handleIncomingTunnelOffer(msg);
              ws.sendJson({ type: "tunnel/answer", id: msg.id, result });
            } catch (err) {
              ws.sendJson({ type: "tunnel/answer", id: msg.id, error: err?.message || String(err) });
            }
          }
        });

        ws.on("close", (code, reason) => {
          clearUpstreamTimers();
          if (upstreamWs === ws) upstreamWs = null;
          upstreamStatus.connected = false;
          const reasonText = typeof reason === "string" ? reason : String(reason || "");
          if (reasonText) {
            upstreamStatus.lastError = `上级关闭 (${code}): ${reasonText}`;
          } else if (code && code !== 1000) {
            upstreamStatus.lastError = `连接已关闭 (code=${code})`;
          }
          if (!stopped && upstreamCfg.enabled) {
            if (code === 1008) {
              onLog("上游拒绝", `上级关闭连接 (1008): ${reasonText || "policy violation"}，请修正入网配置后重新保存`);
              return;
            }
            const delay = Math.min(2000 * Math.pow(1.5, attempt), 15_000);
            reconnectTimer = setTimeout(() => connectUpstream(upstreamCfg, attempt + 1), delay);
          }
        });

        ws.on("error", (err) => {
          upstreamStatus.lastError = err?.message || String(err);
        });
      })
      .catch((err) => {
        upstreamStatus = {
          connected: false,
          url: wsUrl,
          lastError: err?.message || String(err),
          connectedAt: null
        };
        if (!stopped && upstreamCfg.enabled) {
          const delay = Math.min(2000 * Math.pow(1.5, attempt), 15_000);
          reconnectTimer = setTimeout(() => connectUpstream(upstreamCfg, attempt + 1), delay);
        }
      });
  }

  function getTreeStatus() {
    return {
      nodeId: getNodeId(),
      upstream: { ...upstreamStatus, enabled: upstreamCfg.enabled },
      children: Array.from(children.values()).map((c) => ({
        nodeId: c.nodeId,
        online: c.online,
        canCallTree: Boolean(c.canCallTree),
        connectedAt: c.connectedAt,
        projectCount: (c.projects || []).length,
        projects: (c.projects || []).map((p) => p.project)
      })),
      directTunnels: Array.from(directTunnels.entries()).map(([target, t]) => ({
        target,
        url: t.url,
        connectedAt: t.connectedAt
      })),
      directStats: { ...directStats }
    };
  }

  function setChildGrant(nodeId, canCallTree) {
    if (!nodeStore || typeof nodeStore.setGrant !== "function") return false;
    if (!nodeStore.setGrant(nodeId, Boolean(canCallTree))) return false;
    const child = children.get(nodeId);
    if (child) child.canCallTree = Boolean(canCallTree);
    onLog("节点授权", `${nodeId} 允许调用整棵树 = ${Boolean(canCallTree)}`);
    return true;
  }

  function removeChild(nodeId) {
    if (nodeStore) nodeStore.delete(nodeId);
    const entry = children.get(nodeId);
    if (!entry) {
      pushRegistrationToUpstream();
      return false;
    }
    children.delete(nodeId);
    if (entry.ws && !entry.ws.closed) {
      try {
        entry.ws.close(1000, "Removed by admin");
      } catch {
        // ignore
      }
    }
    onLog("节点移除", nodeId);
    pushRegistrationToUpstream();
    return true;
  }

  function shutdown() {
    stopped = true;
    clearInterval(childSweepTimer);
    disconnectUpstream();
    for (const t of directTunnels.values()) {
      try {
        t.ws.close(1001, "Shutting down");
      } catch {
        // ignore
      }
    }
    directTunnels.clear();
    for (const ws of incomingDirectSockets) {
      try {
        ws.close(1001, "Shutting down");
      } catch {
        // ignore
      }
    }
    incomingDirectSockets.clear();
    for (const c of children.values()) {
      if (c.ws && !c.ws.closed) {
        try {
          c.ws.close(1001, "Server shutting down");
        } catch {
          // ignore
        }
      }
    }
    children.clear();
    for (const p of pendingCalls.values()) {
      clearTimeout(p.timer);
      p.reject(new Error("Tree manager shut down."));
    }
    pendingCalls.clear();
  }

  return {
    handleChildUpgrade,
    handleDirectUpgrade,
    listLocalLanCandidates,
    routeToolCall,
    getAggregatedProjects,
    connectUpstream,
    disconnectUpstream,
    pushRegistrationToUpstream,
    removeChild,
    setChildGrant,
    getTreeStatus,
    shutdown
  };
}
