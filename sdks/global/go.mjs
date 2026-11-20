import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const SUBCOMMANDS = ["build", "test", "vet"];

export const meta = {
  name: "go",
  title: "Go 构建与测试",
  category: "Go",
  description: "在白名单内运行 go build/test/vet，支持包路径与 -run 测试名过滤，自动提炼 FAIL/panic 与编译报错行。",
  functions: {
    info: {
      signature: "info() => { ok, version, module, hasModule }",
      description: "查看 go 版本、go.mod 中的 module 名及是否存在 go.mod。"
    },
    run: {
      signature:
        'run(subcommand: "build"|"test"|"vet", opts?: { pkg?: string, run?: string, tailLines?: number }) => { ok, exitCode, durationMs, totalLines, errorLines, tail }',
      description: "运行白名单内的 go 子命令（pkg 默认 ./...；run 仅 test 可用，作 -run 过滤），返回精简日志。"
    }
  }
};

function readModuleName(gomodPath) {
  try {
    const text = fs.readFileSync(gomodPath, "utf8");
    const m = /^module\s+(\S+)/m.exec(text);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

export function createSdk({ project }) {
  const gomodPath = path.join(project.root, "go.mod");

  return {
    info() {
      const res = spawnSync("go", ["version"], { encoding: "utf8", shell: false });
      if (res.error) return { ok: false, error: `未检测到 go: ${res.error.message}` };
      const hasModule = fs.existsSync(gomodPath);
      return {
        ok: res.status === 0,
        version: (res.stdout || res.stderr || "").trim(),
        module: hasModule ? readModuleName(gomodPath) : null,
        hasModule
      };
    },

    run(subcommand, { pkg = "./...", run = "", tailLines = 40 } = {}) {
      if (!SUBCOMMANDS.includes(subcommand)) {
        return {
          ok: false,
          error: `子命令 "${subcommand}" 不在白名单中（允许：${SUBCOMMANDS.join(", ")}）。`
        };
      }
      if (run && subcommand !== "test") {
        return { ok: false, error: "run 参数仅可用于 test 子命令。" };
      }
      if (typeof pkg !== "string" || !/^[A-Za-z0-9_./-]{1,200}$/.test(pkg) || pkg.startsWith("-") || pkg.split("/").includes("..")) {
        return { ok: false, error: `非法的 pkg 参数: ${pkg}` };
      }
      if (run && (typeof run !== "string" || !/^[A-Za-z0-9_|^$.*()\[\]/-]{1,100}$/.test(run) || run.startsWith("-"))) {
        return { ok: false, error: `非法的 run 参数: ${run}` };
      }
      if (!fs.existsSync(gomodPath)) {
        return { ok: false, error: "项目根目录未找到 go.mod。" };
      }
      const args = [subcommand];
      if (run) args.push("-run", run);
      args.push(pkg);

      const started = Date.now();
      const res = spawnSync("go", args, {
        cwd: project.root,
        encoding: "utf8",
        shell: false,
        maxBuffer: 10 * 1024 * 1024
      });
      if (res.error) return { ok: false, error: `go 启动失败: ${res.error.message}` };

      const combined = `${res.stdout || ""}\n${res.stderr || ""}`.trim();
      const lines = combined ? combined.split(/\r?\n/) : [];
      const cap = Math.max(5, Math.min(Number(tailLines) || 40, 120));
      const errorLines = lines
        .filter((l) => /^(---\s*FAIL|FAIL|panic:)/.test(l) || /\.go:\d+:\d+:/.test(l))
        .slice(0, 30);

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
