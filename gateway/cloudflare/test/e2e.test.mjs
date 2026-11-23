import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const BASE = "http://localhost:8787";
const UPSTREAM_PORT = 39491;
const ACCESS_PASSWORD = "test-pass";
const UPSTREAM_TOKEN = "test-token";
const STUB_RESULT = { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "astra-stub", version: "0.0.1" } };
const STUB_TOOLS = { tools: [{ name: "list_projects", description: "stub" }] };

const HERE = dirname(fileURLToPath(import.meta.url));
const WRANGLER = join(HERE, "..", "node_modules", "wrangler", "bin", "wrangler.js");
const LOG = join(HERE, "wrangler-dev.log");

const fetchOpts = (init = {}) => ({ redirect: "manual", ...init });

function cookiesFrom(res) {
  return res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
}
function field(html, name) {
  const m = html.match(new RegExp(`name="${name}" value="([^"]*)"`));
  return m ? m[1].replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))) : "";
}
const b64url = (buf) => buf.toString("base64url");
const verifier = b64url(randomBytes(48));
const challenge = b64url(createHash("sha256").update(verifier).digest());

const GOOGLE_HOSTS = ["oauth-redirect.googleusercontent.com", "oauth-redirect-sandbox.googleusercontent.com", "oauth-redirect-test.googleusercontent.com"];
const geminiUris = () => GOOGLE_HOSTS.flatMap((h) => [`https://${h}/r/user_bound_custom-mcp-1234567890-localhost_8787`, `https://${h}/a/user_bound_custom-mcp-1234567890-localhost_8787`]);

function makeState() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.~";
  let s = "";
  for (let i = 0; s.length < 2400; i++) {
    if (i % 97 === 31) s += "+";
    else if (i % 89 === 17) s += "/";
    else if (i % 83 === 7) s += "=";
    else s += chars[i % chars.length];
  }
  return s.slice(0, 2400);
}

async function startConsent(clientId, redirectUri, state) {
  const q = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    code_challenge: challenge,
    code_challenge_method: "S256",
    scope: "mcp",
    resource: `${BASE}/mcp`,
    state,
  });
  const res = await fetch(`${BASE}/authorize?${q}`, fetchOpts());
  return { res, html: await res.text(), url: `${BASE}/authorize?${q}` };
}

async function postConsent(body, cookie) {
  return fetch(`${BASE}/authorize`, fetchOpts({
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie },
    body: new URLSearchParams(body),
  }));
}

function killTree(child) {
  if (!child?.pid) return;
  try {
    if (process.platform === "win32") execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    else process.kill(-child.pid, "SIGKILL");
  } catch { /* already gone */ }
}

