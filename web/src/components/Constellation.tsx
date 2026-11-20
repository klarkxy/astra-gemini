import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import type { ChildNode, TreeStatus } from "@/lib/types";

let sessionIntroDone = false;

function starPath(cx: number, cy: number, r: number): string {
  const i = +(r * 0.34).toFixed(2);
  return `M ${cx} ${cy - r} L ${cx + i} ${cy - i} L ${cx + r} ${cy} L ${cx + i} ${cy + i} L ${cx} ${cy + r} L ${cx - i} ${cy + i} L ${cx - r} ${cy} L ${cx - i} ${cy - i} Z`;
}

interface Tip {
  x: number;
  y: number;
  title: string;
  lines: string[];
}

interface KidLayout {
  child: ChildNode;
  x: number;
  y: number;
}

export function Constellation({ tree, height }: { tree?: TreeStatus; height: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(0);
  const [tip, setTip] = useState<Tip | null>(null);
  // 整场动画只在本次会话的首次挂载播放
  const intro = useRef(!sessionIntroDone);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setW(Math.max(320, Math.round(el.clientWidth)));
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    sessionIntroDone = true;
  }, []);

  const up = tree?.upstream || {};
  const children = tree?.children || [];
  const nodeId = tree?.nodeId || "本机";

  const layout = useMemo(() => {
    const cx = Math.max(90, Math.round(w * 0.25));
    const cy = Math.round(height * 0.55);
    const n = children.length;
    const arcStart = cx + 66;
    const arcEnd = w * 0.9;
    const step = n ? (arcEnd - arcStart) / n : 0;
    const amp = Math.round(height * 0.3);
    const kids: KidLayout[] = children.map((child, i) => ({
      child,
      x: arcStart + (i + 0.5) * step,
      y: n === 1 ? cy - 8 : cy + 6 - amp * Math.sin((Math.PI * (i + 0.5)) / n)
    }));
    return {
      cx,
      cy,
      kids,
      step,
      showLabels: step >= 62,
      maxLabelLen: Math.max(6, Math.floor(step / 7.5)),
      ux: Math.max(22, cx - Math.min(92, w * 0.12)),
      uy: Math.max(18, cy - Math.round(height * 0.32))
    };
  }, [w, height, children]);

  const dots = useMemo(() => {
    let seed = 0x5eed;
    const rnd = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    return Array.from({ length: 36 }, () => ({
      x: 10 + rnd() * Math.max(1, w - 20),
      y: 8 + rnd() * Math.max(1, height - 16),
      r: 0.7 + rnd() * 1.1
    }));
  }, [w, height]);

  const { cx, cy, kids, showLabels, maxLabelLen, ux, uy } = layout;
  const hasUpstream = !!(up.enabled || up.connected);
  const showTip = (t: Tip | null) =>
    setTip(t ? { ...t, x: Math.min(Math.max(t.x, 110), w - 110) } : t);

  return (
    <div ref={ref} className="relative" style={{ height }}>
      {w > 0 && (
        <svg viewBox={`0 0 ${w} ${height}`} className="block w-full" style={{ height }} role="img" aria-label="节点星图">
          {dots.map((d, i) => (
            <circle key={i} cx={d.x} cy={d.y} r={d.r} className="fill-muted-foreground" opacity={0.16} />
          ))}

          {hasUpstream && (
            <motion.line
              x1={cx - 10} y1={cy - 16} x2={ux + 9} y2={uy + 7}
              stroke={up.connected ? "var(--live)" : "var(--muted-foreground)"}
              strokeDasharray={up.connected ? undefined : "4 5"}
              strokeWidth={1.2} fill="none"
              initial={intro.current ? { pathLength: 0, opacity: 0 } : false}
              animate={{ pathLength: 1, opacity: 0.5 }}
              transition={{ duration: 0.5 }}
            />
          )}

          <AnimatePresence>
            {kids.map((k, i) => {
              const on = !!k.child.online;
              return on ? (
                <motion.line
                  key={`e-${k.child.nodeId}`}
                  x1={cx + 16} y1={cy - 2} x2={k.x - 10} y2={k.y}
                  stroke="var(--live)" strokeWidth={1.2} fill="none"
                  initial={{ pathLength: 0, opacity: 0 }}
                  animate={{ pathLength: 1, opacity: 0.5 }}
                  exit={{ opacity: 0, transition: { duration: 0.2 } }}
                  transition={{ duration: 0.45, delay: intro.current ? 0.15 + i * 0.05 : 0 }}
                />
              ) : (
                <motion.line
                  key={`e-${k.child.nodeId}`}
                  x1={cx + 16} y1={cy - 2} x2={k.x - 10} y2={k.y}
                  stroke="var(--muted-foreground)" strokeDasharray="4 5" strokeWidth={1.2} fill="none"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 0.55 }}
                  exit={{ opacity: 0, transition: { duration: 0.2 } }}
                  transition={{ duration: 0.3, delay: intro.current ? 0.15 + i * 0.05 : 0 }}
                />
              );
            })}
          </AnimatePresence>

          <motion.line
            x1={cx - 14} y1={cy - 3} x2={cx + 14} y2={cy + 5}
            stroke="var(--star)" strokeWidth={1.2} fill="none"
            initial={intro.current ? { pathLength: 0, opacity: 0 } : false}
            animate={{ pathLength: 1, opacity: 0.85 }}
            transition={{ duration: 0.4 }}
          />

          <AnimatePresence>
            {kids.map((k, i) => {
              const c = k.child;
              const on = !!c.online;
              const name = String(c.nodeId || "");
              const label = name.length > maxLabelLen ? `${name.slice(0, maxLabelLen - 1)}…` : name;
              return (
                <motion.g
                  key={`n-${c.nodeId}`}
                  initial={{ scale: 0, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  exit={{ scale: 0, opacity: 0, transition: { duration: 0.2 } }}
                  transition={{ duration: 0.28, delay: intro.current ? 0.25 + i * 0.05 : 0 }}
                  style={{ transformBox: "fill-box", transformOrigin: "center" }}
                  onMouseEnter={() =>
                    showTip({
                      x: k.x, y: k.y - 12,
                      title: name,
                      lines: [`${on ? "在线" : "离线"}，项目 ${(c.projects || []).length} 个`]
                    })
                  }
                  onMouseLeave={() => showTip(null)}
                >
                  <path
                    d={starPath(k.x, k.y, on ? 10 : 8.5)}
                    style={{ fill: on ? "var(--live)" : "var(--muted-foreground)", transition: "fill 0.25s" }}
                  />
                  {showLabels && (
                    <text x={k.x} y={k.y + 20} textAnchor="middle" fontSize={12} className="fill-muted-foreground" style={{ fontFamily: "var(--font-sans)" }}>
                      {label}
                    </text>
                  )}
                </motion.g>
              );
            })}
          </AnimatePresence>

          {hasUpstream && (
            <motion.g
              initial={intro.current ? { scale: 0, opacity: 0 } : false}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ duration: 0.3 }}
              style={{ transformBox: "fill-box", transformOrigin: "center" }}
              onMouseEnter={() =>
                showTip({ x: ux, y: uy - 10, title: "上游", lines: [up.connected ? "已连接" : "重连中"] })
              }
              onMouseLeave={() => showTip(null)}
            >
              <path
                d={starPath(ux, uy, 9)}
                style={{ fill: up.connected ? "var(--live)" : "var(--muted-foreground)", transition: "fill 0.25s" }}
              />
              <text x={ux + 15} y={uy + 4} fontSize={12} className="fill-muted-foreground" style={{ fontFamily: "var(--font-sans)" }}>
                上游
              </text>
            </motion.g>
          )}

          <motion.g
            initial={intro.current ? { scale: 0, opacity: 0 } : false}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ duration: 0.3, delay: intro.current ? 0.1 : 0 }}
            style={{ transformBox: "fill-box", transformOrigin: "center" }}
            onMouseEnter={() => showTip({ x: cx, y: cy - 16, title: nodeId, lines: ["本机节点"] })}
            onMouseLeave={() => showTip(null)}
          >
            <path d={starPath(cx - 15, cy - 3, 14)} style={{ fill: "var(--star)" }} />
            <path d={starPath(cx + 15, cy + 5, 9.5)} style={{ fill: "var(--star)" }} />
          </motion.g>

          <motion.text
            x={cx} y={cy + 34} textAnchor="middle" fontSize={13} fontWeight={600}
            className="fill-foreground" style={{ fontFamily: "var(--font-display)" }}
            initial={intro.current ? { opacity: 0 } : false}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.3, delay: intro.current ? 0.3 : 0 }}
          >
            {nodeId}
          </motion.text>

          {!children.length && (
            <text x={cx + 60} y={cy + 5} fontSize={12} className="fill-muted-foreground" opacity={0.75} style={{ fontFamily: "var(--font-sans)" }}>
              暂无子节点
            </text>
          )}
        </svg>
      )}

      <AnimatePresence>
        {tip && (
          <div key="tip" className="pointer-events-none absolute z-10" style={{ left: tip.x, top: tip.y }}>
            <motion.div
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.12 }}
              className="border-border bg-popover text-popover-foreground max-w-[220px] -translate-x-1/2 -translate-y-full whitespace-normal break-words rounded-md border px-2.5 py-1.5 text-xs shadow-md"
            >
              <div className="font-medium">{tip.title}</div>
              {tip.lines.map((l, i) => (
                <div key={i} className="text-muted-foreground">{l}</div>
              ))}
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}
