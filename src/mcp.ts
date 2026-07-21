import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { CliError } from './errors.js';
import { KeychainOAuthProvider, createOAuthCallback, openBrowser } from './oauth.js';
import type { CredentialStore } from './keychain.js';
import type { DiscoveredServer } from './types.js';

export interface ConnectedClient {
  client: Client;
  protocolVersion?: string;
  close: () => Promise<void>;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined) {
    throw new CliError({
      category: 'config',
      code: 'CONFIG_UNRESOLVED',
      message: `Required environment variable ${name} is not set.`,
    });
  }
  return value;
}

function buildHttpHeaders(server: DiscoveredServer): Headers {
  if (server.config.transport !== 'http') return new Headers();
  const headers = new Headers(server.config.headers);
  for (const [header, environmentName] of Object.entries(server.config.headerEnv)) {
    headers.set(header, requiredEnvironment(environmentName));
  }
  if (server.config.bearerTokenEnvVar) {
    headers.set('authorization', `Bearer ${requiredEnvironment(server.config.bearerTokenEnvVar)}`);
  }
  return headers;
}

function transportFor(
  server: DiscoveredServer,
  options: { provider?: KeychainOAuthProvider } = {},
): Transport {
  if (server.config.transport === 'stdio') {
    const env = {
      ...getDefaultEnvironment(),
      ...server.config.env,
      ...Object.fromEntries(server.config.envVars.map((name) => [name, requiredEnvironment(name)])),
    };
    return new StdioClientTransport({
      command: server.config.command,
      args: server.config.args,
      env,
      ...(server.config.cwd ? { cwd: server.config.cwd } : {}),
      stderr: 'inherit',
    });
  }
  return new StreamableHTTPClientTransport(new URL(server.config.url), {
    ...(options.provider ? { authProvider: options.provider } : {}),
    requestInit: { headers: buildHttpHeaders(server) },
  });
}

function newClient(): Client {
  return new Client({ name: 'mcp-cli', version: '0.1.0' }, { capabilities: {} });
}

function protocolError(error: unknown, server: DiscoveredServer): CliError {
  if (error instanceof CliError) {
    if (error.code === 'AUTH_REQUIRED' && error.remediation === undefined) {
      return new CliError({
        category: 'auth',
        code: 'AUTH_REQUIRED',
        message: `Server ${server.name} requires OAuth authentication.`,
        remediation: { command: `mcp-cli auth login ${server.id}` },
        cause: error,
      });
    }
    return error;
  }
  if (error instanceof UnauthorizedError) {
    return new CliError({
      category: 'auth',
      code: 'AUTH_REQUIRED',
      message: `Server ${server.name} requires OAuth authentication.`,
      remediation: { command: `mcp-cli auth login ${server.id}` },
      cause: error,
    });
  }
  return new CliError({
    category: 'protocol',
    code: 'MCP_CONNECTION_FAILED',
    message: `MCP operation failed for ${server.name}: ${error instanceof Error ? error.message : String(error)}`,
    cause: error,
  });
}

export async function connectServer(
  server: DiscoveredServer,
  options: { store?: CredentialStore } = {},
): Promise<ConnectedClient> {
  const client = newClient();
  const provider =
    server.config.transport === 'http'
      ? new KeychainOAuthProvider({
          serverUrl: server.config.url,
          redirectUrl: new URL('http://127.0.0.1/callback'),
          store: options.store,
        })
      : undefined;
  const transport = transportFor(server, { provider });
  try {
    await client.connect(transport, { timeout: server.config.startupTimeoutMs });
  } catch (error) {
    await transport.close().catch(() => undefined);
    throw protocolError(error, server);
  }
  return {
    client,
    ...('protocolVersion' in transport && typeof transport.protocolVersion === 'string'
      ? { protocolVersion: transport.protocolVersion }
      : {}),
    close: async () => client.close(),
  };
}

