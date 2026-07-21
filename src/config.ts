import { createHash } from 'node:crypto';
import { access, chmod, mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { parse as parseJsonc, type ParseError } from 'jsonc-parser';
import { parse as parseToml } from 'smol-toml';
import { CliError } from './errors.js';
import type {
  DiscoveryOptions,
  DiscoveryResult,
  DiscoveredServer,
  HttpServerConfig,
  NormalizedServerConfig,
  ServerReference,
  ServerSource,
  ServerSourceKind,
  ServerSourceScope,
  SourceDiagnostic,
  StdioServerConfig,
} from './types.js';

const DEFAULT_STARTUP_TIMEOUT_MS = 10_000;
const DEFAULT_TOOL_TIMEOUT_MS = 60_000;

interface SourceCandidate {
  kind: ServerSourceKind;
  scope: ServerSourceScope;
  path: string;
  parse: (content: string) => unknown;
  extract: (document: unknown) => Record<string, unknown>;
}

interface RawServerRecord {
  name: string;
  config: NormalizedServerConfig;
  source: ServerSource;
}

interface OwnConfigDocument {
  $schema?: string;
  version: 1;
  mcpServers: Record<string, unknown>;
}

const SOURCE_KIND_PRIORITY: Record<ServerSourceKind, number> = {
  'mcp-cli': 0,
  explicit: 1,
  project: 2,
  claude: 3,
  'claude-desktop': 4,
  codex: 5,
  cursor: 6,
  vscode: 7,
  gemini: 8,
};

const SOURCE_SCOPE_PRIORITY: Record<ServerSourceScope, number> = {
  project: 0,
  local: 1,
  user: 2,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function asStringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
}

function mergeStringRecords(...records: unknown[]): Record<string, string> {
  return records.reduce<Record<string, string>>(
    (merged, record) => ({ ...merged, ...asStringRecord(record) }),
    {},
  );
}

function parseJsonDocument(content: string): unknown {
  const errors: ParseError[] = [];
  const document: unknown = parseJsonc(content, errors, {
    allowEmptyContent: false,
    allowTrailingComma: true,
  });
  if (errors.length > 0) {
    throw new Error(`JSON parse failed at offset ${errors[0]?.offset ?? 0}`);
  }
  return document;
}

function parseTomlDocument(content: string): unknown {
  return parseToml(content);
}

function serverMap(document: unknown, key: 'mcpServers' | 'servers' = 'mcpServers'): Record<string, unknown> {
  if (!isRecord(document)) return {};
  const value = document[key];
  return isRecord(value) ? value : {};
}

function codexServerMap(document: unknown): Record<string, unknown> {
  if (!isRecord(document)) return {};
  return isRecord(document.mcp_servers) ? document.mcp_servers : {};
}

function claudeProjectServerMap(document: unknown, projectRoot: string): Record<string, unknown> {
  if (!isRecord(document) || !isRecord(document.projects)) return {};
  const resolvedRoot = resolve(projectRoot);
  const entries = Object.entries(document.projects).filter(([path]) => resolve(path) === resolvedRoot);
  const project = entries[0]?.[1];
  return isRecord(project) && isRecord(project.mcpServers) ? project.mcpServers : {};
}

function expandString(value: string, env: NodeJS.ProcessEnv, projectRoot: string, home: string): string {
  let expanded = value
    .replaceAll('${workspaceFolder}', projectRoot)
    .replaceAll('${userHome}', home)
    .replace(/\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
      const resolvedValue = env[name];
      if (resolvedValue === undefined) throw new Error(`Environment variable ${name} is not set`);
      return resolvedValue;
    });

  if (/\$\{input:[^}]+\}/.test(expanded) || /\$\{command:[^}]+\}/.test(expanded)) {
    throw new Error(`Interactive input is unresolved in ${value}`);
  }

  expanded = expanded.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g,
    (_match, name: string, fallback: string | undefined) => {
      const resolvedValue = env[name];
      if (resolvedValue !== undefined) return resolvedValue;
      if (fallback !== undefined) return fallback;
      throw new Error(`Environment variable ${name} is not set`);
    },
  );
  return expanded.replace(/(^|[^$])\$([A-Za-z_][A-Za-z0-9_]*)/g, (_match, prefix: string, name: string) => {
    const resolvedValue = env[name];
    if (resolvedValue === undefined) throw new Error(`Environment variable ${name} is not set`);
    return `${prefix}${resolvedValue}`;
  });
}

