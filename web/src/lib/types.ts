export interface SdkFunction {
  signature?: string;
  description?: string;
}

export interface SdkInfo {
  name: string;
  scope?: string;
  enabled: boolean;
  title?: string;
  category?: string;
  description?: string;
  functions?: Record<string, SdkFunction>;
}

export interface ProjectInfo {
  project: string;
  root?: string;
  mode?: string;
  description?: string;
  sdks: string[] | "*" | string;
  exists?: boolean;
}

export interface BackupInfo {
  project: string;
  backupId: string;
  createdAt: string;
  files?: string[];
}

export interface TunnelStatus {
  running?: boolean;
  mcpUrl?: string;
  publicUrl?: string;
  lastError?: string;
  hasToken?: boolean;
}

export interface UpstreamStatus {
  enabled?: boolean;
  connected?: boolean;
  url?: string;
  lastError?: string;
}

export interface ChildNode {
  nodeId: string;
  online: boolean;
  projects?: string[];
  connectedAt?: string;
}

export interface TreeStatus {
  nodeId?: string;
  upstream?: UpstreamStatus;
  children?: ChildNode[];
  directStats?: { directCalls?: number; relayCalls?: number };
  directTunnels?: unknown[];
}

export interface Settings {
  nodeId?: string;
  publicUrl?: string;
  publicConsole?: boolean;
  gatewayUrl?: string;
  directEnabled?: boolean;
  advertiseLan?: boolean;
  upstream?: { enabled?: boolean; url?: string; token?: string };
  tunnel?: { mode?: string; publicUrl?: string; hasToken?: boolean };
  [key: string]: unknown;
}

export interface GatewayCheckItem {
  name: string;
  ok: boolean;
  detail: string;
}

export interface GatewayCheckResult {
  ok?: boolean;
  error?: string;
  base?: string;
  checks?: GatewayCheckItem[];
}

export interface LogEntry {
  time: string;
  event: string;
  detail: string;
}

export interface RemoteStatus {
  address?: string;
  rendezvous?: {
    connected?: boolean;
    configured?: boolean;
    url?: string;
    lastError?: string;
  };
  p2p?: {
    listening?: boolean;
    port?: number;
    error?: string;
    enabled?: boolean;
    upnpEnabled?: boolean;
    candidates?: string[];
    upnp?: { state?: string; externalAddr?: string };
  };
  remotes?: Record<string, string>;
  remoteAllowFrom?: string[];
  channels?: {
    peer: string;
    mode: string;
    direction: string;
    since: string;
    bytesIn: number;
    bytesOut: number;
  }[];
}

export interface EnvItem {
  available: boolean;
  version?: string;
}

export interface StatusResponse {
  ok: boolean;
  error?: string;
  server?: { name: string; version: string };
  localMcpUrl: string;
  localWsUrl: string;
  authMode: string;
  authToken: string;
  joinToken: string;
  hasJoinToken: boolean;
  publicUrl: string;
  publicMcpUrl: string | null;
  publicConsole: boolean;
  rotatable?: { client?: boolean; join?: boolean; admin?: boolean };
  uptimeSec: number;
  settings: Settings;
  projects: ProjectInfo[];
  sdks: SdkInfo[];
  backups: BackupInfo[];
  tunnel: TunnelStatus;
  tree: TreeStatus;
  logs: LogEntry[];
}

export type PageId = "overview" | "connect" | "sdks" | "projects" | "tree" | "backups" | "env";
