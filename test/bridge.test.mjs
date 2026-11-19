import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import zlib from "node:zlib";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createBridgeServer } from "../src/server.mjs";
import { connectWebSocket } from "../src/ws.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

function initTempGitRepo(dir, { largeFile = false } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  spawnSync("git", ["init"], { cwd: dir });
  spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "Test User"], { cwd: dir });
  fs.writeFileSync(path.join(dir, ".gitignore"), "ignored.log\n", "utf8");
  fs.writeFileSync(path.join(dir, "ignored.log"), "should not appear\n", "utf8");
  fs.writeFileSync(path.join(dir, ".env"), "SECRET_KEY=topsecret\n", "utf8");
  fs.writeFileSync(path.join(dir, "app.js"), "export const answer = 41;\n", "utf8");
  fs.writeFileSync(path.join(dir, "sample.py"), "def add(a, b):\n    return a + b\n", "utf8");
  if (largeFile) {
    fs.writeFileSync(path.join(dir, "large.txt"), "AstraGeminiLine-0123456789\n".repeat(600), "utf8");
  }
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "demo-repo", scripts: { test: "node -e \"console.log('ALL_TESTS_OK')\"" } }, null, 2),
    "utf8"
  );
  spawnSync("git", ["add", "."], { cwd: dir });
  spawnSync("git", ["commit", "-m", "initial"], { cwd: dir });
  fs.writeFileSync(path.join(dir, "draft.txt"), "uncommitted draft\n", "utf8");
}

function makeTempBridgeRoot(tmpBase, name) {
  const dir = path.join(tmpBase, name);
  fs.cpSync(path.join(REPO_ROOT, "sdks"), path.join(dir, "sdks"), { recursive: true });
  fs.symlinkSync(path.join(REPO_ROOT, "src"), path.join(dir, "src"), "junction");
  return dir;
}

async function rpc(baseUrl, token, method, params = {}) {
  const res = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
  });
  return { status: res.status, body: await res.json() };
}

function rawGzipPost(port, token, payloadObj) {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify(payloadObj), "utf8");
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/mcp",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept-Encoding": "gzip",
          Authorization: `Bearer ${token}`,
          "Content-Length": body.length
        }
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const rawBuf = Buffer.concat(chunks);
          const enc = res.headers["content-encoding"] || "";
          const decoded = enc === "gzip" ? zlib.gunzipSync(rawBuf).toString("utf8") : rawBuf.toString("utf8");
          resolve({ status: res.statusCode, encoding: enc, wireBytes: rawBuf.length, json: JSON.parse(decoded) });
        });
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function waitUntil(fn, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 80));
  }
  return false;
}

