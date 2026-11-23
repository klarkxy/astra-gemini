// Usage: node verify.mjs <mcpUrl> <token> <project>
// e.g.   node verify.mjs http://127.0.0.1:3939/mcp $ASTRA_TOKEN demo

const [mcpUrl, token, project] = process.argv.slice(2);
if (!mcpUrl || !token || !project) {
  console.error("usage: node verify.mjs <mcpUrl> <token> <project>");
  process.exit(2);
}

let nextId = 0;

async function rpc(method, params) {
  const id = ++nextId;
  const res = await fetch(mcpUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params })
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${method} failed: HTTP ${res.status} ${text.slice(0, 300)}`);
  }
  const msg = JSON.parse(text);
  if (msg.error) {
    throw new Error(`${method} failed: ${msg.error.message || JSON.stringify(msg.error)}`);
  }
  return msg.result;
}

async function callTool(name, args) {
  const result = await rpc("tools/call", { name, arguments: args });
  if (result?.structuredContent !== undefined) return result.structuredContent;
  const text = result?.content?.find((c) => c.type === "text")?.text;
  if (text) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return result;
}

const init = await rpc("initialize", {
  protocolVersion: "2025-03-26",
  capabilities: {},
  clientInfo: { name: "astra-docker-verify", version: "0.1.0" }
});
console.log(`initialize ok: ${init?.serverInfo?.name} ${init?.serverInfo?.version}`);

await fetch(mcpUrl, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    Authorization: `Bearer ${token}`
  },
  body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })
});

const tools = await rpc("tools/list");
console.log(`tools/list ok: ${(tools?.tools || []).map((t) => t.name).join(", ")}`);

const projects = await callTool("list_projects");
const names = (Array.isArray(projects) ? projects : []).map((p) => p.project);
console.log(`list_projects: ${names.join(", ") || "(empty)"}`);
if (!names.includes(project)) {
  console.error(`FAIL: project "${project}" not in list_projects`);
  process.exit(1);
}

const execRes = await callTool("exec_verify", {
  project,
  script: 'const r = await sdk.npm.run("build"); return r;',
  timeoutMs: 60000
});

if (!execRes?.ok) {
  console.error(`FAIL: exec_verify error: ${execRes?.error || JSON.stringify(execRes)}`);
  process.exit(1);
}
const build = execRes.result;
if (!build?.ok) {
  console.error(`FAIL: npm run build exitCode=${build?.exitCode}\n${build?.tail || ""}`);
  process.exit(1);
}
console.log(`exec_verify ok in ${execRes.durationMs}ms (build exitCode=${build.exitCode}, manager=${build.manager})`);
console.log((build.tail || "").split("\n").filter((l) => l.trim()).slice(-3).join("\n"));
console.log("VERIFY PASS");
