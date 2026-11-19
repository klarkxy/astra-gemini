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
import { PROTOCOL_VERSION } from "../src/tree.mjs";
import { acceptWebSocketUpgrade, connectWebSocket } from "../src/ws.mjs";

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
          const br = await sdk.git.branches();
          const npmRes = await sdk.npm.run("test");
          const pyCheck = await sdk.python.compileCheck("sample.py");
          const localHealth = await sdk.http.request("http://127.0.0.1:${port}/health");
          let ssrfBlocked = false;
          try { await sdk.http.request("https://example.com"); } catch { ssrfBlocked = true; }
          const grepHit = await sdk.fs_read.grep("answer = 42");
          const envBlocked = (await sdk.fs_read.tail(".env")).ok === false;
          const wt = await sdk.worktree.create("iso1");
          const wtRm = await sdk.worktree.remove("iso1");
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

test("Astra Gemini exec_verify sandbox: permission model blocks escapes, sdk calls still work", async () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "astra-sandbox-"));
  const demoRepo = path.join(tmpBase, "demo-repo");
  const bridgeState = makeTempBridgeRoot(tmpBase, "bridge-root");
  initTempGitRepo(demoRepo);

  const projectsConfig = path.join(bridgeState, "projects.json");
  fs.writeFileSync(
    projectsConfig,
    JSON.stringify({ demo: { root: demoRepo, mode: "direct", sdks: ["git"] } }),
    "utf8"
  );

  const token = "sandbox-tok";
  const server = createBridgeServer({ bridgeRoot: bridgeState, projectsConfigPath: projectsConfig, nodeId: "sb", authMode: "bearer", authToken: token });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  const outsideFile = path.join(REPO_ROOT, "package.json");

  try {
    const fsEscape = (await rpc(baseUrl, token, "tools/call", {
      name: "exec_verify",
      arguments: {
        project: "demo",
        script: `
          const p = setTimeout.constructor("return process")();
          try { p.getBuiltinModule("fs").readFileSync(${JSON.stringify(outsideFile)}); return "fs-open"; }
          catch (e) { return e.code || e.name; }
        `
      }
    })).body.result.structuredContent;
    assert.equal(fsEscape.ok, true, fsEscape.error);
    assert.equal(fsEscape.result, "ERR_ACCESS_DENIED");

    const spawnEscape = (await rpc(baseUrl, token, "tools/call", {
      name: "exec_verify",
      arguments: {
        project: "demo",
        script: `
          const p = sdk.git.branches.constructor("return process")();
          try { p.getBuiltinModule("child_process").execSync("echo hi"); return "spawned"; }
          catch (e) { return e.code || e.name; }
        `
      }
    })).body.result.structuredContent;
    assert.equal(spawnEscape.ok, true, spawnEscape.error);
    assert.equal(spawnEscape.result, "ERR_ACCESS_DENIED");

    const vmEscape = (await rpc(baseUrl, token, "tools/call", {
      name: "exec_verify",
      arguments: {
        project: "demo",
        script: `
          try { const p = Object.constructor("return process")(); return typeof p; }
          catch (e) { return e.name; }
        `
      }
    })).body.result.structuredContent;
    assert.equal(vmEscape.ok, true, vmEscape.error);
    assert.equal(vmEscape.result, "ReferenceError");

    const sdkOk = (await rpc(baseUrl, token, "tools/call", {
      name: "exec_verify",
      arguments: {
        project: "demo",
        script: `
          const st = await sdk.git.status();
          let badCall = "";
          try { await sdk.git.nonexistent(); } catch (e) { badCall = e.constructor.name; }
          return { statusOk: st.ok, badCall };
        `
      }
    })).body.result.structuredContent;
    assert.equal(sdkOk.ok, true, sdkOk.error);
    assert.equal(sdkOk.result.statusOk, true);
    assert.equal(sdkOk.result.badCall, "TypeError");
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

  const rootServer = createBridgeServer({ bridgeRoot: rootDir, nodeId: "root", authMode: "bearer", authToken: "r-tok", joinToken: "r-join" });
  await new Promise((r) => rootServer.listen(0, "127.0.0.1", r));
  const rootPort = rootServer.address().port;
  const rootUrl = `http://127.0.0.1:${rootPort}`;

  const branchServer = createBridgeServer({
    bridgeRoot: branchDir,
    nodeId: "branch",
    authMode: "bearer",
    authToken: "b-tok",
    joinToken: "b-join",
    upstream: { enabled: true, url: `ws://127.0.0.1:${rootPort}/ws/tree`, token: "r-join" }
  });
  await new Promise((r) => branchServer.listen(0, "127.0.0.1", r));
  const branchPort = branchServer.address().port;

  const leafCandidates = [];
  const leafServer = createBridgeServer({
    bridgeRoot: leafDir,
    nodeId: "leaf",
    authMode: "bearer",
    authToken: "l-tok",
    joinToken: "l-join",
    directCandidates: leafCandidates,
    upstream: { enabled: true, url: `ws://127.0.0.1:${branchPort}/ws/tree`, token: "b-join" }
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
    joinToken: "r-join",
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
    joinToken: "b-join",
    upstream: { enabled: true, url: `ws://127.0.0.1:${rootPort}/ws/tree`, token: "r-join" }
  });
  await new Promise((r) => branchServer.listen(0, "127.0.0.1", r));
  const branchPort = branchServer.address().port;

  const leafServer = createBridgeServer({
    bridgeRoot: leafDir,
    nodeId: "leaf",
    authMode: "bearer",
    authToken: "l-tok",
    joinToken: "l-join",
    directCandidates: ["ws://127.0.0.1:1/ws/direct"],
    upstream: { enabled: true, url: `ws://127.0.0.1:${branchPort}/ws/tree`, token: "b-join" }
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

test("Astra Gemini token split: join token vs client token isolation", async () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "astra-tokens-"));
  const bridgeState = makeTempBridgeRoot(tmpBase, "bridge");
  fs.writeFileSync(path.join(bridgeState, "projects.json"), "{}", "utf8");

  const server = createBridgeServer({
    bridgeRoot: bridgeState,
    nodeId: "n1",
    authMode: "bearer",
    authToken: "client-tok",
    joinToken: "join-tok"
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();

  try {
    const mcpRes = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer join-tok" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })
    });
    assert.equal(mcpRes.status, 401);
    const wwwAuth = mcpRes.headers.get("www-authenticate") || "";
    assert.match(wwwAuth, new RegExp(`resource_metadata="http://127\.0\.0\.1:${port}/\.well-known/oauth-protected-resource/mcp"`));

    await assert.rejects(
      () => connectWebSocket(`ws://127.0.0.1:${port}/ws/tree`, { headers: { Authorization: "Bearer client-tok" } }),
      /401/
    );

    const ws = await connectWebSocket(`ws://127.0.0.1:${port}/ws/tree`, {
      headers: { Authorization: "Bearer join-tok" }
    });
    ws.close(1000);

    const prRes = await new Promise((resolve, reject) => {
      const r = http.request(
        {
          hostname: "127.0.0.1",
          port,
          path: "/.well-known/oauth-protected-resource/mcp",
          headers: { Host: "example.test", "x-forwarded-proto": "https" }
        },
        (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))));
        }
      );
      r.on("error", reject);
      r.end();
    });
    assert.equal(prRes.resource, "https://example.test/mcp");
    assert.deepEqual(prRes.authorization_servers, ["https://example.test"]);
  } finally {
    server.close();
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});

