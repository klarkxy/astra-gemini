import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import tls from "node:tls";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import zlib from "node:zlib";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createBridgeServer } from "../src/server.mjs";
import { PROTOCOL_VERSION } from "../src/tree.mjs";
import { acceptWebSocketUpgrade, connectWebSocket } from "../src/ws.mjs";
import { loadIdentity } from "../src/identity.mjs";
import { openChannel } from "../src/secure-channel.mjs";
import { createRendezvousServer } from "../src/rendezvous.mjs";
import { createUpnpManager } from "../src/upnp.mjs";
import { writeSecretFile } from "../src/secure-file.mjs";
import { createSdk as createCargoSdk } from "../sdks/global/cargo.mjs";
import { createSdk as createGoSdk } from "../sdks/global/go.mjs";
import { createSdk as createNpmSdk } from "../sdks/global/npm.mjs";
import { createSdk as createGitSdk } from "../sdks/global/git.mjs";

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

test("Astra Gemini single-node: GUI firewall, SDK hot toggles, 9 dev SDKs, snapshot, patch+rollback", async () => {
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
      headers: { "Content-Type": "application/json", "X-Astra-Admin": token },
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
      headers: { "Content-Type": "application/json", "X-Astra-Admin": token },
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

    const del = await fetch(`${parentUrl}/api/tree/children/kid`, {
      method: "DELETE",
      headers: { "X-Astra-Admin": "p-tok" }
    }).then((r) => r.json());
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

    const list = await fetch(`${base}/api/oauth`, { headers: { "X-Astra-Admin": "dcr-tok" } }).then((r) => r.json());
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
    const st = await fetch(`${parentUrl}/api/status`, { headers: { "X-Astra-Admin": "pt" } }).then((r) => r.json());
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

test("Astra Gemini revert: any .. ref rejected and grant API gone", async () => {
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
    for (const ref of ["../x", "a/../b", "..", "../../x/y"]) {
      const res = (await rpc(baseUrl, "t", "tools/call", {
        name: "pull_snapshot", arguments: { project: ref }
      })).body;
      assert.equal(res.result.isError, true, ref);
      assert.match(res.result.content[0].text, /非法的项目路径/);
    }
    const grant = await fetch(`${baseUrl}/api/tree/children/x/grant`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Astra-Admin": "t" },
      body: JSON.stringify({ canCallTree: true })
    });
    assert.equal(grant.status, 404);
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
    assert.deepEqual(bindings.migkid, { secretHash });
  } finally {
    child.close();
    root.close();
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});

function listenOn(server) {
  return new Promise((r) => server.listen(0, "127.0.0.1", r));
}

async function rpcRemote(baseUrl, target, token, method, params = {}) {
  const res = await fetch(`${baseUrl}/remote/${encodeURIComponent(target)}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function remoteStatus(node) {
  const baseUrl = typeof node === "string" ? node : node.baseUrl;
  const headers = node && node.adminKey ? { "X-Astra-Admin": node.adminKey } : {};
  return fetch(`${baseUrl}/api/remote`, { headers }).then((r) => r.json());
}

async function startRemoteNode(tmpBase, name, {
  rvUrl, rvToken, authToken, joinToken, candidates, windowMs = 800, demoRoot = null,
  authMode = "bearer", channelIdleMs, channelPingMs, idleSweepMs
}) {
  const dir = makeTempBridgeRoot(tmpBase, name);
  const projects = demoRoot
    ? { demo: { root: demoRoot, mode: "direct", sdks: ["git", "fs_read"] } }
    : {};
  fs.writeFileSync(path.join(dir, "projects.json"), JSON.stringify(projects, null, 2), "utf8");
  const server = createBridgeServer({
    bridgeRoot: dir,
    nodeId: name,
    authMode,
    authToken,
    joinToken,
    rendezvous: { url: rvUrl, token: rvToken },
    p2pPort: 0,
    p2pCandidates: candidates,
    p2pDirectWindowMs: windowMs,
    channelIdleMs,
    channelPingMs,
    idleSweepMs,
    upnp: false,
    heartbeatIntervalMs: 200
  });
  await listenOn(server);
  return { server, dir, baseUrl: `http://127.0.0.1:${server.address().port}`, adminKey: authToken || "" };
}

async function waitRvConnected(...nodes) {
  for (const n of nodes) {
    const ok = await waitUntil(async () => (await remoteStatus(n)).rendezvous?.connected === true, 8000);
    assert.equal(ok, true, `rendezvous not connected on ${typeof n === "string" ? n : n.baseUrl}`);
  }
}

test("remote identity: ag1- address, self-signed X509 verify, mutual TLS 1.3 channel", async () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "astra-ident-"));
  const dir = path.join(tmpBase, "bridge");
  fs.mkdirSync(dir, { recursive: true });
  const identity = loadIdentity(dir);
  assert.match(identity.address, /^ag1-[a-z2-7]{32}$/);
  assert.equal(loadIdentity(dir).address, identity.address);
  assert.ok(fs.existsSync(path.join(dir, "identity.json")));

  const x509 = new crypto.X509Certificate(identity.certPem);
  assert.equal(x509.verify(identity.publicKey), true);
  assert.equal(x509.subject.includes(`CN=${identity.address}`), true);

  const server = net.createServer();
  const serverChannels = [];
  server.on("connection", (sock) => {
    serverChannels.push(openChannel({ duplex: sock, role: "server", identity }));
  });
  await listenOn(server);
  const port = server.address().port;

  try {
    const cli = await openChannel({
      duplex: net.connect({ host: "127.0.0.1", port }),
      role: "client",
      identity,
      expectedPeerAddress: identity.address
    });
    const srv = await serverChannels[0];
    assert.equal(cli.peerAddress, identity.address);
    assert.equal(srv.peerAddress, identity.address);
    srv.onRequest(async ({ bodyText }) => ({
      status: 200,
      headers: { "content-type": "application/json" },
      bodyText: JSON.stringify({ ok: true, echo: bodyText })
    }));
    const res = await cli.request({ headers: { authorization: "Bearer x" }, body: '{"a":1}' });
    assert.equal(res.status, 200);
    assert.equal(JSON.parse(res.body).echo, '{"a":1}');
    cli.close();
    srv.close();

    await assert.rejects(
      openChannel({
        duplex: net.connect({ host: "127.0.0.1", port }),
        role: "client",
        identity,
        expectedPeerAddress: `ag1-${"q".repeat(32)}`
      }),
      /不匹配/
    );

    const certless = new Promise((resolve, reject) => {
      const raw = net.connect({ host: "127.0.0.1", port });
      raw.on("connect", () => {
        const s = tls.connect({
          socket: raw,
          minVersion: "TLSv1.3",
          rejectUnauthorized: false,
          ALPNProtocols: ["astra/1"],
          checkServerIdentity: () => undefined
        });
        s.on("secureConnect", () => resolve(s));
        s.on("error", reject);
      });
      raw.on("error", reject);
    });
    const tlsSock = await certless;
    await assert.rejects(serverChannels[serverChannels.length - 1], /未提供证书/);
    tlsSock.destroy();
  } finally {
    server.close();
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});