test("Astra Gemini single-node: GUI firewall, SDK hot toggles, 7 dev SDKs, snapshot, patch+rollback", async () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "astra-single-"));
  const demoRepo = path.join(tmpBase, "demo-repo");
  const roRepo = path.join(tmpBase, "ro-repo");
  const bridgeState = makeTempBridgeRoot(tmpBase, "bridge-root");

  initTempGitRepo(demoRepo);
  initTempGitRepo(roRepo);

  const projectsConfig = path.join(bridgeState, "projects.json");
  fs.writeFileSync(
    projectsConfig,
    JSON.stringify(
      {
        demo: { root: demoRepo, mode: "direct", sdks: ["git", "pnpm", "npm", "python", "http", "fs_read", "worktree"] },
        readonlyDemo: { root: roRepo, mode: "readonly", sdks: ["git"] }
      },
      null,
      2
    ),
    "utf8"
  );

  const token = "test-secret-token-v1";
  const server = createBridgeServer({
    bridgeRoot: bridgeState,
    projectsConfigPath: projectsConfig,
    nodeId: "local-pc",
    authMode: "bearer",
    authToken: token
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const health = await fetch(`${baseUrl}/health`).then((r) => r.json());
    assert.equal(health.ok, true);
    assert.equal(health.version, "0.1.0");

    assert.equal((await fetch(`${baseUrl}/ui`)).status, 200);
    assert.equal((await fetch(`${baseUrl}/ui`, { headers: { "cf-connecting-ip": "1.2.3.4" } })).status, 403);
    assert.equal((await rpc(baseUrl, "", "tools/list")).status, 401);

    await fetch(`${baseUrl}/api/sdks/toggle`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "worktree", enabled: true })
    });

    const validPatch = "--- a/app.js\n+++ b/app.js\n@@ -1 +1 @@\n-export const answer = 41;\n+export const answer = 42;\n";
    const applied = (await rpc(baseUrl, token, "tools/call", { name: "apply_patch", arguments: { project: "demo", patch: validPatch } }))
      .body.result.structuredContent;
    assert.equal(applied.ok, true);

    const verifyRes = (await rpc(baseUrl, token, "tools/call", {
      name: "exec_verify",
      arguments: {
        project: "demo",
        script: `
          const br = sdk.git.branches();
          const npmRes = sdk.npm.run("test");
          const pyCheck = sdk.python.compileCheck("sample.py");
          const localHealth = await sdk.http.request("http://127.0.0.1:${port}/health");
          let ssrfBlocked = false;
          try { await sdk.http.request("https://example.com"); } catch { ssrfBlocked = true; }
          const grepHit = sdk.fs_read.grep("answer = 42");
          const envBlocked = sdk.fs_read.tail(".env").ok === false;
          const wt = sdk.worktree.create("iso1");
          const wtRm = sdk.worktree.remove("iso1");
          return { ok: br.ok && npmRes.ok && pyCheck.ok && localHealth.ok && ssrfBlocked && grepHit.count === 1 && envBlocked && wt.ok && wtRm.ok };
        `
      }
    })).body.result.structuredContent;
    assert.equal(verifyRes.ok, true, verifyRes.error);
    assert.equal(verifyRes.result.ok, true);

    const rbRes = await fetch(`${baseUrl}/api/backups/rollback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project: "demo", backupId: applied.backupId })
    }).then((r) => r.json());
    assert.equal(rbRes.ok, true);
    assert.match(fs.readFileSync(path.join(demoRepo, "app.js"), "utf8"), /answer = 41/);
  } finally {
    server.close();
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});

test("Astra Gemini integrity & traffic: knownHashes (SHA-256/MD5), deleted, bundleSha256, patchSha256, optimistic lock, HTTP gzip", async () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "astra-integrity-"));
  const repo = path.join(tmpBase, "repo");
  const bridgeState = makeTempBridgeRoot(tmpBase, "bridge");
  initTempGitRepo(repo, { largeFile: true });

  const projectsConfig = path.join(bridgeState, "projects.json");
  fs.writeFileSync(projectsConfig, JSON.stringify({ demo: { root: repo, mode: "direct", sdks: ["git"] } }), "utf8");

  const token = "tok-v1";
  const server = createBridgeServer({ bridgeRoot: bridgeState, projectsConfigPath: projectsConfig, nodeId: "pc", authMode: "bearer", authToken: token });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const gzRes = await rawGzipPost(port, token, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "pull_snapshot", arguments: { project: "demo" } }
    });
    assert.equal(gzRes.status, 200);
    assert.equal(gzRes.encoding, "gzip");
    const snap1 = gzRes.json.result.structuredContent;
    assert.ok(snap1.bundleSha256 && snap1.bundleSha256.length === 64);
    assert.ok(gzRes.wireBytes < snap1.totalBytes / 3);

    const knownHashes = { "ghost/removed.js": "0".repeat(64) };
    for (const f of snap1.files) {
      if (f.path === "app.js") {
        knownHashes[f.path] = crypto.createHash("md5").update(f.content, "utf8").digest("hex");
      } else {
        knownHashes[f.path] = f.sha256;
      }
    }

    const snap2 = (await rpc(baseUrl, token, "tools/call", {
      name: "pull_snapshot",
      arguments: { project: "demo", knownHashes }
    })).body.result.structuredContent;
    assert.equal(snap2.changedCount, 0);
    assert.equal(snap2.totalBytes, 0);
    assert.equal(snap2.unchangedCount, snap1.fileCount);
    assert.deepEqual(snap2.deleted, ["ghost/removed.js"]);
    assert.equal(snap2.bundleSha256, snap1.bundleSha256);

    const patch = "--- a/app.js\n+++ b/app.js\n@@ -1 +1 @@\n-export const answer = 41;\n+export const answer = 55;\n";
    const realPatchSha = crypto.createHash("sha256").update(patch, "utf8").digest("hex");

    const badShaRes = (await rpc(baseUrl, token, "tools/call", {
      name: "apply_patch",
      arguments: { project: "demo", patch, patchSha256: "f".repeat(64) }
    })).body.result.structuredContent;
    assert.equal(badShaRes.ok, false);
    assert.match(badShaRes.error, /integrity check failed/i);

    const badLockRes = (await rpc(baseUrl, token, "tools/call", {
      name: "apply_patch",
      arguments: { project: "demo", patch, patchSha256: realPatchSha, expectedHashes: { "app.js": "0".repeat(64) } }
    })).body.result.structuredContent;
    assert.equal(badLockRes.ok, false);
    assert.match(badLockRes.error, /Optimistic lock failed/i);

    const appFile = snap1.files.find((f) => f.path === "app.js");
    const okPatchRes = (await rpc(baseUrl, token, "tools/call", {
      name: "apply_patch",
      arguments: { project: "demo", patch, patchSha256: realPatchSha, expectedHashes: { "app.js": appFile.sha256 } }
    })).body.result.structuredContent;
    assert.equal(okPatchRes.ok, true);
    assert.equal(okPatchRes.patchSha256, realPatchSha);
    assert.equal(okPatchRes.postHashes["app.js"], crypto.createHash("sha256").update("export const answer = 55;\n", "utf8").digest("hex"));
  } finally {
    server.close();
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});

test("Astra Gemini 3-tier Direct-First Tunnel Upgrade (>10KB WS gzip payload) + Ticket Security", async () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "astra-direct-"));
  const leafRepo = path.join(tmpBase, "leaf-repo");
  initTempGitRepo(leafRepo, { largeFile: true });

  const rootDir = makeTempBridgeRoot(tmpBase, "root");
  const branchDir = makeTempBridgeRoot(tmpBase, "branch");
  const leafDir = makeTempBridgeRoot(tmpBase, "leaf");

  fs.writeFileSync(path.join(rootDir, "projects.json"), "{}", "utf8");
  fs.writeFileSync(path.join(branchDir, "projects.json"), "{}", "utf8");
  fs.writeFileSync(
    path.join(leafDir, "projects.json"),
    JSON.stringify({ "leaf-app": { root: leafRepo, mode: "direct", sdks: ["git", "npm", "fs_read"] } }, null, 2),
    "utf8"
  );

  const rootServer = createBridgeServer({ bridgeRoot: rootDir, nodeId: "root", authMode: "bearer", authToken: "r-tok" });
  await new Promise((r) => rootServer.listen(0, "127.0.0.1", r));
  const rootPort = rootServer.address().port;
  const rootUrl = `http://127.0.0.1:${rootPort}`;

  const branchServer = createBridgeServer({
    bridgeRoot: branchDir,
    nodeId: "branch",
    authMode: "bearer",
    authToken: "b-tok",
    upstream: { enabled: true, url: `ws://127.0.0.1:${rootPort}/ws/tree`, token: "r-tok" }
  });
  await new Promise((r) => branchServer.listen(0, "127.0.0.1", r));
  const branchPort = branchServer.address().port;

  const leafCandidates = [];
  const leafServer = createBridgeServer({
    bridgeRoot: leafDir,
    nodeId: "leaf",
    authMode: "bearer",
    authToken: "l-tok",
    directCandidates: leafCandidates,
    upstream: { enabled: true, url: `ws://127.0.0.1:${branchPort}/ws/tree`, token: "b-tok" }
  });
  await new Promise((r) => leafServer.listen(0, "127.0.0.1", r));
  const leafPort = leafServer.address().port;
  leafCandidates.push(`ws://127.0.0.1:${leafPort}/ws/direct`);

  try {
    await assert.rejects(
      () => connectWebSocket(`ws://127.0.0.1:${leafPort}/ws/direct`, { headers: { "X-Astra-Ticket": "fake" } }),
      /401/
    );

    const propagated = await waitUntil(async () => {
      const res = await rpc(rootUrl, "r-tok", "tools/call", { name: "list_projects", arguments: {} });
      return (res.body.result.structuredContent || []).some((p) => p.project === "branch/leaf/leaf-app" && p.online);
    });
    assert.equal(propagated, true);

    const snap = (await rpc(rootUrl, "r-tok", "tools/call", {
      name: "pull_snapshot",
      arguments: { project: "branch/leaf/leaf-app" }
    })).body.result.structuredContent;
    const large = snap.files.find((f) => f.path === "large.txt");
    assert.ok(large && large.bytes > 10000);

    const status = rootServer.tree.getTreeStatus();
    assert.equal(status.directTunnels.length, 1);
    assert.equal(status.directStats.directCalls, 1);
    assert.equal(status.directStats.relayCalls, 0);
  } finally {
    leafServer.close();
    branchServer.close();
    rootServer.close();
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});