test("Astra Gemini nodeId TOFU binding: hijack rejected, admin reset allows re-bind", async () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "astra-tofu-"));
  const kidRepo = path.join(tmpBase, "kid-repo");
  initTempGitRepo(kidRepo);
  const parentDir = makeTempBridgeRoot(tmpBase, "parent");
  const childDir = makeTempBridgeRoot(tmpBase, "child");
  fs.writeFileSync(path.join(parentDir, "projects.json"), "{}", "utf8");
  fs.writeFileSync(
    path.join(childDir, "projects.json"),
    JSON.stringify({ "kid-app": { root: kidRepo, mode: "direct", sdks: ["git"] } }),
    "utf8"
  );

  const parent = createBridgeServer({
    bridgeRoot: parentDir,
    nodeId: "parent",
    authMode: "bearer",
    authToken: "p-tok",
    joinToken: "p-join"
  });
  await new Promise((r) => parent.listen(0, "127.0.0.1", r));
  const parentPort = parent.address().port;
  const parentUrl = `http://127.0.0.1:${parentPort}`;

  const child = createBridgeServer({
    bridgeRoot: childDir,
    nodeId: "kid",
    authMode: "bearer",
    authToken: "k-tok",
    joinToken: "k-join",
    upstream: { enabled: true, url: `ws://127.0.0.1:${parentPort}/ws/tree`, token: "p-join" }
  });
  await new Promise((r) => child.listen(0, "127.0.0.1", r));

  const kidOnline = () =>
    (parent.tree.getTreeStatus().children || []).some((c) => c.nodeId === "kid" && c.online);

  try {
    assert.equal(await waitUntil(kidOnline), true);

    const evil = await connectWebSocket(`ws://127.0.0.1:${parentPort}/ws/tree`, {
      headers: { Authorization: "Bearer p-join" }
    });
    const closeCode = await new Promise((resolve) => {
      evil.on("close", (code) => resolve(code));
      evil.sendJson({ type: "node/register", nodeId: "kid", nodeSecret: "f".repeat(64), protocolVersion: PROTOCOL_VERSION, projects: [] });
    });
    assert.equal(closeCode, 1008);
    assert.equal(kidOnline(), true);

    const snap = (await rpc(parentUrl, "p-tok", "tools/call", {
      name: "pull_snapshot",
      arguments: { project: "kid/kid-app" }
    })).body.result.structuredContent;
    assert.ok(snap.files.some((f) => f.path === "app.js"));

    const del = await fetch(`${parentUrl}/api/tree/children/kid`, { method: "DELETE" }).then((r) => r.json());
    assert.equal(del.ok, true);
    assert.equal(await waitUntil(kidOnline, 6000), true);
  } finally {
    child.close();
    parent.close();
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});

