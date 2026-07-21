import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Server as McpServer } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { CredentialStore } from '../src/keychain.js';
import { authStatus, connectServer, listAllTools, loginServer, logoutServer } from '../src/mcp.js';
import type { DiscoveredServer } from '../src/types.js';

class MemoryStore implements CredentialStore {
  readonly values = new Map<string, string>();

  get(account: string): Promise<string | undefined> {
    return Promise.resolve(this.values.get(account));
  }

  set(account: string, value: string): Promise<void> {
    this.values.set(account, value);
    return Promise.resolve();
  }

  delete(account: string): Promise<boolean> {
    return Promise.resolve(this.values.delete(account));
  }

  available(): Promise<boolean> {
    return Promise.resolve(true);
  }
}

async function body(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array));
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return undefined;
  return request.headers['content-type']?.startsWith('application/json')
    ? (JSON.parse(text) as unknown)
    : text;
}

function json(
  response: ServerResponse,
  status: number,
  value: unknown,
  headers: Record<string, string> = {},
): void {
  response.writeHead(status, { 'content-type': 'application/json', ...headers });
  response.end(JSON.stringify(value));
}

interface OAuthFixture {
  url: string;
  close: () => Promise<void>;
  requests: {
    registrations: unknown[];
    authorizationQueries: URLSearchParams[];
    tokenForms: URLSearchParams[];
  };
  requireToken: (token: string) => void;
}

