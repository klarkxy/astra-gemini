import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { globToRegex, isDeniedPath, resolveSafePath } from "./registry.mjs";

function isBinaryBuffer(buf) {
  const len = Math.min(buf.length, 8192);
  for (let i = 0; i < len; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

function hashBuffer(buf, algo = "sha256") {
  return crypto.createHash(algo).update(buf).digest("hex");
}

function matchesKnownHash(buf, sha256, knownHash) {
  if (typeof knownHash !== "string" || !knownHash) return false;
  const norm = knownHash.trim().toLowerCase();
  if (norm.length === 64) return norm === sha256;
  if (norm.length === 32) return norm === hashBuffer(buf, "md5");
  return false;
}

function normalizeKnownHashes(input) {
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
      if (item && typeof item === "object" && typeof item.path === "string" && typeof item.hash === "string" && item.hash) {
        const rel = item.path.replace(/\\/g, "/").replace(/^\.\//, "");
        if (rel) out[rel] = item.hash;
      }
    }
    return out;
  }
  if (val && typeof val === "object") {
    const out = Object.create(null);
    for (const [k, v] of Object.entries(val)) {
      if (typeof v === "string" && v) {
        const rel = k.replace(/\\/g, "/").replace(/^\.\//, "");
        if (rel) out[rel] = v;
      }
    }
    return out;
  }
  return null;
}

function listFilesViaGit(rootDir) {
  const res = spawnSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: rootDir, encoding: "buffer", maxBuffer: 20 * 1024 * 1024 }
  );
  if (res.status !== 0 || res.error) return null;
  const raw = res.stdout.toString("utf8");
  return raw
    .split("\0")
    .map((s) => s.trim())
    .filter(Boolean);
}

function listFilesFallback(rootDir, denyPatterns, currentRel = "", acc = []) {
  const dir = currentRel ? path.join(rootDir, currentRel) : rootDir;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    const rel = currentRel ? `${currentRel}/${entry.name}` : entry.name;
    if (isDeniedPath(rel, denyPatterns)) continue;
    if (entry.isDirectory()) {
      if (isDeniedPath(`${rel}/`, denyPatterns)) continue;
      listFilesFallback(rootDir, denyPatterns, rel, acc);
    } else if (entry.isFile()) {
      acc.push(rel);
    }
  }
  return acc;
}

export function pullSnapshot(projectCfg, opts = {}) {
  const {
    paths = null,
    knownHashes = null,
    includeContent = true,
    maxFiles = 200,
    maxFileBytes = 200_000,
    maxTotalBytes = 2_000_000
  } = opts;

  let candidates = listFilesViaGit(projectCfg.root);
  const source = candidates ? "git" : "walk";
  if (!candidates) {
    candidates = listFilesFallback(projectCfg.root, projectCfg.deny);
  }

  const filterRegexes =
    Array.isArray(paths) && paths.length > 0
      ? paths
          .map((p) => {
            const norm = p.replace(/\\/g, "/").replace(/^\.\//, "");
            if (!/[*?]/.test(norm) && !norm.includes(".")) {
              return [globToRegex(norm), globToRegex(`${norm.replace(/\/$/, "")}/**`)];
            }
            return [globToRegex(norm)];
          })
          .flat()
      : null;

  const knownMap = normalizeKnownHashes(knownHashes);

  const files = [];
  const unchangedPaths = [];
  const skipped = [];
  const seenPaths = new Set();
  const manifestLines = [];
  let totalBytes = 0;
  let scannedCount = 0;
  let truncated = false;

  const sortedCandidates = [...candidates].map((r) => r.replace(/\\/g, "/")).sort();

  for (const rel of sortedCandidates) {
    if (isDeniedPath(rel, projectCfg.deny)) continue;
    if (filterRegexes && !filterRegexes.some((rx) => rx.test(rel))) continue;

    let abs;
    try {
      abs = resolveSafePath(projectCfg.root, rel);
    } catch {
      continue;
    }

    let stat;
    try {
      stat = fs.statSync(abs);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;

    if (scannedCount >= maxFiles) {
      truncated = true;
      break;
    }

    if (stat.size > maxFileBytes) {
      skipped.push({ path: rel, reason: `exceeds maxFileBytes (${stat.size} > ${maxFileBytes})` });
      continue;
    }

    const buf = fs.readFileSync(abs);
    if (isBinaryBuffer(buf)) {
      skipped.push({ path: rel, reason: "binary file" });
      continue;
    }

    const sha256 = hashBuffer(buf, "sha256");
    seenPaths.add(rel);
    scannedCount += 1;
    manifestLines.push(`${rel}:${sha256}`);

    if (knownMap && Object.prototype.hasOwnProperty.call(knownMap, rel) && matchesKnownHash(buf, sha256, knownMap[rel])) {
      unchangedPaths.push(rel);
      continue;
    }

    if (includeContent && totalBytes + buf.length > maxTotalBytes) {
      truncated = true;
      skipped.push({ path: rel, reason: "maxTotalBytes budget reached" });
      break;
    }

    const item = { path: rel, bytes: buf.length, sha256 };
    if (includeContent) {
      item.content = buf.toString("utf8");
      totalBytes += buf.length;
    }
    files.push(item);
  }

  const deleted = [];
  if (knownMap) {
    for (const rawKey of Object.keys(knownMap)) {
      const rel = rawKey.replace(/\\/g, "/").replace(/^\.\//, "");
      if (filterRegexes && !filterRegexes.some((rx) => rx.test(rel))) continue;
      if (!seenPaths.has(rel)) {
        deleted.push(rel);
      }
    }
    deleted.sort();
  }

  const bundleSha256 = crypto.createHash("sha256").update(manifestLines.join("\n"), "utf8").digest("hex");

  return {
    project: projectCfg.id,
    mode: projectCfg.mode,
    source,
    bundleSha256,
    fileCount: scannedCount,
    changedCount: files.length,
    unchangedCount: unchangedPaths.length,
    deleted,
    totalBytes,
    truncated,
    skippedCount: skipped.length,
    skipped: skipped.slice(0, 20),
    unchangedPaths,
    files
  };
}
