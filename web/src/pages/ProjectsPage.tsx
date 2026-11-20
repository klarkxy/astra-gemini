import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { useSeeded, useStatus } from "@/lib/status";
import type { ProjectInfo } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldGroup, FieldLabel, FieldSet, FieldLegend } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Block, ConfirmDialog, PageHead, SkeletonRows, StatusTag } from "@/components/bits";

export function ProjectsPage() {
  const { status, refresh } = useStatus();
  const [alias, setAlias] = useState("");
  const [root, setRoot] = useState("");
  const [mode, setMode] = useState("direct");
  const [desc, setDesc] = useState("");
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [removeTarget, setRemoveTarget] = useState<string | null>(null);

  useSeeded(status?.sdks, () => {
    setChecked(new Set((status?.sdks || []).filter((s) => s.enabled).map((s) => s.name)));
  });

  if (!status) {
    return (
      <>
        <PageHead title="本地项目" sub="登记本机代码文件夹。AI 只能访问这里列出的项目，权限与可用 SDK 逐项控制。" />
        <SkeletonRows />
      </>
    );
  }

  const sdks = status.sdks || [];
  const projects = status.projects || [];

  function fillProject(p: ProjectInfo) {
    setAlias(p.project);
    setRoot(p.root || "");
    setMode(p.mode || "direct");
    setDesc(p.description || "");
    setChecked(
      p.sdks === "*"
        ? new Set(sdks.map((s) => s.name))
        : new Set(Array.isArray(p.sdks) ? p.sdks : [])
    );
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function save() {
    const res = await api.saveProject({
      project: alias.trim(),
      root: root.trim(),
      mode,
      description: desc.trim(),
      sdks: Array.from(checked)
    });
    if (res.ok) {
      toast(`项目 ${alias.trim()} 已保存`);
      refresh();
    } else {
      toast(res.error || "保存失败");
    }
  }

  async function doRemove(id: string) {
    const res = await api.removeProject(id);
    if (res.ok) {
      toast(`已移除 ${id}`);
      refresh();
    }
  }

  return (
    <>
      <PageHead title="本地项目" sub="登记本机代码文件夹。AI 只能访问这里列出的项目，权限与可用 SDK 逐项控制。" />

      <Block title="添加或修改本地项目">
        <FieldGroup className="gap-3">
          <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,220px),1fr))] gap-3">
            <Field>
              <FieldLabel htmlFor="pAlias">项目别名</FieldLabel>
              <Input id="pAlias" value={alias} onChange={(e) => setAlias(e.target.value)} placeholder="my-app（英文、数字、-、_）" />
            </Field>
            <Field>
              <FieldLabel htmlFor="pRoot">本地文件夹路径</FieldLabel>
              <Input id="pRoot" value={root} onChange={(e) => setRoot(e.target.value)} placeholder="H:\Code\my-app" />
            </Field>
            <Field>
              <FieldLabel>权限模式</FieldLabel>
              <Select value={mode} onValueChange={setMode}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="direct">可写 + 自动备份（推荐）</SelectItem>
                    <SelectItem value="readonly">仅只读（只能看代码，禁止改文件）</SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel htmlFor="pDesc">备注（可选）</FieldLabel>
              <Input id="pDesc" value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="简单记一下这是什么项目" />
            </Field>
          </div>
          <FieldSet>
            <FieldLegend className="text-muted-foreground text-xs font-normal">该项目允许调用的 SDK</FieldLegend>
            <div className="flex flex-wrap gap-x-4 gap-y-1.5">
              {sdks.map((s) => (
                <label key={s.name} className="flex cursor-pointer items-center gap-1.5 text-[13px]">
                  <Checkbox
                    checked={checked.has(s.name)}
                    onCheckedChange={(c) => {
                      setChecked((prev) => {
                        const next = new Set(prev);
                        if (c) next.add(s.name);
                        else next.delete(s.name);
                        return next;
                      });
                    }}
                  />
                  {s.name}
                </label>
              ))}
            </div>
          </FieldSet>
          <div>
            <Button onClick={save}>保存项目（立即生效）</Button>
          </div>
        </FieldGroup>
      </Block>

      <Block title="项目列表">
        {!projects.length ? (
          <Empty className="border-border border border-dashed">
            <EmptyHeader>
              <EmptyTitle>还没有添加本地项目</EmptyTitle>
              <EmptyDescription>请在上方表单添加本地代码文件夹。</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>项目别名</TableHead>
                <TableHead>本地路径</TableHead>
                <TableHead>权限</TableHead>
                <TableHead>允许的 SDK</TableHead>
                <TableHead>操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <AnimatePresence initial={false}>
                {projects.map((p) => (
                  <motion.tr
                    key={p.project}
                    layout
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.2 }}
                    className="border-border border-b transition-colors"
                  >
                    <TableCell>
                      <strong>{p.project}</strong>
                      {p.description && <div className="text-muted-foreground mt-0.5 text-xs">{p.description}</div>}
                    </TableCell>
                    <TableCell>
                      <code className="font-mono text-xs">{p.root || ""}</code>{" "}
                      {p.exists ? <StatusTag variant="ok">存在</StatusTag> : <StatusTag variant="err">路径不存在</StatusTag>}
                    </TableCell>
                    <TableCell>
                      <StatusTag variant={p.mode === "readonly" ? "warn" : "ok"}>
                        {p.mode === "readonly" ? "只读" : "可写+备份"}
                      </StatusTag>
                    </TableCell>
                    <TableCell>
                      <code className="font-mono text-xs">{Array.isArray(p.sdks) ? p.sdks.join(", ") : p.sdks}</code>
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      <Button variant="outline" size="sm" onClick={() => fillProject(p)}>编辑</Button>{" "}
                      <Button variant="outline" size="sm" className="text-destructive" onClick={() => setRemoveTarget(p.project)}>移除</Button>
                    </TableCell>
                  </motion.tr>
                ))}
              </AnimatePresence>
            </TableBody>
          </Table>
        )}
      </Block>

      <ConfirmDialog
        open={removeTarget !== null}
        onOpenChange={(o) => !o && setRemoveTarget(null)}
        title="移除项目"
        description={`确定从列表移除项目 "${removeTarget}"？（不会删除硬盘上的文件）`}
        onConfirm={() => {
          if (removeTarget) void doRemove(removeTarget);
          setRemoveTarget(null);
        }}
      />
    </>
  );
}