export async function loginServer(
  server: DiscoveredServer,
  options: { store?: CredentialStore; onAuthorizationUrl?: (url: URL) => void | Promise<void> } = {},
): Promise<{ authenticated: true; alreadyAuthenticated: boolean }> {
  if (server.config.transport !== 'http') {
    throw new CliError({
      category: 'auth',
      code: 'OAUTH_UNSUPPORTED_TRANSPORT',
      message: 'OAuth login is available only for Streamable HTTP servers.',
    });
  }

  const callback = await createOAuthCallback();
  const provider = new KeychainOAuthProvider({
    serverUrl: server.config.url,
    redirectUrl: callback.redirectUrl,
    interactive: true,
    state: callback.state,
    store: options.store,
    onRedirect: async (url) => {
      await (options.onAuthorizationUrl?.(url) ?? openBrowser(url));
    },
  });
  const firstClient = newClient();
  const firstTransport = transportFor(server, { provider }) as StreamableHTTPClientTransport;
  try {
    try {
      await firstClient.connect(firstTransport, { timeout: server.config.startupTimeoutMs });
      await firstClient.close();
      return { authenticated: true, alreadyAuthenticated: true };
    } catch (error) {
      if (!(error instanceof UnauthorizedError)) throw error;
    }

    const authorizationCode = await callback.code;
    await firstTransport.finishAuth(authorizationCode);
    await firstTransport.close().catch(() => undefined);
    const verification = await connectServer(server, { store: options.store });
    await verification.close();
    return { authenticated: true, alreadyAuthenticated: false };
  } catch (error) {
    throw protocolError(error, server);
  } finally {
    await callback.close();
  }
}

export async function authStatus(
  server: DiscoveredServer,
  options: { store?: CredentialStore } = {},
): Promise<unknown> {
  if (server.config.transport !== 'http') {
    return { authenticated: false, supported: false, reason: 'stdio servers do not use MCP OAuth' };
  }
  const provider = new KeychainOAuthProvider({
    serverUrl: server.config.url,
    redirectUrl: new URL('http://127.0.0.1/callback'),
    store: options.store,
  });
  return { supported: true, ...(await provider.status()) };
}

export async function logoutServer(
  server: DiscoveredServer,
  options: { store?: CredentialStore } = {},
): Promise<{ deleted: boolean }> {
  if (server.config.transport !== 'http') {
    throw new CliError({
      category: 'auth',
      code: 'OAUTH_UNSUPPORTED_TRANSPORT',
      message: 'OAuth logout is available only for Streamable HTTP servers.',
    });
  }
  const provider = new KeychainOAuthProvider({
    serverUrl: server.config.url,
    redirectUrl: new URL('http://127.0.0.1/callback'),
    store: options.store,
  });
  return { deleted: await provider.logout() };
}

export async function withClient<T>(
  server: DiscoveredServer,
  action: (client: Client) => Promise<T>,
): Promise<T> {
  const connected = await connectServer(server);
  try {
    return await action(connected.client);
  } catch (error) {
    throw protocolError(error, server);
  } finally {
    await connected.close().catch(() => undefined);
  }
}

export async function listAllTools(client: Client, timeout: number): Promise<unknown[]> {
  const tools: unknown[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listTools(cursor ? { cursor } : undefined, { timeout });
    tools.push(...page.tools);
    cursor = page.nextCursor;
  } while (cursor);
  return tools;
}

export async function listAllResources(client: Client, timeout: number): Promise<unknown[]> {
  const resources: unknown[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listResources(cursor ? { cursor } : undefined, { timeout });
    resources.push(...page.resources);
    cursor = page.nextCursor;
  } while (cursor);
  return resources;
}

export async function listAllResourceTemplates(client: Client, timeout: number): Promise<unknown[]> {
  const resourceTemplates: unknown[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listResourceTemplates(cursor ? { cursor } : undefined, { timeout });
    resourceTemplates.push(...page.resourceTemplates);
    cursor = page.nextCursor;
  } while (cursor);
  return resourceTemplates;
}

export async function listAllPrompts(client: Client, timeout: number): Promise<unknown[]> {
  const prompts: unknown[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listPrompts(cursor ? { cursor } : undefined, { timeout });
    prompts.push(...page.prompts);
    cursor = page.nextCursor;
  } while (cursor);
  return prompts;
}
