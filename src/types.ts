export type ServerSourceKind =
  'claude' | 'claude-desktop' | 'codex' | 'cursor' | 'explicit' | 'gemini' | 'mcp-cli' | 'project' | 'vscode';

export type ServerSourceScope = 'local' | 'project' | 'user';

export interface ServerSource {
  kind: ServerSourceKind;
  scope: ServerSourceScope;
  path: string;
  key: string;
}

export interface CommonServerConfig {
  enabled: boolean;
  startupTimeoutMs: number;
  toolTimeoutMs: number;
}

export interface StdioServerConfig extends CommonServerConfig {
  transport: 'stdio';
  command: string;
  args: string[];
  cwd?: string;
  env: Record<string, string>;
  envVars: string[];
}

export interface HttpServerConfig extends CommonServerConfig {
  transport: 'http';
  url: string;
  headers: Record<string, string>;
  headerEnv: Record<string, string>;
  bearerTokenEnvVar?: string;
}

export type NormalizedServerConfig = HttpServerConfig | StdioServerConfig;

export interface DiscoveredServer {
  id: string;
  name: string;
  config: NormalizedServerConfig;
  sources: ServerSource[];
}

export interface SourceDiagnostic {
  source: Omit<ServerSource, 'key'>;
  exists: boolean;
  loaded: boolean;
  serverCount: number;
  error?: string;
}

export interface DiscoveryResult {
  servers: DiscoveredServer[];
  sources: SourceDiagnostic[];
}

export interface DiscoveryOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  explicitPaths?: string[];
  homeDirectory?: string;
}

export interface ServerReference {
  id: string;
  name: string;
  sources: ServerSource[];
  transport: 'http' | 'stdio';
}

export interface OutputDeliveryInline {
  mode: 'inline';
  bytes: number;
}

export interface OutputDeliveryFile {
  mode: 'file';
  path: string;
  mediaType: 'application/json';
  bytes: number;
  sha256: string;
}

export type OutputDelivery = OutputDeliveryFile | OutputDeliveryInline;

export interface SuccessEnvelope {
  ok: true;
  operation: string;
  server?: ServerReference;
  data: unknown;
  delivery: OutputDelivery;
}

export interface FailureEnvelope {
  ok: false;
  operation: string;
  error: {
    code: string;
    message: string;
    details?: unknown;
    remediation?: { command: string };
  };
}
