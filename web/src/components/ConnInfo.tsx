import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { useStatus, useSeeded } from "@/lib/status";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { CopyButton, FieldRow, MaskedValue, MonoBox } from "./bits";

export function ConnInfo() {
  const { status, refresh } = useStatus();
  const [showToken, setShowToken] = useState(false);
  const [cfgOpen, setCfgOpen] = useState(false);
  const [mode, setMode] = useState("quick");
  const [tnToken, setTnToken] = useState("");
  const [tnPublicUrl, setTnPublicUrl] = useState("");

  useSeeded(status?.settings, () => {
    const tn = status?.settings?.tunnel || {};
    setMode(tn.mode || "quick");
    setTnPublicUrl(tn.publicUrl || "");
  });

  if (!status) {
    return (
      <div className="border-border grid grid-cols-[repeat(auto-fit,minmax(min(100%,280px),1fr))] gap-x-7 gap-y-4 border-b pb-5 pt-3">
        {[0, 1, 2].map((i) => (
          <div key={i}>
            <Skeleton className="mb-1.5 h-3 w-24" />
            <Skeleton className="h-8" />
          </div>
        ))}
      </div>
    );
  }

  const t = status.tunnel || {};
  const publicMcp = status.publicMcpUrl || "";
  const tunnelText = t.running
    ? t.mcpUrl || "正在获取公网地址，请稍等几秒..."
    : t.lastError
      ? `失败: ${t.lastError}`
      : "未启动（需要电脑已装 cloudflared）";
  const hasToken = !!status.settings?.tunnel?.hasToken;

  async function toggleTunnel() {
    const res = t.running ? await api.tunnelStop() : await api.tunnelStart();
    toast(res.ok ? (t.running ? "隧道已停止" : "正在启动隧道，请稍等 3 秒...") : res.error || "操作失败");
    window.setTimeout(refresh, 2500);
  }

  async function saveConfig() {
    const body: { mode: string; publicUrl: string; token?: string } = {
      mode,
      publicUrl: tnPublicUrl.trim()
    };
    const tk = tnToken.trim();
    if (tk) body.token = tk;
    const res = await api.saveTunnelConfig(body);
    if (res.ok) {
      setTnToken("");
      toast("隧道配置已保存");
      refresh();
    } else {
      toast(res.error || "保存失败");
    }
  }

  return (
    <div className="border-border grid grid-cols-[repeat(auto-fit,minmax(min(100%,280px),1fr))] gap-x-7 gap-y-4 border-b pb-5 pt-3">
      <FieldRow label={publicMcp ? "公网 MCP 地址" : "MCP 地址（AI 客户端连接入口）"}>
        <MonoBox>{publicMcp || status.localMcpUrl}</MonoBox>
        <CopyButton text={publicMcp || status.localMcpUrl} message="已复制 MCP 地址" />
      </FieldRow>

      <FieldRow label="客户端 Token">
        <MaskedValue
          visible={showToken}
          onToggle={() => setShowToken((v) => !v)}
          value={status.authMode === "none" ? undefined : status.authToken}
          emptyText="未开启鉴权 (none)"
          copyMessage="已复制客户端 Token"
        />
      </FieldRow>

      {!publicMcp && (
      <div>
        <FieldRow label="公网隧道（Cloudflare Tunnel）">
          <MonoBox title={tunnelText}>{tunnelText}</MonoBox>
          <Button
            size="sm"
            variant={t.running ? "destructive" : "default"}
            onClick={toggleTunnel}
          >
            {t.running ? "停止隧道" : "一键启动"}
          </Button>
          {t.running && t.mcpUrl && (
            <CopyButton text={t.mcpUrl} message="已复制公网 MCP 地址" />
          )}
        </FieldRow>
        <Collapsible open={cfgOpen} onOpenChange={setCfgOpen} className="mt-2">
          <CollapsibleTrigger className="group text-muted-foreground hover:text-foreground flex items-center gap-1 text-xs">
            <ChevronRight className="size-3.5 transition-transform group-data-[state=open]:rotate-90" />
            隧道设置
          </CollapsibleTrigger>
          <CollapsibleContent className="data-[state=open]:animate-collapsible-down data-[state=closed]:animate-collapsible-up overflow-hidden">
            <div className="mt-2 flex flex-wrap gap-2">
              <Select value={mode} onValueChange={setMode}>
                <SelectTrigger size="sm" className="w-auto min-w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="quick">临时隧道（随机域名）</SelectItem>
                    <SelectItem value="named">命名隧道（固定域名）</SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
              <Input
                type="password"
                value={tnToken}
                onChange={(e) => setTnToken(e.target.value)}
                placeholder={hasToken ? "Token 已保存（粘贴新 Token 可覆盖）" : "Tunnel Token（命名隧道）"}
                aria-label="Tunnel Token"
                className={cn("h-8 min-w-32 flex-1 text-[13px]")}
              />
              <Input
                type="text"
                value={tnPublicUrl}
                onChange={(e) => setTnPublicUrl(e.target.value)}
                placeholder="固定域名 https://…"
                aria-label="固定域名"
                className="h-8 min-w-36 flex-1 text-[13px]"
              />
              <Button variant="outline" size="sm" onClick={saveConfig}>
                保存
              </Button>
            </div>
          </CollapsibleContent>
        </Collapsible>
      </div>
      )}
    </div>
  );
}