test("remote rendezvous: token gate, hello signature, welcome address", async () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "astra-rv-"));
  const identity = loadIdentity(path.join(tmpBase, "node"));
  const rv = createRendezvousServer({ token: "rvt" });
  await listenOn(rv.server);
  const base = `ws://127.0.0.1:${rv.server.address().port}`;

  try {
    await assert.rejects(
      connectWebSocket(`${base}/rv`, { headers: { authorization: "Bearer wrong" } }),
      /401|Unexpected|failed/i
    );

    const ws = await connectWebSocket(`${base}/rv`, { headers: { authorization: "Bearer rvt" } });
    const welcome = await new Promise((resolve, reject) => {
      ws.on("message", (text) => {
        const msg = JSON.parse(text);
        if (msg.t === "challenge") {
          const sig = crypto.sign(null, Buffer.from(`astra-rv-v1:${msg.nonce}`), identity.privateKey);
          ws.sendJson({
            t: "hello",
            protocolVersion: PROTOCOL_VERSION,
            spki: identity.spkiDer.toString("base64"),
            sig: sig.toString("base64")
          });
        } else if (msg.t === "welcome") {
          resolve(msg);
        }
      });
      ws.on("close", (code, reason) => reject(new Error(`closed ${code} ${reason}`)));
    });
    assert.equal(welcome.address, identity.address);
    assert.equal(typeof welcome.observedIp, "string");
    ws.close(1000, "bye");

    const badSig = await connectWebSocket(`${base}/rv`, { headers: { authorization: "Bearer rvt" } });
    const closeInfo = await new Promise((resolve) => {
      badSig.on("message", (text) => {
        const msg = JSON.parse(text);
        if (msg.t === "challenge") {
          badSig.sendJson({
            t: "hello",
            protocolVersion: PROTOCOL_VERSION,
            spki: identity.spkiDer.toString("base64"),
            sig: crypto.randomBytes(64).toString("base64")
          });
        }
      });
      badSig.on("close", (code, reason) => resolve({ code, reason }));
    });
    assert.equal(closeInfo.code, 1008);
  } finally {
    rv.close();
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});

