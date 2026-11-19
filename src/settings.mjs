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
  upstream: {
    enabled: false,
    url: "",
    token: ""
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

export function loadSettings(bridgeRoot) {
  const filePath = getSettingsPath(bridgeRoot);
  if (!fs.existsSync(filePath)) {
    return {
      ...DEFAULT_SETTINGS,
      upstream: { ...DEFAULT_SETTINGS.upstream },
      globalSdkEnabled: { ...DEFAULT_SETTINGS.globalSdkEnabled }
    };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return {
      ...DEFAULT_SETTINGS,
      ...raw,
      upstream: {
        ...DEFAULT_SETTINGS.upstream,
        ...(raw.upstream || {})
      },
      globalSdkEnabled: {
        ...DEFAULT_SETTINGS.globalSdkEnabled,
        ...(raw.globalSdkEnabled || {})
      }
    };
  } catch {
    return {
      ...DEFAULT_SETTINGS,
      upstream: { ...DEFAULT_SETTINGS.upstream },
      globalSdkEnabled: { ...DEFAULT_SETTINGS.globalSdkEnabled }
    };
  }
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
    globalSdkEnabled: {
      ...current.globalSdkEnabled,
      ...(nextSettings.globalSdkEnabled || {})
    }
  };
  const filePath = getSettingsPath(bridgeRoot);
  fs.writeFileSync(filePath, JSON.stringify(merged, null, 2) + "\n", "utf8");
  return merged;
}
