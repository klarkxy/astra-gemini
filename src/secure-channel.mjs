import crypto from "node:crypto";
import tls from "node:tls";
import zlib from "node:zlib";
import { addressFromSpkiDer } from "./identity.mjs";

const FRAME_MAX = 16 * 1024 * 1024;
const GZIP_MIN = 4096;
const PING_MS = 25_000;
const SILENCE_MS = 75_000;

function peerAddressOf(sock) {
  const cert = sock.getPeerX509Certificate();
  if (!cert) return null;
  try {
    return addressFromSpkiDer(cert.publicKey.export({ type: "spki", format: "der" }));
  } catch {
    return null;
  }
}

export function openChannel({ duplex, role, identity, expectedPeerAddress = null, onRequest = null, pingIntervalMs = null }) {
  return new Promise((resolve, reject) => {
    const common = {
      key: identity.privatePem,
      cert: identity.certPem,
      minVersion: "TLSv1.3",
      maxVersion: "TLSv1.3",
      ALPNProtocols: ["astra/1"],
      rejectUnauthorized: false
    };
    const sock =
      role === "server"
        ? new tls.TLSSocket(duplex, { isServer: true, requestCert: true, ...common })
        : tls.connect({ socket: duplex, checkServerIdentity: () => undefined, ...common });

    const onSecure = () => {
      const peerAddress = peerAddressOf(sock);
      if (!peerAddress) {
        sock.destroy();
        return reject(new Error("对端未提供证书，无法建立安全通道。"));
      }
      if (role === "client" && expectedPeerAddress && peerAddress !== expectedPeerAddress) {
        sock.destroy();
        return reject(new Error(`对端地址不匹配：期望 ${expectedPeerAddress}，实际 ${peerAddress}`));
      }
      finish(sock, peerAddress, resolve, reject, onRequest, pingIntervalMs);
    };
    sock.once("secure", onSecure);
    sock.once("secureConnect", onSecure);
    sock.once("error", (err) => reject(err));
  });
}

function finish(sock, peerAddress, resolve, reject, initialOnRequest = null, pingIntervalMs = null) {
  let buf = Buffer.alloc(0);
  const pending = new Map();
  let lastSeen = Date.now();
  let onRequest = initialOnRequest;
  let closed = false;
  const stats = { bytesIn: 0, bytesOut: 0, lastSeen, lastActivity: Date.now() };

  sock.on("data", (chunk) => {
    stats.bytesIn += chunk.length;
    lastSeen = Date.now();
    stats.lastSeen = lastSeen;
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    while (buf.length >= 5) {
      const len = buf.readUInt32BE(1);
      if (len > FRAME_MAX) {
        closeChannel();
        return;
      }
      if (buf.length < 5 + len) return;
      const flags = buf[0];
      let payload = buf.subarray(5, 5 + len);
      buf = buf.subarray(5 + len);
      try {
        if (flags & 1) payload = zlib.gunzipSync(payload);
        handleMessage(JSON.parse(payload.toString("utf8")));
      } catch {
        // 忽略无法解析的帧
      }
    }
  });

  const heartbeat = setInterval(() => {
    if (Date.now() - lastSeen > SILENCE_MS) {
      closeChannel();
      return;
    }
    send({ t: "ping" });
  }, pingIntervalMs ?? PING_MS);

  function send(obj) {
    if (closed) return;
    let payload = Buffer.from(JSON.stringify(obj), "utf8");
    let flags = 0;
    if (payload.length > GZIP_MIN) {
      const gz = zlib.gzipSync(payload, { level: 6 });
      if (gz.length < payload.length) {
        payload = gz;
        flags = 1;
      }
    }
    const frame = Buffer.allocUnsafe(5 + payload.length);
    frame[0] = flags;
    frame.writeUInt32BE(payload.length, 1);
    payload.copy(frame, 5);
    stats.bytesOut += frame.length;
    try {
      sock.write(frame);
    } catch {
      // ignore
    }
  }

  function handleMessage(msg) {
    if (msg.t === "ping") {
      send({ t: "pong" });
      return;
    }
    if (msg.t === "pong") return;
    if (msg.t === "res" && msg.id && pending.has(msg.id)) {
      stats.lastActivity = Date.now();
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(msg.error));
      else p.resolve({ status: msg.status, headers: msg.headers || {}, body: msg.body ?? "" });
      return;
    }
    if (msg.t === "req" && msg.id && onRequest) {
      stats.lastActivity = Date.now();
      Promise.resolve()
        .then(() => onRequest({ headers: msg.headers || {}, bodyText: msg.body ?? "" }))
        .then((res) => send({ t: "res", id: msg.id, status: res.status, headers: res.headers || {}, body: res.bodyText ?? "" }))
        .catch((err) => send({ t: "res", id: msg.id, status: 502, headers: {}, body: "", error: err?.message || String(err) }));
    }
  }

  function closeChannel() {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error("安全通道已关闭。"));
    }
    pending.clear();
    try {
      sock.destroy();
    } catch {
      // ignore
    }
    channel.onClose?.();
  }

  stats.lastSeen = lastSeen;
  sock.on("close", closeChannel);
  sock.on("error", () => {});

  const channel = {
    peerAddress,
    stats,
    get closed() {
      return closed;
    },
    request({ headers = {}, body = "", timeoutMs = 150_000 }) {
      const id = crypto.randomBytes(8).toString("hex");
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`远程请求超时 (${timeoutMs}ms)。`));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        send({ t: "req", id, headers, body });
      });
    },
    onRequest(fn) {
      onRequest = fn;
    },
    close() {
      closeChannel();
    },
    onClose: null
  };
  resolve(channel);
}
