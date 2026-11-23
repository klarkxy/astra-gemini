import { AuthorizationError, CimdFetchError, type ConsentDescription } from "@cloudflare/workers-oauth-provider";
import { clearPwFailures, escapeHtml, HTML, isGoogleRedirectUris, pwLocked, recordPwFailure, sameSecret, stripFormAction, type Env } from "./util";

export async function authorize(request: Request, env: Env): Promise<Response> {
  try {
    if (request.method === "GET") return await showConsent(request, env);
    if (request.method === "POST") return await submitConsent(request, env);
    return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, POST" } });
  } catch (error) {
    if (error instanceof AuthorizationError && error.redirectTo) return Response.redirect(error.redirectTo, 302);
    if (error instanceof AuthorizationError || error instanceof CimdFetchError) {
      const message = error instanceof AuthorizationError ? error.description : "无法验证该应用：客户端元数据获取失败。";
      return new Response(escapeHtml(message), { status: 400, headers: { "Content-Type": "text/plain; charset=utf-8" } });
    }
    throw error;
  }
}

function consentPage(details: ConsentDescription, handle: string, returnTo: string): string {
  const name = escapeHtml(details.clientName);
  const host = escapeHtml(details.redirectHost);
  const publisher = details.clientDomain
    ? `发布方：<strong>${escapeHtml(details.clientDomain)}</strong>。`
    : "该应用为自注册，名称未经核实。";
  const loopback = details.redirectIsLoopback
    ? `<p><strong>注意：授权结果将发送到你本机上的应用。</strong>仅当你刚从本机应用发起登录时才继续。</p>`
    : "";
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>授权 ${name}</title>
<style>body{font-family:system-ui,sans-serif;max-width:26em;margin:4em auto;padding:0 1em;line-height:1.6}input[type=password]{font-size:1em;padding:.4em;width:14em}button{font-size:1em;padding:.4em 1.2em;margin-right:.6em}</style></head>
<body>
<h1>允许 ${name} 访问？</h1>
<p>${publisher} 访问令牌将发送到 <strong>${host}</strong>。</p>
${loopback}<form method="post">
<input type="hidden" name="handle" value="${escapeHtml(handle)}">
<input type="hidden" name="return" value="${escapeHtml(returnTo)}">
<p><label>访问口令：<input type="password" name="password" autocomplete="off" required></label></p>
<p><button type="submit" name="decision" value="approve">允许</button><button type="submit" name="decision" value="deny" formnovalidate>拒绝</button></p>
</form></body></html>`;
}

async function showConsent(request: Request, env: Env): Promise<Response> {
  const authRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request);
  const details = await env.OAUTH_PROVIDER.describeConsent(authRequest);
  const consent = await env.OAUTH_PROVIDER.beginConsent(authRequest);
  stripFormAction(consent.headers);
  consent.headers.set("Content-Type", "text/html; charset=utf-8");
  const url = new URL(request.url);
  return new Response(consentPage(details, consent.handle, url.pathname + url.search), { headers: consent.headers });
}

function htmlPage(status: number, body: string): Response {
  return new Response(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${status}</title></head><body>${body}</body></html>`, { status, headers: HTML });
}

async function submitConsent(request: Request, env: Env): Promise<Response> {
  const form = await request.formData();
  const handle = String(form.get("handle") ?? "");
  const returnTo = String(form.get("return") ?? "");
  if (form.get("decision") !== "approve") {
    const denied = await env.OAUTH_PROVIDER.denyConsent(request, handle);
    return new Response(null, { status: 302, headers: denied.headers });
  }
  if (await pwLocked(env)) return htmlPage(429, `<h1>失败次数过多</h1><p>口令连续错误，请 10 分钟后再试。</p>`);
  const password = String(form.get("password") ?? "");
  if (!(await sameSecret(password, env.ACCESS_PASSWORD))) {
    await recordPwFailure(env);
    const retry = returnTo.startsWith("/authorize?") ? `<p><a href="${escapeHtml(returnTo)}">返回重试</a></p>` : "";
    return htmlPage(401, `<h1>口令错误</h1>${retry}`);
  }
  await clearPwFailures(env);
  const approved = await env.OAUTH_PROVIDER.approveConsent(request, handle, { scope: ["mcp"] });
  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: approved.request,
    userId: "owner",
    metadata: {},
    scope: ["mcp"],
    props: {},
  });
  approved.headers.set("Location", redirectTo);
  return new Response(null, { status: 302, headers: approved.headers });
}

// POST /admin/clients —— 口令预注册客户端（Gemini「高级」手动凭据通道）
export async function adminClients(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } });
  if (await pwLocked(env)) return new Response("Too Many Requests", { status: 429 });
  const token = /^Bearer[\t ]+(.+)$/i.exec(request.headers.get("Authorization") ?? "")?.[1] ?? "";
  if (!(await sameSecret(token, env.ACCESS_PASSWORD))) {
    await recordPwFailure(env);
    return new Response("Unauthorized", { status: 401 });
  }
  let body: { redirect_uris?: unknown; client_name?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }
  if (!isGoogleRedirectUris(body?.redirect_uris)) {
    return Response.json({ error: "invalid_redirect_uris", description: "Only Gemini (Google OAuth relay) redirect URIs are accepted." }, { status: 400 });
  }
  const client = await env.OAUTH_PROVIDER.createClient({
    redirectUris: body.redirect_uris,
    clientName: typeof body.client_name === "string" && body.client_name ? body.client_name : "Gemini",
    tokenEndpointAuthMethod: "client_secret_post",
  });
  return Response.json({ client_id: client.clientId, client_secret: client.clientSecret, redirect_uris: client.redirectUris }, { status: 201 });
}
