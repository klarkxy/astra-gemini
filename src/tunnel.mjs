import { spawn, spawnSync } from "node:child_process";

export function checkEnvironment() {
  const probe = (cmd, args = ["--version"]) => {
    const needsShell = process.platform === "win32" && ["npm", "pnpm"].includes(cmd);
    const res = spawnSync(cmd, args, { encoding: "utf8", timeout: 5000, shell: needsShell });
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

export function createTunnelManager(port, getTunnelConfig = () => null) {
  let child = null;
  let publicUrl = null;
  let lastError = null;
  let stderrTail = "";
  let intentionalStop = false;

  function stop() {
    if (child) {
      intentionalStop = true;
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
    stderrTail = "";
    intentionalStop = false;
    const cfg = getTunnelConfig() || {};
    const isNamed = cfg.mode === "named";
    if (isNamed && !cfg.token) {
      lastError = "命名隧道模式需要先保存 Tunnel Token";
      return { ok: false, running: false, error: lastError };
    }
    try {
      child = isNamed
        ? spawn("cloudflared", ["tunnel", "--no-autoupdate", "run"], {
            env: { ...process.env, TUNNEL_TOKEN: cfg.token },
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true
          })
        : spawn("cloudflared", ["tunnel", "--url", `http://127.0.0.1:${port}`], {
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true
          });
    } catch (err) {
      lastError = err.message;
      return { ok: false, running: false, error: lastError };
    }
    if (isNamed && cfg.publicUrl) {
      publicUrl = cfg.publicUrl.replace(/\/+$/, "");
    }

    const scan = (chunk) => {
      const text = chunk.toString("utf8");
      const m = text.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
      if (m) publicUrl = m[0];
    };
    if (isNamed) {
      child.stdout.on("data", () => {});
      child.stderr.on("data", (c) => {
        stderrTail = (stderrTail + c.toString("utf8")).slice(-2048);
      });
    } else {
      child.stdout.on("data", scan);
      child.stderr.on("data", scan);
    }
    child.on("error", (err) => {
      lastError = err.message;
      child = null;
    });
    child.on("close", () => {
      child = null;
      publicUrl = null;
      if (isNamed && !intentionalStop && stderrTail.trim()) {
        lastError = stderrTail.trim().split(/\r?\n/).filter(Boolean).slice(-3).join(" | ").slice(0, 500);
      }
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
