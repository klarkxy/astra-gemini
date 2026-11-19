import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

export const meta = {
  name: "worktree",
  title: "Git Worktree 独立隔离区（可选）",
  category: "进阶隔离",
  description: "按需在 .bridge-worktrees/ 下开辟独立 Git 工作树做并行开发或破坏性测试（默认关闭，需要时一键开启）。",
  functions: {
    list: {
      signature: "list() => { ok, worktrees: string[] }",
      description: "列出当前仓库已有的全部 git worktree。"
    },
    create: {
      signature: "create(name: string, ref?: string) => { ok, name, path }",
      description: "在 .bridge-worktrees/<project>/<name> 创建隔离工作树（默认基于 HEAD）。"
    },
    remove: {
      signature: "remove(name: string) => { ok, name, removed }",
      description: "清理并移除指定隔离工作树。"
    }
  }
};

function sanitizeName(name) {
  if (typeof name !== "string" || !/^[a-zA-Z0-9_-]{1,48}$/.test(name)) {
    throw new Error("Worktree name must match /^[a-zA-Z0-9_-]{1,48}$/.");
  }
  return name;
}

export function createSdk({ bridgeRoot, project }) {
  const wtBase = path.join(bridgeRoot, ".bridge-worktrees", project.id);

  return {
    list() {
      const res = spawnSync("git", ["worktree", "list", "--porcelain"], {
        cwd: project.root,
        encoding: "utf8"
      });
      if (res.status !== 0) return { ok: false, error: (res.stderr || "git worktree list failed").trim() };
      const worktrees = res.stdout
        .split(/\r?\n/)
        .filter((l) => l.startsWith("worktree "))
        .map((l) => l.slice("worktree ".length).trim());
      return { ok: true, worktrees };
    },

    create(name, ref = "HEAD") {
      if (project.mode === "readonly") {
        return { ok: false, error: "Cannot create worktree for a readonly project." };
      }
      const safe = sanitizeName(name);
      fs.mkdirSync(wtBase, { recursive: true });
      const target = path.join(wtBase, safe);
      if (fs.existsSync(target)) {
        return { ok: false, error: `Worktree "${safe}" already exists.` };
      }
      const res = spawnSync("git", ["worktree", "add", "--detach", target, ref], {
        cwd: project.root,
        encoding: "utf8"
      });
      if (res.status !== 0) return { ok: false, error: (res.stderr || "git worktree add failed").trim() };
      return { ok: true, name: safe, path: target };
    },

    remove(name) {
      if (project.mode === "readonly") {
        return { ok: false, error: "Cannot remove worktree for a readonly project." };
      }
      const safe = sanitizeName(name);
      const target = path.join(wtBase, safe);
      const res = spawnSync("git", ["worktree", "remove", "--force", target], {
        cwd: project.root,
        encoding: "utf8"
      });
      if (res.status !== 0) return { ok: false, error: (res.stderr || "git worktree remove failed").trim() };
      return { ok: true, name: safe, removed: true };
    }
  };
}
