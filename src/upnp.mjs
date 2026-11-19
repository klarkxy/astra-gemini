import dgram from "node:dgram";
import http from "node:http";
import os from "node:os";

const SSDP_ADDR = "239.255.255.250";
const SSDP_PORT = 1900;
const SERVICE_TYPES = [
  "urn:schemas-upnp-org:service:WANIPConnection:1",
  "urn:schemas-upnp-org:service:WANIPConnection:2",
  "urn:schemas-upnp-org:service:WANPPPConnection:1"
];
const RENEW_MS = 30 * 60 * 1000;

function msearch(st) {
  return Buffer.from(
    `M-SEARCH * HTTP/1.1\r\nHOST: ${SSDP_ADDR}:${SSDP_PORT}\r\nMAN: "ssdp:discover"\r\nMX: 1\r\nST: ${st}\r\n\r\n`
  );
}

function discoverLocations(timeoutMs = 2000) {
  return new Promise((resolve) => {
    const locations = new Set();
    const sock = dgram.createSocket({ type: "udp4", reuseAddr: true });
    const done = () => {
      try {
        sock.close();
      } catch {
        // ignore
      }
      resolve([...locations]);
    };
    sock.on("error", done);
    sock.on("message", (msg) => {
      const m = /^LOCATION:\s*(\S+)/im.exec(msg.toString("utf8"));
      if (m) locations.add(m[1]);
    });
    sock.on("listening", () => {
      for (const st of SERVICE_TYPES) {
        try {
          sock.send(msearch(st), SSDP_PORT, SSDP_ADDR);
        } catch {
          // ignore
        }
      }
    });
    try {
      sock.bind(0);
    } catch {
      done();
      return;
    }
    setTimeout(done, timeoutMs).unref();
  });
}

function httpGet(url, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("timeout")));
  });
}

function httpPost(url, body, headers, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request(
      {
        method: "POST",
        host: u.hostname,
        port: u.port || 80,
        path: u.pathname + u.search,
        headers: {
          "content-type": "text/xml; charset=utf-8",
          "content-length": Buffer.byteLength(body),
          ...headers
        },
        timeout: timeoutMs
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString("utf8") }));
      }
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.end(body);
  });
}

function pickLocalIpv4(gatewayHost = null) {
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const i of list || []) {
      if (i.family === "IPv4" && !i.internal && i.address) {
        return i.address;
      }
    }
  }
  return "127.0.0.1";
}

function findControlUrl(xml, location) {
  const baseMatch = /<URLBase>([^<]+)<\/URLBase>/i.exec(xml);
  const base = baseMatch ? baseMatch[1].trim() : location;
  for (const st of SERVICE_TYPES) {
    const serviceRe = /<service>([\s\S]*?)<\/service>/gi;
    let m;
    while ((m = serviceRe.exec(xml))) {
      const block = m[1];
      if (!new RegExp(escapeRe(st), "i").test(block)) continue;
      const cu = /<controlURL>([^<]+)<\/controlURL>/i.exec(block);
      if (!cu) continue;
      return { controlUrl: new URL(cu[1].trim(), base).toString(), serviceType: st };
    }
  }
  return null;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function soapEnvelope(serviceType, action, args) {
  const inner = Object.entries(args)
    .map(([k, v]) => `<${k}>${String(v)}</${k}>`)
    .join("");
  return `<?xml version="1.0" encoding="utf-8"?>` +
    `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">` +
    `<s:Body><u:${action} xmlns:u="${serviceType}">${inner}</u:${action}></s:Body></s:Envelope>`;
}

export function createUpnpManager({ port, internalIp = null, location = null, enabled = true, onLog = () => {} } = {}) {
  let state = { state: enabled ? "idle" : "disabled", externalIp: null, externalAddr: null, error: null };
  let service = null;
  let renewTimer = null;
  let stopped = false;

  async function resolveService() {
    if (location) {
      const xml = await httpGet(location);
      const found = findControlUrl(xml, location);
      if (!found) throw new Error("UPnP 描述中未找到 WANIPConnection 服务。");
      return found;
    }
    const locations = await discoverLocations(2000);
    for (const loc of locations) {
      try {
        const xml = await httpGet(loc);
        const found = findControlUrl(xml, loc);
        if (found) return found;
      } catch {
        // 尝试下一个 LOCATION
      }
    }
    throw new Error("未发现可用的 UPnP 网关。");
  }

  async function soap(action, args) {
    const body = soapEnvelope(service.serviceType, action, args);
    return httpPost(service.controlUrl, body, { SOAPAction: `"${service.serviceType}#${action}"` });
  }

  async function getExternalIp() {
    const res = await soap("GetExternalIPAddress", {});
    const m = /<NewExternalIPAddress>([^<]+)<\/NewExternalIPAddress>/i.exec(res.text);
    return m ? m[1].trim() : null;
  }

  async function addMapping() {
    const client = internalIp || pickLocalIpv4(service && new URL(service.controlUrl).hostname);
    await soap("AddPortMapping", {
      NewRemoteHost: "",
      NewExternalPort: port,
      NewProtocol: "TCP",
      NewInternalPort: port,
      NewInternalClient: client,
      NewEnabled: 1,
      NewPortMappingDescription: "astra-gemini",
      NewLeaseDuration: 3600
    });
  }

  async function deleteMapping() {
    try {
      await soap("DeletePortMapping", { NewRemoteHost: "", NewExternalPort: port, NewProtocol: "TCP" });
    } catch {
      // 关机清理失败不影响退出
    }
  }

  async function start() {
    if (!enabled || stopped) return state;
    state = { ...state, state: "searching" };
    try {
      service = await resolveService();
      const ip = await getExternalIp();
      await addMapping();
      state = { state: "mapped", externalIp: ip, externalAddr: ip ? `${ip}:${port}` : null, error: null };
      onLog(`UPnP 端口映射成功：${state.externalAddr || port}`);
      renewTimer = setInterval(() => {
        addMapping().catch((err) => {
          state = { ...state, state: "failed", error: err.message };
        });
      }, RENEW_MS);
      renewTimer.unref();
    } catch (err) {
      state = { state: "failed", externalIp: null, externalAddr: null, error: err.message };
      onLog(`UPnP 不可用：${err.message}`);
    }
    return state;
  }

  async function stop() {
    stopped = true;
    if (renewTimer) clearInterval(renewTimer);
    if (service && state.state === "mapped") await deleteMapping();
    return state;
  }

  return { start, stop, status: () => state };
}
