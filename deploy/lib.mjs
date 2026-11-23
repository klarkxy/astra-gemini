import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { writeSecretFile } from "../src/secure-file.mjs";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOCAL_JSON_PATH = path.join(REPO_ROOT, "deploy", "local.json");

export const SSH_OPTS = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15"];

export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const eq = a.indexOf("=");
    if (eq !== -1) {
      out[a.slice(2, eq)] = a.slice(eq + 1);
    } else {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        out[key] = next;
        i++;
      } else {
        out[key] = true;
      }
    }
  }
  return out;
}

export function loadLocal() {
  try {
    const raw = JSON.parse(fs.readFileSync(LOCAL_JSON_PATH, "utf8"));
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

export function saveLocal(data) {
  writeSecretFile(LOCAL_JSON_PATH, JSON.stringify(data, null, 2) + "\n");
}

export function step(msg) {
  console.log(`\n==> ${msg}`);
}

export function info(msg) {
  console.log(`    ${msg}`);
}

export function fail(msg, code = 1) {
  console.error(`失败：${msg}`);
  process.exit(code);
}

// Windows 下 .cmd/.bat（含裸 npm/npx）不能无 shell 直接 spawn。
// 统一经 cmd.exe 调用，避免 shell:true 的 DEP0190 告警；命令串内无密钥。
function cmdline(cmd, args) {
  if (process.platform === "win32" && (/\.(cmd|bat)$/i.test(cmd) || /^(npm|npx)$/i.test(cmd))) {
    const line = [cmd, ...args]
      .map((a) => (/[\s&|<>^%"]/.test(a) ? `"${String(a).replace(/"/g, '""')}"` : String(a)))
      .join(" ");
    return { file: "cmd.exe", args: ["/d", "/s", "/c", line] };
  }
  return { file: cmd, args };
}

// 静默捕获输出；input 经 stdin 传入（绝不进命令行参数/日志）
export function run(cmd, args, { cwd, input, timeoutMs = 120000 } = {}) {
  return new Promise((resolve) => {
    const s = cmdline(cmd, args);
    const child = spawn(s.file, s.args, { cwd, windowsHide: true });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: stderr || String(err.message), timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: timedOut ? -2 : (code ?? -1), stdout, stderr, timedOut });
    });
    child.stdin.on("error", () => {});
    if (input !== undefined && input !== null) child.stdin.write(input);
    child.stdin.end();
  });
}

// 输出直接透传（构建类命令）
export function runInherit(cmd, args, { cwd } = {}) {
  return new Promise((resolve) => {
    const s = cmdline(cmd, args);
    const child = spawn(s.file, s.args, { cwd, stdio: "inherit", windowsHide: true });
    child.on("error", () => resolve(-1));
    child.on("close", (code) => resolve(code ?? -1));
  });
}
