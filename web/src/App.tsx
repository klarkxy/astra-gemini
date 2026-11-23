import { useEffect, useState, type ReactNode } from "react";
import { AnimatePresence, motion, MotionConfig } from "motion/react";
import { Lock, Sparkle } from "lucide-react";
import { cn, fmtUptime } from "@/lib/utils";
import { api, setAdminKey } from "@/lib/api";
import { pageFromHash, StatusProvider, useStatus } from "@/lib/status";
import type { PageId } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { OverviewPage } from "@/pages/OverviewPage";
import { ConnectPage } from "@/pages/ConnectPage";
import { SdksPage } from "@/pages/SdksPage";
import { ProjectsPage } from "@/pages/ProjectsPage";
import { TreePage } from "@/pages/TreePage";
import { BackupsPage } from "@/pages/BackupsPage";
import { EnvPage } from "@/pages/EnvPage";

const NAV: { id: PageId; label: string }[] = [
  { id: "overview", label: "概览" },
  { id: "connect", label: "接入客户端" },
  { id: "sdks", label: "SDK 能力" },
  { id: "projects", label: "本地项目" },
  { id: "tree", label: "星图组网" },
  { id: "backups", label: "备份回滚" },
  { id: "env", label: "自检与日志" }
];

const PAGE_SPRING = { type: "spring", stiffness: 500, damping: 42 } as const;

function NavItem({ item, active, onClick }: { item: { id: PageId; label: string }; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={cn(
        "relative whitespace-nowrap px-4 py-2.5 text-left text-sm transition-colors",
        "border-transparent min-[821px]:border-l-2 min-[821px]:py-2 min-[821px]:pl-[18px]",
        "max-[820px]:border-b-2",
        active ? "text-foreground font-semibold" : "text-muted-foreground hover:text-foreground"
      )}
    >
      {active && (
        <motion.span
          layoutId="nav-indicator"
          transition={PAGE_SPRING}
          className={cn(
            "bg-primary absolute",
            "min-[821px]:inset-y-0 min-[821px]:left-0 min-[821px]:w-0.5",
            "max-[820px]:inset-x-0 max-[820px]:bottom-0 max-[820px]:h-0.5"
          )}
        />
      )}
      {item.label}
    </button>
  );
}

function SideStatus() {
  const { status, error, refresh } = useStatus();
  return (
    <div
      className={cn(
        "border-border flex text-xs text-muted-foreground",
        "min-[821px]:mt-auto min-[821px]:flex-col min-[821px]:gap-1 min-[821px]:border-t min-[821px]:px-5 min-[821px]:py-4",
        "max-[820px]:ml-auto max-[820px]:items-center max-[820px]:gap-3 max-[820px]:border-l max-[820px]:px-4 max-[820px]:whitespace-nowrap"
      )}
    >
      {error ? (
        <span className="text-destructive inline-flex items-center gap-2 font-semibold" title={error}>
          <span className="bg-destructive size-2 rounded-full" />
          连接中断
        </span>
      ) : (
        <span className="text-foreground inline-flex items-center gap-2 font-semibold">
          <span className="live-dot bg-live size-2 rounded-full" />
          运行中
        </span>
      )}
      <span className="whitespace-nowrap">节点 {status?.tree?.nodeId || "-"}</span>
      <span className="font-display whitespace-nowrap">{status ? fmtUptime(status.uptimeSec) : ""}</span>
      <Button variant="outline" size="sm" className="min-[821px]:mt-2 min-[821px]:self-start" onClick={() => refresh()}>
        刷新状态
      </Button>
    </div>
  );
}

