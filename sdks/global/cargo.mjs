import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const SUBCOMMANDS = ["check", "test", "clippy", "build", "fmt"];

export const meta = {
  name: "cargo",
  title: "Rust / Cargo 验证",
  category: "Rust",
  description: "在白名单内运行 cargo check/test/clippy/build，以及只校验不改写的 cargo fmt --check，自动提炼 error/warning 行。",
  functions: {
    info: {
      signature: "info() => { ok, version, hasManifest }",
      description: "查看 cargo 版本及项目根目录是否存在 Cargo.toml。"
    },
    run: {
      signature:
        'run(subcommand: "check"|"test"|"clippy"|"build"|"fmt", opts?: { package?: string, tailLines?: number }) => { ok, exitCode, durationMs, totalLines, errorLines, tail }',
      description: "运行白名单内的 cargo 子命令（可选 -p 指定包名；fmt 等价于 fmt --check），返回精简日志。"
    }
  }
};

export function createSdk({ project }) {
  const manifestPath = path.join(project.root, "Cargo.toml");

  return {
    info() {
      const res = spawnSync("cargo", ["--version"], { encoding: "utf8", shell: false });
      if (res.error) return { ok: false, error: `未检测到 cargo: ${res.error.message}` };
      return {
        ok: res.status === 0,
        version: (res.stdout || res.stderr || "").trim(),
        hasManifest: fs.existsSync(manifestPath)
      };
    },

    run(subcommand, { package: pkg = "", tailLines = 40 } = {}) {
      if (!SUBCOMMANDS.includes(subcommand)) {
        return {
          ok: false,
          error: `子命令 "${subcommand}" 不在白名单中（允许：${SUBCOMMANDS.join(", ")}）。`
        };
      }
      if (pkg && (typeof pkg !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(pkg))) {
        return { ok: false, error: `非法的 package 参数: ${pkg}` };
      }
      if (!fs.existsSync(manifestPath)) {
        return { ok: false, error: "项目根目录未找到 Cargo.toml。" };
      }
      const args = subcommand === "fmt" ? ["fmt", "--check"] : [subcommand];
      if (pkg) args.push("-p", pkg);

      const started = Date.now();
      const res = spawnSync("cargo", args, {
        cwd: project.root,
        encoding: "utf8",
        shell: false,
        maxBuffer: 10 * 1024 * 1024
      });
      if (res.error) return { ok: false, error: `cargo 启动失败: ${res.error.message}` };

      const combined = `${res.stdout || ""}\n${res.stderr || ""}`.trim();
      const lines = combined ? combined.split(/\r?\n/) : [];
      const cap = Math.max(5, Math.min(Number(tailLines) || 40, 120));
      const errorLines = lines
        .filter((l) => /^(error|warning)(\[[A-Z]\d+\])?:/.test(l) || /test .* FAILED/.test(l) || /panicked/.test(l))
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