test("remote direct: A proxies /remote/<addr>/mcp to B over P2P mutual TLS", async () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "astra-direct-"));
  const rv = createRendezvousServer({ token: "rvt" });
  await listenOn(rv.server);
  const rvUrl = `ws://127.0.0.1:${rv.server.address().port}`;
  const rvHttp = `http://127.0.0.1:${rv.server.address().port}`;

  const bRepo = path.join(tmpBase, "b-repo");
  initTempGitRepo(bRepo);
  let aCands = [];
  let bCands = [];
  const A = await startRemoteNode(tmpBase, "nodeA", {
    rvUrl, rvToken: "rvt", authToken: "tA", joinToken: "jA", candidates: () => aCands
  });
  const B = await startRemoteNode(tmpBase, "nodeB", {
    rvUrl, rvToken: "rvt", authToken: "tB", joinToken: "jB", candidates: () => bCands, demoRoot: bRepo
  });

  try {
    const statA = await remoteStatus(A);
    const statB = await remoteStatus(B);
    aCands = [`127.0.0.1:${statA.p2p.port}`];
    bCands = [`127.0.0.1:${statB.p2p.port}`];
    await waitRvConnected(A, B);

    const list = await rpcRemote(A.baseUrl, statB.address, "tB", "tools/list");
    assert.equal(list.status, 200);
    const names = (list.body.result.tools || []).map((t) => t.name);
    assert.ok(names.includes("pull_snapshot"));

    const snap = await rpcRemote(A.baseUrl, statB.address, "tB", "tools/call", {
      name: "pull_snapshot",
      arguments: { project: "demo" }
    });
    assert.equal(snap.status, 200);
    assert.notEqual(snap.body.result.isError, true);
    assert.match(JSON.stringify(snap.body.result), /app\.js/);

    const statA2 = await remoteStatus(A);
    assert.equal(statA2.channels.length >= 1, true);
    assert.equal(statA2.channels[0].mode, "direct");
    assert.equal(statA2.channels[0].peer, statB.address);

    const health = await fetch(`${rvHttp}/health`).then((r) => r.json());
    assert.equal(health.relayedBytes, 0);

    const [p1, p2] = await Promise.all([
      rpcRemote(A.baseUrl, statB.address, "tB", "tools/list"),
      rpcRemote(A.baseUrl, statB.address, "tB", "tools/list")
    ]);
    assert.equal(p1.status, 200);
    assert.equal(p2.status, 200);
    const statA3 = await remoteStatus(A);
    assert.equal(statA3.channels.filter((c) => c.direction === "out" && c.peer === statB.address).length, 1);

    const reverse = await rpcRemote(B.baseUrl, statA.address, "tA", "tools/list");
    assert.equal(reverse.status, 200);
    const statB2 = await remoteStatus(B);
    assert.equal(
      statB2.channels.filter((c) => c.direction === "out" && c.peer === statA.address).length,
      1
    );

    const bad = await rpcRemote(A.baseUrl, statB.address, "wrong-token", "tools/list");
    assert.equal(bad.status, 401);
  } finally {
    A.server.close();
    B.server.close();
    rv.close();
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});

test("remote relay fallback: ciphertext-only bytes over rendezvous when direct fails", async () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "astra-relay-"));
  const captured = [];
  const rv = createRendezvousServer({ token: "rvt", onRelayChunk: (buf) => captured.push(Buffer.from(buf)) });
  await listenOn(rv.server);
  const rvUrl = `ws://127.0.0.1:${rv.server.address().port}`;
  const rvHttp = `http://127.0.0.1:${rv.server.address().port}`;

  const bRepo = path.join(tmpBase, "b-repo");
  initTempGitRepo(bRepo);
  const dead = ["127.0.0.1:9"];
  const A = await startRemoteNode(tmpBase, "nodeA", {
    rvUrl, rvToken: "rvt", authToken: "tA", joinToken: "jA", candidates: () => dead, windowMs: 600
  });
  const B = await startRemoteNode(tmpBase, "nodeB", {
    rvUrl, rvToken: "rvt", authToken: "tB", joinToken: "jB", candidates: () => dead, windowMs: 600, demoRoot: bRepo
  });

  try {
    const statB = await remoteStatus(B);
    await waitRvConnected(A, B);

    const list = await rpcRemote(A.baseUrl, statB.address, "tB", "tools/list");
    assert.equal(list.status, 200);

    const statA2 = await remoteStatus(A);
    assert.equal(statA2.channels.length >= 1, true);
    assert.equal(statA2.channels[0].mode, "relay");

    const ok = await waitUntil(async () => {
      const h = await fetch(`${rvHttp}/health`).then((r) => r.json());
      return h.relayedBytes > 0;
    }, 4000);
    assert.equal(ok, true);

    const blob = Buffer.concat(captured).toString("latin1");
    assert.equal(blob.includes("tB"), false);
    assert.equal(blob.includes("tools/list"), false);
  } finally {
    A.server.close();
    B.server.close();
    rv.close();
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});

