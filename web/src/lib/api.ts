import type {
  EnvItem,
  OauthClient,
  RemoteStatus,
  StatusResponse
} from "./types";

export type ApiResult = { ok?: boolean; error?: string } & Record<string, unknown>;

const ADMIN_KEY_STORAGE = "astra-admin-key";

const hashKey = /^#k=([^&]+)/.exec(window.location.hash || "");
if (hashKey) {
  try {
    sessionStorage.setItem(ADMIN_KEY_STORAGE, hashKey[1]);
  } catch {
    // ignore
  }
  history.replaceState(null, "", window.location.pathname + window.location.search);
}

export function getAdminKey(): string {
  try {
    return sessionStorage.getItem(ADMIN_KEY_STORAGE) || "";
  } catch {
    return "";
  }
}

export function setAdminKey(key: string) {
  try {
    sessionStorage.setItem(ADMIN_KEY_STORAGE, key);
  } catch {
    // ignore
  }
}

async function req<T>(method: string, url: string, body?: unknown): Promise<T> {
  const adminKey = getAdminKey();
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: {
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(adminKey ? { "X-Astra-Admin": adminKey } : {})
      },
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
  } catch {
    return { ok: false, error: "无法连接服务" } as T;
  }
  const data = (await res.json().catch(() => null)) as ({ ok?: boolean; error?: string } & Record<string, unknown>) | null;
  if (data == null) return { ok: false, error: `HTTP ${res.status}` } as T;
  if (!res.ok) return { ...data, ok: false, error: data.error || `HTTP ${res.status}` } as T;
  return data as T;
}

export const api = {
  status: () => req<StatusResponse>("GET", "/api/status"),
  env: () => req<{ ok: boolean; env: Record<string, EnvItem> }>("GET", "/api/env"),
  oauth: () => req<{ ok: boolean; clients?: OauthClient[] }>("GET", "/api/oauth"),
  remote: () => req<RemoteStatus>("GET", "/api/remote"),
  toggleSdk: (name: string, enabled: boolean) =>
    req<ApiResult>("POST", "/api/sdks/toggle", { name, enabled }),
  saveProject: (body: {
    project: string;
    root: string;
    mode: string;
    description: string;
    sdks: string[];
  }) => req<ApiResult>("POST", "/api/projects", body),
  removeProject: (id: string) =>
    req<ApiResult>("DELETE", `/api/projects/${encodeURIComponent(id)}`),
  saveUpstream: (body: { nodeId: string; enabled: boolean; url: string; token: string }) =>
    req<ApiResult>("POST", "/api/tree/upstream", body),
  removeChild: (nodeId: string) =>
    req<ApiResult>("DELETE", `/api/tree/children/${encodeURIComponent(nodeId)}`),
  rollback: (project: string, backupId: string) =>
    req<ApiResult>("POST", "/api/backups/rollback", { project, backupId }),
  tunnelStart: () => req<ApiResult>("POST", "/api/tunnel/start"),
  tunnelStop: () => req<ApiResult>("POST", "/api/tunnel/stop"),
  saveTunnelConfig: (body: { mode: string; publicUrl: string; token?: string }) =>
    req<ApiResult>("POST", "/api/tunnel/config", body),
  saveSettings: (body: Record<string, unknown>) =>
    req<ApiResult>("POST", "/api/settings", body),
  revokeAllOauth: () => req<ApiResult>("POST", "/api/oauth/revoke-all", {}),
  saveRendezvous: (body: { enabled: boolean; url: string; token?: string }) =>
    req<ApiResult>("POST", "/api/rendezvous", body),
  saveRemoteAlias: (alias: string, address: string | null) =>
    req<ApiResult>("POST", "/api/remote/aliases", { alias, address }),
  saveAllow: (addresses: string[]) =>
    req<ApiResult>("POST", "/api/remote/allow", { addresses })
};
