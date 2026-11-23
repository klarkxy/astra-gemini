import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { adminClients, authorize } from "./consent";
import { proxyMcp } from "./proxy";
import { isGoogleRedirectUris, type Env } from "./util";

const providers = new Map<string, OAuthProvider<Env>>();

// workers.dev 域名在构建期未知，按请求 origin（或 PUBLIC_ORIGIN 覆盖）懒建并缓存。
function providerFor(origin: string): OAuthProvider<Env> {
  let provider = providers.get(origin);
  if (!provider) {
    provider = new OAuthProvider<Env>({
      apiRoute: "/mcp",
      apiHandler: { fetch: (request, env) => proxyMcp(request, env) },
      defaultHandler: {
        fetch(request, env) {
          const { pathname } = new URL(request.url);
          if (pathname === "/authorize") return authorize(request, env);
          if (pathname === "/admin/clients") return adminClients(request, env);
          return Promise.resolve(new Response("Not Found", { status: 404 }));
        },
      },
      authorizeEndpoint: "/authorize",
      tokenEndpoint: "/oauth/token",
      clientRegistrationEndpoint: "/oauth/register",
      scopesSupported: ["mcp"],
      requiredScopes: ["mcp"],
      resourceMetadata: { resource: `${origin}/mcp`, authorization_servers: [origin] },
      clientIdMetadataDocumentEnabled: false,
      accessTokenTTL: 3600,
      refreshTokenIdleTTL: 90 * 24 * 3600,
      clientRegistrationCallback: ({ clientMetadata }) =>
        isGoogleRedirectUris(clientMetadata.redirect_uris)
          ? undefined
          : { code: "access_denied", description: "Only Gemini (Google OAuth relay) clients may register.", status: 403 },
      onError: ({ code, status, internal }) => {
        console.warn(JSON.stringify({
          oauthError: code,
          status,
          category: internal?.category,
          reason: internal?.reason,
          detail: internal?.detail === undefined ? undefined : String(internal.detail),
        }));
      },
    });
    providers.set(origin, provider);
  }
  return provider;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    let status = 500;
    try {
      const origin = env.PUBLIC_ORIGIN || url.origin;
      const response = await providerFor(origin).fetch(request, env, ctx);
      status = response.status;
      return response;
    } finally {
      console.log(JSON.stringify({
        m: request.method,
        p: url.pathname,
        s: status,
        ua: (request.headers.get("user-agent") ?? "").slice(0, 60),
      }));
    }
  },
} satisfies ExportedHandler<Env>;