test("remote aliases, unknown target 404, offline target 502", async () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "astra-alias-"));
  const rv = createRendezvousServer({ token: "rvt" });
  await listenOn(rv.server);
  const rvUrl = `ws://127.0.0.1:${rv.server.address().port}`;

  const A = await startRemoteNode(tmpBase, "nodeA", {
    rvUrl, rvToken: "rvt", authToken: "tA", joinToken: "jA", candidates: () => []
  });
  const B = await startRemoteNode(tmpBase, "nodeB", {
    rvUrl, rvToken: "rvt", authToken: "tB", joinToken: "jB", candidates: () => []
  });

  try {
    const statB = await remoteStatus(B);
    await waitRvConnected(A, B);

    const add = await fetch(`${A.baseUrl}/api/remote/aliases`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Astra-Admin": "tA" },
      body: JSON.stringify({ alias: "bb", address: statB.address })
    }).then((r) => r.json());
    assert.equal(add.ok, true);
    assert.equal(add.remotes.bb, statB.address);

    const list = await rpcRemote(A.baseUrl, "bb", "tB", "tools/list");
    assert.equal(list.status, 200);

    const unknown = await rpcRemote(A.baseUrl, "nosuch", "tB", "tools/list");
    assert.equal(unknown.status, 404);

    const offline = await rpcRemote(A.baseUrl, `ag1-${"a".repeat(32)}`, "tB", "tools/list");
    assert.equal(offline.status, 502);
    assert.match(offline.body.error, /不在线/);
  } finally {
    A.server.close();
    B.server.close();
    rv.close();
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});

test("remote remoteAllowFrom: B rejects A not on allowlist", async () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "astra-allow-"));
  const rv = createRendezvousServer({ token: "rvt" });
  await listenOn(rv.server);
  const rvUrl = `ws://127.0.0.1:${rv.server.address().port}`;

  const A = await startRemoteNode(tmpBase, "nodeA", {
    rvUrl, rvToken: "rvt", authToken: "tA", joinToken: "jA", candidates: () => []
  });
  const B = await startRemoteNode(tmpBase, "nodeB", {
    rvUrl, rvToken: "rvt", authToken: "tB", joinToken: "jB", candidates: () => []
  });

  try {
    const statB = await remoteStatus(B);
    await waitRvConnected(A, B);

    const allow = await fetch(`${B.baseUrl}/api/remote/allow`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Astra-Admin": "tB" },
      body: JSON.stringify({ addresses: [`ag1-${"z".repeat(32)}`] })
    }).then((r) => r.json());
    assert.equal(allow.ok, true);

    const res = await rpcRemote(A.baseUrl, statB.address, "tB", "tools/list");
    assert.equal(res.status, 502);
    assert.match(res.body.error, /允许列表/);
  } finally {
    A.server.close();
    B.server.close();
    rv.close();
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});

test("remote p2p preamble: garbage and unknown sid closed before TLS", async () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "astra-pre-"));
  const B = await startRemoteNode(tmpBase, "nodeB", {
    rvUrl: "", rvToken: "", authToken: "tB", joinToken: "jB", candidates: () => []
  });
  try {
    const statB = await remoteStatus(B);
    const p2pPort = statB.p2p.port;
    assert.ok(p2pPort > 0);

    for (const payload of ["GARBAGE NOT A PREAMBLE\n", "ASTRA-P2P/1 deadbeefdeadbeef\n"]) {
      const closed = await new Promise((resolve) => {
        const sock = net.connect({ host: "127.0.0.1", port: p2pPort });
        const timer = setTimeout(() => {
          sock.destroy();
          resolve(false);
        }, 2500);
        sock.on("connect", () => sock.write(payload));
        sock.on("close", () => {
          clearTimeout(timer);
          resolve(true);
        });
        sock.on("error", () => {});
      });
      assert.equal(closed, true, `socket not closed for ${JSON.stringify(payload)}`);
    }
  } finally {
    B.server.close();
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});