test("Astra Gemini OAuth 2.1: DCR, authorize, PKCE, refresh rotation, persistence", async () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "astra-oauth-"));
  const demoRepo = path.join(tmpBase, "demo-repo");
  initTempGitRepo(demoRepo);
  const bridgeState = makeTempBridgeRoot(tmpBase, "bridge");
  const projectsConfig = path.join(bridgeState, "projects.json");
  fs.writeFileSync(projectsConfig, JSON.stringify({ demo: { root: demoRepo, mode: "direct", sdks: ["git"] } }), "utf8");

  const clientToken = "oauth-client-tok";
  const makeServer = () =>
    createBridgeServer({
      bridgeRoot: bridgeState,
      projectsConfigPath: projectsConfig,
      nodeId: "o",
      authMode: "bearer",
      authToken: clientToken,
      joinToken: "j"
    });

  const server = makeServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  let accessToken;

  try {
    const pr = await fetch(`${base}/.well-known/oauth-protected-resource/mcp`).then((r) => r.json());
    assert.equal(pr.resource, `${base}/mcp`);
    assert.deepEqual(pr.authorization_servers, [base]);

    const as = await fetch(`${base}/.well-known/oauth-authorization-server`).then((r) => r.json());
    assert.equal(as.issuer, base);
    assert.equal(as.token_endpoint, `${base}/oauth/token`);
    assert.equal(as.registration_endpoint, `${base}/oauth/register`);

    const badReg = await fetch(`${base}/oauth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["http://evil.example.com/cb"] })
    });
    assert.equal(badReg.status, 400);
    assert.equal((await badReg.json()).error, "invalid_redirect_uri");

    const redirectUri = "https://claude.ai/api/mcp/auth_callback";
    const reg = await fetch(`${base}/oauth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "Claude",
        redirect_uris: [redirectUri],
        token_endpoint_auth_method: "none"
      })
    });
    assert.equal(reg.status, 201);
    const client = await reg.json();
    assert.ok(client.client_id);
    assert.ok(!client.client_secret);
    assert.equal(client.token_endpoint_auth_method, "none");

    const verifier = `v-${crypto.randomBytes(32).toString("base64url")}`;
    const challenge = crypto.createHash("sha256").update(verifier, "utf8").digest("base64url");
    const authParams = {
      client_id: client.client_id,
      response_type: "code",
      redirect_uri: redirectUri,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "st-123",
      resource: `${base}/mcp`
    };

    const badAuth = await fetch(
      `${base}/oauth/authorize?` +
        new URLSearchParams({ ...authParams, redirect_uri: "https://claude.ai/other_cb" }),
      { redirect: "manual" }
    );
    assert.equal(badAuth.status, 400);
    assert.equal(badAuth.headers.get("location"), null);

    const getAuth = await fetch(`${base}/oauth/authorize?` + new URLSearchParams(authParams), {
      redirect: "manual"
    });
    assert.equal(getAuth.status, 200);
    const html = await getAuth.text();
    assert.match(html, /访问口令/);
    assert.equal(getAuth.headers.get("x-frame-options"), "DENY");

    const postForm = (body) =>
      fetch(`${base}/oauth/authorize`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(body),
        redirect: "manual"
      });

    const wrongPw = await postForm({ ...authParams, password: "wrong-token" });
    assert.equal(wrongPw.status, 401);
    assert.equal(wrongPw.headers.get("location"), null);

    const rightPw = await postForm({ ...authParams, password: clientToken });
    assert.equal(rightPw.status, 302);
    const loc = new URL(rightPw.headers.get("location"));
    assert.equal(loc.origin + loc.pathname, redirectUri);
    assert.equal(loc.searchParams.get("state"), "st-123");
    const code = loc.searchParams.get("code");
    assert.ok(code);

    const postToken = (body) =>
      fetch(`${base}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(body)
      });

    const badTok = await postToken({
      grant_type: "authorization_code",
      client_id: client.client_id,
      code,
      redirect_uri: redirectUri,
      code_verifier: "wrong-verifier"
    });
    assert.equal(badTok.status, 400);
    assert.equal((await badTok.json()).error, "invalid_grant");

    const tok = await postToken({
      grant_type: "authorization_code",
      client_id: client.client_id,
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier
    });
    assert.equal(tok.status, 200);
    const tokens = await tok.json();
    assert.equal(tokens.token_type, "Bearer");
    assert.equal(tokens.expires_in, 3600);
    assert.ok(tokens.access_token && tokens.refresh_token);

    const reuse = await postToken({
      grant_type: "authorization_code",
      client_id: client.client_id,
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier
    });
    assert.equal((await reuse.json()).error, "invalid_grant");

    const mcpRes = await rpc(base, tokens.access_token, "tools/list");
    assert.equal(mcpRes.status, 200);
    assert.ok(mcpRes.body.result.tools.length >= 5);

    const ref1 = await postToken({
      grant_type: "refresh_token",
      client_id: client.client_id,
      refresh_token: tokens.refresh_token
    });
    assert.equal(ref1.status, 200);
    const tokens2 = await ref1.json();
    assert.notEqual(tokens2.access_token, tokens.access_token);
    assert.ok(tokens2.refresh_token);

    const refOld = await postToken({
      grant_type: "refresh_token",
      client_id: client.client_id,
      refresh_token: tokens.refresh_token
    });
    assert.equal((await refOld.json()).error, "invalid_grant");

    accessToken = tokens2.access_token;
  } finally {
    server.close();
  }

  const server2 = makeServer();
  await new Promise((r) => server2.listen(0, "127.0.0.1", r));
  try {
    const persisted = await rpc(`http://127.0.0.1:${server2.address().port}`, accessToken, "tools/list");
    assert.equal(persisted.status, 200);
    assert.ok(persisted.body.result.tools.length >= 5);
  } finally {
    server2.close();
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});

