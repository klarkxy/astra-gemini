import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadSettings } from "./settings.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = path.join(__dirname, "worker-runner.mjs");

const SAFE_ENV_KEYS = [
  "PATH",
  "Path",
  "HOME",
  "USERPROFILE",
  "TEMP",
  "TMP",
  "SystemRoot",
  "ComSpec",
  "NODE_ENV",
  "LANG",
  "LC_ALL",
  "PATHEXT",
  "APPDATA",
  "LOCALAPPDATA"
];

function buildSafeEnv() {
  const env = {};
  for (const key of SAFE_ENV_KEYS) {
    if (process.env[key] !== undefined) {
      env[key] = process.env[key];
    }
  }
  return env;
}

function runWorker(payload, { cwd, timeoutMs = 30_000, timeoutCapMs = 120_000 }) {
  const clampedTimeout = Math.max(1000, Math.min(Number(timeoutMs) || 30_000, timeoutCapMs));

  return new Promise((resolve) => {
    const child = spawn(process.execPath, [WORKER_PATH], {
      cwd,
      env: buildSafeEnv(),
      stdio: ["pipe", "pipe", "pipe"]
    });

    const stdoutChunks = [];
    const stderrChunks = [];
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
      resolve({
        ok: false,
        timedOut: true,
        error: `Verification script timed out after ${clampedTimeout}ms.`
      });
    }, clampedTimeout);

    child.stdout.on("data", (c) => stdoutChunks.push(c));
    child.stderr.on("data", (c) => stderrChunks.push(c));

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, error: err.message });
    });

    child.on("close", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const out = Buffer.concat(stdoutChunks).toString("utf8").trim();
      const errOut = Buffer.concat(stderrChunks).toString("utf8").trim();
      if (!out) {
        resolve({ ok: false, error: errOut || "Worker exited with empty output." });
        return;
      }
      try {
        resolve(JSON.parse(out));
      } catch {
        resolve({ ok: false, error: `Invalid worker JSON output: ${out.slice(0, 500)}`, stderr: errOut.slice(0, 500) });
      }
    });

    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

export async function listGlobalSdkCatalog(bridgeRoot) {
  const settings = loadSettings(bridgeRoot);
  return runWorker(
    { action: "catalog", bridgeRoot, globalSdkEnabled: settings.globalSdkEnabled },
    { cwd: bridgeRoot, timeoutMs: 10_000 }
  );
}

export async function listSdks(bridgeRoot, projectCfg) {
  const settings = loadSettings(bridgeRoot);
  return runWorker(
    { action: "list", bridgeRoot, projectCfg, globalSdkEnabled: settings.globalSdkEnabled },
    { cwd: projectCfg.root, timeoutMs: 10_000 }
  );
}

export async function execVerify(bridgeRoot, projectCfg, opts = {}) {
  const { script, timeoutMs = 30_000, maxOutputBytes = 8192 } = opts;
  if (typeof script !== "string" || script.trim() === "") {
    throw new Error("Missing required parameter: script (JavaScript code string).");
  }
  const settings = loadSettings(bridgeRoot);
  const clampedTimeout = Math.max(1000, Math.min(Number(timeoutMs) || 30_000, 120_000));
  return runWorker(
    {
      action: "exec",
      bridgeRoot,
      projectCfg,
      globalSdkEnabled: settings.globalSdkEnabled,
      script,
      maxOutputBytes,
      timeoutMs: clampedTimeout
    },
    { cwd: projectCfg.root, timeoutMs: clampedTimeout + 5_000, timeoutCapMs: 125_000 }
  );
}