function expandValue(value: unknown, env: NodeJS.ProcessEnv, projectRoot: string, home: string): unknown {
  if (typeof value === 'string') return expandString(value, env, projectRoot, home);
  if (Array.isArray(value)) return value.map((item) => expandValue(item, env, projectRoot, home));
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, expandValue(item, env, projectRoot, home)]),
    );
  }
  return value;
}

function normalizeTimeout(
  raw: Record<string, unknown>,
  millisecondsKey: string,
  secondsKey: string,
  fallback: number,
): number {
  const milliseconds = asNumber(raw[millisecondsKey]);
  if (milliseconds !== undefined) return milliseconds;
  const seconds = asNumber(raw[secondsKey]);
  return seconds === undefined ? fallback : seconds * 1_000;
}

function normalizeRawServer(rawValue: unknown): NormalizedServerConfig {
  if (!isRecord(rawValue)) throw new Error('Server definition must be an object');
  const rawType = asString(rawValue.type)?.toLowerCase();
  if (rawType === 'sse' || typeof rawValue.sseUrl === 'string') {
    throw new CliError({
      category: 'config',
      code: 'LEGACY_SSE_UNSUPPORTED',
      message: 'Legacy SSE transports are not supported; migrate this server to Streamable HTTP.',
    });
  }

  const enabled = asBoolean(rawValue.enabled) ?? !asBoolean(rawValue.disabled);
  const startupTimeoutMs = normalizeTimeout(
    rawValue,
    'startupTimeoutMs',
    'startup_timeout_sec',
    DEFAULT_STARTUP_TIMEOUT_MS,
  );
  const toolTimeoutMs = normalizeTimeout(
    rawValue,
    'toolTimeoutMs',
    'tool_timeout_sec',
    DEFAULT_TOOL_TIMEOUT_MS,
  );
  const url = asString(rawValue.url) ?? asString(rawValue.httpUrl) ?? asString(rawValue.serverUrl);

  if (url !== undefined || rawType === 'http' || rawType === 'streamable-http') {
    if (!url) throw new Error('HTTP server definition is missing url');
    const parsedUrl = new URL(url);
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      throw new Error(`Unsupported HTTP URL protocol ${parsedUrl.protocol}`);
    }
    return {
      transport: 'http',
      url: parsedUrl.toString(),
      enabled,
      headers: mergeStringRecords(rawValue.headers, rawValue.http_headers),
      headerEnv: mergeStringRecords(rawValue.headerEnv, rawValue.env_http_headers),
      ...((asString(rawValue.bearerTokenEnvVar) ?? asString(rawValue.bearer_token_env_var))
        ? {
            bearerTokenEnvVar:
              asString(rawValue.bearerTokenEnvVar) ?? asString(rawValue.bearer_token_env_var) ?? '',
          }
        : {}),
      startupTimeoutMs,
      toolTimeoutMs,
    } satisfies HttpServerConfig;
  }

  const command = asString(rawValue.command);
  if (!command) throw new Error('Stdio server definition is missing command');
  return {
    transport: 'stdio',
    command,
    args: asStringArray(rawValue.args),
    ...(asString(rawValue.cwd) ? { cwd: asString(rawValue.cwd) } : {}),
    env: asStringRecord(rawValue.env),
    envVars: [...new Set([...asStringArray(rawValue.envVars), ...asStringArray(rawValue.env_vars)])],
    enabled,
    startupTimeoutMs,
    toolTimeoutMs,
  } satisfies StdioServerConfig;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stableValue(value[key])]),
  );
}