test("Astra Gemini keepalive: parent sweeps dead children, child reconnects on silent upstream", async () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "astra-keepalive-"));
  const parentDir = makeTempBridgeRoot(tmpBase, "parent");
  const leafDir = makeTempBridgeRoot(tmpBase, "leaf");
  fs.writeFileSync(path.join(parentDir, "projects.json"), "{}", "utf8");
  fs.writeFileSync(path.join(leafDir, "projects.json"), "{}", "utf8");

  const parent = createBridgeServer({
    bridgeRoot: parentDir,
    nodeId: "p",
    authMode: "bearer",
    authToken: "t",
    joinToken: "j",
    heartbeatIntervalMs: 200
  });
  await new Promise((r) => parent.listen(0, "127.0.0.1", r));
  const parentPort = parent.address().port;

  const silentSockets = [];
  const silent = http.createServer((req, res) => {
    res.writeHead(404);
    res.end();
  });
  silent.on("upgrade", (req, socket, head) => {
    const w = acceptWebSocketUpgrade(req, socket, head);
    if (!w) return;
    silentSockets.push(w);
    w.on("message", () => {});
    w.on("close", () => {});
    w.on("error", () => {});
  });
  await new Promise((r) => silent.listen(0, "127.0.0.1", r));
  const silentPort = silent.address().port;

  const leaf = createBridgeServer({
    bridgeRoot: leafDir,
    nodeId: "leaf",
    authMode: "bearer",
    authToken: "lt",
    joinToken: "lj",
    heartbeatIntervalMs: 200,
    upstream: { enabled: true, url: `ws://127.0.0.1:${silentPort}/ws/tree`, token: "x" }
  });
  await new Promise((r) => leaf.listen(0, "127.0.0.1", r));

  try {
    const ghost = await connectWebSocket(`ws://127.0.0.1:${parentPort}/ws/tree`, {
      headers: { Authorization: "Bearer j" }
    });
    ghost.sendJson({ type: "node/register", nodeId: "ghost", nodeSecret: "a".repeat(64), protocolVersion: PROTOCOL_VERSION, projects: [] });
    const ghostOnline = () =>
      (parent.tree.getTreeStatus().children || []).some((c) => c.nodeId === "ghost" && c.online);
    assert.equal(await waitUntil(ghostOnline), true);

    const ghostClosed = new Promise((resolve) => ghost.on("close", (code) => resolve(code)));
    assert.equal(await Promise.race([ghostClosed, new Promise((r) => setTimeout(() => r(0), 3000))]), 1006);
    const ghostGone = () =>
      (parent.tree.getTreeStatus().children || []).some((c) => c.nodeId === "ghost" && !c.online);
    assert.equal(await waitUntil(ghostGone), true);

    assert.equal(await waitUntil(() => silentSockets.length >= 2, 8000), true);
  } finally {
    leaf.close();
    silent.closeAllConnections?.();
    silent.close();
    parent.close();
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});

