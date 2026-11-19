import crypto from "node:crypto";
import net from "node:net";
import os from "node:os";
import { Duplex } from "node:stream";
import { connectWebSocket } from "./ws.mjs";
import { openChannel } from "./secure-channel.mjs";
import { createUpnpManager } from "./upnp.mjs";
import { PROTOCOL_VERSION } from "./tree.mjs";

const ADDRESS_RE = /^ag1-[a-z2-7]{32}$/;
const PREAMBLE_RE = /^ASTRA-P2P\/1 ([a-f0-9]{16,64})$/i;
const DIAL_TIMEOUT_MS = 1500;
const PREAMBLE_TIMEOUT_MS = 5000;
const CHANNEL_IDLE_MS = 5 * 60 * 1000;
const CONNECT_TOTAL_MS = 60_000;
const RV_PING_MS = 25_000;
const RV_SILENCE_MS = 75_000;
const PROXY_TIMEOUT_MS = 150_000;

function parseHostPort(addr) {
  const s = String(addr).trim();
  if (s.startsWith("[")) {
    const end = s.indexOf("]");
    return { host: s.slice(1, end), port: Number(s.slice(end + 2)) };
  }
  const idx = s.lastIndexOf(":");
  return { host: s.slice(0, idx), port: Number(s.slice(idx + 1)) };
}

function wsAsDuplex(ws) {
  const d = new Duplex({
    write(chunk, _enc, cb) {
      try {
        ws.sendBinary(chunk);
        cb();
      } catch (err) {
        cb(err);
      }
    },
    read() {},
    final(cb) {
      try {
        ws.close(1000, "done");
      } catch {
        // ignore
      }
      cb();
    }
  });
  ws.on("binary", (buf) => d.push(buf));
  ws.on("close", () => {
    d.push(null);
    d.destroy();
  });
  ws.on("error", (err) => d.destroy(err));
  d.on("close", () => {
    if (!ws.closed) ws.close(1000, "closed");
  });
  return d;
}

