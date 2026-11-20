export { cn } from "cn";

export function fmtUptime(sec?: number): string {
  const s0 = Math.max(0, Math.floor(sec || 0));
  const d = Math.floor(s0 / 86400);
  const h = Math.floor((s0 % 86400) / 3600);
  const m = Math.floor((s0 % 3600) / 60);
  const s = s0 % 60;
  if (d) return `运行 ${d} 天 ${h} 小时`;
  if (h) return `运行 ${h} 小时 ${m} 分`;
  if (m) return `运行 ${m} 分 ${s} 秒`;
  return `运行 ${s} 秒`;
}
