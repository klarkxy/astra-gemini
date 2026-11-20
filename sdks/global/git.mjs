import { spawnSync } from "node:child_process";
import path from "node:path";
import { rollbackBackup } from "../../src/patch.mjs";
import { isDeniedPath } from "../../src/registry.mjs";

export const meta = {
  name: "git",
  title: "Git 版本与回滚",
  category: "版本控制",
  description: "查看工作区状态、diff、提交内容、逐行溯源、分支与提交记录（均遵守 deny 规则），支持一键回滚 apply_patch 生成的自动备份。",
  functions: {
    status: {
      signature: "status() => { ok, branch, clean, files: string[] }",
      description: "返回当前仓库简短状态与分支名。"
    },
    diff: {
      signature: "diff(opts?: { statOnly?: boolean, maxChars?: number }) => { ok, diff, truncated, hiddenCount }",
      description: "查看当前未提交改动（支持仅看 --stat），自动剔除 deny 命中的敏感文件并用 hiddenCount 告知数量。"
    },
    show: {
      signature: "show(rev: string, path?: string, opts?: { maxChars?: number }) => { ok, stat?, content?, truncated }",
      description: "不带 path 时查看指定提交的 --stat 概要（不含补丁内容）；带 path 时输出该文件在该版本的内容（遵守 deny 规则）。"
    },
    blame: {
      signature: "blame(path: string, opts?: { startLine?: number, endLine?: number }) => { ok, lines: string[] }",
      description: "按行查看文件的最后修改提交（默认 1-200 行，单次最多 400 行，遵守 deny 规则）。"
    },
    log: {
      signature: "log(limit?: number) => { ok, commits: string[] }",
      description: "查看最近提交记录（最多 30 条）。"
    },
    branches: {
      signature: "branches() => { ok, current, all: string[] }",
      description: "列出本地分支与当前所在分支。"
    },
    rollback: {
      signature: "rollback(backupId: string) => { ok, backupId, restored, removed }",
      description: "按 backupId 还原 apply_patch 前自动留底的原文件。"
    }
  }
};

function runGit(cwd, args) {
  return spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 5 * 1024 * 1024, shell: false });
}

function capChars(maxChars) {
  return Math.max(500, Math.min(Number(maxChars) || 6000, 20000));
}

function checkRelPath(project, relPath) {
  if (typeof relPath !== "string" || relPath.trim() === "") {
    return "路径不能为空。";
  }
  const normalized = relPath.replace(/\\/g, "/");
  if (path.isAbsolute(relPath) || normalized.split("/").includes("..") || normalized.startsWith("-")) {
    return `非法路径: ${relPath}`;
  }
  if (isDeniedPath(normalized, project.deny)) {
    return `受保护路径禁止访问: ${relPath}`;
  }
  return null;
}

export function createSdk({ bridgeRoot, project }) {
  return {
    status() {
      const res = runGit(project.root, ["status", "--porcelain=v1", "-b"]);
      if (res.status !== 0) return { ok: false, error: (res.stderr || "git status failed").trim() };
      const lines = res.stdout.split(/\r?\n/).filter(Boolean);
      const branch = (lines[0] || "").replace(/^##\s*/, "");
      const files = lines.slice(1);
      return { ok: true, branch, clean: files.length === 0, files };
    },

    diff({ statOnly = false, maxChars = 6000 } = {}) {
      const namesRes = runGit(project.root, ["-c", "core.quotepath=false", "diff", "--name-only", "--relative"]);
      if (namesRes.status !== 0) return { ok: false, error: (namesRes.stderr || "git diff failed").trim() };
      const changed = (namesRes.stdout || "").split(/\r?\n/).filter(Boolean);
      const allowed = changed.filter((p) => !isDeniedPath(p, project.deny));
      const hiddenCount = changed.length - allowed.length;
      if (allowed.length === 0) {
        return { ok: true, diff: "", truncated: false, hiddenCount };
      }
      const args = statOnly ? ["diff", "--stat"] : ["diff"];
      const res = runGit(project.root, [...args, "--", ...allowed]);
      if (res.status !== 0) return { ok: false, error: (res.stderr || "git diff failed").trim() };
      const cap = capChars(maxChars);
      const raw = res.stdout || "";
      const truncated = raw.length > cap;
      return { ok: true, truncated, hiddenCount, diff: truncated ? raw.slice(0, cap) + "\n... [truncated]" : raw };
    },

    show(rev, relPath = "", { maxChars = 6000 } = {}) {
      if (typeof rev !== "string" || !/^[A-Za-z0-9_./~^@{}-]{1,100}$/.test(rev) || rev.startsWith("-")) {
        return { ok: false, error: `非法的 rev 参数: ${rev}` };
      }
      const cap = capChars(maxChars);
      if (!relPath) {
        const res = runGit(project.root, ["show", "--stat", "--format=fuller", rev]);
        if (res.status !== 0) return { ok: false, error: (res.stderr || "git show failed").trim() };
        const raw = res.stdout || "";
        const truncated = raw.length > cap;
        return { ok: true, truncated, stat: truncated ? raw.slice(0, cap) + "\n... [truncated]" : raw };
      }
      const pathError = checkRelPath(project, relPath);
      if (pathError) return { ok: false, error: pathError };
      const res = runGit(project.root, ["show", `${rev}:./${relPath.replace(/\\/g, "/").replace(/^\.\//, "")}`]);
      if (res.status !== 0) return { ok: false, error: (res.stderr || "git show failed").trim() };
      const raw = res.stdout || "";
      const truncated = raw.length > cap;
      return { ok: true, truncated, content: truncated ? raw.slice(0, cap) + "\n... [truncated]" : raw };
    },

    blame(relPath, { startLine = 1, endLine = 200 } = {}) {
      const pathError = checkRelPath(project, relPath);
      if (pathError) return { ok: false, error: pathError };
      const s = Math.max(1, Math.floor(Number(startLine) || 1));
      const e = Math.min(s + 399, Math.max(s, Math.floor(Number(endLine) || 200)));
      const res = runGit(project.root, ["blame", "-L", `${s},${e}`, "--date=short", "--", relPath]);
      if (res.status !== 0) return { ok: false, error: (res.stderr || "git blame failed").trim() };
      return { ok: true, lines: (res.stdout || "").split(/\r?\n/).filter(Boolean) };
    },

    log(limit = 10) {
      const n = Math.max(1, Math.min(Number(limit) || 10, 30));
      const res = runGit(project.root, ["log", `-${n}`, "--oneline"]);
      if (res.status !== 0) return { ok: false, error: (res.stderr || "git log failed").trim() };
      return { ok: true, commits: res.stdout.split(/\r?\n/).filter(Boolean) };
    },

    branches() {
      const res = runGit(project.root, ["branch", "--format=%(HEAD)|%(refname:short)"]);
      if (res.status !== 0) return { ok: false, error: (res.stderr || "git branch failed").trim() };
      let current = "";
      const all = [];
      for (const line of res.stdout.split(/\r?\n/).filter(Boolean)) {
        const [head, name] = line.split("|");
        if (name) {
          all.push(name);
          if (head === "*") current = name;
        }
      }
      return { ok: true, current, all };
    },

    rollback(backupId) {
      if (project.mode === "readonly") {
        return { ok: false, error: "Rollback is disabled on readonly projects." };
      }
      return rollbackBackup(bridgeRoot, project, backupId);
    }
  };
}
