import { useState } from "react";
import { toast } from "sonner";
import { adminKeyRemembered, api, setAdminKey } from "@/lib/api";
import { useStatus } from "@/lib/status";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
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

type SecretKind = "client" | "join" | "admin" | "mcpPath";

const SECRET_ROWS: { kind: SecretKind; label: string; impact: string }[] = [
  {
    kind: "client",
    label: "客户端 Token",
    impact: "已接入的代码工具会失效，需要更新各客户端的 Bearer Token；Gemini Capability URL 不受影响。"
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
  },
  {
    kind: "mcpPath",
    label: "Gemini 路径密钥",
    impact: "已保存到 Gemini 的免 OAuth URL 会立即失效，需要在 Connected Apps 中更新地址；/mcp Bearer 直连不受影响。"
  }
];

export function ConnectPage() {
  const { status, refresh } = useStatus();
  const [showToken, setShowToken] = useState(false);
  const [showMcpPath, setShowMcpPath] = useState(false);
  const [rotating, setRotating] = useState<SecretKind | null>(null);

  if (!status) {
    return (
      <>
        <PageHead title="接入客户端" sub="代码工具直连 MCP；Gemini App 通过免 OAuth 密钥路径接入。" />
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
  const mcpPathEnabled = status.mcpPathEnabled !== false;
  const fallbackBase = (status.publicUrl || status.localMcpUrl.replace(/\/mcp\/?$/, "")).replace(/\/+$/, "");
  const geminiMcpUrl =
    status.publicGeminiMcpUrl || (status.mcpPathToken ? `${fallbackBase}/mcp/${status.mcpPathToken}` : "");
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

  async function saveMcpPathEnabled(enabled: boolean) {
    const res = await api.saveSettings({ mcpPathEnabled: enabled });
    toast(res.ok ? (enabled ? "免 OAuth 密钥路径已启用" : "免 OAuth 密钥路径已关闭") : res.error || "保存失败");
    refresh();
  }

  return (
    <>
      <PageHead title="接入客户端" sub="代码工具直连 MCP；Gemini App 通过免 OAuth 密钥路径接入。" />
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

      <Block title="Gemini App（免 OAuth 密钥路径）" sub="高熵路径本身就是凭据；Gemini Advanced 留空即可直连，无需 Cloudflare Worker 或 OAuth。">
        <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-2">
          <label className="flex cursor-pointer items-center gap-2.5 text-[13px]">
            <Switch checked={mcpPathEnabled} onCheckedChange={(v) => void saveMcpPathEnabled(v)} />
            启用免 OAuth 密钥路径
          </label>
          <span className={mcpPathEnabled ? "text-live text-xs" : "text-muted-foreground text-xs"}>
            {mcpPathEnabled ? "已启用" : "已关闭（请求返回 404）"}
          </span>
        </div>
        {geminiMcpUrl ? (
          <>
            <FieldRow label="在 Gemini「Settings → Connected Apps → Add custom app」填写">
              <MaskedValue
                visible={showMcpPath}
                onToggle={() => setShowMcpPath((v) => !v)}
                value={geminiMcpUrl}
                emptyText="未配置 Gemini 路径密钥"
                copyMessage="已复制 Gemini 免 OAuth MCP 地址"
              />
            </FieldRow>
            <p className="text-muted-foreground mt-1.5 text-xs">
              Advanced 留空；完整 URL 就是凭据，不要提交到 issue、日志或公开仓库。
            </p>
            {!status.publicGeminiMcpUrl && mcpPathEnabled && (
              <p className="text-warn mt-1.5 text-xs">
                尚未在「星图组网」固定公网 publicUrl；请确认上方地址是 Gemini 云端可访问的公网 HTTPS 地址。
              </p>
            )}
            {!mcpPathEnabled && (
              <p className="text-muted-foreground mt-1.5 text-xs">
                当前开关已关闭，Gemini 保存该 URL 后也会返回 404；重新开启即可恢复。
              </p>
            )}
          </>
        ) : (
          <p className="text-muted-foreground m-0 text-[13px]">
            未检测到 mcp-path.txt。Docker 与 Windows 托盘首启会自动生成；手工启动时请先生成该文件并重启服务。
          </p>
        )}
        <ol className="m-0 mt-4 list-decimal space-y-2.5 pl-5 text-[13px]">
          <li>反向代理需转发 POST /mcp/*，并避免把完整密钥路径写入访问日志。</li>
          <li>若 Gemini 不显示 Connected Apps，请使用英文界面、美国出口，并开启 Gemini Apps Activity。</li>
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