export function createRemoteManager({
  identity,
  handleMcp,
  onLog = () => {},
  getRendezvous = () => ({ enabled: false, url: "", token: "" }),
  getP2p = () => ({ enabled: true, port: 3940, upnp: true }),
  getRemotes = () => ({}),
  getRemoteAllowFrom = () => [],
  getAuthMode = () => "bearer",
  p2pPort = null,
  p2pCandidates = null,
  upnp: upnpEnabled = true,
  p2pDirectWindowMs = 2000,
  channelIdleMs = CHANNEL_IDLE_MS,
  channelPingMs = null,
  idleSweepMs = 60_000,
  rendezvous: rendezvousOverride = null
} = {}) {
  const rv = {
    ws: null,
    connected: false,
    configured: false,
    url: "",
    lastError: null,
    backoff: 0,
    reconnectTimer: null,
    pingTimer: null,
    lastPong: 0
  };
  const sessions = new Map();
  const pendingConnects = new Map();
  const inflight = new Map();
  const channels = new Map();
  let p2pServer = null;
  let p2pBoundPort = null;
  let p2pError = null;
  let upnpMgr = null;
  let stopped = false;

  function rvConfig() {
    if (rendezvousOverride) return { enabled: true, ...rendezvousOverride };
    return getRendezvous() || { enabled: false, url: "", token: "" };
  }

  function ownCandidates() {
    if (typeof p2pCandidates === "function") return p2pCandidates();
    if (Array.isArray(p2pCandidates)) return p2pCandidates;
    const list = [];
    const port = p2pBoundPort;
    if (port) {
      for (const infos of Object.values(os.networkInterfaces())) {
        for (const i of infos || []) {
          if (i.internal || !i.address) continue;
          if (i.family === "IPv4") list.push(`${i.address}:${port}`);
          else if (i.family === "IPv6" && !/^fe80/i.test(i.address)) list.push(`[${i.address}]:${port}`);
        }
      }
    }
    const ext = upnpMgr?.status()?.externalAddr;
    if (ext) list.push(ext);
    return list;
  }

  function serveRequest(req) {
    if (getAuthMode() === "none") {
      return {
        status: 403,
        headers: { "content-type": "application/json; charset=utf-8" },
        bodyText: JSON.stringify({ error: "本节点未启用鉴权，拒绝远程请求。" })
      };
    }
    const headers = {};
    for (const h of ["authorization", "content-type", "accept", "mcp-protocol-version"]) {
      if (req.headers[h] !== undefined) headers[h] = req.headers[h];
    }
    return handleMcp({ headers, bodyText: req.bodyText });
  }

  function attachSocket(session, socket) {
    if (session.state !== "dialing") {
      socket.destroy();
      return;
    }
    session.pending.add(socket);
    socket.once("close", () => session.pending.delete(socket));
    openChannel({
      duplex: socket,
      role: session.role === "a" ? "client" : "server",
      identity,
      expectedPeerAddress: session.peerAddress,
      onRequest: session.role === "b" ? serveRequest : null,
      pingIntervalMs: channelPingMs
    })
      .then((channel) => {
        session.pending.delete(socket);
        tryWin(session, channel, "direct");
      })
      .catch(() => {
        try {
          socket.destroy();
        } catch {
          // ignore
        }
      });
  }

  function tryWin(session, channel, mode) {
    if (session.state !== "dialing") {
      channel.close();
      return;
    }
    session.state = "connected";
    clearTimeout(session.windowTimer);
    clearTimeout(session.totalTimer);
    for (const s of session.pending) {
      try {
        s.destroy();
      } catch {
        // ignore
      }
    }
    session.pending.clear();
    sessions.delete(session.sid);
    const direction = session.role === "a" ? "out" : "in";
    const record = { channel, mode, direction, since: Date.now() };
    channels.set(`${direction}:${channel.peerAddress}`, record);
    channel.onClose = () => {
      const key = `${direction}:${channel.peerAddress}`;
      if (channels.get(key)?.channel === channel) channels.delete(key);
    };
    onLog(`远程通道建立：${channel.peerAddress}（${mode === "direct" ? "直连" : "中继"}，${direction === "out" ? "呼出" : "呼入"}）`);
    session.resolve?.(channel);
  }

  function failSession(session, error) {
    if (session.state !== "dialing") return;
    session.state = "failed";
    clearTimeout(session.windowTimer);
    clearTimeout(session.totalTimer);
    for (const s of session.pending) {
      try {
        s.destroy();
      } catch {
        // ignore
      }
    }
    session.pending.clear();
    sessions.delete(session.sid);
    session.reject?.(error);
  }

  function dialCandidates(session, candidates) {
    for (const addr of candidates || []) {
      const { host, port } = parseHostPort(addr);
      if (!host || !port) continue;
      let socket;
      try {
        socket = net.connect({ host, port });
      } catch {
        continue;
      }
      session.pending.add(socket);
      socket.setTimeout(DIAL_TIMEOUT_MS, () => socket.destroy());
      socket.once("close", () => session.pending.delete(socket));
      socket.on("connect", () => {
        socket.setTimeout(0);
        try {
          socket.write(`ASTRA-P2P/1 ${session.sid}\n`);
        } catch {
          socket.destroy();
          return;
        }
        attachSocket(session, socket);
      });
      socket.on("error", () => {});
    }
  }

  function openRelayLeg(session, role) {
    const cfg = rvConfig();
    const base = String(cfg.url || "").replace(/\/+$/, "");
    if (!base || !session.relayKey) return;
    session.relayStarted = true;
    connectWebSocket(`${base}/rv/relay?sid=${session.sid}&role=${role}&key=${session.relayKey}`, {
      headers: { authorization: `Bearer ${cfg.token}` }
    })
      .then((ws) => {
        const duplex = wsAsDuplex(ws);
        session.pending.add(duplex);
        openChannel({
          duplex,
          role: role === "a" ? "client" : "server",
          identity,
          expectedPeerAddress: session.peerAddress,
          onRequest: role === "b" ? serveRequest : null,
          pingIntervalMs: channelPingMs
        })
          .then((channel) => {
            session.pending.delete(duplex);
            tryWin(session, channel, "relay");
          })
          .catch(() => {
            duplex.destroy();
            failSession(session, new Error("直连与中继均失败，无法建立到目标节点的通道。"));
          });
      })
      .catch(() => {
        failSession(session, new Error("直连与中继均失败，无法建立到目标节点的通道。"));
      });
  }

  function startSession({ sid, role, peerAddress, relayKey, peerCandidates }) {
    const session = {
      sid,
      role,
      peerAddress,
      relayKey,
      state: "dialing",
      pending: new Set(),
      relayStarted: false,
      resolve: null,
      reject: null
    };
    sessions.set(sid, session);
    dialCandidates(session, peerCandidates);
    if (role === "a") {
      session.windowTimer = setTimeout(() => {
        if (session.state !== "dialing") return;
        if (rv.ws && !rv.ws.closed) {
          rv.ws.sendJson({ t: "relay", sid });
          openRelayLeg(session, "a");
        } else {
          failSession(session, new Error("直连与中继均失败，无法建立到目标节点的通道。"));
        }
      }, p2pDirectWindowMs);
    }
    session.totalTimer = setTimeout(() => {
      failSession(session, new Error("直连与中继均失败，无法建立到目标节点的通道。"));
    }, CONNECT_TOTAL_MS);
    return session;
  }

  function handleIncoming(msg) {
    const from = msg.from;
    const allow = getRemoteAllowFrom() || [];
    if (Array.isArray(allow) && allow.length > 0 && !allow.includes(from)) {
      if (rv.ws && !rv.ws.closed) {
        rv.ws.sendJson({ t: "reject", sid: msg.sid, error: "发起节点不在允许列表（remoteAllowFrom）" });
      }
      return;
    }
    if (rv.ws && !rv.ws.closed) {
      rv.ws.sendJson({ t: "accept", sid: msg.sid, candidates: ownCandidates() });
    }
    startSession({
      sid: msg.sid,
      role: "b",
      peerAddress: from,
      relayKey: msg.relayKey,
      peerCandidates: msg.candidates || []
    });
  }

  function onRvMessage(text) {
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (msg.t === "challenge" && !rv.helloSent) {
      rv.helloSent = true;
      const sig = crypto.sign(null, Buffer.from(`astra-rv-v1:${msg.nonce}`), identity.privateKey);
      rv.ws.sendJson({
        t: "hello",
        protocolVersion: PROTOCOL_VERSION,
        spki: identity.spkiDer.toString("base64"),
        sig: sig.toString("base64")
      });
      return;
    }
    if (msg.t === "welcome") {
      rv.connected = true;
      rv.lastError = null;
      rv.backoff = 0;
      rv.lastPong = Date.now();
      onLog(`牵线服务已连接（${rv.url}）`);
      return;
    }
    if (msg.t === "pong") {
      rv.lastPong = Date.now();
      return;
    }
    if (msg.t === "connect-ok" && msg.id) {
      const pending = pendingConnects.get(msg.id);
      if (pending) {
        pendingConnects.delete(msg.id);
        clearTimeout(pending.timer);
        pending.resolve(msg);
      }
      return;
    }
    if (msg.t === "connect-fail" && msg.id) {
      const pending = pendingConnects.get(msg.id);
      if (pending) {
        pendingConnects.delete(msg.id);
        clearTimeout(pending.timer);
        pending.reject(new Error(msg.error || "连接失败"));
      }
      return;
    }
    if (msg.t === "incoming") {
      handleIncoming(msg);
      return;
    }
    if (msg.t === "relay" && msg.sid) {
      const session = sessions.get(msg.sid);
      if (session && session.role === "b" && !session.relayStarted) {
        openRelayLeg(session, "b");
      }
    }
  }

  function scheduleReconnect() {
    if (stopped || rv.reconnectTimer) return;
    const delay = Math.min(15000, 2000 * 1.5 ** rv.backoff);
    rv.backoff += 1;
    rv.reconnectTimer = setTimeout(() => {
      rv.reconnectTimer = null;
      connectRv();
    }, delay);
    rv.reconnectTimer.unref();
  }

  function connectRv() {
    const cfg = rvConfig();
    if (!cfg.enabled || !cfg.url || !cfg.token) {
      rv.configured = false;
      rv.connected = false;
      return;
    }
    rv.configured = true;
    rv.url = cfg.url;
    const base = String(cfg.url).replace(/\/+$/, "");
    rv.helloSent = false;
    connectWebSocket(`${base}/rv`, { headers: { authorization: `Bearer ${cfg.token}` } })
      .then((ws) => {
        rv.ws = ws;
        ws.on("message", onRvMessage);
        ws.on("close", (code, reason) => {
          if (rv.ws === ws) rv.ws = null;
          rv.connected = false;
          if (rv.pingTimer) {
            clearInterval(rv.pingTimer);
            rv.pingTimer = null;
          }
          if (code === 1008) {
            rv.lastError = `牵线服务拒绝连接 (1008): ${reason || "策略拒绝"}`;
            onLog(`牵线服务拒绝连接：${rv.lastError}，请修正配置后重试`);
            return;
          }
          rv.lastError = `牵线服务断开 (${code}): ${reason || ""}`;
          scheduleReconnect();
        });
        rv.pingTimer = setInterval(() => {
          if (Date.now() - rv.lastPong > RV_SILENCE_MS && rv.connected) {
            ws.terminate();
            return;
          }
          if (!ws.closed) ws.sendJson({ t: "ping" });
        }, RV_PING_MS);
        rv.pingTimer.unref();
      })
      .catch((err) => {
        rv.connected = false;
        rv.lastError = `牵线服务连接失败: ${err.message}`;
        scheduleReconnect();
      });
  }

  function startP2p() {
    const cfg = getP2p() || {};
    if (cfg.enabled === false) {
      p2pError = "disabled";
      return;
    }
    const desired = p2pPort != null ? p2pPort : cfg.port || 3940;
    p2pServer = net.createServer((socket) => {
      socket.setTimeout(PREAMBLE_TIMEOUT_MS, () => socket.destroy());
      let buf = Buffer.alloc(0);
      const onData = (chunk) => {
        buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
        const idx = buf.indexOf(0x0a);
        if (idx < 0) {
          if (buf.length > 256) socket.destroy();
          return;
        }
        const line = buf.subarray(0, idx).toString("latin1").trim();
        const rest = buf.subarray(idx + 1);
        socket.off("data", onData);
        socket.setTimeout(0);
        const m = PREAMBLE_RE.exec(line);
        const session = m && sessions.get(m[1]);
        if (!session || session.state !== "dialing") {
          socket.destroy();
          return;
        }
        if (rest.length) socket.unshift(rest);
        attachSocket(session, socket);
      };
      socket.on("data", onData);
      socket.on("error", () => {});
    });
    p2pServer.on("error", (err) => {
      if (err.code === "EAFNOSUPPORT" || err.code === "EADDRNOTAVAIL") {
        onLog(`P2P IPv6 监听不可用（${err.code}），改用 0.0.0.0`);
        p2pServer.listen(desired, "0.0.0.0");
        return;
      }
      if (desired !== 0 && err.code === "EADDRINUSE") {
        onLog(`P2P 端口 ${desired} 被占用，改用随机端口`);
        p2pServer.listen(0, "::");
        return;
      }
      p2pError = err.message;
      onLog(`P2P 监听失败：${err.message}`);
    });
    p2pServer.on("listening", () => {
      const addr = p2pServer.address();
      p2pBoundPort = addr && typeof addr === "object" ? addr.port : null;
      p2pError = null;
    });
    p2pServer.listen(desired, "::");
  }

  function startUpnp() {
    const cfg = getP2p() || {};
    if (!upnpEnabled || cfg.upnp === false || cfg.enabled === false || p2pPort != null) {
      upnpMgr = createUpnpManager({ enabled: false });
      return;
    }
    upnpMgr = createUpnpManager({ port: p2pBoundPort || cfg.port || 3940, onLog });
    upnpMgr.start();
  }

  function getChannel(targetAddress) {
    const existing = channels.get(`out:${targetAddress}`);
    if (existing && !existing.channel.closed) return Promise.resolve(existing.channel);
    if (inflight.has(targetAddress)) return inflight.get(targetAddress);
    const p = establishChannel(targetAddress).finally(() => {
      if (inflight.get(targetAddress) === p) inflight.delete(targetAddress);
    });
    inflight.set(targetAddress, p);
    return p;
  }

  async function establishChannel(targetAddress) {
    if (!rv.connected) {
      throw new Error("未配置牵线服务或牵线服务当前未连接。");
    }
    const id = crypto.randomBytes(8).toString("hex");
    const hello = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingConnects.delete(id);
        reject(new Error("牵线服务未响应 connect。"));
      }, 30_000);
      pendingConnects.set(id, { resolve, reject, timer });
      rv.ws.sendJson({ t: "connect", id, to: targetAddress, candidates: ownCandidates() });
    });
    const session = startSession({
      sid: hello.sid,
      role: "a",
      peerAddress: targetAddress,
      relayKey: hello.relayKey,
      peerCandidates: hello.candidates || []
    });
    return new Promise((resolve, reject) => {
      session.resolve = resolve;
      session.reject = reject;
    });
  }

  function resolveTarget(target) {
    if (ADDRESS_RE.test(target)) return target;
    const remotes = getRemotes() || {};
    return remotes[target] || null;
  }

  async function proxyRequest(target, headers, bodyText) {
    const address = resolveTarget(target);
    if (!address) {
      return {
        status: 404,
        headers: { "content-type": "application/json; charset=utf-8" },
        bodyText: JSON.stringify({ error: `未知的远程目标「${target}」，请先在别名中绑定节点地址。` })
      };
    }
    try {
      const channel = await getChannel(address);
      const res = await channel.request({ headers, body: bodyText, timeoutMs: PROXY_TIMEOUT_MS });
      const out = {};
      if (res.headers["content-type"]) out["content-type"] = res.headers["content-type"];
      if (res.headers["www-authenticate"]) out["www-authenticate"] = res.headers["www-authenticate"];
      return { status: res.status, headers: out, bodyText: res.body ?? "" };
    } catch (err) {
      return {
        status: 502,
        headers: { "content-type": "application/json; charset=utf-8" },
        bodyText: JSON.stringify({ error: err.message })
      };
    }
  }

  const idleSweep = setInterval(() => {
    const now = Date.now();
    for (const rec of channels.values()) {
      const last = rec.channel.stats?.lastActivity || rec.since;
      if (now - last > channelIdleMs) rec.channel.close();
    }
  }, idleSweepMs);
  idleSweep.unref();

  function getStatus() {
    return {
      address: identity.address,
      rendezvous: {
        configured: rv.configured,
        connected: rv.connected,
        url: rv.url || null,
        lastError: rv.lastError
      },
      p2p: {
        enabled: getP2p()?.enabled !== false,
        upnpEnabled: getP2p()?.upnp !== false,
        listening: !!(p2pServer && p2pBoundPort),
        port: p2pBoundPort,
        candidates: ownCandidates(),
        error: p2pError,
        upnp: upnpMgr ? upnpMgr.status() : { state: "disabled" }
      },
      remotes: getRemotes() || {},
      remoteAllowFrom: getRemoteAllowFrom() || [],
      channels: [...channels.values()].map((rec) => ({
        peer: rec.channel.peerAddress,
        mode: rec.mode,
        direction: rec.direction,
        since: rec.since,
        bytesIn: rec.channel.stats.bytesIn,
        bytesOut: rec.channel.stats.bytesOut
      }))
    };
  }

  function shutdown() {
    stopped = true;
    clearInterval(idleSweep);
    if (rv.reconnectTimer) clearTimeout(rv.reconnectTimer);
    if (rv.pingTimer) clearInterval(rv.pingTimer);
    if (rv.ws && !rv.ws.closed) rv.ws.close(1001, "shutdown");
    for (const pending of pendingConnects.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("节点正在关闭。"));
    }
    pendingConnects.clear();
    for (const session of sessions.values()) {
      session.state = "closed";
      clearTimeout(session.windowTimer);
      clearTimeout(session.totalTimer);
      for (const s of session.pending) {
        try {
          s.destroy();
        } catch {
          // ignore
        }
      }
    }
    sessions.clear();
    for (const rec of channels.values()) rec.channel.close();
    channels.clear();
    if (p2pServer) {
      try {
        p2pServer.close();
      } catch {
        // ignore
      }
    }
    upnpMgr?.stop();
  }

  startP2p();
  startUpnp();
  connectRv();

  return {
    getChannel,
    proxyRequest,
    getStatus,
    reconnectRendezvous: connectRv,
    shutdown
  };
}
