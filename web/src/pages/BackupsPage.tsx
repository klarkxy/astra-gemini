import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { useStatus } from "@/lib/status";
import type { BackupInfo } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Block, ConfirmDialog, PageHead, SkeletonRows } from "@/components/bits";

export function BackupsPage() {
  const { status, refresh } = useStatus();
  const [target, setTarget] = useState<BackupInfo | null>(null);

  if (!status) {
    return (
      <>
        <PageHead title="备份回滚" sub="AI 每次修改本机文件前都会自动保存底稿，可一键还原到修改前的状态。" />
        <SkeletonRows />
      </>
    );
  }
  const backups = status.backups || [];

  async function doRollback(b: BackupInfo) {
    const res = await api.rollback(b.project, b.backupId);
    toast(res.ok ? "已成功还原原文件！" : res.error || "还原失败");
    refresh();
  }

  return (
    <>
      <PageHead title="备份回滚" sub="AI 每次修改本机文件前都会自动保存底稿，可一键还原到修改前的状态。" />
      <Block>
        {!backups.length ? (
          <Empty className="border-border border border-dashed">
            <EmptyHeader>
              <EmptyTitle>还没有自动备份记录</EmptyTitle>
              <EmptyDescription>当 AI 修改过你的代码后，这里会自动出现可一键还原的快照。</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>时间</TableHead>
                <TableHead>项目</TableHead>
                <TableHead>改动文件</TableHead>
                <TableHead>操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <AnimatePresence initial={false}>
                {backups.map((b) => (
                  <motion.tr
                    key={b.backupId}
                    layout
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.2 }}
                    className="border-border border-b transition-colors"
                  >
                    <TableCell>{String(b.createdAt || "").replace("T", " ").slice(0, 19)}</TableCell>
                    <TableCell><strong>{b.project}</strong></TableCell>
                    <TableCell><code className="font-mono text-xs">{(b.files || []).join(", ")}</code></TableCell>
                    <TableCell>
                      <Button variant="outline" size="sm" className="text-destructive" onClick={() => setTarget(b)}>一键还原</Button>
                    </TableCell>
                  </motion.tr>
                ))}
              </AnimatePresence>
            </TableBody>
          </Table>
        )}
      </Block>

      <ConfirmDialog
        open={target !== null}
        onOpenChange={(o) => !o && setTarget(null)}
        title="还原备份"
        description={`确定将项目 "${target?.project}" 还原到这次备份前的状态？`}
        confirmText="一键还原"
        onConfirm={() => {
          if (target) void doRollback(target);
          setTarget(null);
        }}
      />
    </>
  );
}
