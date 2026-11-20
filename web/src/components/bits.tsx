import { useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Check, Copy } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from "@/components/ui/alert-dialog";

export function PageHead({ title, sub }: { title: string; sub: string }) {
  return (
    <div className="pb-1 pt-7">
      <h2 className="font-display m-0 text-xl font-semibold">{title}</h2>
      <p className="text-muted-foreground m-0 mt-1 text-[13px]">{sub}</p>
    </div>
  );
}

export function Block({
  title,
  sub,
  side,
  children
}: {
  title?: string;
  sub?: string;
  side?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="border-border border-t py-5">
      {title && (
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <h3 className="font-display m-0 text-base font-semibold">{title}</h3>
            {sub && <div className="text-muted-foreground mt-0.5 text-xs">{sub}</div>}
          </div>
          {side}
        </div>
      )}
      {children}
    </section>
  );
}

type StagVariant = "ok" | "err" | "warn" | "muted";

const STAG_COLOR: Record<StagVariant, string> = {
  ok: "text-live",
  err: "text-destructive",
  warn: "text-warn",
  muted: "text-muted-foreground"
};

export function StatusTag({ variant = "muted", children, className }: { variant?: StagVariant; children: ReactNode; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 whitespace-nowrap text-xs", STAG_COLOR[variant], className)}>
      <span className="size-[7px] shrink-0 rounded-full bg-current" />
      {children}
    </span>
  );
}

export async function copyText(text: string | undefined | null, msg?: string): Promise<boolean> {
  if (!text) {
    toast("暂无可复制内容");
    return false;
  }
  try {
    await navigator.clipboard.writeText(text);
    toast(msg || "已复制");
    return true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.readOnly = true;
    ta.style.cssText = "position:fixed;opacity:0;pointer-events:none";
    document.body.appendChild(ta);
    try {
      ta.select();
      if (document.execCommand("copy")) {
        toast(msg || "已复制");
        return true;
      }
    } finally {
      ta.remove();
    }
    window.prompt("请手动复制：", text);
    return false;
  }
}

export function CopyButton({ text, message, className }: { text?: string | null; message?: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="outline"
      size="sm"
      className={className}
      onClick={async () => {
        if (await copyText(text, message)) {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1200);
        }
      }}
    >
      <AnimatePresence mode="wait" initial={false}>
        <motion.span
          key={copied ? "check" : "copy"}
          initial={{ scale: 0.5, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          exit={{ scale: 0.5, opacity: 0 }}
          transition={{ duration: 0.12 }}
          className="inline-flex"
          data-icon="inline-start"
        >
          {copied ? <Check className="text-live" /> : <Copy />}
        </motion.span>
      </AnimatePresence>
      复制
    </Button>
  );
}

export function MonoBox({ children, className, title }: { children: ReactNode; className?: string; title?: string }) {
  return (
    <code title={title} className={cn("bg-card border-border min-w-0 flex-1 truncate rounded-md border px-2.5 py-1.5 font-mono text-xs", className)}>
      {children}
    </code>
  );
}

export function FieldRow({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className={className}>
      <div className="text-muted-foreground mb-1.5 text-xs">{label}</div>
      <div className="flex items-center gap-2">{children}</div>
    </div>
  );
}

/** Masked token box + show/hide button with text crossfade. */
export function MaskedValue({
  visible,
  onToggle,
  value,
  emptyText,
  copyMessage
}: {
  visible: boolean;
  onToggle: () => void;
  value?: string;
  emptyText: string;
  copyMessage: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <MonoBox className="relative overflow-hidden">
        <AnimatePresence mode="wait" initial={false}>
          <motion.span
            key={visible ? "shown" : "masked"}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.12 }}
            className="block truncate"
          >
            {value ? (visible ? value : "•".repeat(24)) : emptyText}
          </motion.span>
        </AnimatePresence>
      </MonoBox>
      <Button variant="outline" size="sm" onClick={onToggle} disabled={!value}>
        {visible ? "隐藏" : "显示"}
      </Button>
      <CopyButton text={value} message={copyMessage} />
    </div>
  );
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  onConfirm,
  confirmText = "确定"
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  onConfirm: () => void;
  confirmText?: string;
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>取消</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={onConfirm}>
            {confirmText}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function SkeletonRows({ rows = 4 }: { rows?: number }) {
  return (
    <div className="flex flex-col gap-3 pt-6">
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className="h-12" style={{ animationDelay: `${i * 80}ms` }} />
      ))}
    </div>
  );
}
