import type { ComponentType } from "react";
import {
  ArrowUpToLine,
  ChevronRight,
  FolderCode,
  History,
  Network,
  Puzzle
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useStatus } from "@/lib/status";
import type { PageId } from "@/lib/types";
import { Constellation } from "@/components/Constellation";
import { ConnInfo } from "@/components/ConnInfo";
import { Skeleton } from "@/components/ui/skeleton";

interface SummaryRow {
  icon: ComponentType<{ className?: string }>;
  text: string;
  warn?: boolean;
  page: PageId;
}

export function OverviewPage({ go }: { go: (p: PageId) => void }) {
  const { status } = useStatus();

  if (!status) {
    return (
      <>
        <Skeleton className="mt-3 h-[220px] w-full" />
        <div className="border-border grid grid-cols-[repeat(auto-fit,minmax(min(100%,280px),1fr))] gap-x-7 gap-y-4 border-b py-5">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-9" />
          ))}
        </div>
        <div className="flex flex-col gap-2 pt-5">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <Skeleton key={i} className="h-8" />
          ))}
        </div>
      </>
    );
  }

  const tree = status.tree || {};
  const children = tree.children || [];
  const online = children.filter((c) => c.online).length;
  const sdks = status.sdks || [];
  const enabled = sdks.filter((s) => s.enabled).length;
  const projects = status.projects || [];
  const missing = projects.filter((p) => p.exists === false).length;
  const up = tree.upstream || {};
  const upText = up.connected ? "已连接" : up.enabled ? "重连中" : "未配置（独立节点）";

  const rows: SummaryRow[] = [
    {
      icon: FolderCode,
      text: missing > 0 ? `本地项目 ${projects.length} 个，其中 ${missing} 个路径不存在` : `本地项目 ${projects.length} 个`,
      warn: missing > 0,
      page: "projects"
    },
    { icon: Puzzle, text: `SDK 已启用 ${enabled}/${sdks.length}`, page: "sdks" },
    { icon: Network, text: `子节点 在线 ${online}/${children.length}`, page: "tree" },
    { icon: ArrowUpToLine, text: `上游 ${upText}`, warn: !!up.enabled && !up.connected, page: "tree" },
    { icon: History, text: `备份 ${(status.backups || []).length} 份`, page: "backups" }
  ];

  return (
    <>
      <div className="pt-3">
        <Constellation tree={tree} height={220} />
      </div>
      <ConnInfo />
      <nav className="pt-2" aria-label="分区概览">
        {rows.map((r) => (
          <button
            key={r.page}
            onClick={() => go(r.page)}
            className="hover:text-foreground border-border flex w-full items-center gap-3 border-b py-3 text-left text-[13px] transition-colors last:border-b-0"
          >
            <r.icon className={cn("size-4 shrink-0", r.warn ? "text-warn" : "text-muted-foreground")} />
            <span className={cn("flex-1", r.warn ? "text-warn" : "text-muted-foreground")}>{r.text}</span>
            <ChevronRight className="text-muted-foreground size-4 shrink-0" />
          </button>
        ))}
      </nav>
    </>
  );
}