test("Astra Gemini 3-tier Automatic Relay Fallback when Direct Tunnel candidates are unreachable", async () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "astra-fallback-"));
  const leafRepo = path.join(tmpBase, "leaf-repo");
  initTempGitRepo(leafRepo, { largeFile: true });

  const rootDir = makeTempBridgeRoot(tmpBase, "root");
  const branchDir = makeTempBridgeRoot(tmpBase, "branch");
  const leafDir = makeTempBridgeRoot(tmpBase, "leaf");

  fs.writeFileSync(path.join(rootDir, "projects.json"), "{}", "utf8");
  fs.writeFileSync(path.join(branchDir, "projects.json"), "{}", "utf8");
  fs.writeFileSync(
    path.join(leafDir, "projects.json"),
    JSON.stringify({ "leaf-app": { root: leafRepo, mode: "direct", sdks: ["fs_read"] } }, null, 2),
    "utf8"
  );

  const rootServer = createBridgeServer({
    bridgeRoot: rootDir,
    nodeId: "root",
    authMode: "bearer",
    authToken: "r-tok",
    directTimeoutMs: 400
  });
  await new Promise((r) => rootServer.listen(0, "127.0.0.1", r));
  const rootPort = rootServer.address().port;
  const rootUrl = `http://127.0.0.1:${rootPort}`;

  const branchServer = createBridgeServer({
    bridgeRoot: branchDir,
    nodeId: "branch",
    authMode: "bearer",
    authToken: "b-tok",
    upstream: { enabled: true, url: `ws://127.0.0.1:${rootPort}/ws/tree`, token: "r-tok" }
  });
  await new Promise((r) => branchServer.listen(0, "127.0.0.1", r));
  const branchPort = branchServer.address().port;

  const leafServer = createBridgeServer({
    bridgeRoot: leafDir,
    nodeId: "leaf",
    authMode: "bearer",
    authToken: "l-tok",
    directCandidates: ["ws://127.0.0.1:1/ws/direct"],
    upstream: { enabled: true, url: `ws://127.0.0.1:${branchPort}/ws/tree`, token: "b-tok" }
  });
  await new Promise((r) => leafServer.listen(0, "127.0.0.1", r));

  try {
    const propagated = await waitUntil(async () => {
      const res = await rpc(rootUrl, "r-tok", "tools/call", { name: "list_projects", arguments: {} });
      return (res.body.result.structuredContent || []).some((p) => p.project === "branch/leaf/leaf-app" && p.online);
    });
    assert.equal(propagated, true);

    const snap = (await rpc(rootUrl, "r-tok", "tools/call", {
      name: "pull_snapshot",
      arguments: { project: "branch/leaf/leaf-app" }
    })).body.result.structuredContent;
    assert.ok(snap.files.some((f) => f.path === "large.txt"));

    const status = rootServer.tree.getTreeStatus();
    assert.equal(status.directTunnels.length, 0);
    assert.equal(status.directStats.directFallbacks, 1);
    assert.equal(status.directStats.relayCalls, 1);
  } finally {
    leafServer.close();
    branchServer.close();
    rootServer.close();
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});
