import fs from "node:fs";
import { getSettingsPath, loadSettings, saveSettings } from "../src/settings.mjs";

const bridgeRoot = process.env.ASTRA_BRIDGE_ROOT || "/data";

// 首次启动才播种环境变量：控制台对设置的修改优先级高于 env。
const firstBoot = !fs.existsSync(getSettingsPath(bridgeRoot));

const current = loadSettings(bridgeRoot);

const patch = {
  // 容器内网 IP 对节点无意义：关闭 UPnP 与 LAN 直连宣告，树内调用回退中继。
  advertiseLan: false,
  p2p: { ...current.p2p, upnp: false }
};

if (firstBoot) {
  const nodeId = (process.env.ASTRA_NODE_ID || "").trim();
  if (nodeId) patch.nodeId = nodeId;

  const upstreamUrl = (process.env.ASTRA_UPSTREAM_URL || "").trim();
  if (upstreamUrl) {
    patch.upstream = {
      enabled: true,
      url: upstreamUrl,
      token: (process.env.ASTRA_UPSTREAM_TOKEN || "").trim()
    };
  }
}

saveSettings(bridgeRoot, patch);