test("gateway e2e", { timeout: 300_000 }, async (t) => {
  const upstream = createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${UPSTREAM_TOKEN}`) {
      res.writeHead(401, { "content-type": "application/json" }).end('{"error":"bad token"}');
      return;
    }
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let msg;
      try { msg = JSON.parse(raw); } catch { res.writeHead(400).end(); return; }
      const headers = { "content-type": "application/json", "mcp-session-id": "stub-session-1" };
      if (msg.method === "initialize") res.writeHead(200, headers).end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: STUB_RESULT }));
      else if (msg.method === "tools/list") res.writeHead(200, headers).end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: STUB_TOOLS }));
      else if (String(msg.method).startsWith("notifications/")) res.writeHead(202).end();
      else res.writeHead(400).end();
    });
  });
  await new Promise((r) => upstream.listen(UPSTREAM_PORT, "127.0.0.1", r));

  const log = createWriteStream(LOG);
  const wrangler = spawn(process.execPath, [
    WRANGLER, "dev", "--port", "8787", "--ip", "127.0.0.1",
    "--var", `ACCESS_PASSWORD:${ACCESS_PASSWORD}`,
    "--var", `UPSTREAM_TOKEN:${UPSTREAM_TOKEN}`,
    "--var", `UPSTREAM_MCP_URL:http://127.0.0.1:${UPSTREAM_PORT}/mcp`,
    "--var", `PUBLIC_ORIGIN:${BASE}`,
  ], { stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32", env: { ...process.env, WRANGLER_SEND_METRICS: "false" } });
  wrangler.stdout.pipe(log);
  wrangler.stderr.pipe(log);

  let issuer;
  try {
    const deadline = Date.now() + 120_000;
    let ready = false, earlyExit = null;
    wrangler.once("exit", (c) => { earlyExit = c; });
    while (Date.now() < deadline) {
      if (earlyExit !== null) throw new Error(`wrangler exited early (${earlyExit}); see ${LOG}`);
      try {
        const r = await fetch(`${BASE}/.well-known/oauth-authorization-server`, { signal: AbortSignal.timeout(3000) });
        if (r.ok) { ready = true; issuer = (await r.json()).issuer; break; }
      } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 500));
    }
    if (!ready) throw new Error(`wrangler dev did not become ready; see ${LOG}`);
    t.diagnostic(`issuer = ${issuer}`);

    let clientId, clientSecret;
    const redirectUri = `https://oauth-redirect.googleusercontent.com/r/user_bound_custom-mcp-1234567890-localhost_8787`;
    const state = makeState();

    await t.test("1. /mcp unauthenticated -> 401 + resource_metadata", async () => {
      const res = await fetch(`${BASE}/mcp`, fetchOpts({ method: "POST", headers: { "content-type": "application/json" }, body: "{}" }));
      assert.equal(res.status, 401);
      const www = res.headers.get("www-authenticate") ?? "";
      const meta = www.match(/resource_metadata="([^"]+)"/)?.[1] ?? www.match(/resource_metadata=([^\s,]+)/)?.[1];
      assert.ok(meta, `WWW-Authenticate missing resource_metadata: ${www}`);
      const doc = await (await fetch(meta)).json();
      assert.equal(doc.resource, `${BASE}/mcp`);
    });

    await t.test("2. AS metadata", async () => {
      const res = await fetch(`${BASE}/.well-known/oauth-authorization-server`);
      assert.equal(res.status, 200);
      const md = await res.json();
      assert.ok(md.authorization_endpoint);
      assert.ok(md.token_endpoint);
      assert.ok(md.registration_endpoint);
      assert.ok(md.response_types_supported.includes("code"));
      assert.ok(md.code_challenge_methods_supported.includes("S256"));
      assert.equal(md.authorization_response_iss_parameter_supported, true);
    });

    await t.test("3. DCR: Gemini shape -> 201; evil/mixed -> 403", async () => {
      const res = await fetch(`${BASE}/oauth/register`, fetchOpts({
        method: "POST",
        headers: { "content-type": "application/json", "user-agent": "OpenAuth" },
        body: JSON.stringify({ redirect_uris: geminiUris(), token_endpoint_auth_method: "client_secret_post", client_name: "Gemini" }),
      }));
      const text = await res.text();
      assert.equal(res.status, 201, text);
      const body = JSON.parse(text);
      assert.ok(body.client_id);
      assert.ok(body.client_secret);
      clientId = body.client_id;
      clientSecret = body.client_secret;

      const evil = await fetch(`${BASE}/oauth/register`, fetchOpts({
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ redirect_uris: ["https://evil.example/cb"] }),
      }));
      assert.equal(evil.status, 403);

      const mixed = await fetch(`${BASE}/oauth/register`, fetchOpts({
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ redirect_uris: [...geminiUris().slice(0, 5), "https://evil.example/cb"] }),
      }));
      assert.equal(mixed.status, 403);
    });

    let handle, cookie;
    await t.test("4. GET /authorize -> 200 HTML, no form-action", async () => {
      const { res, html } = await startConsent(clientId, redirectUri, state);
      assert.equal(res.status, 200);
      const csp = res.headers.get("content-security-policy") ?? "";
      assert.doesNotMatch(csp, /form-action/i);
      t.diagnostic(`GET /authorize response headers:\n${[...res.headers.entries()].map(([k, v]) => `  ${k}: ${v}`).join("\n")}\n  set-cookie: ${res.headers.getSetCookie().join(" | ")}`);
      cookie = cookiesFrom(res);
      handle = field(html, "handle");
      assert.ok(handle, "handle not found in consent page");
      assert.ok(cookie.includes("__Host-"), "binding cookie not set");
    });

    await t.test("5. POST /authorize wrong password -> 401, no Location", async () => {
      const res = await postConsent({ handle, return: "/authorize?x=1", decision: "approve", password: "wrong" }, cookie);
      assert.equal(res.status, 401);
      assert.equal(res.headers.get("location"), null);
    });

    let code, accessToken, refreshToken;
    await t.test("6. POST /authorize correct password -> 302 + code/state/iss", async () => {
      const fresh = await startConsent(clientId, redirectUri, state);
      const h = field(fresh.html, "handle");
      const ret = field(fresh.html, "return");
      const res = await postConsent({ handle: h, return: ret, decision: "approve", password: ACCESS_PASSWORD }, cookiesFrom(fresh.res));
      assert.equal(res.status, 302);
      const loc = res.headers.get("location");
      assert.ok(loc?.startsWith(redirectUri), `Location ${loc} does not start with ${redirectUri}`);
      const target = new URL(loc);
      code = target.searchParams.get("code");
      assert.ok(code);
      assert.equal(target.searchParams.get("state"), state);
      assert.equal(target.searchParams.get("iss"), issuer);
    });

    await t.test("7. authorization_code exchange -> tokens", async () => {
      const res = await fetch(`${BASE}/oauth/token`, fetchOpts({
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code", client_id: clientId, client_secret: clientSecret,
          code, code_verifier: verifier, redirect_uri: redirectUri, resource: `${BASE}/mcp`,
        }),
      }));
      const text = await res.text();
      assert.equal(res.status, 200, text);
      const body = JSON.parse(text);
      assert.ok(body.access_token);
      assert.ok(body.refresh_token);
      assert.match(body.token_type, /bearer/i);
      accessToken = body.access_token;
      refreshToken = body.refresh_token;
    });

    const mcp = (body, token = accessToken) => fetch(`${BASE}/mcp`, fetchOpts({
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    }));

    await t.test("8. /mcp proxied with access token; GET -> 405", async () => {
      const init = await mcp({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
      assert.equal(init.status, 200);
      assert.deepEqual((await init.json()).result, STUB_RESULT);
      const tools = await mcp({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
      assert.equal(tools.status, 200);
      assert.deepEqual((await tools.json()).result, STUB_TOOLS);
      const notif = await mcp({ jsonrpc: "2.0", method: "notifications/initialized" });
      assert.equal(notif.status, 202);
      const get = await fetch(`${BASE}/mcp`, fetchOpts({ headers: { authorization: `Bearer ${accessToken}` } }));
      assert.equal(get.status, 405);
    });

    await t.test("9. refresh_token grant -> new working access token", async () => {
      const res = await fetch(`${BASE}/oauth/token`, fetchOpts({
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "refresh_token", client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken }),
      }));
      const text = await res.text();
      assert.equal(res.status, 200, text);
      const body = JSON.parse(text);
      const via = await mcp({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} }, body.access_token);
      assert.equal(via.status, 200);
    });

    await t.test("10. deny -> 302 access_denied + state", async () => {
      const fresh = await startConsent(clientId, redirectUri, state);
      const res = await postConsent({ handle: field(fresh.html, "handle"), return: "", decision: "deny" }, cookiesFrom(fresh.res));
      assert.equal(res.status, 302);
      const target = new URL(res.headers.get("location"));
      assert.equal(target.searchParams.get("error"), "access_denied");
      assert.equal(target.searchParams.get("state"), state);
    });

    await t.test("11. /admin/clients", async () => {
      const noAuth = await fetch(`${BASE}/admin/clients`, fetchOpts({
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ redirect_uris: [redirectUri] }),
      }));
      assert.equal(noAuth.status, 401);
      const created = await fetch(`${BASE}/admin/clients`, fetchOpts({
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${ACCESS_PASSWORD}` },
        body: JSON.stringify({ redirect_uris: [redirectUri], client_name: "Gemini-manual" }),
      }));
      const createdText = await created.text();
      assert.equal(created.status, 201, createdText);
      const client = JSON.parse(createdText);
      assert.ok(client.client_id);
      assert.ok(client.client_secret);
      const consent = await startConsent(client.client_id, redirectUri, "s");
      assert.equal(consent.res.status, 200);
    });
  } finally {
    killTree(wrangler);
    upstream.close();
    log.end();
    await new Promise((r) => setTimeout(r, 500));
  }
});
