import crypto from "node:crypto";
import EventEmitter from "node:events";
import http from "node:http";
import https from "node:https";
import zlib from "node:zlib";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const GZIP_THRESHOLD_BYTES = 4096;

function encodeFrame(opcode, payloadBuf, mask = false) {
  const len = payloadBuf.length;
  let headerLen = 2;
  if (len >= 126 && len < 65536) headerLen += 2;
  else if (len >= 65536) headerLen += 8;
  if (mask) headerLen += 4;

  const out = Buffer.allocUnsafe(headerLen + len);
  out[0] = 0x80 | (opcode & 0x0f);

  let offset = 2;
  const maskBit = mask ? 0x80 : 0x00;
  if (len < 126) {
    out[1] = maskBit | len;
  } else if (len < 65536) {
    out[1] = maskBit | 126;
    out.writeUInt16BE(len, 2);
    offset = 4;
  } else {
    out[1] = maskBit | 127;
    out.writeBigUInt64BE(BigInt(len), 2);
    offset = 10;
  }

  if (mask) {
    const key = crypto.randomBytes(4);
    key.copy(out, offset);
    offset += 4;
    for (let i = 0; i < len; i++) {
      out[offset + i] = payloadBuf[i] ^ key[i & 3];
    }
  } else {
    payloadBuf.copy(out, offset);
  }
  return out;
}

export class MiniWebSocket extends EventEmitter {
  constructor(socket, { isClient = false, initialBuffer = null } = {}) {
    super();
    this.socket = socket;
    this.isClient = isClient;
    this.closed = false;
    this._buf = Buffer.alloc(0);
    this._fragOpcode = null;
    this._fragChunks = [];

    socket.setNoDelay(true);
    socket.on("data", (chunk) => this._onData(chunk));
    socket.on("close", () => this._handleClose(1006, ""));
    socket.on("error", (err) => {
      if (!this.closed) this.emit("error", err);
    });

    if (initialBuffer && initialBuffer.length > 0) {
      this._onData(initialBuffer);
    }
  }

  sendText(text) {
    if (this.closed) throw new Error("WebSocket is closed.");
    const buf = Buffer.from(String(text), "utf8");
    if (buf.length > GZIP_THRESHOLD_BYTES) {
      const gz = zlib.gzipSync(buf, { level: 6 });
      if (gz.length < buf.length) {
        this.socket.write(encodeFrame(0x2, gz, this.isClient));
        return;
      }
    }
    this.socket.write(encodeFrame(0x1, buf, this.isClient));
  }

  sendJson(obj) {
    this.sendText(JSON.stringify(obj));
  }

  ping(data = "") {
    if (this.closed) return;
    this.socket.write(encodeFrame(0x9, Buffer.from(String(data), "utf8"), this.isClient));
  }

  close(code = 1000, reason = "") {
    if (this.closed) return;
    const reasonBuf = Buffer.from(reason, "utf8");
    const payload = Buffer.allocUnsafe(2 + reasonBuf.length);
    payload.writeUInt16BE(code, 0);
    reasonBuf.copy(payload, 2);
    try {
      this.socket.write(encodeFrame(0x8, payload, this.isClient));
    } catch {
      // ignore
    }
    try {
      this.socket.end();
    } catch {
      // ignore
    }
    this._handleClose(code, reason);
  }

  terminate() {
    if (this.closed) return;
    try {
      this.socket.destroy();
    } catch {
      // ignore
    }
    this._handleClose(1006, "terminated");
  }

  _handleClose(code, reason) {
    if (this.closed) return;
    this.closed = true;
    this.emit("close", code, reason);
  }

  _deliverPayload(opcode, payload) {
    if (opcode === 0x1) {
      this.emit("message", payload.toString("utf8"));
      return;
    }
    if (opcode === 0x2) {
      if (payload.length >= 2 && payload[0] === 0x1f && payload[1] === 0x8b) {
        try {
          const inflated = zlib.gunzipSync(payload);
          this.emit("message", inflated.toString("utf8"));
          return;
        } catch {
          // fall through as raw binary
        }
      }
      this.emit("binary", payload);
    }
  }

