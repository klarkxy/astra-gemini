import fs from "node:fs";
import path from "node:path";

export const DEFAULT_DENY_PATTERNS = [
  ".env",
  ".env.*",
  "**/.env",
  "**/.env.*",
  "**/*.pem",
  "**/*.key",
  "**/*.p12",
  "**/*.pfx",
  "**/*secret*",
  "**/id_rsa*",
  "**/id_ed25519*",
  ".git/**",
  "node_modules/**",
  ".bridge-backup/**",
  "**/.bridge-backup/**"
];

function escapeRegex(str) {
  return str.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

export function globToRegex(pattern) {
  const normalized = pattern.replace(/\\/g, "/").replace(/^\.\//, "");
  let regexStr = "^";
  let i = 0;
  while (i < normalized.length) {
    const ch = normalized[i];
    if (ch === "*") {
      if (normalized[i + 1] === "*") {
        if (normalized[i + 2] === "/") {
          regexStr += "(?:.*/)?";
          i += 3;
        } else {
          regexStr += ".*";
          i += 2;
        }
      } else {
        regexStr += "[^/]*";
        i += 1;
      }
    } else if (ch === "?") {
      regexStr += "[^/]";
      i += 1;
    } else {
      regexStr += escapeRegex(ch);
      i += 1;
    }
  }
  regexStr += "$";
  return new RegExp(regexStr, "i");
}

export function isDeniedPath(relPath, denyPatterns = []) {
  const norm = relPath.replace(/\\/g, "/").replace(/^\.\//, "");
  const allPatterns = [...DEFAULT_DENY_PATTERNS, ...denyPatterns];
  return allPatterns.some((p) => globToRegex(p).test(norm));
}

export function resolveSafePath(rootDir, relPath) {
  const absRoot = path.resolve(rootDir);
  if (typeof relPath !== "string" || relPath.trim() === "") {
    throw new Error("Path must be a non-empty string.");
  }
  if (path.isAbsolute(relPath)) {
    throw new Error(`Absolute paths are not allowed: ${relPath}`);
  }
  const normalizedRel = relPath.replace(/\\/g, "/");
  if (normalizedRel.split("/").includes("..")) {
    throw new Error(`Path traversal is not allowed: ${relPath}`);
  }
  const absTarget = path.resolve(absRoot, normalizedRel);
  const relFromRoot = path.relative(absRoot, absTarget);
  if (relFromRoot.startsWith("..") || path.isAbsolute(relFromRoot)) {
    throw new Error(`Resolved path escapes project root: ${relPath}`);
  }

  const realRoot = fs.existsSync(absRoot) ? fs.realpathSync(absRoot) : absRoot;
  let probe = absTarget;
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  if (fs.existsSync(probe)) {
    const realProbe = fs.realpathSync(probe);
    const relReal = path.relative(realRoot, realProbe);
    if (relReal.startsWith("..") || path.isAbsolute(relReal)) {
      throw new Error(`Symlink escapes project root: ${relPath}`);
    }
  }

  return absTarget;
}

export function loadProjectsConfig(configPath) {
  const resolved = path.resolve(configPath);
  if (!fs.existsSync(resolved)) {
    return {};
  }
  const raw = fs.readFileSync(resolved, "utf8");
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("projects.json must be a JSON object mapping project aliases to configs.");
  }
  return parsed;
}

export function saveProjectsConfig(configPath, cfg) {
  const resolved = path.resolve(configPath);
  fs.writeFileSync(resolved, JSON.stringify(cfg, null, 2) + "\n", "utf8");
  return cfg;
}

export function upsertProject(configPath, projectId, entry) {
  if (!projectId || !/^[a-zA-Z0-9_-]{1,64}$/.test(projectId)) {
    throw new Error("项目别名只能包含字母、数字、短横线或下划线（1~64 字符）。");
  }
  if (!entry || typeof entry.root !== "string" || !entry.root.trim()) {
    throw new Error("请填写有效的本地项目目录路径。");
  }
  const mode = entry.mode || "direct";
  if (!["readonly", "direct"].includes(mode)) {
    throw new Error('权限模式只能是 "readonly" 或 "direct"。');
  }
  const cfg = loadProjectsConfig(configPath);
  cfg[projectId] = {
    root: entry.root.trim(),
    mode,
    sdks: entry.sdks === "*" ? "*" : Array.isArray(entry.sdks) ? entry.sdks : ["git", "pnpm", "npm", "python", "cargo", "go", "http", "fs_read"],
    ...(Array.isArray(entry.allowedScripts) && entry.allowedScripts.length > 0 ? { allowedScripts: entry.allowedScripts } : {}),
    ...(Array.isArray(entry.deny) && entry.deny.length > 0 ? { deny: entry.deny } : {}),
    description: typeof entry.description === "string" ? entry.description.trim() : ""
  };
  saveProjectsConfig(configPath, cfg);
  return cfg[projectId];
}

export function deleteProject(configPath, projectId) {
  const cfg = loadProjectsConfig(configPath);
  if (!Object.prototype.hasOwnProperty.call(cfg, projectId)) {
    return false;
  }
  delete cfg[projectId];
  saveProjectsConfig(configPath, cfg);
  return true;
}

export function listProjects(configPath, { includeRoot = false } = {}) {
  const cfg = loadProjectsConfig(configPath);
  return Object.entries(cfg).map(([id, entry]) => ({
    project: id,
    ...(includeRoot ? { root: entry.root || "" } : {}),
    mode: entry.mode || "direct",
    sdks: entry.sdks ?? ["git", "pnpm", "npm", "python", "cargo", "go", "http", "fs_read"],
    allowedScripts: Array.isArray(entry.allowedScripts) ? entry.allowedScripts : null,
    exists: Boolean(entry.root && fs.existsSync(entry.root)),
    description: entry.description || ""
  }));
}

export function getProject(configPath, projectId) {
  if (!projectId || typeof projectId !== "string") {
    throw new Error("Missing required parameter: project");
  }
  const cfg = loadProjectsConfig(configPath);
  const entry = cfg[projectId];
  if (!entry) {
    const available = Object.keys(cfg).join(", ") || "(none)";
    throw new Error(`Unknown project "${projectId}". Registered projects: ${available}`);
  }
  if (!entry.root || !fs.existsSync(entry.root)) {
    throw new Error(`Project root does not exist for "${projectId}".`);
  }
  const mode = entry.mode || "direct";
  if (!["readonly", "direct"].includes(mode)) {
    throw new Error(`Invalid mode "${mode}" for project "${projectId}". Use "readonly" or "direct".`);
  }
  return {
    id: projectId,
    root: path.resolve(entry.root),
    mode,
    sdks: entry.sdks ?? ["git", "pnpm", "npm", "python", "cargo", "go", "http", "fs_read"],
    deny: Array.isArray(entry.deny) ? entry.deny : [],
    allowedScripts: Array.isArray(entry.allowedScripts) ? entry.allowedScripts : null,
    description: entry.description || ""
  };
}
