import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { useStatus } from "@/lib/status";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Constellation } from "@/components/Constellation";
import {
  Block,
  ConfirmDialog,
  CopyButton,
  FieldRow,
  MaskedValue,
  MonoBox,
  PageHead,
  SkeletonRows,
  StatusTag
} from "@/components/bits";

function RemoteSection() {
  const { remote, refresh } = useStatus();
  const [rvUrl, setRvUrl] = useState("");
  const [rvToken, setRvToken] = useState("");
  const [swP2p, setSwP2p] = useState(true);
  const [swUpnp, setSwUpnp] = useState(true);
  const [rAllow, setRAllow] = useState("");
  const [alias, setAlias] = useState("");
  const [aliasAddr, setAliasAddr] = useState("");
  const remoteSeeded = useRef(false);

  useEffect(() => {
    if (!remoteSeeded.current && remote) {
      setRvUrl(remote.rendezvous?.url || "");
      setSwP2p(remote.p2p?.enabled !== false);
      setSwUpnp(remote.p2p?.upnpEnabled !== false);
      setRAllow((remote.remoteAllowFrom || []).join(","));
      remoteSeeded.current = true;
    }
  }, [remote]);

  if (!remote) return null;
  const rv = remote.rendezvous || {};
  const p2p = remote.p2p || {};
  const upnp = p2p.upnp || {};
  const aliases = Object.entries(remote.remotes || {});
  const channels = remote.channels || [];

  const rvBadge = rv.connected
    ? { variant: "ok" as const, text: "牵线已连接" }
    : rv.configured
      ? { variant: "warn" as const, text: "牵线重连中" }
      : { variant: "muted" as const, text: "未配置" };

  async function saveRendezvous(enabled: boolean) {
    const body: { enabled: boolean; url: string; token?: string } = { enabled, url: rvUrl.trim() };
    const tk = rvToken.trim();
    if (tk) body.token = tk;
    const res = await api.saveRendezvous(body);
    toast(res.ok ? "牵线服务配置已保存" : res.error || "保存失败");
    const p2pRes = await api.saveSettings({ p2p: { enabled: swP2p, upnp: swUpnp } });
    if (!p2pRes.ok) toast(p2pRes.error || "P2P 开关保存失败");
    remoteSeeded.current = false;
    window.setTimeout(refresh, 800);
  }

  async function addAlias() {
    const res = await api.saveRemoteAlias(alias.trim(), aliasAddr.trim());
    toast(res.ok ? "别名已添加" : res.error || "添加失败");
    refresh();
  }

  async function delAlias(a: string) {
    const res = await api.saveRemoteAlias(a, null);
    toast(res.ok ? "别名已删除" : res.error || "删除失败");
    refresh();
  }

  async function saveAllow() {
    const raw = rAllow.trim();
    const addresses = raw ? raw.split(",").map((s) => s.trim()).filter(Boolean) : [];
    const res = await api.saveAllow(addresses);
    toast(res.ok ? "白名单已保存" : res.error || "保存失败");
    refresh();
  }

  return (
    <>
      <Block
        title="远程直达"
        sub="A 设备上的 AI 通过本机入口访问远端节点 B。端到端加密：Ed25519 节点证书 + TLS 1.3 双向认证，牵线服务只撮合与转发密文。"
        side={<StatusTag variant={rvBadge.variant}>{rvBadge.text}</StatusTag>}
      >
        <FieldRow label="本机节点地址" className="mb-3">
          <MonoBox>{remote.address || "…"}</MonoBox>
          <CopyButton text={remote.address || ""} message="已复制节点地址" />
        </FieldRow>
        <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,220px),1fr))] gap-3">
          <Field>
            <FieldLabel htmlFor="rRvUrl">牵线服务地址</FieldLabel>
            <Input id="rRvUrl" value={rvUrl} onChange={(e) => setRvUrl(e.target.value)} placeholder="wss://rv.example.com（可选）" />
          </Field>
          <Field>
            <FieldLabel htmlFor="rRvToken">牵线服务 Token</FieldLabel>
            <Input id="rRvToken" type="password" value={rvToken} onChange={(e) => setRvToken(e.target.value)} placeholder="RV_TOKEN（留空则保持不变）" />
          </Field>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-2">
          <Button onClick={() => saveRendezvous(true)}>保存并连接牵线服务</Button>
          <Button variant="outline" className="text-destructive" onClick={() => saveRendezvous(false)}>停用牵线服务</Button>
          <label className="flex cursor-pointer items-center gap-2.5 text-[13px]">
            <Switch checked={swP2p} onCheckedChange={setSwP2p} />
            P2P 直连监听（重启后生效）
          </label>
          <label className="flex cursor-pointer items-center gap-2.5 text-[13px]">
            <Switch checked={swUpnp} onCheckedChange={setSwUpnp} />
            UPnP 路由器端口映射（重启后生效）
          </label>
        </div>
        {rv.lastError && <div className="text-muted-foreground mt-2 text-xs">{rv.lastError}</div>}
        <div className="text-muted-foreground mt-2 text-xs">
          <div>P2P：{p2p.listening ? `监听端口 ${p2p.port}` : p2p.error === "disabled" ? "已停用" : p2p.error || "未启动"}</div>
          <div>候选地址：{(p2p.candidates || []).join(", ") || "(无)"}</div>
          <div>UPnP：{upnp.state === "mapped" ? `已映射 ${upnp.externalAddr}` : upnp.state || "disabled"}</div>
        </div>
      </Block>

      <Block title="远端别名" sub="本机作为 A，通过别名访问远端节点 B。">
        {!aliases.length ? (
          <Empty className="border-border border border-dashed">
            <EmptyHeader>
              <EmptyTitle>暂无别名</EmptyTitle>
              <EmptyDescription>
                添加后远端项目会以 <code>/remote/&lt;别名&gt;/mcp</code> 入口暴露给本机 AI。
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>别名</TableHead>
                <TableHead>节点地址</TableHead>
                <TableHead>给对端 AI 的接入命令</TableHead>
                <TableHead>操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <AnimatePresence initial={false}>
                {aliases.map(([a, addr]) => {
                  const cmd = `claude mcp add --transport http ${a} http://127.0.0.1:${location.port}/remote/${a}/mcp --header "Authorization: Bearer <对方客户端 Token>"`;
                  return (
                    <motion.tr
                      key={a}
                      layout
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      transition={{ duration: 0.2 }}
                      className="border-border border-b transition-colors"
                    >
                      <TableCell><strong>{a}</strong></TableCell>
                      <TableCell><code className="font-mono text-xs">{addr}</code></TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <MonoBox className="flex-none text-[11px]">{cmd}</MonoBox>
                          <CopyButton text={cmd} message="已复制接入命令" />
                        </div>
                      </TableCell>
                      <TableCell>
                        <Button variant="outline" size="sm" className="text-destructive" onClick={() => delAlias(a)}>删除</Button>
                      </TableCell>
                    </motion.tr>
                  );
                })}
              </AnimatePresence>
            </TableBody>
          </Table>
        )}
        <div className="mt-3 grid grid-cols-[repeat(auto-fit,minmax(min(100%,220px),1fr))] gap-3">
          <Field>
            <FieldLabel htmlFor="rAlias">别名</FieldLabel>
            <Input id="rAlias" value={alias} onChange={(e) => setAlias(e.target.value)} placeholder="例如 home-b" />
          </Field>
          <Field>
            <FieldLabel htmlFor="rAliasAddr">远端节点地址</FieldLabel>
            <Input id="rAliasAddr" value={aliasAddr} onChange={(e) => setAliasAddr(e.target.value)} placeholder="ag1-…（向 B 索取）" />
          </Field>
        </div>
        <Button variant="outline" size="sm" className="mt-3" onClick={addAlias}>添加别名</Button>
      </Block>

      <Block title="呼入白名单与活跃通道" sub="本机作为 B 时，控制哪些远端节点可以呼入。">
        <Field>
          <FieldLabel htmlFor="rAllow">呼入白名单 remoteAllowFrom</FieldLabel>
          <Input id="rAllow" value={rAllow} onChange={(e) => setRAllow(e.target.value)} placeholder="节点地址逗号分隔，留空 = 接受任意节点" />
        </Field>
        <Button variant="outline" size="sm" className="my-3" onClick={saveAllow}>保存白名单</Button>
        {!channels.length ? (
          <Empty className="border-border border border-dashed">
            <EmptyHeader>
              <EmptyTitle>当前没有活跃的远程通道</EmptyTitle>
            </EmptyHeader>
          </Empty>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>对端</TableHead>
                <TableHead>方式</TableHead>
                <TableHead>方向</TableHead>
                <TableHead>建立时间</TableHead>
                <TableHead>流量(收/发)</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <AnimatePresence initial={false}>
                {channels.map((c) => (
                  <motion.tr
                    key={`${c.peer}-${c.since}`}
                    layout
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.2 }}
                    className="border-border border-b transition-colors"
                  >
                    <TableCell><code className="font-mono text-xs">{c.peer}</code></TableCell>
                    <TableCell>
                      <StatusTag variant={c.mode === "direct" ? "ok" : "muted"}>
                        {c.mode === "direct" ? "直连" : "中继"}
                      </StatusTag>
                    </TableCell>
                    <TableCell>{c.direction === "out" ? "呼出" : "呼入"}</TableCell>
                    <TableCell>{new Date(c.since).toLocaleString("zh-CN", { hour12: false })}</TableCell>
                    <TableCell className="font-display">{c.bytesIn} / {c.bytesOut}</TableCell>
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

export function TreePage() {
  const { status, refresh } = useStatus();
  const [tNodeId, setTNodeId] = useState("");
  const [tUpUrl, setTUpUrl] = useState("");
  const [tUpToken, setTUpToken] = useState("");
  const [swDirect, setSwDirect] = useState(true);
  const [swLan, setSwLan] = useState(true);
  const [swPubCon, setSwPubCon] = useState(false);
  const [sPublicUrl, setSPublicUrl] = useState("");
  const [showJoinToken, setShowJoinToken] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<string | null>(null);
  const treeSeeded = useRef(false);

  useEffect(() => {
    if (!treeSeeded.current && status?.settings) {
      const s = status.settings;
      setTNodeId(s.nodeId || status.tree?.nodeId || "");
      setTUpUrl(s.upstream?.url || "");
      setTUpToken(s.upstream?.token || "");
      setSwDirect(s.directEnabled !== false);
      setSwLan(s.advertiseLan !== false);
      setSwPubCon(typeof s.publicConsole === "boolean" ? s.publicConsole : Boolean(status.publicConsole));
      setSPublicUrl(s.publicUrl || "");
      treeSeeded.current = true;
    }
  }, [status]);

  if (!status) {
    return (
      <>
        <PageHead title="星图组网" sub="树状反向 WebSocket 组网：本机可接受子节点连入，也可作为分支外连上游父节点。" />
        <SkeletonRows />
      </>
    );
  }

  const tr = status.tree || {};
  const up = tr.upstream || {};
  const children = tr.children || [];
  const ds = tr.directStats || {};
  const dts = tr.directTunnels || [];

  const badge = up.connected
    ? { variant: "ok" as const, text: "已连接上游" }
    : up.enabled
      ? { variant: "warn" as const, text: "重连中" }
      : { variant: "muted" as const, text: "独立节点" };
  const detail = up.connected
    ? `已连通 ${up.url}`
    : up.enabled
      ? up.lastError
        ? `连接中（${up.lastError}）`
        : "正在尝试连接上游..."
      : "未配置上游父节点";

  const publicBase = status.publicUrl || status.tunnel?.publicUrl || "";
  const publicWs =
    publicBase && !/^http:\/\/(127\.0\.0\.1|localhost|\[?::1\]?)/i.test(publicBase)
      ? publicBase.replace(/^http/i, "ws") + "/ws/tree"
      : status.localWsUrl;
  const childJoinUrl = publicWs || "ws://127.0.0.1:3939/ws/tree";

  async function saveUpstream(enabled: boolean) {
    const res = await api.saveUpstream({
      nodeId: tNodeId.trim(),
      enabled,
      url: tUpUrl.trim(),
      token: tUpToken.trim()
    });
    toast(res.ok ? (enabled ? "已开始连接上游父节点..." : "已断开上游连接") : res.error || "操作失败");
    window.setTimeout(refresh, 1200);
  }

  async function saveToggles() {
    const res = await api.saveSettings({
      directEnabled: swDirect,
      advertiseLan: swLan,
      publicUrl: sPublicUrl.trim(),
      publicConsole: swPubCon
    });
    toast(res.ok ? "设置已保存" : res.error || "保存失败");
  }

  async function doRemoveChild(nodeId: string) {
    const res = await api.removeChild(nodeId);
    toast(res.ok ? `已移除 ${nodeId}` : res.error || "移除失败");
    refresh();
  }

  return (
    <>
      <div className="pt-3">
        <Constellation tree={tr} height={140} />
      </div>
      <PageHead title="星图组网" sub="树状反向 WebSocket 组网：本机可接受子节点连入，也可作为分支外连上游父节点。" />

      <Block
        title="连接上游父节点"
        sub="主动外连父节点，免公网 IP。父节点将能调用本机项目，本机无法反向调用父节点或兄弟节点。"
        side={<StatusTag variant={badge.variant}>{badge.text}</StatusTag>}
      >
        <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,220px),1fr))] gap-3">
          <Field>
            <FieldLabel htmlFor="tNodeId">本机节点名</FieldLabel>
            <Input id="tNodeId" value={tNodeId} onChange={(e) => setTNodeId(e.target.value)} placeholder="home-pc" />
          </Field>
          <Field>
            <FieldLabel htmlFor="tUpUrl">上游父节点 WS 地址</FieldLabel>
            <Input id="tUpUrl" value={tUpUrl} onChange={(e) => setTUpUrl(e.target.value)} placeholder="例如 wss://parent.example.com/ws/tree" />
          </Field>
          <Field>
            <FieldLabel htmlFor="tUpToken">上游父节点入网 Token</FieldLabel>
            <Input id="tUpToken" type="password" value={tUpToken} onChange={(e) => setTUpToken(e.target.value)} placeholder="粘贴父节点的 join-token" />
          </Field>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2.5">
          <Button onClick={() => saveUpstream(true)}>保存并连接上游</Button>
          <Button variant="outline" className="text-destructive" onClick={() => saveUpstream(false)}>断开上游（转为独立根节点）</Button>
          <span className="text-muted-foreground text-xs">{detail}</span>
        </div>
      </Block>

      <Block title="子节点接入信息" sub="把下面的地址与入网 Token 填进其他设备的“上游父节点”，它们就会连入本机。">
        <FieldRow label="接入地址">
          <MonoBox>{childJoinUrl}</MonoBox>
          <CopyButton text={childJoinUrl} message="已复制子节点接入地址" />
        </FieldRow>
        <FieldRow label="入网 Token" className="mt-2.5">
          <MaskedValue
            visible={showJoinToken}
            onToggle={() => setShowJoinToken((v) => !v)}
            value={status.joinToken || undefined}
            emptyText="未配置"
            copyMessage="已复制入网 Token"
          />
        </FieldRow>
      </Block>

      <Block title="直连与广播设置" sub="优先让父子节点之间建立直连隧道，失败时自动回退到树内中继。">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
          <label className="flex cursor-pointer items-center gap-2.5 text-[13px]">
            <Switch checked={swDirect} onCheckedChange={setSwDirect} />
            优先直连隧道（Direct-First）
          </label>
          <label className="flex cursor-pointer items-center gap-2.5 text-[13px]">
            <Switch checked={swLan} onCheckedChange={setSwLan} />
            广播局域网候选地址（advertiseLan）
          </label>
        </div>
        <Field className="mt-3 max-w-[420px]">
          <FieldLabel htmlFor="sPublicUrl">固定公网地址 publicUrl（可选）</FieldLabel>
          <Input id="sPublicUrl" value={sPublicUrl} onChange={(e) => setSPublicUrl(e.target.value)} placeholder="https://astra.example.com" />
        </Field>
        <label className="mt-3 flex cursor-pointer items-center gap-2.5 text-[13px]">
          <Switch checked={swPubCon} onCheckedChange={setSwPubCon} />
          公网控制台
        </label>
        <div className="text-muted-foreground mt-1 text-xs">
          需已配置公网地址且为 bearer 鉴权；关闭后经公网访问的控制台会立即失效。
        </div>
        <div className="mt-2.5">
          <Button variant="outline" size="sm" onClick={saveToggles}>保存设置</Button>
        </div>
        <div className="text-muted-foreground mt-2 text-xs">
          直连隧道：{dts.length} 条活跃，直连调用 {ds.directCalls || 0} 次，自动回退中继 {ds.relayCalls || 0} 次
        </div>
      </Block>

      <Block title="已连入的子节点">
        {!children.length ? (
          <Empty className="border-border border border-dashed">
            <EmptyHeader>
              <EmptyTitle>当前还没有子节点连入本机</EmptyTitle>
              <EmptyDescription>在其他设备填入上方接入地址与入网 Token 后，它们会自动出现在这里。</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>子节点名</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>挂载项目（调用前缀：节点名/项目名）</TableHead>
                <TableHead>上线时间</TableHead>
                <TableHead>操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <AnimatePresence initial={false}>
                {children.map((c) => (
                  <motion.tr
                    key={c.nodeId}
                    layout
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.2 }}
                    className="border-border border-b transition-colors"
                  >
                    <TableCell><strong>{c.nodeId}</strong></TableCell>
                    <TableCell>
                      <StatusTag variant={c.online ? "ok" : "err"}>{c.online ? "在线" : "离线"}</StatusTag>
                    </TableCell>
                    <TableCell>
                      <code className="font-mono text-xs">
                        {(c.projects || []).map((p) => `${c.nodeId}/${p}`).join(", ") || "(无)"}
                      </code>
                    </TableCell>
                    <TableCell>{(c.connectedAt || "").replace("T", " ").slice(0, 19)}</TableCell>
                    <TableCell>
                      <Button variant="outline" size="sm" className="text-destructive" onClick={() => setRemoveTarget(c.nodeId)}>移除/重置</Button>
                    </TableCell>
                  </motion.tr>
                ))}
              </AnimatePresence>
            </TableBody>
          </Table>
        )}
      </Block>

      <RemoteSection />

      <ConfirmDialog
        open={removeTarget !== null}
        onOpenChange={(o) => !o && setRemoveTarget(null)}
        title="移除子节点"
        description={`确定移除并重置子节点 "${removeTarget}" 的入网绑定？`}
        onConfirm={() => {
          if (removeTarget) void doRemoveChild(removeTarget);
          setRemoveTarget(null);
        }}
      />
    </>
  );
}