test("Astra Gemini relay timeout: relayed exec_verify uses tool timeout + hop grace", async () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "astra-relayto-"));
  const leafRepo = path.join(tmpBase, "leaf-repo");
  initTempGitRepo(leafRepo);

  const rootDir = makeTempBridgeRoot(tmpBase, "root");
  const branchDir = makeTempBridgeRoot(tmpBase, "branch");
  const leafDir = makeTempBridgeRoot(tmpBase, "leaf");

  fs.writeFileSync(path.join(rootDir, "projects.json"), "{}", "utf8");
  fs.writeFileSync(path.join(branchDir, "projects.json"), "{}", "utf8");
  fs.writeFileSync(
    path.join(leafDir, "projects.json"),
    JSON.stringify({ "leaf-app": { root: leafRepo, mode: "direct", sdks: ["git"] } }, null, 2),
    "utf8"
  );

  const rootServer = createBridgeServer({
    bridgeRoot: rootDir,
    nodeId: "root",
    authMode: "bearer",
    authToken: "r-tok",
    joinToken: "r-join",
    relayBaseTimeoutMs: 500,
    directEnabled: false
  });
  await new Promise((r) => rootServer.listen(0, "127.0.0.1", r));
  const rootPort = rootServer.address().port;
  const rootUrl = `http://127.0.0.1:${rootPort}`;

  const branchServer = createBridgeServer({
    bridgeRoot: branchDir,
    nodeId: "branch",
    authMode: "bearer",
    authToken: "b-tok",
    joinToken: "b-join",
    upstream: { enabled: true, url: `ws://127.0.0.1:${rootPort}/ws/tree`, token: "r-join" }
  });
  await new Promise((r) => branchServer.listen(0, "127.0.0.1", r));
  const branchPort = branchServer.address().port;

  const leafServer = createBridgeServer({
    bridgeRoot: leafDir,
    nodeId: "leaf",
    authMode: "bearer",
    authToken: "l-tok",
    joinToken: "l-join",
    upstream: { enabled: true, url: `ws://127.0.0.1:${branchPort}/ws/tree`, token: "b-join" }
  });
  await new Promise((r) => leafServer.listen(0, "127.0.0.1", r));

  try {
    const propagated = await waitUntil(async () => {
      const res = await rpc(rootUrl, "r-tok", "tools/call", { name: "list_projects", arguments: {} });
      return (res.body.result.structuredContent || []).some((p) => p.project === "branch/leaf/leaf-app" && p.online);
    });
    assert.equal(propagated, true);

    const res = (await rpc(rootUrl, "r-tok", "tools/call", {
      name: "exec_verify",
      arguments: {
        project: "branch/leaf/leaf-app",
        timeoutMs: 5000,
        script: `await new Promise((r) => setTimeout(r, 1500)); return "ok-slept";`
      }
    })).body.result.structuredContent;
    assert.equal(res.ok, true, res.error);
    assert.equal(res.result, "ok-slept");
    assert.ok(rootServer.tree.getTreeStatus().directStats.relayCalls >= 1);
  } finally {
    leafServer.close();
    branchServer.close();
    rootServer.close();
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});
test("Astra Gemini OAuth: register rate limit + eviction protects tokened clients", async () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "astra-dcr-"));
  const demoRepo = path.join(tmpBase, "demo-repo");
  initTempGitRepo(demoRepo);
  const bridgeState = makeTempBridgeRoot(tmpBase, "bridge");
  const projectsConfig = path.join(bridgeState, "projects.json");
  fs.writeFileSync(projectsConfig, JSON.stringify({ demo: { root: demoRepo, mode: "direct", sdks: ["git"] } }), "utf8");

  const clientToken = "dcr-tok";
  const server = createBridgeServer({
    bridgeRoot: bridgeState,
    projectsConfigPath: projectsConfig,
    nodeId: "dcr",
    authMode: "bearer",
    authToken: clientToken,
    joinToken: "j",
    oauthMaxClients: 3,
    oauthRegisterLimit: 5
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  try {
    const redirectUri = "https://claude.ai/api/mcp/auth_callback";
    const regA = await fetch(`${base}/oauth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_name: "Keeper", redirect_uris: [redirectUri], token_endpoint_auth_method: "none" })
    });
    assert.equal(regA.status, 201);
    const clientA = (await regA.json()).client_id;

    const verifier = "v-" + crypto.randomBytes(32).toString("base64url");
    const challenge = crypto.createHash("sha256").update(verifier, "utf8").digest("base64url");
    const authParams = {
      client_id: clientA,
      response_type: "code",
      redirect_uri: redirectUri,
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource: `${base}/mcp`
    };
    const authRes = await fetch(`${base}/oauth/authorize`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ ...authParams, password: clientToken }),
      redirect: "manual"
    });
    assert.equal(authRes.status, 302);
    const code = new URL(authRes.headers.get("location")).searchParams.get("code");
    const tokRes = await fetch(`${base}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: clientA,
        code,
        redirect_uri: redirectUri,
        code_verifier: verifier
      })
    });
    assert.equal(tokRes.status, 200);
    const tokens = await tokRes.json();
    assert.ok(tokens.refresh_token);

    const statuses = [];
    for (let i = 0; i < 5; i++) {
      const r = await fetch(`${base}/oauth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_name: `spam${i}`, redirect_uris: [`https://spam${i}.example.com/cb`] })
      });
      statuses.push(r.status);
    }
    assert.deepEqual(statuses, [201, 201, 201, 201, 429]);

    const list = await fetch(`${base}/api/oauth`).then((r) => r.json());
    assert.equal(list.clients.length, 3);
    assert.ok(list.clients.some((c) => c.client_id === clientA));

    const ref = await fetch(`${base}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: clientA,
        refresh_token: tokens.refresh_token
      })
    });
    assert.equal(ref.status, 200);
    assert.ok((await ref.json()).access_token);
  } finally {
    server.close();
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});
test("Astra Gemini protocol handshake: version mismatch closed 1008, no auto-reconnect", async () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "astra-proto-"));
  const parentDir = makeTempBridgeRoot(tmpBase, "parent");
  const childDir = makeTempBridgeRoot(tmpBase, "child");
  fs.writeFileSync(path.join(parentDir, "projects.json"), "{}", "utf8");
  fs.writeFileSync(path.join(childDir, "projects.json"), "{}", "utf8");

  const parent = createBridgeServer({
    bridgeRoot: parentDir, nodeId: "root", authMode: "bearer", authToken: "pt", joinToken: "pj"
  });
  await new Promise((r) => parent.listen(0, "127.0.0.1", r));
  const parentPort = parent.address().port;
  const parentUrl = `http://127.0.0.1:${parentPort}`;

  const child = createBridgeServer({
    bridgeRoot: childDir, nodeId: "v99", authMode: "bearer", authToken: "ct", joinToken: "cj",
    protocolVersion: 99,
    upstream: { enabled: true, url: `ws://127.0.0.1:${parentPort}/ws/tree`, token: "pj" }
  });
  await new Promise((r) => child.listen(0, "127.0.0.1", r));

  try {
    assert.equal(
      await waitUntil(() => /mismatch/i.test(child.tree.getTreeStatus().upstream.lastError || ""), 5000),
      true
    );
    const up = child.tree.getTreeStatus().upstream;
    assert.equal(up.connected, false);
    assert.match(up.lastError, /protocol version mismatch: parent=1 child=99/);

    await new Promise((r) => setTimeout(r, 3000));
    const st = await fetch(`${parentUrl}/api/status`).then((r) => r.json());
    const rejects = (st.logs || []).filter(
      (l) => l.event === "节点被拒" && String(l.detail || "").includes("协议版本不匹配")
    );
    assert.equal(rejects.length, 1);
    assert.ok(!(st.tree.children || []).some((c) => c.nodeId === "v99"));
    assert.equal(child.tree.getTreeStatus().upstream.connected, false);
  } finally {
    child.close();
    parent.close();
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});