test("upnp: fake IGD controlURL parsing, AddPortMapping fields, DeletePortMapping on stop", async () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "astra-upnp-"));
  const soapCalls = [];
  const igd = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/desc.xml") {
      const port = igd.address().port;
      res.writeHead(200, { "content-type": "text/xml" }).end(
        `<?xml version="1.0"?><root><URLBase>http://127.0.0.1:${port}/</URLBase>` +
          `<device><serviceList><service>` +
          `<serviceType>urn:schemas-upnp-org:service:WANIPConnection:1</serviceType>` +
          `<controlURL>/ctl</controlURL>` +
          `</service></serviceList></device></root>`
      );
      return;
    }
    if (req.method === "POST" && req.url === "/ctl") {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        const action = /#(\w+)"/.exec(req.headers.soapaction || "")?.[1] || "";
        soapCalls.push({ action, text });
        let body = '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>';
        if (action === "GetExternalIPAddress") {
          body += '<u:GetExternalIPAddressResponse xmlns:u="urn:schemas-upnp-org:service:WANIPConnection:1"><NewExternalIPAddress>203.0.113.7</NewExternalIPAddress></u:GetExternalIPAddressResponse>';
        } else {
          body += `<u:${action}Response xmlns:u="urn:schemas-upnp-org:service:WANIPConnection:1"/>`;
        }
        body += "</s:Body></s:Envelope>";
        res.writeHead(200, { "content-type": "text/xml" }).end(body);
      });
      return;
    }
    res.writeHead(404).end();
  });
  await listenOn(igd);

  try {
    const mgr = createUpnpManager({
      port: 3940,
      internalIp: "192.168.1.50",
      location: `http://127.0.0.1:${igd.address().port}/desc.xml`
    });
    const st = await mgr.start();
    assert.equal(st.state, "mapped");
    assert.equal(st.externalAddr, "203.0.113.7:3940");

    const add = soapCalls.find((c) => c.action === "AddPortMapping");
    assert.ok(add);
    assert.match(add.text, /<NewExternalPort>3940<\/NewExternalPort>/);
    assert.match(add.text, /<NewInternalPort>3940<\/NewInternalPort>/);
    assert.match(add.text, /<NewProtocol>TCP<\/NewProtocol>/);
    assert.match(add.text, /<NewInternalClient>192\.168\.1\.50<\/NewInternalClient>/);
    assert.match(add.text, /astra-gemini/);
    assert.match(add.text, /<NewLeaseDuration>3600<\/NewLeaseDuration>/);

    await mgr.stop();
    assert.equal(soapCalls.some((c) => c.action === "DeletePortMapping"), true);
  } finally {
    igd.close();
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});

test("remote auth guard: authMode none node rejects remote channel requests with 403", async () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "astra-noauth-"));
  const rv = createRendezvousServer({ token: "rvt" });
  await listenOn(rv.server);
  const rvUrl = `ws://127.0.0.1:${rv.server.address().port}`;
  const A = await startRemoteNode(tmpBase, "nodeA", {
    rvUrl, rvToken: "rvt", authToken: "tA", joinToken: "jA", candidates: () => []
  });
  const B = await startRemoteNode(tmpBase, "nodeB", {
    rvUrl, rvToken: "rvt", joinToken: "jB", candidates: () => [], authMode: "none"
  });
  try {
    const statB = await remoteStatus(B);
    await waitRvConnected(A, B);
    for (const token of [null, "anything"]) {
      const res = await rpcRemote(A.baseUrl, statB.address, token, "tools/list");
      assert.equal(res.status, 403);
      assert.match(res.body.error, /未启用鉴权/);
    }
  } finally {
    A.server.close();
    B.server.close();
    rv.close();
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});

test("remote idle: channel closes after channelIdleMs despite ping/pong traffic", async () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "astra-idle-"));
  const rv = createRendezvousServer({ token: "rvt" });
  await listenOn(rv.server);
  const rvUrl = `ws://127.0.0.1:${rv.server.address().port}`;
  const opts = {
    rvUrl, rvToken: "rvt", candidates: () => [],
    channelPingMs: 50, channelIdleMs: 400, idleSweepMs: 150
  };
  const A = await startRemoteNode(tmpBase, "nodeA", { ...opts, authToken: "tA", joinToken: "jA" });
  const B = await startRemoteNode(tmpBase, "nodeB", { ...opts, authToken: "tB", joinToken: "jB" });
  try {
    const statB = await remoteStatus(B);
    await waitRvConnected(A, B);
    const res = await rpcRemote(A.baseUrl, statB.address, "tB", "tools/list");
    assert.equal(res.status, 200);
    assert.equal((await remoteStatus(A)).channels.length >= 1, true);
    const closed = await waitUntil(async () => (await remoteStatus(A)).channels.length === 0, 5000);
    assert.equal(closed, true, "idle channel was not closed");
  } finally {
    A.server.close();
    B.server.close();
    rv.close();
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});

