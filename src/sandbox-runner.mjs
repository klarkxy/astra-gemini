import vm from "node:vm";

function formatLogArg(arg) {
  if (typeof arg === "string") return arg;
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}

process.on("disconnect", () => process.exit(1));

const pending = new Map();
let callSeq = 0;
let runStarted = false;

function send(msg) {
  try {
    process.send(msg);
    return true;
  } catch {
    return false;
  }
}

function sendDoneAndExit(msg) {
  try {
    process.send(msg, () => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  } catch {
    process.exit(0);
  }
}

async function run({ script, maxOutputBytes = 8192, sdkShape = {} }) {
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

  const sdk = Object.create(null);
  for (const [sdkName, fnNames] of Object.entries(sdkShape)) {
    const ns = Object.create(null);
    for (const fnName of fnNames) {
      ns[fnName] = (...args) =>
        new Promise((resolve, reject) => {
          const id = ++callSeq;
          pending.set(id, { resolve, reject });
          if (!send({ type: "call", id, sdk: sdkName, fn: fnName, args })) {
            pending.delete(id);
            reject(new Error("SDK call arguments are not serializable."));
          }
        });
    }
    sdk[sdkName] = Object.freeze(ns);
  }
  Object.freeze(sdk);

  const sandbox = {
    sdk,
    console: Object.freeze({
      log: (...a) => pushLog("log", a),
      info: (...a) => pushLog("info", a),
      warn: (...a) => pushLog("warn", a),
      error: (...a) => pushLog("error", a)
    }),
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

    sendDoneAndExit({
      type: "done",
      ok: true,
      durationMs: Date.now() - started,
      truncated,
      logs,
      result: serializedResult ?? null
    });
  } catch (err) {
    sendDoneAndExit({
      type: "done",
      ok: false,
      durationMs: Date.now() - started,
      truncated,
      logs,
      error: err?.message || String(err)
    });
  }
}

process.on("message", (msg) => {
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "result") {
    const entry = pending.get(msg.id);
    if (!entry) return;
    pending.delete(msg.id);
    if (msg.ok) {
      entry.resolve(msg.value);
    } else {
      entry.reject(new Error(msg.error || "SDK call failed."));
    }
    return;
  }
  if (msg.type === "run" && !runStarted) {
    runStarted = true;
    run(msg).catch((err) => {
      sendDoneAndExit({ type: "done", ok: false, truncated: false, logs: [], error: err?.message || String(err) });
    });
  }
});
