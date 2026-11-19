import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function defaultNodeId() {
  const raw = (os.hostname() || "node").toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return (raw || "local-node").slice(0, 32);
}

export const DEFAULT_SETTINGS = {
  nodeId: defaultNodeId(),
  port: 3939,
  authMode: "bearer",
  publicUrl: "",
  directEnabled: true,
  advertiseLan: true,
  upstream: {
    enabled: false,
    url: "",
    token: ""
  },
  tunnel: {
    mode: "quick",
    token: "",
    publicUrl: ""
  },
  globalSdkEnabled: {
    git: true,
    pnpm: true,
    npm: true,
    python: true,
    http: true,
    fs_read: true,
    worktree: false
  }
};

export function getSettingsPath(bridgeRoot) {
  return path.join(path.resolve(bridgeRoot), "settings.json");
}

function mergedDefaults() {
  return {
    ...DEFAULT_SETTINGS,
    upstream: { ...DEFAULT_SETTINGS.upstream },
    tunnel: { ...DEFAULT_SETTINGS.tunnel },
    globalSdkEnabled: { ...DEFAULT_SETTINGS.globalSdkEnabled }
  };
}

export function loadSettings(bridgeRoot) {
  const filePath = getSettingsPath(bridgeRoot);
  let merged = mergedDefaults();
  if (fs.existsSync(filePath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
      merged = {
        ...mergedDefaults(),
        ...raw,
        upstream: { ...DEFAULT_SETTINGS.upstream, ...(raw.upstream || {}) },
        tunnel: { ...DEFAULT_SETTINGS.tunnel, ...(raw.tunnel || {}) },
        globalSdkEnabled: {
          ...DEFAULT_SETTINGS.globalSdkEnabled,
          ...(raw.globalSdkEnabled || {})
        }
      };
    } catch {
      merged = mergedDefaults();
    }
  }
  if (typeof merged.nodeSecret !== "string" || !/^[0-9a-f]{64}$/i.test(merged.nodeSecret)) {
    merged.nodeSecret = crypto.randomBytes(32).toString("hex");
    try {
      fs.writeFileSync(filePath, JSON.stringify(merged, null, 2) + "\n", "utf8");
    } catch {
      // ignore
    }
  }
  return merged;
}

export function saveSettings(bridgeRoot, nextSettings) {
  const current = loadSettings(bridgeRoot);
  const merged = {
    ...current,
    ...nextSettings,
    upstream: {
      ...current.upstream,
      ...(nextSettings.upstream || {})
    },
    tunnel: {
      ...current.tunnel,
      ...(nextSettings.tunnel || {})
    },
    globalSdkEnabled: {
      ...current.globalSdkEnabled,
      ...(nextSettings.globalSdkEnabled || {})
    }
  };
  const filePath = getSettingsPath(bridgeRoot);
  fs.writeFileSync(filePath, JSON.stringify(merged, null, 2) + "\n", "utf8");
  return merged;
}