test("rendezvous relay: duplicate role join and wrong key rejected with 403", async () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "astra-dupleg-"));
  const idA = loadIdentity(path.join(tmpBase, "na"));
  const idB = loadIdentity(path.join(tmpBase, "nb"));
  const rv = createRendezvousServer({ token: "rvt" });
  await listenOn(rv.server);
  const base = `ws://127.0.0.1:${rv.server.address().port}`;

  const mkNode = async (id) => {
    const ws = await connectWebSocket(`${base}/rv`, { headers: { authorization: "Bearer rvt" } });
    const queue = [];
    const waiters = [];
    ws.on("message", (t) => {
      const m = JSON.parse(t);
      if (m.t === "challenge") {
        const sig = crypto.sign(null, Buffer.from(`astra-rv-v1:${m.nonce}`), id.privateKey);
        ws.sendJson({
          t: "hello",
          protocolVersion: PROTOCOL_VERSION,
          spki: id.spkiDer.toString("base64"),
          sig: sig.toString("base64")
        });
        return;
      }
      for (let i = 0; i < waiters.length; i++) {
        if (waiters[i](m)) {
          waiters.splice(i, 1);
          return;
        }
      }
      queue.push(m);
    });
    const next = (pred) =>
      new Promise((resolve) => {
        const i = queue.findIndex(pred);
        if (i >= 0) return resolve(queue.splice(i, 1)[0]);
        waiters.push((m) => {
          if (!pred(m)) return false;
          resolve(m);
          return true;
        });
      });
    await next((m) => m.t === "welcome");
    return { ws, next };
  };

  try {
    const nodeA = await mkNode(idA);
    const nodeB = await mkNode(idB);
    nodeA.ws.sendJson({ t: "connect", id: "c1", to: idB.address, candidates: [] });
    const incoming = await nodeB.next((m) => m.t === "incoming");
    nodeB.ws.sendJson({ t: "accept", sid: incoming.sid, candidates: [] });
    const connOk = await nodeA.next((m) => m.t === "connect-ok");

    const leg1 = await connectWebSocket(
      `${base}/rv/relay?sid=${connOk.sid}&role=a&key=${connOk.relayKey}`,
      { headers: { authorization: "Bearer rvt" } }
    );
    assert.ok(leg1);
    await assert.rejects(
      connectWebSocket(`${base}/rv/relay?sid=${connOk.sid}&role=a&key=${connOk.relayKey}`, {
        headers: { authorization: "Bearer rvt" }
      }),
      /403/
    );
    await assert.rejects(
      connectWebSocket(`${base}/rv/relay?sid=${connOk.sid}&role=b&key=badkey`, {
        headers: { authorization: "Bearer rvt" }
      }),
      /403/
    );
    leg1.close(1000, "done");
    nodeA.ws.close(1000, "done");
    nodeB.ws.close(1000, "done");
  } finally {
    rv.close();
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});

test("cargo SDK: whitelist rejection, package validation, missing manifest, real cargo check", (t) => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "astra-cargo-"));
  try {
    const sdk = createCargoSdk({ bridgeRoot: tmpBase, project: { root: tmpBase, deny: [] } });
    assert.equal(sdk.run("install").ok, false);
    assert.equal(sdk.run("run").ok, false);
    assert.equal(sdk.run("check").ok, false); // 无 Cargo.toml

    fs.writeFileSync(
      path.join(tmpBase, "Cargo.toml"),
      '[package]\nname = "tiny"\nversion = "0.1.0"\nedition = "2021"\n',
      "utf8"
    );
    fs.mkdirSync(path.join(tmpBase, "src"));
    fs.writeFileSync(path.join(tmpBase, "src", "lib.rs"), "pub fn add(a: i32, b: i32) -> i32 { a + b }\n", "utf8");

    assert.equal(sdk.run("check", { package: "-x" }).ok, false);
    assert.equal(sdk.run("check", { package: "a;b" }).ok, false);

    const hasCargo = spawnSync("cargo", ["--version"], { encoding: "utf8" });
    if (hasCargo.error || hasCargo.status !== 0) {
      t.skip("cargo toolchain unavailable");
      return;
    }
    const info = sdk.info();
    assert.equal(info.ok, true);
    assert.equal(info.hasManifest, true);
    const res = sdk.run("check");
    assert.equal(res.ok, true, res.error || res.tail);
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});

