import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { isDeniedPath, resolveSafePath } from "./registry.mjs";

function hashBuffer(buf, algo = "sha256") {
  return crypto.createHash(algo).update(buf).digest("hex");
}

function timingSafeHexEqual(a, b) {
  const ba = Buffer.from(String(a || "").trim().toLowerCase(), "utf8");
  const bb = Buffer.from(String(b || "").trim().toLowerCase(), "utf8");
  if (ba.length !== bb.length || ba.length === 0) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function normalizeExpectedHashes(input) {
  let val = input;
  if (typeof val === "string" && val.trim()) {
    try {
      val = JSON.parse(val);
    } catch {
      return null;
    }
  }
  if (Array.isArray(val)) {
    const out = Object.create(null);
    for (const item of val) {
      if (!item || typeof item !== "object" || typeof item.path !== "string" || !item.path.trim()) continue;
      const rel = item.path.replace(/\\/g, "/").replace(/^\.\//, "");
      if (item.exists === false || item.hash === null || item.hash === "") {
        out[rel] = null;
      } else if (typeof item.hash === "string") {
        out[rel] = item.hash;
      }
    }
    return out;
  }
  if (val && typeof val === "object") {
    return val;
  }
  return null;
}

export function parsePatchPaths(patchText) {
  const paths = new Set();
  const lines = patchText.split(/\r?\n/);
  for (const line of lines) {
    if (line.startsWith("--- ") || line.startsWith("+++ ")) {
      let raw = line.slice(4).trim();
      const tabIdx = raw.indexOf("\t");
      if (tabIdx !== -1) raw = raw.slice(0, tabIdx).trim();
      if (raw === "/dev/null") continue;
      if (raw.startsWith("a/") || raw.startsWith("b/")) {
        raw = raw.slice(2);
      }
      if (raw) paths.add(raw);
    }
  }
  return Array.from(paths);
}

function getBackupRoot(bridgeRoot, projectId) {
  return path.join(bridgeRoot, ".bridge-backup", projectId);
}

function createBackup(bridgeRoot, projectCfg, relPaths) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const suffix = crypto.randomBytes(3).toString("hex");
  const backupId = `${stamp}_${suffix}`;
  const backupDir = path.join(getBackupRoot(bridgeRoot, projectCfg.id), backupId);
  fs.mkdirSync(backupDir, { recursive: true });

  const entries = [];
  for (const rel of relPaths) {
    const abs = resolveSafePath(projectCfg.root, rel);
    const existed = fs.existsSync(abs);
    if (existed) {
      const dest = path.join(backupDir, "files", rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(abs, dest);
    }
    entries.push({ path: rel, existed });
  }

  fs.writeFileSync(
    path.join(backupDir, "manifest.json"),
    JSON.stringify({ backupId, project: projectCfg.id, createdAt: new Date().toISOString(), entries }, null, 2),
    "utf8"
  );
  return backupId;
}

export function listBackups(bridgeRoot, projectId = null) {
  const base = path.join(bridgeRoot, ".bridge-backup");
  if (!fs.existsSync(base)) return [];
  const projectDirs = projectId ? [projectId] : fs.readdirSync(base);
  const results = [];

  for (const pid of projectDirs) {
    const pDir = path.join(base, pid);
    if (!fs.existsSync(pDir) || !fs.statSync(pDir).isDirectory()) continue;
    for (const bid of fs.readdirSync(pDir)) {
      const mPath = path.join(pDir, bid, "manifest.json");
      if (!fs.existsSync(mPath)) continue;
      try {
        const m = JSON.parse(fs.readFileSync(mPath, "utf8"));
        results.push({
          project: m.project || pid,
          backupId: m.backupId || bid,
          createdAt: m.createdAt || "",
          files: (m.entries || []).map((e) => e.path)
        });
      } catch {
        // ignore corrupt manifest
      }
    }
  }
  return results.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || "")).slice(0, 50);
}

