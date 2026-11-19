import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { resolveSafePath } from "../../src/registry.mjs";

export const meta = {
  name: "python",
  title: "Python / pytest 验证",
  category: "Python",
  description: "自动探测项目内的 .venv 或系统 Python，安全运行 pytest 单元测试或 ruff/flake8 静态检查。",
  functions: {
    info: {
      signature: "info() => { ok, pythonBin, version, usingVenv }",
      description: "检测当前项目将使用的 Python 解释器路径和版本。"
    },
    pytest: {
      signature: "pytest(target?: string, opts?: { keyword?: string, tailLines?: number }) => { ok, exitCode, durationMs, errorLines, tail }",
      description: "运行 pytest（可选指定相对测试文件/目录和 -k 关键词），返回精简测试摘要。"
    },
    compileCheck: {
      signature: "compileCheck(target?: string) => { ok, exitCode, output }",
      description: "使用 python -m py_compile / compileall 检查语法错误，零额外依赖。"
    }
  }
};

function detectPython(rootDir) {
  const venvCandidates =
    process.platform === "win32"
      ? [path.join(rootDir, ".venv", "Scripts", "python.exe"), path.join(rootDir, "venv", "Scripts", "python.exe")]
      : [path.join(rootDir, ".venv", "bin", "python"), path.join(rootDir, "venv", "bin", "python")];

  for (const cand of venvCandidates) {
    if (fs.existsSync(cand)) return { bin: cand, usingVenv: true };
  }
  const sysCandidates = process.platform === "win32" ? ["python", "py"] : ["python3", "python"];
  for (const bin of sysCandidates) {
    const res = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 5000 });
    if (!res.error && res.status === 0) return { bin, usingVenv: false };
  }
  return null;
}

export function createSdk({ project }) {
  return {
    info() {
      const py = detectPython(project.root);
      if (!py) return { ok: false, error: "未检测到可用的 Python 解释器。" };
      const res = spawnSync(py.bin, ["--version"], { encoding: "utf8" });
      return {
        ok: true,
        pythonBin: py.usingVenv ? path.relative(project.root, py.bin) : py.bin,
        version: (res.stdout || res.stderr || "").trim(),
        usingVenv: py.usingVenv
      };
    },

    pytest(target = "", { keyword = "", tailLines = 40 } = {}) {
      const py = detectPython(project.root);
      if (!py) return { ok: false, error: "未检测到可用的 Python 解释器。" };

      const args = ["-m", "pytest", "-q", "--tb=short"];
      if (keyword && typeof keyword === "string") {
        if (!/^[a-zA-Z0-9_ .-]{1,80}$/.test(keyword)) {
          return { ok: false, error: `非法的 keyword 参数: ${keyword}` };
        }
        args.push("-k", keyword);
      }
      if (target) {
        resolveSafePath(project.root, target);
        args.push(target);
      }

      const started = Date.now();
      const res = spawnSync(py.bin, args, {
        cwd: project.root,
        encoding: "utf8",
        maxBuffer: 10 * 1024 * 1024
      });
      const combined = `${res.stdout || ""}\n${res.stderr || ""}`.trim();
      const lines = combined ? combined.split(/\r?\n/) : [];
      const cap = Math.max(5, Math.min(Number(tailLines) || 40, 120));
      const errorLines = lines.filter((l) => /FAILED|ERROR|AssertionError|Traceback/i.test(l)).slice(0, 30);

      return {
        ok: res.status === 0,
        exitCode: res.status,
        durationMs: Date.now() - started,
        errorLines,
        tail: lines.slice(-cap).join("\n")
      };
    },

    compileCheck(target = ".") {
      const py = detectPython(project.root);
      if (!py) return { ok: false, error: "未检测到可用的 Python 解释器。" };
      if (target && target !== ".") resolveSafePath(project.root, target);
      const res = spawnSync(py.bin, ["-m", "compileall", "-q", target || "."], {
        cwd: project.root,
        encoding: "utf8"
      });
      return {
        ok: res.status === 0,
        exitCode: res.status,
        output: `${res.stdout || ""}\n${res.stderr || ""}`.trim().slice(0, 4000)
      };
    }
  };
}
