import crypto from "node:crypto";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { acceptWebSocketUpgrade } from "./ws.mjs";
import { addressFromSpkiDer } from "./identity.mjs";
import { PROTOCOL_VERSION } from "./tree.mjs";

const HEARTBEAT_MS = 25_000;
const SILENCE_MS = 75_000;
const SESSION_TTL_MS = 60_000;

function tokenEqual(a, b) {
  const da = crypto.createHash("sha256").update(String(a ?? "")).digest();
  const db = crypto.createHash("sha256").update(String(b ?? "")).digest();
  return crypto.timingSafeEqual(da, db);
}

function bearer(req) {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || "");
  return m ? m[1] : null;
}

export function createRendezvousServer({
  token,
  host = "127.0.0.1",
  port = 3941,
  onLog = () => {},
  onRelayChunk = null,
  protocolVersion = PROTOCOL_VERSION
} = {}) {
  if (!token) throw new Error("RV_TOKEN is required.");

  const nodes = new Map();
  const sessions = new Map();
  let totalRelayed = 0;

  const server = http.createServer((req, res) => {
    let pathname;
    try {
      pathname = new URL(req.url || "/", "http://localhost").pathname;
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (req.method === "GET" && pathname === "/health") {
      const body = JSON.stringify({ ok: true, nodes: nodes.size, sessions: sessions.size, relayedBytes: totalRelayed });
      res.writeHead(200, { "content-type": "application/json" }).end(body);
      return;
    }
    res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: "Not found" }));
  });

  server.on("upgrade", (req, socket, head) => {
    let url;
    try {
      url = new URL(req.url || "/", "http://localhost");
    } catch {
      socket.destroy();
      return;
    }
    if (!tokenEqual(bearer(req), token)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    if (url.pathname === "/rv") {
      const ws = acceptWebSocketUpgrade(req, socket, head);
      handleNode(ws, req);
      return;
    }
    if (url.pathname === "/rv/relay") {
      const sid = url.searchParams.get("sid") || "";
      const role = url.searchParams.get("role") || "";
      const key = url.searchParams.get("key") || "";
      const session = sessions.get(sid);
      if (
        !session ||
        (role !== "a" && role !== "b") ||
        !tokenEqual(key, session[role].key) ||
        session[role].socket
      ) {
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        socket.destroy();
        return;
      }
      const ws = acceptWebSocketUpgrade(req, socket, head);
      handleRelay(ws, session, role);
      return;
    }
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
  });

  function handleNode(ws, req) {
    const nonce = crypto.randomBytes(16).toString("hex");
    let node = null;
    ws.sendJson({ t: "challenge", nonce });

    ws.on("message", (text) => {
      let msg;
      try {
        msg = JSON.parse(text);
      } catch {
        return;
      }
      if (!node) {
        if (msg.t !== "hello") return;
        if (msg.protocolVersion !== protocolVersion) {
          ws.close(1008, `protocol version mismatch: server=${protocolVersion} child=${msg.protocolVersion}`);
          return;
        }
        let address;
        let publicKey;
        try {
          const der = Buffer.from(String(msg.spki || ""), "base64");
          publicKey = crypto.createPublicKey({ key: der, format: "der", type: "spki" });
          address = addressFromSpkiDer(der);
        } catch {
          ws.close(1008, "hello spki 无效");
          return;
        }
        let verified = false;
        try {
          verified = crypto.verify(
            null,
            Buffer.from(`astra-rv-v1:${nonce}`),
            publicKey,
            Buffer.from(String(msg.sig || ""), "base64")
          );
        } catch {
          verified = false;
        }
        if (!verified) {
          ws.close(1008, "hello 签名验证失败");
          return;
        }
        const old = nodes.get(address);
        if (old && old.ws !== ws) old.ws.close(1000, "replaced by newer connection");
        const ip = String(req.socket.remoteAddress || "").replace(/^::ffff:/, "");
        node = { address, ws, ip, lastSeen: Date.now() };
        nodes.set(address, node);
        onLog(`节点 ${address} 上线（${ip}）`);
        ws.sendJson({ t: "welcome", address, observedIp: ip });
        return;
      }

      if (msg.t === "ping") {
        node.lastSeen = Date.now();
        ws.sendJson({ t: "pong" });
        return;
      }
      if (msg.t === "connect" && msg.id && typeof msg.to === "string") {
        const target = nodes.get(msg.to);
        if (!target) {
          ws.sendJson({ t: "connect-fail", id: msg.id, error: "目标节点不在线" });
          return;
        }
        const sid = crypto.randomBytes(8).toString("hex");
        const session = {
          sid,
          connectId: msg.id,
          a: { addr: node.address, key: crypto.randomBytes(16).toString("hex"), socket: null },
          b: { addr: msg.to, key: crypto.randomBytes(16).toString("hex"), socket: null },
          createdAt: Date.now(),
          relayedBytes: 0,
          relayPipe: false,
          closed: false
        };
        sessions.set(sid, session);
        target.ws.sendJson({
          t: "incoming",
          sid,
          from: node.address,
          candidates: Array.isArray(msg.candidates) ? msg.candidates : [],
          relayKey: session.b.key
        });
        return;
      }
      if (msg.t === "accept" && msg.sid) {
        const session = sessions.get(msg.sid);
        if (!session || session.b.addr !== node.address) return;
        const a = nodes.get(session.a.addr);
        if (a) {
          a.ws.sendJson({
            t: "connect-ok",
            id: session.connectId,
            sid: session.sid,
            candidates: Array.isArray(msg.candidates) ? msg.candidates : [],
            relayKey: session.a.key
          });
        }
        return;
      }
      if (msg.t === "reject" && msg.sid) {
        const session = sessions.get(msg.sid);
        if (!session || session.b.addr !== node.address) return;
        const a = nodes.get(session.a.addr);
        if (a) a.ws.sendJson({ t: "connect-fail", id: session.connectId, error: msg.error || "目标拒绝连接" });
        sessions.delete(msg.sid);
        return;
      }
      if (msg.t === "relay" && msg.sid) {
        const session = sessions.get(msg.sid);
        if (!session || session.a.addr !== node.address) return;
        const b = nodes.get(session.b.addr);
        if (b) b.ws.sendJson({ t: "relay", sid: session.sid });
      }
    });

    ws.on("close", () => {
      if (node && nodes.get(node.address)?.ws === ws) {
        nodes.delete(node.address);
        onLog(`节点 ${node.address} 下线`);
      }
    });
  }

  function handleRelay(ws, session, role) {
    session[role].socket = ws;
    session.pendingBytes ||= { a: [], b: [] };
    const peer = () => session[role === "a" ? "b" : "a"].socket;
    const forward = (buf, other) => {
      session.relayedBytes += buf.length;
      totalRelayed += buf.length;
      onRelayChunk?.(buf);
      try {
        other.sendBinary(buf);
      } catch {
        // ignore
      }
    };
    if (session.a.socket && session.b.socket && !session.relayPipe) {
      session.relayPipe = true;
      for (const buf of session.pendingBytes.a) forward(buf, session.b.socket);
      for (const buf of session.pendingBytes.b) forward(buf, session.a.socket);
      session.pendingBytes = { a: [], b: [] };
      onLog(`relay ${session.sid} 管道建立（${session.a.addr} ↔ ${session.b.addr}）`);
    }
    ws.on("binary", (buf) => {
      const other = peer();
      if (!other || other.closed) {
        if (session.pendingBytes[role].length >= 64) {
          killSession(session);
          return;
        }
        session.pendingBytes[role].push(Buffer.from(buf));
        return;
      }
      forward(buf, other);
    });
    ws.on("close", () => {
      const other = peer();
      if (other && !other.closed) other.close(1000, "peer closed");
      if (!session.closed) {
        session.closed = true;
        onLog(`relay ${session.sid} 关闭，转发 ${session.relayedBytes} 字节`);
      }
      sessions.delete(session.sid);
    });
  }

  function killSession(session) {
    if (session.closed) return;
    session.closed = true;
    for (const r of ["a", "b"]) {
      const s = session[r].socket;
      if (s && !s.closed) s.close(1011, "session closed");
    }
    sessions.delete(session.sid);
    onLog(`relay ${session.sid} 关闭（缓冲溢出），转发 ${session.relayedBytes} 字节`);
  }

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const n of nodes.values()) {
      if (now - n.lastSeen > SILENCE_MS) {
        n.ws.terminate();
        if (nodes.get(n.address)?.ws === n.ws) nodes.delete(n.address);
      }
    }
    for (const s of sessions.values()) {
      if (!s.relayPipe && now - s.createdAt > SESSION_TTL_MS) {
        const a = nodes.get(s.a.addr);
        if (a) a.ws.sendJson({ t: "connect-fail", id: s.connectId, error: "连接会话超时" });
        sessions.delete(s.sid);
      }
    }
    for (const n of nodes.values()) {
      if (now - n.lastSeen > SILENCE_MS) nodes.delete(n.address);
    }
  }, HEARTBEAT_MS);
  sweep.unref();

  return {
    server,
    address() {
      return server.address();
    },
    close() {
      clearInterval(sweep);
      for (const s of sessions.values()) {
        s.a.socket?.close?.();
        s.b.socket?.close?.();
      }
      for (const n of nodes.values()) n.ws.close(1001, "server shutdown");
      server.close();
    }
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const token = process.env.RV_TOKEN;
  if (!token) {
    console.error("请通过环境变量 RV_TOKEN 提供访问令牌。");
    process.exit(1);
  }
  const rv = createRendezvousServer({
    token,
    onLog: (line) => console.log(`[rendezvous] ${line}`)
  });
  rv.server.listen(Number(process.env.PORT || 3941), process.env.HOST || "127.0.0.1", () => {
    const addr = rv.server.address();
    console.log(`牵线服务已启动：http://${addr.address}:${addr.port}/health`);
  });
}