function Shell({ page, go }: { page: PageId; go: (p: PageId) => void }) {
  const pages: Record<PageId, ReactNode> = {
    overview: <OverviewPage go={go} />,
    connect: <ConnectPage />,
    sdks: <SdksPage />,
    projects: <ProjectsPage />,
    tree: <TreePage />,
    backups: <BackupsPage />,
    env: <EnvPage />
  };
  return (
    <div className="flex min-h-screen max-[820px]:flex-col">
      <aside
        className={cn(
          "bg-card border-border w-full shrink-0 min-[821px]:w-56",
          "min-[821px]:sticky min-[821px]:top-0 min-[821px]:flex min-[821px]:h-screen min-[821px]:flex-col min-[821px]:border-r"
        )}
      >
        <div className="flex items-center gap-2.5 px-5 pb-4 pt-5 max-[820px]:px-4 max-[820px]:pb-2 max-[820px]:pt-3.5">
          <Sparkle className="text-primary size-5" />
          <div>
            <div className="font-display text-lg font-semibold leading-tight max-[820px]:text-base">Astra Gemini</div>
            <div className="text-muted-foreground text-xs">星空双子座</div>
          </div>
        </div>
        <div className="flex min-h-0 flex-1 flex-col max-[820px]:flex-row max-[820px]:items-stretch max-[820px]:overflow-x-auto">
          <nav className="flex flex-col py-1.5 max-[820px]:flex-row max-[820px]:px-1 max-[820px]:py-0" aria-label="控制台分区">
            {NAV.map((item) => (
              <NavItem key={item.id} item={item} active={page === item.id} onClick={() => go(item.id)} />
            ))}
          </nav>
          <SideStatus />
        </div>
      </aside>
      <main className="min-w-0 flex-1 px-8 pb-20 max-[820px]:px-4 max-[820px]:pb-16">
        <div className="max-w-[960px]">
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={page}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.18, ease: "easeOut" }}
            >
              {pages[page]}
            </motion.div>
          </AnimatePresence>
        </div>
      </main>
    </div>
  );
}

function LockedScreen() {
  const { refresh, error } = useStatus();
  const [key, setKey] = useState("");
  const [remember, setRemember] = useState(false);
  const [failed, setFailed] = useState("");
  async function unlock() {
    const k = key.trim();
    if (!k) return;
    setAdminKey(k, remember);
    setKey("");
    const s = await api.status();
    setFailed(s?.ok ? "" : s?.error || "密钥不正确或服务不可用。");
    void refresh();
  }
  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="flex items-center gap-2.5 pb-2">
          <Lock className="text-primary size-5" />
          <h2 className="font-display m-0 text-xl font-semibold">控制台已锁定</h2>
        </div>
        <p className="text-muted-foreground m-0 text-[13px]">
          需要管理密钥：粘贴 admin-key.txt 中的密钥（Docker 部署在 /data/admin-key.txt）。
        </p>
        <div className="mt-4 flex gap-2">
          <Input
            type="password"
            value={key}
            placeholder="粘贴管理密钥"
            onChange={(e) => {
              setKey(e.target.value);
              setFailed("");
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") void unlock();
            }}
          />
          <Button onClick={() => void unlock()}>解锁</Button>
        </div>
        <label className="text-muted-foreground mt-3 flex items-center gap-2 text-xs">
          <Checkbox checked={remember} onCheckedChange={(v) => setRemember(v === true)} />
          在此设备记住
        </label>
        {failed ? (
          <p className="text-destructive m-0 mt-2 text-xs">{failed}</p>
        ) : error && !error.startsWith("需要管理密钥") ? (
          <p className="text-destructive m-0 mt-2 text-xs">{error}</p>
        ) : null}
      </div>
    </div>
  );
}

function AuthedShell({ page, go }: { page: PageId; go: (p: PageId) => void }) {
  const { locked } = useStatus();
  return locked ? <LockedScreen /> : <Shell page={page} go={go} />;
}

export default function App() {
  const [page, setPage] = useState<PageId>(() => pageFromHash(window.location.hash));

  useEffect(() => {
    const onHash = () => setPage(pageFromHash(window.location.hash));
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const go = (p: PageId) => {
    if (p !== page) window.location.hash = p;
  };

  return (
    <MotionConfig reducedMotion="user">
      <StatusProvider>
        <TooltipProvider>
          <AuthedShell page={page} go={go} />
          <Toaster position="bottom-right" />
        </TooltipProvider>
      </StatusProvider>
    </MotionConfig>
  );
}
