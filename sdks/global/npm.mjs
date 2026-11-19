import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const DEFAULT_ALLOWED_SCRIPTS = ["test", "lint", "typecheck", "check", "build", "verify"];

export const meta = {
  name: "npm",
  title: "npm 脚本验证",
  category: "前端 / Node",
  description: "运行 package.json 中白名单允许的 npm 脚本（如 test、lint、build），自动提炼错误行与尾部摘要。",
  functions: {
    listScripts: {
      signature: "listScripts() => { ok, allowed, available }",
      description: "查看当前项目允许运行的 npm 脚本。"
    },
    run: {
      signature: "run(scriptName: string, opts?: { tailLines?: number }) => { ok, exitCode, durationMs, errorLines, tail }",
      description: "执行指定的白名单 npm 脚本并返回精简结果。"
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
  const npmBin = "npm";

  return {
    listScripts() {
      const scripts = readPackageScripts(project.root);
      if (!scripts) return { ok: false, error: "项目根目录未找到 package.json。" };
      const available = {};
      for (const [k, v] of Object.entries(scripts)) {
        if (allowlist.includes(k)) available[k] = v;
      }
      return { ok: true, allowed: allowlist, available };
    },

    run(scriptName, { tailLines = 40 } = {}) {
      if (!allowlist.includes(scriptName)) {
        return {
          ok: false,
          error: `脚本 "${scriptName}" 不在白名单中（允许：${allowlist.join(", ")}）。`
        };
      }
      const scripts = readPackageScripts(project.root);
      if (!scripts || !scripts[scriptName]) {
        return { ok: false, error: `package.json 中未定义脚本 "${scriptName}"。` };
      }

      const started = Date.now();
      const res = spawnSync(npmBin, ["run", scriptName], {
        cwd: project.root,
        encoding: "utf8",
        shell: process.platform === "win32",
        maxBuffer: 10 * 1024 * 1024
      });
      if (res.error) return { ok: false, error: `npm 启动失败: ${res.error.message}` };

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
