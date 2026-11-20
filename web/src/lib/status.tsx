import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "./api";
import type { OauthClient, PageId, RemoteStatus, StatusResponse } from "./types";

interface StatusCtx {
  status: StatusResponse | null;
  remote: RemoteStatus | null;
  oauthClients: OauthClient[];
  error: string | null;
  refresh: () => Promise<void>;
}

const Ctx = createContext<StatusCtx | null>(null);

export function StatusProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [remote, setRemote] = useState<RemoteStatus | null>(null);
  const [oauthClients, setOauthClients] = useState<OauthClient[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [s, o, r] = await Promise.all([api.status(), api.oauth(), api.remote()]);
    if (s?.ok) {
      setStatus(s);
      setError(null);
    } else {
      setError(s?.error || "状态获取失败");
    }
    if (o?.ok) setOauthClients(o.clients || []);
    if (r && r.address) setRemote(r);
  }, []);

  useEffect(() => {
    void refresh();
    const iv = window.setInterval(() => {
      if (!document.hidden) void refresh();
    }, 5000);
    const onVis = () => {
      if (!document.hidden) void refresh();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.clearInterval(iv);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [refresh]);

  return <Ctx.Provider value={{ status, remote, oauthClients, error, refresh }}>{children}</Ctx.Provider>;
}

export function useStatus(): StatusCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("useStatus must be used inside StatusProvider");
  return c;
}

const PAGES: PageId[] = ["overview", "sdks", "projects", "tree", "backups", "env"];

export function pageFromHash(hash: string): PageId {
  const h = hash.replace(/^#/, "");
  return (PAGES as string[]).includes(h) ? (h as PageId) : "overview";
}

/** Seed a form once when source data first arrives (mirrors the old *FormInitialized flags). */
export function useSeeded(source: unknown, seed: () => void) {
  const done = useRef(false);
  useEffect(() => {
    if (!done.current && source) {
      seed();
      done.current = true;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source]);
}