async function startHttpFixture(authenticated: boolean): Promise<OAuthFixture> {
  let origin = '';
  let requiredToken = authenticated ? 'access-one' : '';
  const requests = {
    registrations: [] as unknown[],
    authorizationQueries: [] as URLSearchParams[],
    tokenForms: [] as URLSearchParams[],
  };

  const httpServer = createServer(async (request, response) => {
    const requestUrl = new URL(request.url ?? '/', origin);
    const mcpUrl = `${origin}/mcp`;
    if (requestUrl.pathname === '/.well-known/oauth-protected-resource') {
      json(response, 200, {
        resource: mcpUrl,
        authorization_servers: [origin],
        scopes_supported: ['mcp:tools'],
      });
      return;
    }
    if (requestUrl.pathname === '/.well-known/oauth-authorization-server') {
      json(response, 200, {
        issuer: origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        registration_endpoint: `${origin}/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
      });
      return;
    }
    if (requestUrl.pathname === '/register') {
      const registration = await body(request);
      requests.registrations.push(registration);
      json(response, 201, {
        ...(typeof registration === 'object' && registration !== null ? registration : {}),
        client_id: 'mcp-cli-test',
        client_id_issued_at: Math.floor(Date.now() / 1000),
      });
      return;
    }
    if (requestUrl.pathname === '/token') {
      const tokenBody = await body(request);
      const form = new URLSearchParams(typeof tokenBody === 'string' ? tokenBody : '');
      requests.tokenForms.push(form);
      const grantType = form.get('grant_type');
      json(response, 200, {
        access_token: grantType === 'refresh_token' ? 'access-two' : 'access-one',
        token_type: 'Bearer',
        refresh_token: 'refresh-one',
        expires_in: 3600,
        scope: 'mcp:tools',
      });
      return;
    }
    if (requestUrl.pathname === '/authorize') {
      requests.authorizationQueries.push(requestUrl.searchParams);
      response.writeHead(204).end();
      return;
    }
    if (requestUrl.pathname !== '/mcp') {
      response.writeHead(404).end();
      return;
    }
    if (authenticated && request.headers.authorization !== `Bearer ${requiredToken}`) {
      response.writeHead(401, {
        'www-authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource", scope="mcp:tools"`,
      });
      response.end();
      return;
    }
    if (request.method !== 'POST') {
      response.writeHead(405).end();
      return;
    }

    const server = new McpServer(
      { name: authenticated ? 'oauth-http-fixture' : 'http-fixture', version: '1.0.0' },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: [{ name: 'remote', inputSchema: { type: 'object', additionalProperties: false } }],
    }));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    await transport.handleRequest(request, response, await body(request));
    response.on('close', () => {
      void transport.close();
      void server.close();
    });
  });
  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(0, '127.0.0.1', resolve);
  });
  const address = httpServer.address() as AddressInfo;
  origin = `http://127.0.0.1:${address.port}`;
  return {
    url: `${origin}/mcp`,
    requests,
    requireToken(token: string): void {
      requiredToken = token;
    },
    close: async () => {
      await new Promise<void>((resolve, reject) =>
        httpServer.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

function configuredServer(url: string): DiscoveredServer {
  return {
    id: 'explicit:user/remote',
    name: 'remote',
    config: {
      transport: 'http',
      url,
      enabled: true,
      headers: {},
      headerEnv: {},
      startupTimeoutMs: 5_000,
      toolTimeoutMs: 5_000,
    },
    sources: [{ kind: 'explicit', scope: 'user', path: '/fixture.json', key: 'remote' }],
  };
}

describe('Streamable HTTP and OAuth integration', () => {
  it('connects to an authless Streamable HTTP server', async () => {
    const fixture = await startHttpFixture(false);
    try {
      const connected = await connectServer(configuredServer(fixture.url), { store: new MemoryStore() });
      expect(connected.protocolVersion).toMatch(/^202/);
      expect(await listAllTools(connected.client, 5_000)).toMatchObject([{ name: 'remote' }]);
      await connected.close();
    } finally {
      await fixture.close();
    }
  });

  it('returns AUTH_REQUIRED without opening a browser during a normal operation', async () => {
    const fixture = await startHttpFixture(true);
    try {
      await expect(
        connectServer(configuredServer(fixture.url), { store: new MemoryStore() }),
      ).rejects.toMatchObject({
        code: 'AUTH_REQUIRED',
        exitCode: 4,
        remediation: { command: 'mcp-cli auth login explicit:user/remote' },
      });
    } finally {
      await fixture.close();
    }
  });

  it('completes discovery, DCR, PKCE, resource indication, refresh, status, and logout', async () => {
    const fixture = await startHttpFixture(true);
    const store = new MemoryStore();
    const server = configuredServer(fixture.url);
    try {
      const login = await loginServer(server, {
        store,
        onAuthorizationUrl: async (authorizationUrl) => {
          fixture.requests.authorizationQueries.push(authorizationUrl.searchParams);
          expect(authorizationUrl.searchParams.get('code_challenge_method')).toBe('S256');
          expect(authorizationUrl.searchParams.get('resource')).toBe(fixture.url);
          const redirect = new URL(authorizationUrl.searchParams.get('redirect_uri') ?? '');
          redirect.searchParams.set('code', 'authorization-code');
          redirect.searchParams.set('state', authorizationUrl.searchParams.get('state') ?? '');
          await fetch(redirect);
        },
      });
      expect(login).toEqual({ authenticated: true, alreadyAuthenticated: false });
      expect(fixture.requests.registrations).toHaveLength(1);
      expect(fixture.requests.tokenForms[0]?.get('code_verifier')).toBeTruthy();
      expect(fixture.requests.tokenForms[0]?.get('resource')).toBe(fixture.url);
      expect(await authStatus(server, { store })).toMatchObject({
        authenticated: true,
        hasClientInformation: true,
        hasRefreshToken: true,
        scope: 'mcp:tools',
      });

      fixture.requireToken('access-two');
      const refreshed = await connectServer(server, { store });
      expect(await listAllTools(refreshed.client, 5_000)).toHaveLength(1);
      await refreshed.close();
      expect(fixture.requests.tokenForms.some((form) => form.get('grant_type') === 'refresh_token')).toBe(
        true,
      );
      expect(await logoutServer(server, { store })).toEqual({ deleted: true });
      expect(await authStatus(server, { store })).toMatchObject({ authenticated: false });
    } finally {
      await fixture.close();
    }
  });
});
