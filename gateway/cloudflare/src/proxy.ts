import type { Env } from "./util";

const FORWARD_HEADERS = ["content-type", "mcp-protocol-version", "mcp-session-id"];
const RETURN_HEADERS = ["content-type", "mcp-session-id"];

export async function proxyMcp(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } });
  const headers = new Headers();
  for (const name of FORWARD_HEADERS) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  if (!headers.has("accept")) headers.set("Accept", "application/json, text/event-stream");
  headers.set("Authorization", `Bearer ${env.UPSTREAM_TOKEN}`);
  let upstream: Response;
  try {
    upstream = await fetch(env.UPSTREAM_MCP_URL, { method: "POST", headers, body: request.body });
  } catch {
    return Response.json({ error: "upstream_unreachable" }, { status: 502 });
  }
  if (upstream.status === 401 || upstream.status === 403) {
    return Response.json({ error: "upstream_auth_failed" }, { status: 502 });
  }
  const out = new Headers();
  for (const name of RETURN_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) out.set(name, value);
  }
  return new Response(upstream.body, { status: upstream.status, headers: out });
}