test("go SDK: whitelist rejection, pkg/run validation, missing go.mod, real go vet", (t) => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "astra-go-"));
  try {
    const sdk = createGoSdk({ bridgeRoot: tmpBase, project: { root: tmpBase, deny: [] } });
    assert.equal(sdk.run("install").ok, false);
    assert.equal(sdk.run("run").ok, false);
    assert.equal(sdk.run("vet").ok, false); // 无 go.mod

    fs.writeFileSync(path.join(tmpBase, "go.mod"), "module example.com/tiny\n\ngo 1.22\n", "utf8");
    fs.writeFileSync(path.join(tmpBase, "main.go"), "package main\n\nfunc main() {}\n", "utf8");

    assert.equal(sdk.run("vet", { pkg: "-x" }).ok, false);
    assert.equal(sdk.run("vet", { pkg: "a;b" }).ok, false);
    assert.equal(sdk.run("build", { run: "TestX" }).ok, false); // run 仅限 test
    assert.equal(sdk.run("test", { run: "-x" }).ok, false);
    assert.equal(sdk.run("test", { run: "a;b" }).ok, false);

    const hasGo = spawnSync("go", ["version"], { encoding: "utf8" });
    if (hasGo.error || hasGo.status !== 0) {
      t.skip("go toolchain unavailable");
      return;
    }
    const info = sdk.info();
    assert.equal(info.ok, true);
    assert.equal(info.module, "example.com/tiny");
    const res = sdk.run("vet", { pkg: "./..." });
    assert.equal(res.ok, true, res.error || res.tail);
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});

test("npm SDK: manager auto-detect via packageManager field and lockfiles", () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "astra-pm-"));
  try {
    const pkg = { name: "demo", scripts: { test: "node -e 1" } };
    const write = (obj) => fs.writeFileSync(path.join(tmpBase, "package.json"), JSON.stringify(obj), "utf8");
    const make = () =>
      createNpmSdk({ bridgeRoot: tmpBase, project: { root: tmpBase, deny: [], allowedScripts: ["test"] } });

    write(pkg);
    fs.writeFileSync(path.join(tmpBase, "yarn.lock"), "", "utf8");
    assert.equal(make().listScripts().manager, "yarn");

    write({ ...pkg, packageManager: "bun@1.1.0" });
    assert.equal(make().listScripts().manager, "bun"); // packageManager 优先于 lockfile

    fs.rmSync(path.join(tmpBase, "yarn.lock"));
    assert.equal(make().listScripts().manager, "bun");

    write(pkg);
    assert.equal(make().listScripts().manager, "npm");
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});

test("git SDK: diff hides denied files, show/blame enforce deny and validate args", () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "astra-gitsdk-"));
  try {
    const repo = path.join(tmpBase, "repo");
    fs.mkdirSync(repo, { recursive: true });
    spawnSync("git", ["init"], { cwd: repo });
    spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
    spawnSync("git", ["config", "user.name", "Test User"], { cwd: repo });
    fs.writeFileSync(path.join(repo, ".env"), "SECRET_KEY=topsecret\n", "utf8");
    fs.writeFileSync(path.join(repo, "src.txt"), "line one\n", "utf8");
    spawnSync("git", ["add", "."], { cwd: repo });
    spawnSync("git", ["commit", "-m", "init"], { cwd: repo });
    fs.writeFileSync(path.join(repo, ".env"), "SECRET_KEY=newsecret\n", "utf8");
    fs.writeFileSync(path.join(repo, "src.txt"), "line one\nline two\n", "utf8");

    const sdk = createGitSdk({ bridgeRoot: tmpBase, project: { root: repo, deny: [], mode: "direct" } });

    const d = sdk.diff();
    assert.equal(d.ok, true);
    assert.ok(!d.diff.includes("newsecret"), "diff leaked denied .env content");
    assert.ok(d.diff.includes("line two"));
    assert.ok(d.hiddenCount >= 1);

    const stat = sdk.diff({ statOnly: true });
    assert.equal(stat.ok, true);
    assert.ok(!stat.diff.includes(".env"), "stat diff leaked denied .env name");
    assert.ok(stat.hiddenCount >= 1);

    assert.equal(sdk.show("--output=x").ok, false);
    assert.equal(sdk.show("HEAD", ".env").ok, false);
    assert.equal(sdk.show("HEAD", "../outside").ok, false);
    const sh = sdk.show("HEAD", "src.txt");
    assert.equal(sh.ok, true);
    assert.match(sh.content, /line one/);
    const headStat = sdk.show("HEAD");
    assert.equal(headStat.ok, true);
    assert.match(headStat.stat, /src\.txt/);

    const bl = sdk.blame("src.txt");
    assert.equal(bl.ok, true);
    assert.ok(Array.isArray(bl.lines) && bl.lines.length >= 1);
    assert.equal(sdk.blame(".env").ok, false);
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});

