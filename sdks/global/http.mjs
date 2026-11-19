import net from "node:net";

export const meta = {
  name: "http",
  title: "本地服务探活与接口验证",
  category: "联调与验收",
  description: "严格限定仅访问本机 127.0.0.1 / localhost，用于探测本地开发服务器端口和校验 HTTP 接口返回。",
  functions: {
    probePort: {
      signature: "async probePort(port: number, timeoutMs?: number) => { ok, open, port }",
      description: "检测本机指定 TCP 端口是否已监听。"
    },
    request: {
      signature: "async request(url: string, opts?: { method?: string, headers?: object, body?: string, maxChars?: number }) => { ok, status, contentType, body, truncated }",
      description: "向 http://127.0.0.1:<port>/... 或 http://localhost:<port>/... 发起请求并返回精简响应。"
    }
  }
};

function assertLocalUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`无效的 URL: ${rawUrl}`);
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("仅允许 http/https 协议。");
  }
  if (!["127.0.0.1", "localhost", "::1"].includes(parsed.hostname)) {
    throw new Error(`安全限制：http SDK 仅允许访问本机回环地址，已拦截 ${parsed.hostname}`);
  }
  return parsed.href;
}

export function createSdk() {
  return {
    probePort(port, timeoutMs = 1500) {
      const p = Number(port);
      if (!Number.isInteger(p) || p < 1 || p > 65535) {
        return Promise.resolve({ ok: false, open: false, error: `非法端口号: ${port}` });
      }
      return new Promise((resolve) => {
        const socket = new net.Socket();
        let done = false;
        const finish = (open) => {
          if (done) return;
          done = true;
          try {
            socket.destroy();
          } catch {
            // ignore
          }
          resolve({ ok: true, open, port: p });
        };
        socket.setTimeout(Math.min(Number(timeoutMs) || 1500, 5000));
        socket.once("connect", () => finish(true));
        socket.once("timeout", () => finish(false));
        socket.once("error", () => finish(false));
        socket.connect(p, "127.0.0.1");
      });
    },

    async request(rawUrl, { method = "GET", headers = {}, body = undefined, maxChars = 4000 } = {}) {
      const safeUrl = assertLocalUrl(rawUrl);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);
      try {
        const res = await fetch(safeUrl, {
          method,
          headers,
          body: body !== undefined ? String(body) : undefined,
          signal: controller.signal
        });
        const text = await res.text();
        const cap = Math.max(200, Math.min(Number(maxChars) || 4000, 16000));
        const truncated = text.length > cap;
        return {
          ok: res.ok,
          status: res.status,
          contentType: res.headers.get("content-type") || "",
          truncated,
          body: truncated ? text.slice(0, cap) + "... [truncated]" : text
        };
      } catch (err) {
        return { ok: false, error: err?.message || String(err) };
      } finally {
        clearTimeout(timer);
      }
    }
  };
}
