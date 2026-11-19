import { spawnSync } from "node:child_process";
import { rollbackBackup } from "../../src/patch.mjs";

export const meta = {
  name: "git",
  title: "Git 版本与回滚",
  category: "版本控制",
  description: "查看工作区状态、diff、分支与提交记录，支持一键回滚 apply_patch 生成的自动备份。",
  functions: {
    status: {
      signature: "status() => { ok, branch, clean, files: string[] }",
      description: "返回当前仓库简短状态与分支名。"
    },
    diff: {
      signature: "diff(opts?: { statOnly?: boolean, maxChars?: number }) => { ok, diff, truncated }",
      description: "查看当前未提交改动（支持仅看 --stat）。"
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
  return spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 5 * 1024 * 1024 });
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
      const args = statOnly ? ["diff", "--stat"] : ["diff"];
      const res = runGit(project.root, args);
      if (res.status !== 0) return { ok: false, error: (res.stderr || "git diff failed").trim() };
      const cap = Math.max(500, Math.min(Number(maxChars) || 6000, 20000));
      const raw = res.stdout || "";
      const truncated = raw.length > cap;
      return { ok: true, truncated, diff: truncated ? raw.slice(0, cap) + "\n... [truncated]" : raw };
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
