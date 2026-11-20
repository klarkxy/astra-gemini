import { ChevronRight } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { useStatus } from "@/lib/status";
import type { SdkInfo } from "@/lib/types";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Switch } from "@/components/ui/switch";
import { PageHead, SkeletonRows, StatusTag } from "@/components/bits";

function SdkItem({ sdk, onToggle }: { sdk: SdkInfo; onToggle: (name: string, enabled: boolean) => void }) {
  const fns = Object.entries(sdk.functions || {});
  return (
    <div className="border-border flex items-start gap-4 border-t py-3.5 first:border-t-0">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2.5">
          <span className="font-display text-base font-semibold">{sdk.title || sdk.name}</span>
          <StatusTag>{sdk.category || "dev"}</StatusTag>
          <code className="text-muted-foreground font-mono text-xs">{sdk.name}</code>
        </div>
        {sdk.description && (
          <p className="text-muted-foreground mb-0 mt-1 text-[13px]">{sdk.description}</p>
        )}
        <Collapsible className="mt-2">
          <CollapsibleTrigger className="group text-primary flex items-center gap-1 text-xs">
            <ChevronRight className="size-3.5 transition-transform group-data-[state=open]:rotate-90" />
            包含 {fns.length} 个函数
          </CollapsibleTrigger>
          <CollapsibleContent className="data-[state=open]:animate-collapsible-down data-[state=closed]:animate-collapsible-up overflow-hidden">
            <ul className="text-muted-foreground m-0 mt-2 list-none p-0 text-xs">
              {fns.map(([k, v]) => (
                <li key={k} className="border-border border-t border-dashed py-1.5">
                  <code className="text-foreground font-mono">{k}</code>
                  {"："}
                  {v.description || v.signature || ""}
                </li>
              ))}
            </ul>
          </CollapsibleContent>
        </Collapsible>
      </div>
      <Switch
        checked={sdk.enabled}
        onCheckedChange={(c) => onToggle(sdk.name, c)}
        aria-label={`开启或关闭 ${sdk.name}`}
      />
    </div>
  );
}

export function SdksPage() {
  const { status, refresh } = useStatus();
  if (!status) {
    return (
      <>
        <PageHead title="SDK 能力" sub="开关立即热生效，无需重启。关闭的 SDK 对 AI 不可见；把 .mjs 文件放进 sdks/global/ 后刷新即可上线。" />
        <SkeletonRows />
      </>
    );
  }
  const sdks = status.sdks || [];

  async function toggle(name: string, enabled: boolean) {
    const res = await api.toggleSdk(name, enabled);
    if (res.ok) {
      toast(`${name} 已${enabled ? "开启" : "关闭"}（已热生效）`);
      refresh();
    } else {
      toast(res.error || "切换失败");
    }
  }

  return (
    <>
      <PageHead title="SDK 能力" sub="开关立即热生效，无需重启。关闭的 SDK 对 AI 不可见；把 .mjs 文件放进 sdks/global/ 后刷新即可上线。" />
      <div className="pt-1">
        {!sdks.length ? (
          <Empty className="border-border border border-dashed">
            <EmptyHeader>
              <EmptyTitle>暂未发现 SDK</EmptyTitle>
              <EmptyDescription>请在 sdks/global/ 下放置 .mjs 文件。</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          sdks.map((s) => <SdkItem key={s.name} sdk={s} onToggle={toggle} />)
        )}
      </div>
    </>
  );
}
