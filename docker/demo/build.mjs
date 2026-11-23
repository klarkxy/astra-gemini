import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(root, "dist");

fs.mkdirSync(dist, { recursive: true });
fs.copyFileSync(path.join(root, "src", "index.mjs"), path.join(dist, "index.mjs"));
fs.writeFileSync(
  path.join(dist, "build-info.json"),
  JSON.stringify(
    {
      builtAt: new Date().toISOString(),
      node: process.version,
      hostname: os.hostname()
    },
    null,
    2
  ) + "\n"
);

console.log(`[demo] build ok -> dist/ (node ${process.version} on ${os.hostname()})`);
