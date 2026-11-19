import fs from "node:fs";
import path from "node:path";
import { isDeniedPath, resolveSafePath } from "../../src/registry.mjs";

export const meta = {
  name: "fs_read",
  title: "只读日志与局部检索",
  category: "辅助排查",
  description: "在项目目录内安全只读查看日志尾部或关键词检索（自动拦截 .env/密钥等敏感文件）。",
  functions: {
    stat: {
      signature: "stat(relPath: string) => { ok, exists, isFile, bytes, mtime }",
      description: "查看项目内指定相对路径的文件状态。"
    },
    tail: {
      signature: "tail(relPath: string, lines?: number) => { ok, totalLines, content }",
      description: "读取文本或日志文件的最后 N 行（默认 50 行，最大 200 行）。"
    },
    grep: {
      signature: "grep(pattern: string, subdir?: string, maxMatches?: number) => { ok, count, matches }",
      description: "在项目源码中按正则表达式快速检索匹配行（默认最多返回 40 条）。"
    }
  }
};

function walkSafeFiles(rootDir, denyPatterns, currentRel = "", acc = []) {
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
      walkSafeFiles(rootDir, denyPatterns, rel, acc);
    } else if (entry.isFile()) {
      acc.push(rel);
    }
  }
  return acc;
}

export function createSdk({ project }) {
  return {
    stat(relPath) {
      if (isDeniedPath(relPath, project.deny)) {
        return { ok: false, error: `受保护路径禁止访问: ${relPath}` };
      }
      const abs = resolveSafePath(project.root, relPath);
      if (!fs.existsSync(abs)) return { ok: true, exists: false };
      const st = fs.statSync(abs);
      return { ok: true, exists: true, isFile: st.isFile(), bytes: st.size, mtime: st.mtime.toISOString() };
    },

    tail(relPath, lines = 50) {
      if (isDeniedPath(relPath, project.deny)) {
        return { ok: false, error: `受保护路径禁止访问: ${relPath}` };
      }
      const abs = resolveSafePath(project.root, relPath);
      if (!fs.existsSync(abs)) return { ok: false, error: `文件不存在: ${relPath}` };
      const raw = fs.readFileSync(abs, "utf8");
      const all = raw.split(/\r?\n/);
      const n = Math.max(1, Math.min(Number(lines) || 50, 200));
      return { ok: true, totalLines: all.length, content: all.slice(-n).join("\n") };
    },

    grep(pattern, subdir = "", maxMatches = 40) {
      let regex;
      try {
        regex = new RegExp(pattern, "i");
      } catch (err) {
        return { ok: false, error: `无效正则: ${err.message}` };
      }
      if (subdir) resolveSafePath(project.root, subdir);
      const files = walkSafeFiles(project.root, project.deny, subdir.replace(/\\/g, "/"));
      const cap = Math.max(1, Math.min(Number(maxMatches) || 40, 100));
      const matches = [];

      for (const rel of files) {
        if (matches.length >= cap) break;
        const abs = path.join(project.root, rel);
        let st;
        try {
          st = fs.statSync(abs);
        } catch {
          continue;
        }
        if (st.size > 300_000) continue;
        let text;
        try {
          text = fs.readFileSync(abs, "utf8");
        } catch {
          continue;
        }
        if (text.includes("\0")) continue;
        const lines = text.split(/\r?\n/);
        for (let idx = 0; idx < lines.length; idx++) {
          if (regex.test(lines[idx])) {
            matches.push({ file: rel, line: idx + 1, text: lines[idx].slice(0, 200) });
            if (matches.length >= cap) break;
          }
        }
      }
      return { ok: true, count: matches.length, matches };
    }
  };
}