  _onData(chunk) {
    this._buf = this._buf.length === 0 ? chunk : Buffer.concat([this._buf, chunk]);

    while (this._buf.length >= 2) {
      const b0 = this._buf[0];
      const b1 = this._buf[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let payloadLen = b1 & 0x7f;
      let offset = 2;

      if (payloadLen === 126) {
        if (this._buf.length < 4) return;
        payloadLen = this._buf.readUInt16BE(2);
        offset = 4;
      } else if (payloadLen === 127) {
        if (this._buf.length < 10) return;
        const bigLen = this._buf.readBigUInt64BE(2);
        if (bigLen > BigInt(32 * 1024 * 1024)) {
          this.close(1009, "Frame too large");
          return;
        }
        payloadLen = Number(bigLen);
        offset = 10;
      }

      const maskLen = masked ? 4 : 0;
      if (this._buf.length < offset + maskLen + payloadLen) return;

      let maskKey = null;
      if (masked) {
        maskKey = this._buf.subarray(offset, offset + 4);
        offset += 4;
      }

      const payload = Buffer.from(this._buf.subarray(offset, offset + payloadLen));
      this._buf = this._buf.subarray(offset + payloadLen);

      if (masked && maskKey) {
        for (let i = 0; i < payload.length; i++) {
          payload[i] ^= maskKey[i & 3];
        }
      }

      if (opcode === 0x8) {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1000;
        const reason = payload.length > 2 ? payload.subarray(2).toString("utf8") : "";
        this.close(code, reason);
        return;
      }
      if (opcode === 0x9) {
        if (!this.closed) {
          this.socket.write(encodeFrame(0xa, payload, this.isClient));
        }
        continue;
      }
      if (opcode === 0xa) {
        this.emit("pong", payload);
        continue;
      }

      if (opcode === 0x0) {
        this._fragChunks.push(payload);
        if (fin) {
          const full = Buffer.concat(this._fragChunks);
          const op = this._fragOpcode;
          this._fragChunks = [];
          this._fragOpcode = null;
          this._deliverPayload(op, full);
        }
      } else if (opcode === 0x1 || opcode === 0x2) {
        if (fin) {
          this._deliverPayload(opcode, payload);
        } else {
          this._fragOpcode = opcode;
          this._fragChunks = [payload];
        }
      }
    }
  }
}

export function acceptWebSocketUpgrade(req, socket, head) {
  const key = req.headers["sec-websocket-key"];
  if (!key) {
    socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
    socket.destroy();
    return null;
  }
  const accept = crypto.createHash("sha1").update(key + WS_GUID).digest("base64");
  socket.write(
    [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
      "\r\n"
    ].join("\r\n")
  );
  return new MiniWebSocket(socket, { isClient: false, initialBuffer: head });
}

export function connectWebSocket(rawUrl, { headers = {}, timeoutMs = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(rawUrl);
    const isSecure = parsed.protocol === "wss:" || parsed.protocol === "https:";
    const mod = isSecure ? https : http;
    const key = crypto.randomBytes(16).toString("base64");
    const expectedAccept = crypto.createHash("sha1").update(key + WS_GUID).digest("base64");

    const req = mod.request({
      hostname: parsed.hostname,
      port: parsed.port || (isSecure ? 443 : 80),
      path: `${parsed.pathname}${parsed.search}`,
      method: "GET",
      headers: {
        Upgrade: "websocket",
        Connection: "Upgrade",
        "Sec-WebSocket-Key": key,
        "Sec-WebSocket-Version": "13",
        ...headers
      },
      timeout: timeoutMs
    });

    req.on("upgrade", (res, socket, head) => {
      const accept = res.headers["sec-websocket-accept"];
      if (accept !== expectedAccept) {
        socket.destroy();
        reject(new Error("Invalid Sec-WebSocket-Accept header."));
        return;
      }
      resolve(new MiniWebSocket(socket, { isClient: true, initialBuffer: head }));
    });

    req.on("response", (res) => {
      reject(new Error(`WebSocket upgrade rejected with HTTP ${res.statusCode}`));
    });
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("WebSocket connection timed out."));
    });
    req.on("error", (err) => reject(err));
    req.end();
  });
}
