import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SANDBOX_PATH = path.join(__dirname, "sandbox-runner.mjs");

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function discoverSdkFiles(bridgeRoot, projectId, allowlist, globalEnabledMap = {}, includeDisabled = false) {
  const dirs = [
    { scope: "global", dir: path.join(bridgeRoot, "sdks", "global") },
    ...(projectId ? [{ scope: "project", dir: path.join(bridgeRoot, "sdks", "projects", projectId) }] : [])
  ];

  const found = new Map();
  for (const { scope, dir } of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".mjs")) continue;
      const sdkName = entry.name.slice(0, -4);
      const globallyEnabled = Object.prototype.hasOwnProperty.call(globalEnabledMap, sdkName)
        ? Boolean(globalEnabledMap[sdkName])
        : true;
      const projectAllowed =
        allowlist === "*" || !Array.isArray(allowlist) ? true : allowlist.includes(sdkName);

      if (!includeDisabled && (!globallyEnabled || !projectAllowed)) {
        continue;
      }
      found.set(sdkName, {
        name: sdkName,
        scope,
        globallyEnabled,
        projectAllowed,
        file: path.join(dir, entry.name)
      });
    }
  }
  return Array.from(found.values()).sort((a, b) => a.name.localeCompare(b.name));
}

async function main() {
  const raw = await readStdin();
  const payload = JSON.parse(raw);
  const {
    action,
    bridgeRoot,
    projectCfg = null,
    globalSdkEnabled = {},
    script,
    maxOutputBytes = 8192,
    timeoutMs = 30_000
  } = payload;

  if (action === "catalog") {
    const sdkEntries = discoverSdkFiles(bridgeRoot, null, "*", globalSdkEnabled, true);
    const sdks = [];
    for (const entry of sdkEntries) {
      const mod = await import(pathToFileURL(entry.file).href);
      sdks.push({
        name: entry.name,
        scope: entry.scope,
        enabled: entry.globallyEnabled,
        title: mod.meta?.title || entry.name,
        category: mod.meta?.category || "dev",
        description: mod.meta?.description || "",
        functions: mod.meta?.functions || {}
      });
    }
    process.stdout.write(JSON.stringify({ ok: true, sdks }));
    return;
  }

  const sdkEntries = discoverSdkFiles(
    bridgeRoot,
    projectCfg?.id || null,
    projectCfg?.sdks ?? "*",
    globalSdkEnabled,
    false
  );

  if (action === "list") {
    const sdks = [];
    for (const entry of sdkEntries) {
      const mod = await import(pathToFileURL(entry.file).href);
      sdks.push({
        name: entry.name,
        scope: entry.scope,
        title: mod.meta?.title || entry.name,
        description: mod.meta?.description || "",
        functions: mod.meta?.functions || {}
      });
    }
    process.stdout.write(JSON.stringify({ ok: true, project: projectCfg.id, sdks }));
    return;
  }

  if (action === "exec") {
    if (!process.allowedNodeEnvironmentFlags?.has("--allow-net")) {
      process.stdout.write(
        JSON.stringify({
          ok: false,
          error: "exec_verify 需要 Node.js >= 25（权限模型需支持网络限制）。"
        })
      );
      return;
    }

    const sdkNamespace = Object.create(null);
    const ctx = {
      bridgeRoot,
      project: projectCfg
    };

    for (const entry of sdkEntries) {
      const mod = await import(pathToFileURL(entry.file).href);
      if (typeof mod.createSdk === "function") {
        sdkNamespace[entry.name] = Object.freeze(mod.createSdk(ctx));
      }
    }
    Object.freeze(sdkNamespace);

    const sdkShape = {};
    for (const [name, sdkObj] of Object.entries(sdkNamespace)) {
      sdkShape[name] = Object.keys(sdkObj).filter((k) => typeof sdkObj[k] === "function");
    }

    const clampedTimeout = Math.max(1000, Math.min(Number(timeoutMs) || 30_000, 120_000));
    const sandboxEnv = {};
    if (process.platform === "win32" && process.env.SystemRoot) {
      sandboxEnv.SystemRoot = process.env.SystemRoot;
    }

    const child = spawn(
      process.execPath,
      ["--permission", `--allow-fs-read=${SANDBOX_PATH}`, SANDBOX_PATH],
      {
        cwd: projectCfg?.root || bridgeRoot,
        env: sandboxEnv,
        stdio: ["ignore", "pipe", "pipe", "ipc"]
      }
    );

    const result = await new Promise((resolve) => {
      let settled = false;
      const stderrChunks = [];
      let stderrBytes = 0;

      const finish = (obj) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(obj);
      };

      const timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // ignore
        }
        finish({
          ok: false,
          timedOut: true,
          error: `Verification script timed out after ${clampedTimeout}ms.`
        });
      }, clampedTimeout);

      child.stdout.resume();
      child.stderr.on("data", (c) => {
        if (stderrBytes < 8192) {
          stderrChunks.push(c);
          stderrBytes += c.length;
        }
      });

      child.on("message", async (msg) => {
        if (!msg || typeof msg !== "object") return;
        if (msg.type === "call") {
          const reply = (ok, valueOrError) => {
            try {
              child.send(
                ok
                  ? { type: "result", id: msg.id, ok: true, value: valueOrError }
                  : { type: "result", id: msg.id, ok: false, error: valueOrError }
              );
            } catch {
              // ignore
            }
          };
          const { sdk, fn, args } = msg;
          if (
            typeof sdk !== "string" ||
            typeof fn !== "string" ||
            !Array.isArray(args) ||
            !Object.hasOwn(sdkNamespace, sdk) ||
            !Object.hasOwn(sdkNamespace[sdk], fn) ||
            typeof sdkNamespace[sdk][fn] !== "function"
          ) {
            reply(false, "Unknown SDK function.");
            return;
          }
          try {
            const value = await sdkNamespace[sdk][fn](...args);
            reply(true, JSON.parse(JSON.stringify(value ?? null)));
          } catch (err) {
            reply(false, err?.message || String(err));
          }
          return;
        }
        if (msg.type === "done") {
          finish(
            msg.ok
              ? {
                  ok: true,
                  durationMs: msg.durationMs,
                  truncated: msg.truncated,
                  logs: msg.logs,
                  result: msg.result ?? null
                }
              : {
                  ok: false,
                  durationMs: msg.durationMs,
                  truncated: msg.truncated,
                  logs: msg.logs,
                  error: msg.error || "Verification script failed."
                }
          );
        }
      });

      child.on("error", (err) => {
        finish({ ok: false, error: err.message });
      });

      child.on("close", (code) => {
        const errOut = Buffer.concat(stderrChunks).toString("utf8").trim();
        finish({
          ok: false,
          error: errOut.slice(0, 2000) || `Sandbox exited without result (code ${code}).`
        });
      });

      try {
        child.send({ type: "run", script, maxOutputBytes, sdkShape });
      } catch (err) {
        finish({ ok: false, error: err.message });
      }
    });

    process.stdout.write(JSON.stringify(result));
    return;
  }

  throw new Error(`Unknown worker action: ${action}`);
}

main().catch((err) => {
  process.stdout.write(JSON.stringify({ ok: false, error: err?.message || String(err) }));
  process.exitCode = 1;
});
