import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const DEFAULT_ALLOWED_SCRIPTS = ["test", "lint", "typecheck", "check", "build", "verify"];

export const meta = {
  name: "pnpm",
  title: "pnpm 脚本与 Monorepo 验证",
  category: "前端 / Node",
  description: "运行白名单内的 pnpm 脚本，支持 Monorepo --filter 子包过滤，并自动压缩冗长日志只提炼报错行。",
  functions: {
    listScripts: {
      signature: "listScripts() => { ok, allowed, available, isWorkspace }",
      description: "查看根目录允许运行的 package.json 脚本及是否为 pnpm workspace。"
    },
    listWorkspaces: {
      signature: "listWorkspaces() => { ok, packages: Array<{ name, path }> }",
      description: "列出当前 pnpm workspace 中的所有子包名称与相对路径。"
    },
    run: {
      signature: "run(scriptName: string, opts?: { filter?: string, tailLines?: number }) => { ok, exitCode, durationMs, errorLines, tail }",
      description: "执行白名单内的 pnpm 脚本（可选 --filter 指定子包），返回精简报错和尾部日志。"
    }
  }
};

function readPackageScripts(rootDir) {
  const pkgPath = path.join(rootDir, "package.json");
  if (!fs.existsSync(pkgPath)) return null;
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  return pkg.scripts && typeof pkg.scripts === "object" ? pkg.scripts : {};
}

export function createSdk({ project }) {
  const allowlist =
    Array.isArray(project.allowedScripts) && project.allowedScripts.length > 0
      ? project.allowedScripts
      : DEFAULT_ALLOWED_SCRIPTS;
  const pnpmBin = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

  return {
    listScripts() {
      const scripts = readPackageScripts(project.root);
      if (!scripts) return { ok: false, error: "项目根目录未找到 package.json。" };
      const available = {};
      for (const [k, v] of Object.entries(scripts)) {
        if (allowlist.includes(k)) available[k] = v;
      }
      const isWorkspace = fs.existsSync(path.join(project.root, "pnpm-workspace.yaml"));
      return { ok: true, allowed: allowlist, available, isWorkspace };
    },

    listWorkspaces() {
      const res = spawnSync(pnpmBin, ["list", "-r", "--depth", "-1", "--json"], {
        cwd: project.root,
        encoding: "utf8",
        maxBuffer: 5 * 1024 * 1024
      });
      if (res.error) return { ok: false, error: `pnpm 未安装或不可用: ${res.error.message}` };
      if (res.status !== 0) return { ok: false, error: (res.stderr || res.stdout || "pnpm list failed").trim() };
      try {
        const parsed = JSON.parse(res.stdout || "[]");
        const packages = parsed.map((p) => ({
          name: p.name || "(unnamed)",
          path: path.relative(project.root, p.path || project.root) || "."
        }));
        return { ok: true, packages };
      } catch {
        return { ok: false, error: "解析 pnpm workspace JSON 输出失败。" };
      }
    },

    run(scriptName, { filter = "", tailLines = 40 } = {}) {
      if (!allowlist.includes(scriptName)) {
        return {
          ok: false,
          error: `脚本 "${scriptName}" 不在白名单中（允许：${allowlist.join(", ")}）。`
        };
      }
      const args = [];
      if (filter && typeof filter === "string") {
        if (!/^[a-zA-Z0-9@/_.*-]+$/.test(filter)) {
          return { ok: false, error: `非法的 filter 参数: ${filter}` };
        }
        args.push("--filter", filter);
      }
      args.push("run", scriptName);

      const started = Date.now();
      const res = spawnSync(pnpmBin, args, {
        cwd: project.root,
        encoding: "utf8",
        maxBuffer: 10 * 1024 * 1024
      });
      if (res.error) return { ok: false, error: `pnpm 启动失败: ${res.error.message}` };

      const combined = `${res.stdout || ""}\n${res.stderr || ""}`.trim();
      const lines = combined ? combined.split(/\r?\n/) : [];
      const cap = Math.max(5, Math.min(Number(tailLines) || 40, 120));
      const errorLines = lines.filter((l) => /error|fail|exception|assert|✗|✖/i.test(l)).slice(0, 30);

      return {
        ok: res.status === 0,
        exitCode: res.status,
        durationMs: Date.now() - started,
        totalLines: lines.length,
        errorLines,
        tail: lines.slice(-cap).join("\n")
      };
    }
  };
}
