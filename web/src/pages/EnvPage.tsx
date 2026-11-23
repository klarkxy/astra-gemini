import { useCallback, useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { api } from "@/lib/api";
import { useStatus } from "@/lib/status";
import type { EnvItem } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Block, PageHead, SkeletonRows, StatusTag } from "@/components/bits";

export function EnvPage() {
  const { status } = useStatus();
  const [env, setEnv] = useState<Record<string, EnvItem> | null>(null);

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
        <PageHead title="自检与日志" sub="本机运行环境自检与最近调用日志。" />
        <SkeletonRows />
      </>
    );
  }
  const logs = status.logs || [];

  return (
    <>
      <PageHead title="自检与日志" sub="本机运行环境自检与最近调用日志。" />

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
    </>
  );
}