export function rollbackBackup(bridgeRoot, projectCfg, backupId) {
  if (!backupId || /[/\\]/.test(backupId) || backupId.includes("..")) {
    throw new Error(`Invalid backupId: ${backupId}`);
  }
  const backupDir = path.join(getBackupRoot(bridgeRoot, projectCfg.id), backupId);
  const manifestPath = path.join(backupDir, "manifest.json");
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Backup "${backupId}" not found for project "${projectCfg.id}".`);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const restored = [];
  const removed = [];

  for (const entry of manifest.entries) {
    const abs = resolveSafePath(projectCfg.root, entry.path);
    if (entry.existed) {
      const src = path.join(backupDir, "files", entry.path);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.copyFileSync(src, abs);
      restored.push(entry.path);
    } else if (fs.existsSync(abs)) {
      fs.unlinkSync(abs);
      removed.push(entry.path);
    }
  }

  return { ok: true, backupId, restored, removed };
}

export function applyPatch(bridgeRoot, projectCfg, opts = {}) {
  const { patch, patchSha256 = null, expectedHashes = null, dryRun = false } = opts;
  if (projectCfg.mode === "readonly") {
    throw new Error(`Project "${projectCfg.id}" is configured as readonly. Patching is blocked.`);
  }
  if (typeof patch !== "string" || patch.trim() === "") {
    throw new Error("Missing required parameter: patch (unified diff string).");
  }

  const actualPatchSha256 = hashBuffer(Buffer.from(patch, "utf8"), "sha256");
  if (patchSha256) {
    const expected = String(patchSha256).trim().toLowerCase();
    const actual = expected.length === 32 ? hashBuffer(Buffer.from(patch, "utf8"), "md5") : actualPatchSha256;
    if (!timingSafeHexEqual(actual, expected)) {
      return {
        ok: false,
        dryRun,
        error: `Patch integrity check failed: expected ${expected}, got ${actual}.`
      };
    }
  }

  const touchedPaths = parsePatchPaths(patch);
  if (touchedPaths.length === 0) {
    throw new Error("Could not parse any target file paths from unified diff patch.");
  }

  for (const rel of touchedPaths) {
    resolveSafePath(projectCfg.root, rel);
    if (isDeniedPath(rel, projectCfg.deny)) {
      throw new Error(`Patch targets a denied/protected path: ${rel}`);
    }
  }

  const expectedMap = normalizeExpectedHashes(expectedHashes);
  if (expectedMap) {
    for (const [rawRel, expHash] of Object.entries(expectedMap)) {
      const rel = rawRel.replace(/\\/g, "/").replace(/^\.\//, "");
      const abs = resolveSafePath(projectCfg.root, rel);
      const exists = fs.existsSync(abs);
      if (expHash === null) {
        if (exists) {
          return {
            ok: false,
            dryRun,
            files: touchedPaths,
            error: `Optimistic lock failed: expected "${rel}" not to exist, but it already exists on disk.`
          };
        }
        continue;
      }
      if (!exists) {
        return {
          ok: false,
          dryRun,
          files: touchedPaths,
          error: `Optimistic lock failed: "${rel}" was deleted or moved on disk.`
        };
      }
      const buf = fs.readFileSync(abs);
      const expStr = String(expHash).trim().toLowerCase();
      const actual = expStr.length === 32 ? hashBuffer(buf, "md5") : hashBuffer(buf, "sha256");
      if (!timingSafeHexEqual(actual, expStr)) {
        return {
          ok: false,
          dryRun,
          files: touchedPaths,
          error: `Optimistic lock failed for "${rel}": file changed locally since last snapshot.`
        };
      }
    }
  }

  const check = spawnSync("git", ["-c", "core.autocrlf=false", "apply", "--check", "--whitespace=nowarn", "-"], {
    cwd: projectCfg.root,
    input: patch,
    encoding: "utf8"
  });
  if (check.status !== 0) {
    return {
      ok: false,
      dryRun,
      files: touchedPaths,
      error: (check.stderr || check.stdout || "git apply --check failed").trim()
    };
  }

  if (dryRun) {
    return { ok: true, dryRun: true, patchSha256: actualPatchSha256, files: touchedPaths };
  }

  const backupId = createBackup(bridgeRoot, projectCfg, touchedPaths);

  const applied = spawnSync("git", ["-c", "core.autocrlf=false", "apply", "--whitespace=nowarn", "-"], {
    cwd: projectCfg.root,
    input: patch,
    encoding: "utf8"
  });
  if (applied.status !== 0) {
    return {
      ok: false,
      backupId,
      files: touchedPaths,
      error: (applied.stderr || applied.stdout || "git apply failed").trim()
    };
  }

  const postHashes = {};
  for (const rel of touchedPaths) {
    const abs = resolveSafePath(projectCfg.root, rel);
    postHashes[rel] = fs.existsSync(abs) ? hashBuffer(fs.readFileSync(abs), "sha256") : null;
  }

  return {
    ok: true,
    dryRun: false,
    project: projectCfg.id,
    backupId,
    patchSha256: actualPatchSha256,
    files: touchedPaths,
    postHashes
  };
}
