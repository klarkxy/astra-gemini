import { spawn, spawnSync } from "node:child_process";

export function checkEnvironment() {
  const probe = (cmd, args = ["--version"]) => {
    const bin = process.platform === "win32" && ["npm", "pnpm"].includes(cmd) ? `${cmd}.cmd` : cmd;
    const res = spawnSync(bin, args, { encoding: "utf8", timeout: 5000 });
    if (res.error || res.status !== 0) return { available: false, version: "" };
    const text = (res.stdout || res.stderr || "").trim().split(/\r?\n/)[0] || "";
    return { available: true, version: text };
  };

  return {
    node: { available: true, version: process.version },
    git: probe("git"),
    pnpm: probe("pnpm"),
    npm: probe("npm"),
    python: probe("python3").available ? probe("python3") : probe("python"),
    cloudflared: probe("cloudflared")
  };
}

export function createTunnelManager(port) {
  let child = null;
  let publicUrl = null;
  let lastError = null;

  function stop() {
    if (child) {
      try {
        child.kill();
      } catch {
        // ignore
      }
      child = null;
    }
    publicUrl = null;
    return { running: false, publicUrl: null };
  }

  function start() {
    if (child) {
      return { ok: true, running: true, publicUrl };
    }
    lastError = null;
    publicUrl = null;
    try {
      child = spawn("cloudflared", ["tunnel", "--url", `http://127.0.0.1:${port}`], {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true
      });
    } catch (err) {
      lastError = err.message;
      return { ok: false, running: false, error: lastError };
    }

    const scan = (chunk) => {
      const text = chunk.toString("utf8");
      const m = text.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
      if (m) publicUrl = m[0];
    };
    child.stdout.on("data", scan);
    child.stderr.on("data", scan);
    child.on("error", (err) => {
      lastError = err.message;
      child = null;
    });
    child.on("close", () => {
      child = null;
      publicUrl = null;
    });

    return { ok: true, running: true, publicUrl };
  }

  function status() {
    return {
      running: Boolean(child),
      publicUrl,
      mcpUrl: publicUrl ? `${publicUrl}/mcp` : null,
      lastError
    };
  }

  return { start, stop, status };
}
