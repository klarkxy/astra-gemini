import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "./api";
import type { PageId, RemoteStatus, StatusResponse } from "./types";

interface StatusCtx {
  status: StatusResponse | null;
  remote: RemoteStatus | null;
  error: string | null;
  locked: boolean;
  refresh: () => Promise<void>;
}

const Ctx = createContext<StatusCtx | null>(null);

export function StatusProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [remote, setRemote] = useState<RemoteStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [locked, setLocked] = useState(false);

  const refresh = useCallback(async () => {
    const [s, r] = await Promise.all([api.status(), api.remote()]);
    const code = (s as (StatusResponse & { code?: string }) | null)?.code;
    if (code === "admin_auth_required" || code === "admin_locked") {
      setLocked(true);
      setError(s?.error || "需要管理密钥");
    } else if (s?.ok) {
      setStatus(s);
      setError(null);
      setLocked(false);
    } else {
      setError(s?.error || "状态获取失败");
    }
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

  return <Ctx.Provider value={{ status, remote, error, locked, refresh }}>{children}</Ctx.Provider>;
}

export function useStatus(): StatusCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("useStatus must be used inside StatusProvider");
  return c;
}

const PAGES: PageId[] = ["overview", "connect", "sdks", "projects", "tree", "backups", "env"];

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
