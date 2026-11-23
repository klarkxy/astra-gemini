import { useState } from "react";
import { toast } from "sonner";
import { adminKeyRemembered, api, setAdminKey } from "@/lib/api";
import { useSeeded, useStatus } from "@/lib/status";
import type { GatewayCheckItem } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Block,
  ConfirmDialog,
  CopyButton,
  FieldRow,
  MaskedValue,
  MonoBox,
  PageHead,
  SkeletonRows
} from "@/components/bits";

const TOKEN_PH = "<客户端 Token>";

type SecretKind = "client" | "join" | "admin";

const SECRET_ROWS: { kind: SecretKind; label: string; impact: string }[] = [
  {
    kind: "client",
    label: "客户端 Token",
    impact: "已接入的代码工具和 Gemini 网关的 UPSTREAM_TOKEN 会失效；轮换后运行 node deploy/gateway.mjs --secrets-only 更新网关。"
  },
  {
    kind: "join",
    label: "加入 Token",
    impact: "已连接的子节点保持连接，新节点入网需使用新 Token。"
  },
  {
    kind: "admin",
    label: "管理密钥",
    impact: "其他浏览器需重新输入管理密钥。"
  }
];

export function ConnectPage() {
  const { status, refresh } = useStatus();
  const [showToken, setShowToken] = useState(false);
  const [rotating, setRotating] = useState<SecretKind | null>(null);
  const [gwUrl, setGwUrl] = useState("");
  const [gwChecks, setGwChecks] = useState<GatewayCheckItem[] | null>(null);
  const [gwBusy, setGwBusy] = useState(false);

  useSeeded(status?.settings, () => setGwUrl(status?.settings?.gatewayUrl || ""));

  if (!status) {
    return (
      <>
        <PageHead title="接入客户端" sub="代码工具直连 MCP；Gemini App 经 Cloudflare 网关接入。" />
        <SkeletonRows />
      </>
    );
  }

  const mcpUrl = status.publicMcpUrl || status.localMcpUrl;
  const claudeCmd = `claude mcp add --transport http astra ${mcpUrl} --header "Authorization: Bearer ${TOKEN_PH}"`;
  const mcpJson = JSON.stringify(
    {
      mcpServers: {
        astra: {
          url: mcpUrl,
          headers: { Authorization: `Bearer ${TOKEN_PH}` }
        }
      }
    },
    null,
    2
  );
  const gwBase = (status.settings?.gatewayUrl || "").trim().replace(/\/+$/, "");
  const rotatingRow = SECRET_ROWS.find((r) => r.kind === rotating);

  async function doRotate() {
    if (!rotating) return;
    const kind = rotating;
    setRotating(null);
    const res = await api.rotateSecret(kind);
    if (!res.ok) {
      toast(res.error || "轮换失败");
      return;
    }
    if (kind === "admin" && typeof res.value === "string" && res.value) {
      setAdminKey(res.value, adminKeyRemembered());
    }
    toast("已轮换并写入密钥文件");
    refresh();
  }

  async function saveGwUrl() {
    const res = await api.saveSettings({ gatewayUrl: gwUrl.trim() });
    toast(res.ok ? "网关地址已保存" : res.error || "保存失败");
    refresh();
  }

  async function runGwCheck() {
    setGwBusy(true);
    setGwChecks(null);
    const res = await api.checkGateway(gwUrl.trim() || undefined);
    setGwBusy(false);
    if (Array.isArray(res.checks)) {
      setGwChecks(res.checks);
      if (res.error) toast(res.error);
    } else {
      toast(res.error || "自检失败");
    }
  }

  return (
    <>
      <PageHead title="接入客户端" sub="代码工具直连 MCP；Gemini App 经 Cloudflare 网关接入。" />
      <Block title="直连 MCP（代码工具）">
        <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,280px),1fr))] gap-x-7 gap-y-4">
          <FieldRow label="MCP 地址">
            <MonoBox title={mcpUrl}>{mcpUrl}</MonoBox>
            <CopyButton text={mcpUrl} message="已复制 MCP 地址" />
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
        </div>
        <p className="text-muted-foreground mt-4 text-[13px]">
          请求头 <code className="font-mono">Authorization: Bearer {TOKEN_PH}</code>
        </p>
        <div className="mt-3 space-y-4">
          <FieldRow label="Claude Code">
            <MonoBox title={claudeCmd}>{claudeCmd}</MonoBox>
            <CopyButton text={claudeCmd} message="已复制 Claude Code 命令" />
          </FieldRow>
          <div>
            <div className="mb-1.5 flex items-center gap-2">
              <span className="text-muted-foreground text-xs">通用 mcp.json（Cursor 等）</span>
              <CopyButton text={mcpJson} message="已复制 mcp.json" className="h-6 px-2 text-xs" />
            </div>
            <pre className="bg-card border-border m-0 overflow-x-auto rounded-md border px-2.5 py-1.5 font-mono text-xs">
              {mcpJson}
            </pre>
          </div>
        </div>
      </Block>

      <Block title="密钥管理" sub="轮换后立即写入密钥文件并生效；仅当密钥来自密钥文件（非环境变量固定）时可轮换。">
        <div className="space-y-3.5">
          {SECRET_ROWS.map((row) => {
            const rotatable = Boolean(status.rotatable?.[row.kind]);
            return (
              <div key={row.kind} className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                <strong className="w-24 shrink-0 text-[13px]">{row.label}</strong>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!rotatable}
                  title={rotatable ? undefined : "由环境变量固定"}
                  onClick={() => setRotating(row.kind)}
                >
                  轮换
                </Button>
                <span className="text-muted-foreground min-w-0 flex-1 text-xs">
                  {rotatable ? row.impact : "由环境变量固定，修改环境变量后重启。"}
                </span>
              </div>
            );
          })}
        </div>
      </Block>

      <Block title="Gemini App（Cloudflare 网关）" sub="Worker 承担公网 OAuth，/mcp 校验令牌后用 UPSTREAM_TOKEN 转发到本节点。">
        <FieldRow label="网关地址">
          <Input
            value={gwUrl}
            onChange={(e) => setGwUrl(e.target.value)}
            placeholder="https://astra-gemini-gateway.<sub>.workers.dev"
            className="max-w-[420px] font-mono text-xs"
          />
          <Button variant="outline" size="sm" onClick={saveGwUrl}>保存</Button>
          <Button variant="outline" size="sm" disabled={gwBusy} onClick={runGwCheck}>
            {gwBusy ? "自检中…" : "自检"}
          </Button>
        </FieldRow>
        {gwChecks && (
          <ul className="m-0 mt-2.5 list-none space-y-1 p-0 text-xs">
            {gwChecks.map((c) => (
              <li key={c.name} className={c.ok ? "text-live" : "text-destructive"}>
                {c.ok ? "✓" : "✗"} {c.name}：{c.detail}
              </li>
            ))}
          </ul>
        )}
        {gwBase && (
          <div className="mt-3">
            <FieldRow label="在 Gemini「设置 → Connected Apps → Add custom app」填写">
              <MonoBox title={`${gwBase}/mcp`}>{gwBase}/mcp</MonoBox>
              <CopyButton text={`${gwBase}/mcp`} message="已复制 Gemini MCP 地址" />
            </FieldRow>
            <p className="text-muted-foreground mt-1.5 text-xs">
              Advanced 留空；授权页口令见本机 deploy/local.json 的 gateway.accessPassword。
            </p>
          </div>
        )}
        <ol className="m-0 mt-4 list-decimal space-y-2.5 pl-5 text-[13px]">
          <li>
            在仓库根目录运行 <code className="font-mono">node deploy/gateway.mjs</code>
            （首次需在 <code className="font-mono">gateway/cloudflare</code> 下{" "}
            <code className="font-mono">npx wrangler login</code>）。
          </li>
          <li>
            <code className="font-mono">UPSTREAM_MCP_URL</code> 填本节点公网 MCP 地址：
            {status.publicMcpUrl ? (
              <div className="mt-1 flex items-center gap-2">
                <MonoBox title={status.publicMcpUrl}>{status.publicMcpUrl}</MonoBox>
                <CopyButton text={status.publicMcpUrl} message="已复制公网 MCP 地址" />
              </div>
            ) : (
              <span className="text-muted-foreground"> 需先在「星图组网」页配置「固定公网地址」</span>
            )}
          </li>
          <li>
            <code className="font-mono">UPSTREAM_TOKEN</code> 填本页「客户端 Token」。
          </li>
        </ol>
      </Block>

      <ConfirmDialog
        open={rotating !== null}
        onOpenChange={(o) => !o && setRotating(null)}
        title={`轮换${rotatingRow?.label ?? ""}`}
        description={`确定轮换${rotatingRow?.label ?? "该密钥"}？${rotatingRow?.impact ?? ""}`}
        onConfirm={doRotate}
        confirmText="轮换"
      />
    </>
  );
}