test("Astra Gemini sibling routing: ../ via common parent requires canCallTree grant", async () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "astra-sib-"));
  const repoA = path.join(tmpBase, "repo-a");
  const repoB = path.join(tmpBase, "repo-b");
  initTempGitRepo(repoA);
  initTempGitRepo(repoB);
  const rootDir = makeTempBridgeRoot(tmpBase, "root");
  const aDir = makeTempBridgeRoot(tmpBase, "a");
  const bDir = makeTempBridgeRoot(tmpBase, "b");
  fs.writeFileSync(path.join(rootDir, "projects.json"), "{}", "utf8");
  fs.writeFileSync(path.join(aDir, "projects.json"), JSON.stringify({ demo: { root: repoA, mode: "direct", sdks: ["git"] } }), "utf8");
  fs.writeFileSync(path.join(bDir, "projects.json"), JSON.stringify({ demo: { root: repoB, mode: "direct", sdks: ["git"] } }), "utf8");

  const root = createBridgeServer({
    bridgeRoot: rootDir, nodeId: "root", authMode: "bearer", authToken: "rt", joinToken: "rj", heartbeatIntervalMs: 200
  });
  await new Promise((r) => root.listen(0, "127.0.0.1", r));
  const rootPort = root.address().port;
  const rootUrl = `http://127.0.0.1:${rootPort}`;
  const up = { enabled: true, url: `ws://127.0.0.1:${rootPort}/ws/tree`, token: "rj" };

  const nodeA = createBridgeServer({
    bridgeRoot: aDir, nodeId: "anode", authMode: "bearer", authToken: "at", joinToken: "aj", heartbeatIntervalMs: 200, upstream: up
  });
  await new Promise((r) => nodeA.listen(0, "127.0.0.1", r));
  const aUrl = `http://127.0.0.1:${nodeA.address().port}`;

  const nodeB = createBridgeServer({
    bridgeRoot: bDir, nodeId: "bnode", authMode: "bearer", authToken: "bt", joinToken: "bj", heartbeatIntervalMs: 200, upstream: up
  });
  await new Promise((r) => nodeB.listen(0, "127.0.0.1", r));
  const bUrl = `http://127.0.0.1:${nodeB.address().port}`;

  const online = (nid) => (root.tree.getTreeStatus().children || []).some((c) => c.nodeId === nid && c.online);

  try {
    assert.equal(await waitUntil(() => online("anode") && online("bnode")), true);

    const denied = (await rpc(aUrl, "at", "tools/call", {
      name: "pull_snapshot", arguments: { project: "../bnode/demo" }
    })).body;
    assert.equal(denied.result.isError, true);
    assert.match(denied.result.content[0].text, /未被授权调用上级/);

    const listDenied = (await rpc(aUrl, "at", "tools/call", { name: "list_projects", arguments: {} })).body.result.structuredContent;
    assert.ok(!listDenied.some((p) => String(p.project).startsWith("../")));

    const grant = await fetch(`${rootUrl}/api/tree/children/anode/grant`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ canCallTree: true })
    }).then((r) => r.json());
    assert.equal(grant.ok, true);

    const listOk = (await rpc(aUrl, "at", "tools/call", { name: "list_projects", arguments: {} })).body.result.structuredContent;
    assert.ok(listOk.some((p) => p.project === "../bnode/demo" && p.via === "upstream"));
    assert.ok(!listOk.some((p) => String(p.project).startsWith("../anode")));

    const snap = (await rpc(aUrl, "at", "tools/call", {
      name: "pull_snapshot", arguments: { project: "../bnode/demo" }
    })).body.result.structuredContent;
    assert.ok(snap.files.some((f) => f.path === "app.js"));

    const patch = "--- a/app.js\n+++ b/app.js\n@@ -1 +1 @@\n-export const answer = 41;\n+export const answer = 42;\n";
    const patched = (await rpc(aUrl, "at", "tools/call", {
      name: "apply_patch", arguments: { project: "../bnode/demo", patch }
    })).body.result.structuredContent;
    assert.equal(patched.ok, true, JSON.stringify(patched));
    assert.equal(fs.readFileSync(path.join(repoB, "app.js"), "utf8"), "export const answer = 42;\n");

    const ex = (await rpc(aUrl, "at", "tools/call", {
      name: "exec_verify",
      arguments: { project: "../bnode/demo", script: "const s = await sdk.git.status(); return s.ok && s.branch.length > 0;" }
    })).body.result.structuredContent;
    assert.equal(ex.ok, true, JSON.stringify(ex));
    assert.equal(ex.result, true);

    const deniedB = (await rpc(bUrl, "bt", "tools/call", {
      name: "pull_snapshot", arguments: { project: "../anode/demo" }
    })).body;
    assert.equal(deniedB.result.isError, true);
    assert.match(deniedB.result.content[0].text, /未被授权调用上级/);
  } finally {
    nodeA.close();
    nodeB.close();
    root.close();
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});