function fingerprint(config: NormalizedServerConfig): string {
  return createHash('sha256')
    .update(JSON.stringify(stableValue(config)))
    .digest('hex');
}

function sourceId(source: ServerSource, name: string): string {
  return `${source.kind}:${source.scope}/${name}`;
}

function compareSources(left: ServerSource, right: ServerSource): number {
  return (
    SOURCE_KIND_PRIORITY[left.kind] - SOURCE_KIND_PRIORITY[right.kind] ||
    SOURCE_SCOPE_PRIORITY[left.scope] - SOURCE_SCOPE_PRIORITY[right.scope]
  );
}

function preferredSource(server: DiscoveredServer): ServerSource {
  const source = server.sources.toSorted(compareSources)[0];
  if (!source) throw new Error(`Server ${server.name} has no configuration source`);
  return source;
}

function compareServers(left: DiscoveredServer, right: DiscoveredServer): number {
  const leftSource = preferredSource(left);
  const rightSource = preferredSource(right);
  return compareSources(leftSource, rightSource) || left.id.localeCompare(right.id);
}

function deduplicate(records: RawServerRecord[]): DiscoveredServer[] {
  const byNameAndFingerprint = new Map<string, RawServerRecord[]>();
  for (const record of records) {
    if (!record.config.enabled) continue;
    const key = `${record.name}\0${fingerprint(record.config)}`;
    const group = byNameAndFingerprint.get(key) ?? [];
    group.push(record);
    byNameAndFingerprint.set(key, group);
  }

  return [...byNameAndFingerprint.values()]
    .map((group) => {
      const first = group[0];
      if (!first) throw new Error('Unexpected empty server group');
      return {
        id: sourceId(first.source, first.name),
        name: first.name,
        config: first.config,
        sources: group.map((record) => record.source),
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name) || compareServers(left, right));
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function findProjectRoot(cwd: string): Promise<string> {
  let current = resolve(cwd);
  for (;;) {
    if (await pathExists(join(current, '.git'))) return current;
    const parent = dirname(current);
    if (parent === current) return resolve(cwd);
    current = parent;
  }
}

async function vscodeProfileCandidates(userDirectory: string): Promise<SourceCandidate[]> {
  const profilesDirectory = join(userDirectory, 'profiles');
  let profileNames: string[] = [];
  try {
    profileNames = (await readdir(profilesDirectory)).sort();
  } catch {
    // VS Code profiles are optional.
  }
  return [
    {
      kind: 'vscode',
      scope: 'user',
      path: join(userDirectory, 'mcp.json'),
      parse: parseJsonDocument,
      extract: (document) => serverMap(document, 'servers'),
    },
    ...profileNames.map((profile): SourceCandidate => ({
      kind: 'vscode',
      scope: 'user',
      path: join(profilesDirectory, profile, 'mcp.json'),
      parse: parseJsonDocument,
      extract: (document) => serverMap(document, 'servers'),
    })),
  ];
}

async function buildCandidates(input: {
  home: string;
  projectRoot: string;
  explicitPaths: string[];
}): Promise<SourceCandidate[]> {
  const vscodeUser = join(input.home, 'Library', 'Application Support', 'Code', 'User');
  const jsonMcpServers = (
    kind: ServerSourceKind,
    scope: ServerSourceScope,
    path: string,
  ): SourceCandidate => ({
    kind,
    scope,
    path,
    parse: parseJsonDocument,
    extract: (document) => serverMap(document),
  });
  return [
    jsonMcpServers('mcp-cli', 'user', join(input.home, '.mcp-cli', 'config.json')),
    jsonMcpServers('project', 'project', join(input.projectRoot, '.mcp.json')),
    jsonMcpServers('cursor', 'project', join(input.projectRoot, '.cursor', 'mcp.json')),
    {
      kind: 'vscode',
      scope: 'project',
      path: join(input.projectRoot, '.vscode', 'mcp.json'),
      parse: parseJsonDocument,
      extract: (document) => serverMap(document, 'servers'),
    },
    jsonMcpServers('gemini', 'project', join(input.projectRoot, '.gemini', 'settings.json')),
    {
      kind: 'codex',
      scope: 'project',
      path: join(input.projectRoot, '.codex', 'config.toml'),
      parse: parseTomlDocument,
      extract: codexServerMap,
    },
    {
      kind: 'claude',
      scope: 'user',
      path: join(input.home, '.claude.json'),
      parse: parseJsonDocument,
      extract: (document) => serverMap(document),
    },
    {
      kind: 'claude',
      scope: 'local',
      path: join(input.home, '.claude.json'),
      parse: parseJsonDocument,
      extract: (document) => claudeProjectServerMap(document, input.projectRoot),
    },
    jsonMcpServers(
      'claude-desktop',
      'user',
      join(input.home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'),
    ),
    jsonMcpServers('cursor', 'user', join(input.home, '.cursor', 'mcp.json')),
    {
      kind: 'codex',
      scope: 'user',
      path: join(input.home, '.codex', 'config.toml'),
      parse: parseTomlDocument,
      extract: codexServerMap,
    },
    ...(await vscodeProfileCandidates(vscodeUser)),
    jsonMcpServers('gemini', 'user', join(input.home, '.gemini', 'settings.json')),
    ...input.explicitPaths.map((path): SourceCandidate => {
      const absolutePath = resolve(path);
      const isToml = extname(absolutePath).toLowerCase() === '.toml';
      return {
        kind: 'explicit',
        scope: 'user',
        path: absolutePath,
        parse: isToml ? parseTomlDocument : parseJsonDocument,
        extract: (document) => {
          if (isToml) return codexServerMap(document);
          const mcpServers = serverMap(document);
          return Object.keys(mcpServers).length > 0 ? mcpServers : serverMap(document, 'servers');
        },
      };
    }),
  ];
}

export async function discoverServers(options: DiscoveryOptions = {}): Promise<DiscoveryResult> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const home = resolve(options.homeDirectory ?? homedir());
  const projectRoot = await findProjectRoot(cwd);
  const env = options.env ?? process.env;
  const candidates = await buildCandidates({
    home,
    projectRoot,
    explicitPaths: options.explicitPaths ?? [],
  });
  const records: RawServerRecord[] = [];
  const diagnostics: SourceDiagnostic[] = [];

  for (const candidate of candidates) {
    const exists = await pathExists(candidate.path);
    const diagnostic: SourceDiagnostic = {
      source: { kind: candidate.kind, scope: candidate.scope, path: candidate.path },
      exists,
      loaded: false,
      serverCount: 0,
    };
    if (!exists) {
      diagnostics.push(diagnostic);
      continue;
    }
    try {
      const content = await readFile(candidate.path, 'utf8');
      const expanded = expandValue(candidate.parse(content), env, projectRoot, home);
      const rawServers = candidate.extract(expanded);
      for (const [name, rawServer] of Object.entries(rawServers)) {
        const source: ServerSource = {
          kind: candidate.kind,
          scope: candidate.scope,
          path: candidate.path,
          key: name,
        };
        records.push({ name, config: normalizeRawServer(rawServer), source });
      }
      diagnostic.loaded = true;
      diagnostic.serverCount = Object.keys(rawServers).length;
    } catch (error) {
      diagnostic.error = error instanceof Error ? error.message : String(error);
    }
    diagnostics.push(diagnostic);
  }

  return { servers: deduplicate(records), sources: diagnostics };
}

export function resolveServerCandidates(servers: DiscoveredServer[], reference: string): DiscoveredServer[] {
  const exact = servers.filter(
    (server) =>
      server.id === reference || server.sources.some((source) => sourceId(source, server.name) === reference),
  );
  if (exact.length > 0) return exact.toSorted(compareServers);
  const matching = servers.filter((server) => server.name === reference).toSorted(compareServers);
  if (matching.length > 0) return matching;
  throw new CliError({
    category: 'resolution',
    code: 'SERVER_NOT_FOUND',
    message: `No configured MCP server matches ${reference}.`,
    details: { available: servers.map((server) => server.id) },
  });
}

export function resolveServer(servers: DiscoveredServer[], reference: string): DiscoveredServer {
  const server = resolveServerCandidates(servers, reference)[0];
  if (!server) throw new Error(`Unexpected empty resolution result for ${reference}`);
  return server;
}

export function serverReference(server: DiscoveredServer): ServerReference {
  return {
    id: server.id,
    name: server.name,
    sources: server.sources,
    transport: server.config.transport,
  };
}

export function redactServer(server: DiscoveredServer): unknown {
  const config = server.config;
  const redactedConfig =
    config.transport === 'stdio'
      ? {
          ...config,
          env: Object.fromEntries(Object.keys(config.env).map((key) => [key, '[REDACTED]'])),
        }
      : {
          ...config,
          headers: Object.fromEntries(Object.keys(config.headers).map((key) => [key, '[REDACTED]'])),
        };
  return { ...serverReference(server), config: redactedConfig };
}

export function ownConfigPath(homeDirectory = homedir()): string {
  return join(homeDirectory, '.mcp-cli', 'config.json');
}

async function readOwnDocument(path: string): Promise<OwnConfigDocument> {
  try {
    const document = parseJsonDocument(await readFile(path, 'utf8'));
    if (!isRecord(document)) throw new Error('Config root must be an object');
    return {
      ...(typeof document.$schema === 'string' ? { $schema: document.$schema } : {}),
      version: 1,
      mcpServers: isRecord(document.mcpServers) ? document.mcpServers : {},
    };
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return { version: 1, mcpServers: {} };
    }
    throw error;
  }
}

async function writeOwnDocument(path: string, document: OwnConfigDocument): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { mode: 0o700, recursive: true });
  await chmod(directory, 0o700);
  const tempPath = join(directory, `.${basename(path)}.${process.pid}.tmp`);
  await writeFile(tempPath, `${JSON.stringify(document, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await chmod(tempPath, 0o600);
  await rename(tempPath, path);
  await chmod(path, 0o600);
}

export async function addOwnedServer(input: {
  name: string;
  rawConfig: Record<string, unknown>;
  force?: boolean;
  homeDirectory?: string;
}): Promise<void> {
  normalizeRawServer(input.rawConfig);
  const path = ownConfigPath(input.homeDirectory);
  const document = await readOwnDocument(path);
  if (document.mcpServers[input.name] !== undefined && !input.force) {
    throw new CliError({
      category: 'config',
      code: 'SERVER_ALREADY_EXISTS',
      message: `mcp-cli already owns a server named ${input.name}; pass --force to replace it.`,
    });
  }
  document.$schema ??= 'https://raw.githubusercontent.com/ricokahler/mcp-cli/main/config.schema.json';
  document.mcpServers[input.name] = input.rawConfig;
  await writeOwnDocument(path, document);
}

export async function removeOwnedServer(input: { name: string; homeDirectory?: string }): Promise<void> {
  const path = ownConfigPath(input.homeDirectory);
  const document = await readOwnDocument(path);
  if (document.mcpServers[input.name] === undefined) {
    throw new CliError({
      category: 'resolution',
      code: 'OWNED_SERVER_NOT_FOUND',
      message: `No mcp-cli-owned server named ${input.name} exists.`,
    });
  }
  document.mcpServers = Object.fromEntries(
    Object.entries(document.mcpServers).filter(([name]) => name !== input.name),
  );
  await writeOwnDocument(path, document);
}

export async function inspectPathMode(path: string): Promise<number | undefined> {
  try {
    return (await stat(path)).mode & 0o777;
  } catch {
    return undefined;
  }
}
