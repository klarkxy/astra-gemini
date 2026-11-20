import { useCallback, useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { useStatus } from "@/lib/status";
import type { EnvItem } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Block, ConfirmDialog, PageHead, SkeletonRows, StatusTag } from "@/components/bits";

export function EnvPage() {
  const { status, refresh } = useStatus();
  const [env, setEnv] = useState<Record<string, EnvItem> | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState(false);

  const loadEnv = useCallback(async () => {
    const res = await api.env().catch(() => null);
    if (res?.ok) setEnv(res.env || {});
  }, []);

  useEffect(() => {
    void loadEnv();
  }, [loadEnv]);

  if (!status) {
    return (
      <>
        <PageHead title="自检与日志" sub="本机运行环境自检、已授权的 AI 客户端与最近调用日志。" />
        <SkeletonRows />
      </>
    );
  }
  const logs = status.logs || [];

  async function revokeAll() {
    const res = await api.revokeAllOauth();
    toast(res.ok ? "已撤销全部令牌" : res.error || "操作失败");
    refresh();
  }

  return (
    <>
      <PageHead title="自检与日志" sub="本机运行环境自检、已授权的 AI 客户端与最近调用日志。" />

      <Block title="电脑环境自检" side={<Button variant="outline" size="sm" onClick={loadEnv}>重新检测</Button>}>
        <div className="flex flex-wrap gap-x-3.5 gap-y-2">
          {!env ? (
            <span className="text-muted-foreground text-xs">检测中…</span>
          ) : (
            Object.entries(env).map(([k, v]) => (
              <StatusTag key={k} variant={v.available ? "ok" : "err"}>
                {k}：{v.available ? v.version || "已安装" : "未检测到"}
              </StatusTag>
            ))
          )}
        </div>
      </Block>

      <OauthBlock onRevoke={() => setConfirmRevoke(true)} />

      <Block title="最近运行日志">
        {!logs.length ? (
          <div className="text-muted-foreground text-xs">暂无调用记录。</div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>时间</TableHead>
                <TableHead>事件</TableHead>
                <TableHead>详情</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <AnimatePresence initial={false}>
                {logs.map((l, i) => (
                  <motion.tr
                    key={`${l.time}-${l.event}-${l.detail}-${i}`}
                    layout
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.2 }}
                    className="border-border border-b transition-colors"
                  >
                    <TableCell>{l.time}</TableCell>
                    <TableCell><strong>{l.event}</strong></TableCell>
                    <TableCell><code className="font-mono text-xs">{l.detail}</code></TableCell>
                  </motion.tr>
                ))}
              </AnimatePresence>
            </TableBody>
          </Table>
        )}
      </Block>

      <ConfirmDialog
        open={confirmRevoke}
        onOpenChange={setConfirmRevoke}
        title="撤销全部令牌"
        description="确定撤销全部 OAuth 访问令牌？所有已连接的 AI 客户端需要重新授权。"
        confirmText="全部撤销"
        onConfirm={() => {
          void revokeAll();
          setConfirmRevoke(false);
        }}
      />
    </>
  );
}

function OauthBlock({ onRevoke }: { onRevoke: () => void }) {
  const { oauthClients } = useStatus();
  return (
    <Block
      title="已授权的 AI 客户端（OAuth）"
      side={<Button variant="outline" size="sm" className="text-destructive" onClick={onRevoke}>全部撤销</Button>}
    >
      {!oauthClients.length ? (
        <Empty className="border-border border border-dashed">
          <EmptyHeader>
            <EmptyTitle>暂无已授权的 AI 客户端</EmptyTitle>
            <EmptyDescription>Claude/ChatGPT 连接器完成 OAuth 登录后会出现在这里。</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>客户端</TableHead>
              <TableHead>client_id</TableHead>
              <TableHead>回调地址</TableHead>
              <TableHead>注册时间</TableHead>
              <TableHead>活跃令牌</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <AnimatePresence initial={false}>
              {oauthClients.map((c) => (
                <motion.tr
                  key={c.client_id}
                  layout
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.2 }}
                  className="border-border border-b transition-colors"
                >
                  <TableCell><strong>{c.client_name || "(未命名)"}</strong></TableCell>
                  <TableCell><code className="font-mono text-xs">{c.client_id}</code></TableCell>
                  <TableCell><code className="font-mono text-xs">{(c.redirect_uris || []).join(", ")}</code></TableCell>
                  <TableCell>{new Date(c.created_at || 0).toLocaleString("zh-CN", { hour12: false })}</TableCell>
                  <TableCell className="font-display">{c.activeTokens || 0}</TableCell>
                </motion.tr>
              ))}
            </AnimatePresence>
          </TableBody>
        </Table>
      )}
    </Block>
  );
}
