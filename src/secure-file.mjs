import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

export const SECRET_FILES = [
  "token.txt",
  "join-token.txt",
  "admin-key.txt",
  "identity.json",
  "settings.json",
  "nodes.json"
];

let cachedSid;
let warnedRestrict = false;

const SYSTEM32 = path.join(process.env.SystemRoot || "C:\\Windows", "System32");
const WHOAMI_EXE = path.join(SYSTEM32, "whoami.exe");
const ICACLS_EXE = path.join(SYSTEM32, "icacls.exe");

function currentUserSid() {
  if (cachedSid !== undefined) return cachedSid;
  cachedSid = null;
  try {
    const res = spawnSync(WHOAMI_EXE, ["/user", "/fo", "csv", "/nh"], { encoding: "utf8", shell: false });
    if (!res.error && res.status === 0) {
      const line = (res.stdout || "").split(/\r?\n/).find((l) => l.trim());
      const sid = String((line || "").split(",")[1] || "").trim().replace(/^"|"$/g, "");
      if (/^S-1-[\d-]+$/.test(sid)) cachedSid = sid;
    }
  } catch {
    cachedSid = null;
  }
  return cachedSid;
}

export function restrictToOwner(filePath) {
  if (process.platform === "win32") {
    try {
      const sid = currentUserSid();
      if (!sid) throw new Error("whoami /user 未返回当前用户 SID");
      const res = spawnSync(ICACLS_EXE, [filePath, "/inheritance:r", "/grant:r", `*${sid}:F`], { shell: false });
      if (res.error || res.status !== 0) {
        throw new Error(String(res.stderr || res.stdout || res.error?.message || "icacls failed").trim());
      }
    } catch (err) {
      if (!warnedRestrict) {
        warnedRestrict = true;
        console.warn(`[astra] 无法收紧文件权限 ${filePath}: ${err.message}`);
      }
    }
    return;
  }
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // ignore
  }
}

export function writeSecretFile(filePath, content) {
  const existed = fs.existsSync(filePath);
  fs.writeFileSync(filePath, content, { encoding: "utf8", mode: 0o600 });
  if (!existed) restrictToOwner(filePath);
}

export function hardenSecretFiles(bridgeRoot) {
  for (const name of SECRET_FILES) {
    const p = path.join(bridgeRoot, name);
    if (fs.existsSync(p)) restrictToOwner(p);
  }
}