test("Astra Gemini multi-level routing: ../../ hops and mid-level grant revocation", async () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "astra-multi-"));
  const repoB = path.join(tmpBase, "repo-b");
  initTempGitRepo(repoB);
  const rootDir = makeTempBridgeRoot(tmpBase, "root");
  const midDir = makeTempBridgeRoot(tmpBase, "mid");
  const sibDir = makeTempBridgeRoot(tmpBase, "sib");
  const deepDir = makeTempBridgeRoot(tmpBase, "deep");
  fs.writeFileSync(path.join(rootDir, "projects.json"), "{}", "utf8");
  fs.writeFileSync(path.join(midDir, "projects.json"), "{}", "utf8");
  fs.writeFileSync(path.join(deepDir, "projects.json"), "{}", "utf8");
  fs.writeFileSync(path.join(sibDir, "projects.json"), JSON.stringify({ demo: { root: repoB, mode: "direct", sdks: ["git"] } }), "utf8");

  const root = createBridgeServer({
    bridgeRoot: rootDir, nodeId: "root", authMode: "bearer", authToken: "rt", joinToken: "rj", heartbeatIntervalMs: 200
  });
  await new Promise((r) => root.listen(0, "127.0.0.1", r));
  const rootPort = root.address().port;
  const rootUrl = `http://127.0.0.1:${rootPort}`;
  const toRoot = { enabled: true, url: `ws://127.0.0.1:${rootPort}/ws/tree`, token: "rj" };

  const mid = createBridgeServer({
    bridgeRoot: midDir, nodeId: "mid", authMode: "bearer", authToken: "mt", joinToken: "mj", heartbeatIntervalMs: 200, upstream: toRoot
  });
  await new Promise((r) => mid.listen(0, "127.0.0.1", r));
  const midPort = mid.address().port;
  const midUrl = `http://127.0.0.1:${midPort}`;

  const sib = createBridgeServer({
    bridgeRoot: sibDir, nodeId: "sib", authMode: "bearer", authToken: "st", joinToken: "sj", heartbeatIntervalMs: 200, upstream: toRoot
  });
  await new Promise((r) => sib.listen(0, "127.0.0.1", r));

  const deep = createBridgeServer({
    bridgeRoot: deepDir, nodeId: "deep", authMode: "bearer", authToken: "dt", joinToken: "dj", heartbeatIntervalMs: 200,
    upstream: { enabled: true, url: `ws://127.0.0.1:${midPort}/ws/tree`, token: "mj" }
  });
  await new Promise((r) => deep.listen(0, "127.0.0.1", r));
  const deepUrl = `http://127.0.0.1:${deep.address().port}`;

  try {
    assert.equal(await waitUntil(() =>
      ["mid", "sib"].every((n) => (root.tree.getTreeStatus().children || []).some((c) => c.nodeId === n && c.online)) &&
      (mid.tree.getTreeStatus().children || []).some((c) => c.nodeId === "deep" && c.online)
    ), true);

    const grantDeep = await fetch(`${midUrl}/api/tree/children/deep/grant`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ canCallTree: true })
    }).then((r) => r.json());
    assert.equal(grantDeep.ok, true);
    const grantMid = await fetch(`${rootUrl}/api/tree/children/mid/grant`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ canCallTree: true })
    }).then((r) => r.json());
    assert.equal(grantMid.ok, true);

    const snap = (await rpc(deepUrl, "dt", "tools/call", {
      name: "pull_snapshot", arguments: { project: "../../sib/demo" }
    })).body.result.structuredContent;
    assert.ok(snap.files.some((f) => f.path === "app.js"), JSON.stringify(snap));

    const revoke = await fetch(`${rootUrl}/api/tree/children/mid/grant`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ canCallTree: false })
    }).then((r) => r.json());
    assert.equal(revoke.ok, true);

    const denied = (await rpc(deepUrl, "dt", "tools/call", {
      name: "pull_snapshot", arguments: { project: "../../sib/demo" }
    })).body;
    assert.equal(denied.result.isError, true);
    assert.match(denied.result.content[0].text, /未被授权调用上级/);
  } finally {
    deep.close();
    sib.close();
    mid.close();
    root.close();
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});

