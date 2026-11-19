import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { pathToFileURL } from "node:url";

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

function formatLogArg(arg) {
  if (typeof arg === "string") return arg;
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
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
    maxOutputBytes = 8192
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

    const logs = [];
    let logBytes = 0;
    let truncated = false;

    const pushLog = (level, args) => {
      const line = `[${level}] ${args.map(formatLogArg).join(" ")}`;
      if (logBytes + line.length > maxOutputBytes) {
        truncated = true;
        return;
      }
      logs.push(line);
      logBytes += line.length + 1;
    };

    const sandbox = {
      sdk: sdkNamespace,
      console: Object.freeze({
        log: (...a) => pushLog("log", a),
        info: (...a) => pushLog("info", a),
        warn: (...a) => pushLog("warn", a),
        error: (...a) => pushLog("error", a)
      }),
      JSON,
      Math,
      Date,
      Promise,
      Array,
      Object,
      String,
      Number,
      Boolean,
      RegExp,
      Map,
      Set,
      URL,
      Error,
      TypeError,
      setTimeout,
      clearTimeout
    };

    const wrapped = `(async () => {\n${script}\n})()`;
    const started = Date.now();
    try {
      const vmContext = vm.createContext(sandbox);
      const compiled = new vm.Script(wrapped, { filename: "verify-script.mjs" });
      const result = await compiled.runInContext(vmContext);
      let serializedResult = result;
      try {
        const str = JSON.stringify(result);
        if (str && str.length > maxOutputBytes) {
          truncated = true;
          serializedResult = str.slice(0, maxOutputBytes) + "... [truncated]";
        }
      } catch {
        serializedResult = String(result);
      }

      process.stdout.write(
        JSON.stringify({
          ok: true,
          durationMs: Date.now() - started,
          truncated,
          logs,
          result: serializedResult ?? null
        })
      );
    } catch (err) {
      process.stdout.write(
        JSON.stringify({
          ok: false,
          durationMs: Date.now() - started,
          truncated,
          logs,
          error: err?.message || String(err)
        })
      );
    }
    return;
  }

  throw new Error(`Unknown worker action: ${action}`);
}

main().catch((err) => {
  process.stdout.write(JSON.stringify({ ok: false, error: err?.message || String(err) }));
  process.exitCode = 1;
});
