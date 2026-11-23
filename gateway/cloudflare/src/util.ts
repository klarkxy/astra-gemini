import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

export interface Env {
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
  ACCESS_PASSWORD: string;
  UPSTREAM_TOKEN: string;
  UPSTREAM_MCP_URL: string;
  PUBLIC_ORIGIN?: string;
}

export const escapeHtml = (v: string) => v.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export const HTML = { "Content-Type": "text/html; charset=utf-8" };

const GOOGLE_RELAY_HOSTS = new Set([
  "oauth-redirect.googleusercontent.com",
  "oauth-redirect-sandbox.googleusercontent.com",
  "oauth-redirect-test.googleusercontent.com",
]);

export function isGoogleRedirectUris(value: unknown): value is string[] {
  if (!Array.isArray(value) || value.length === 0) return false;
  return value.every((uri) => {
    if (typeof uri !== "string") return false;
    try {
      const url = new URL(uri);
      return url.protocol === "https:" && !url.username && !url.password && !url.hash
        && GOOGLE_RELAY_HOSTS.has(url.hostname)
        && (url.pathname.startsWith("/r/") || url.pathname.startsWith("/a/"));
    } catch {
      return false;
    }
  });
}

async function sha256(s: string) {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
}

export async function sameSecret(a: string, b: string): Promise<boolean> {
  const [ha, hb] = await Promise.all([sha256(a), sha256(b)]);
  return crypto.subtle.timingSafeEqual(ha, hb);
}

const LOCK_KEY = "pwfail";
const LOCK_LIMIT = 10;
const LOCK_TTL = 600;

export async function pwLocked(env: Env): Promise<boolean> {
  return (Number(await env.OAUTH_KV.get(LOCK_KEY)) || 0) >= LOCK_LIMIT;
}

export async function recordPwFailure(env: Env): Promise<void> {
  const n = Number(await env.OAUTH_KV.get(LOCK_KEY)) || 0;
  await env.OAUTH_KV.put(LOCK_KEY, String(n + 1), { expirationTtl: LOCK_TTL });
}

export async function clearPwFailures(env: Env): Promise<void> {
  await env.OAUTH_KV.delete(LOCK_KEY);
}

// 去掉 CSP 里的 form-action：Google 回调中继会二次跳转，带该指令的页面在 Chrome 下会被拦。
export function stripFormAction(headers: Headers): void {
  const csp = headers.get("Content-Security-Policy");
  if (!csp || !/form-action/i.test(csp)) return;
  const kept = csp.split(";").map((d) => d.trim()).filter((d) => d && !/^form-action/i.test(d));
  if (kept.length) headers.set("Content-Security-Policy", kept.join("; "));
  else headers.delete("Content-Security-Policy");
}