test("Astra Gemini invalid project ref: mid-path .. rejected", async () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "astra-badref-"));
  const demoRepo = path.join(tmpBase, "demo-repo");
  initTempGitRepo(demoRepo);
  const bridgeDir = makeTempBridgeRoot(tmpBase, "bridge");
  fs.writeFileSync(path.join(bridgeDir, "projects.json"), JSON.stringify({ demo: { root: demoRepo, mode: "direct", sdks: ["git"] } }), "utf8");

  const server = createBridgeServer({
    bridgeRoot: bridgeDir, nodeId: "solo", authMode: "bearer", authToken: "t", joinToken: "j"
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const res = (await rpc(baseUrl, "t", "tools/call", {
      name: "pull_snapshot", arguments: { project: "a/../b" }
    })).body;
    assert.equal(res.result.isError, true);
    assert.match(res.result.content[0].text, /只能作为开头/);
  } finally {
    server.close();
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});

test("Astra Gemini nodes.json migration: legacy string bindings upgraded on registration", async () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "astra-mig-"));
  const rootDir = makeTempBridgeRoot(tmpBase, "root");
  const childDir = makeTempBridgeRoot(tmpBase, "child");
  fs.writeFileSync(path.join(rootDir, "projects.json"), "{}", "utf8");
  fs.writeFileSync(path.join(childDir, "projects.json"), "{}", "utf8");

  const nodeSecret = "c".repeat(64);
  fs.writeFileSync(path.join(childDir, "settings.json"), JSON.stringify({ nodeId: "migkid", nodeSecret }), "utf8");
  const secretHash = crypto.createHash("sha256").update(nodeSecret, "utf8").digest("hex");
  fs.writeFileSync(path.join(rootDir, "nodes.json"), JSON.stringify({ migkid: secretHash }), "utf8");

  const root = createBridgeServer({
    bridgeRoot: rootDir, nodeId: "root", authMode: "bearer", authToken: "rt", joinToken: "rj", heartbeatIntervalMs: 200
  });
  await new Promise((r) => root.listen(0, "127.0.0.1", r));
  const rootPort = root.address().port;

  const child = createBridgeServer({
    bridgeRoot: childDir, nodeId: "migkid", authMode: "bearer", authToken: "ct", joinToken: "cj", heartbeatIntervalMs: 200,
    upstream: { enabled: true, url: `ws://127.0.0.1:${rootPort}/ws/tree`, token: "rj" }
  });
  await new Promise((r) => child.listen(0, "127.0.0.1", r));

  try {
    const online = () => (root.tree.getTreeStatus().children || []).some((c) => c.nodeId === "migkid" && c.online);
    assert.equal(await waitUntil(online), true);
    const bindings = JSON.parse(fs.readFileSync(path.join(rootDir, "nodes.json"), "utf8"));
    assert.deepEqual(bindings.migkid, { secretHash, canCallTree: false });
  } finally {
    child.close();
    root.close();
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});