test("admin API key: /api/* requires X-Astra-Admin, /ui exempt, client-token fallback", async () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "astra-adminkey-"));
  try {
    const bridgeDir = makeTempBridgeRoot(tmpBase, "bridge");
    fs.writeFileSync(path.join(bridgeDir, "projects.json"), "{}", "utf8");
    const server = createBridgeServer({
      bridgeRoot: bridgeDir,
      nodeId: "ak",
      authMode: "bearer",
      authToken: "client-tok",
      adminKey: "admin-secret"
    });
    await listenOn(server);
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      const noKey = await fetch(`${base}/api/status`);
      assert.equal(noKey.status, 401);
      assert.equal((await noKey.json()).code, "admin_auth_required");
      const wrong = await fetch(`${base}/api/status`, { headers: { "X-Astra-Admin": "nope" } });
      assert.equal(wrong.status, 401);
      const clientTok = await fetch(`${base}/api/status`, { headers: { "X-Astra-Admin": "client-tok" } });
      assert.equal(clientTok.status, 401);
      const good = await fetch(`${base}/api/status`, { headers: { "X-Astra-Admin": "admin-secret" } });
      assert.equal(good.status, 200);
      assert.equal((await fetch(`${base}/ui`)).status, 200);
    } finally {
      server.close();
    }

    const bridge2 = makeTempBridgeRoot(tmpBase, "bridge2");
    fs.writeFileSync(path.join(bridge2, "projects.json"), "{}", "utf8");
    const server2 = createBridgeServer({
      bridgeRoot: bridge2,
      nodeId: "ak2",
      authMode: "bearer",
      authToken: "client-tok2"
    });
    await listenOn(server2);
    try {
      const res = await fetch(`http://127.0.0.1:${server2.address().port}/api/status`, {
        headers: { "X-Astra-Admin": "client-tok2" }
      });
      assert.equal(res.status, 200);
    } finally {
      server2.close();
    }
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});

function assertAclOwnerOnly(filePath) {
  if (process.platform === "win32") {
    const sys32 = path.join(process.env.SystemRoot || "C:\\Windows", "System32");
    const out = spawnSync(path.join(sys32, "icacls.exe"), [filePath], { encoding: "utf8" }).stdout || "";
    const who = spawnSync(path.join(sys32, "whoami.exe"), ["/user", "/fo", "csv", "/nh"], { encoding: "utf8" }).stdout || "";
    const firstLine = who.split(/\r?\n/).find((l) => l.trim()) || "";
    const sid = String(firstLine.split(",")[1] || "").trim().replace(/^"|"$/g, "");
    const account = String(firstLine.split(",")[0] || "").trim().replace(/^"|"$/g, "");
    assert.ok(sid || account, `无法解析当前用户 SID: ${who}`);
    const outLower = out.toLowerCase();
    assert.ok(
      outLower.includes(sid.toLowerCase()) || (account && outLower.includes(account.toLowerCase())),
      `icacls 输出未包含当前用户 ${account || sid}: ${out}`
    );
    for (const line of out.split(/\r?\n/)) {
      const ace = line.replace(filePath, "");
      assert.ok(!/authenticated users|everyone|\busers\b/i.test(ace), `ACL 中不应出现其他主体: ${line}`);
    }
  } else {
    assert.equal(fs.statSync(filePath).mode & 0o077, 0, `${filePath} 权限应仅属主可读写`);
  }
}

test("secret file ACLs: writeSecretFile + startup hardenSecretFiles restrict to owner", async () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "astra-acl-"));
  try {
    const fresh = path.join(tmpBase, "fresh-secret.txt");
    writeSecretFile(fresh, "s3cr3t");
    assert.equal(fs.readFileSync(fresh, "utf8"), "s3cr3t");
    assertAclOwnerOnly(fresh);

    const bridgeDir = makeTempBridgeRoot(tmpBase, "bridge");
    fs.writeFileSync(path.join(bridgeDir, "projects.json"), "{}", "utf8");
    const server = createBridgeServer({ bridgeRoot: bridgeDir, nodeId: "acl", authMode: "none" });
    await listenOn(server);
    try {
      assertAclOwnerOnly(path.join(bridgeDir, "identity.json"));
      assertAclOwnerOnly(path.join(bridgeDir, "settings.json"));
    } finally {
      server.close();
    }
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});
