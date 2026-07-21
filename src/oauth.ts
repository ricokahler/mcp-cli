import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { spawn } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import type { OAuthClientProvider, OAuthDiscoveryState } from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { CliError } from './errors.js';
import { credentialAccount, MacOsKeychainStore, type CredentialStore } from './keychain.js';

interface StoredOAuthRecord {
  version: 1;
  tokens?: OAuthTokens;
  clientInformation?: OAuthClientInformationMixed;
  codeVerifier?: string;
  discoveryState?: OAuthDiscoveryState;
}

export interface OAuthStatus {
  authenticated: boolean;
  hasClientInformation: boolean;
  hasRefreshToken: boolean;
  tokenType?: string;
  scope?: string;
  expiresIn?: number;
}

export class KeychainOAuthProvider implements OAuthClientProvider {
  readonly clientMetadataUrl = undefined;
  readonly redirectUrl: URL;
  readonly clientMetadata: OAuthClientMetadata;
  readonly account: string;
  private readonly store: CredentialStore;
  private readonly interactive: boolean;
  private readonly onRedirect?: (url: URL) => void | Promise<void>;
  private readonly oauthState: string;
  private recordPromise?: Promise<StoredOAuthRecord>;

  constructor(input: {
    serverUrl: string;
    redirectUrl: URL;
    interactive?: boolean;
    store?: CredentialStore;
    state?: string;
    onRedirect?: (url: URL) => void | Promise<void>;
  }) {
    this.redirectUrl = input.redirectUrl;
    this.store = input.store ?? new MacOsKeychainStore();
    this.account = credentialAccount(input.serverUrl);
    this.interactive = input.interactive ?? false;
    this.oauthState = input.state ?? randomBytes(24).toString('base64url');
    this.onRedirect = input.onRedirect;
    this.clientMetadata = {
      client_name: 'mcp-cli',
      redirect_uris: [this.redirectUrl.toString()],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      software_id: 'https://github.com/ricokahler/mcp-cli',
      software_version: '0.1.0',
    };
  }

  state(): string {
    return this.oauthState;
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    return (await this.load()).clientInformation;
  }

  async saveClientInformation(clientInformation: OAuthClientInformationMixed): Promise<void> {
    await this.update({ clientInformation });
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    return (await this.load()).tokens;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await this.update({ tokens });
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    if (!this.interactive) {
      throw new CliError({
        category: 'auth',
        code: 'AUTH_REQUIRED',
        message: 'This server requires OAuth authentication.',
      });
    }
    if (this.onRedirect) await this.onRedirect(authorizationUrl);
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    await this.update({ codeVerifier });
  }

  async codeVerifier(): Promise<string> {
    const verifier = (await this.load()).codeVerifier;
    if (!verifier) {
      throw new CliError({
        category: 'auth',
        code: 'OAUTH_STATE_MISSING',
        message: 'OAuth PKCE verifier is missing from Keychain.',
      });
    }
    return verifier;
  }

  async saveDiscoveryState(discoveryState: OAuthDiscoveryState): Promise<void> {
    await this.update({ discoveryState });
  }

  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    return (await this.load()).discoveryState;
  }

  async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): Promise<void> {
    if (scope === 'all') {
      await this.store.delete(this.account);
      this.recordPromise = Promise.resolve({ version: 1 });
      return;
    }
    const record = await this.load();
    if (scope === 'client') delete record.clientInformation;
    if (scope === 'tokens') delete record.tokens;
    if (scope === 'verifier') delete record.codeVerifier;
    if (scope === 'discovery') delete record.discoveryState;
    await this.save(record);
  }

  async status(): Promise<OAuthStatus> {
    const record = await this.load();
    return {
      authenticated: record.tokens?.access_token !== undefined,
      hasClientInformation: record.clientInformation !== undefined,
      hasRefreshToken: record.tokens?.refresh_token !== undefined,
      ...(record.tokens?.token_type ? { tokenType: record.tokens.token_type } : {}),
      ...(record.tokens?.scope ? { scope: record.tokens.scope } : {}),
      ...(record.tokens?.expires_in === undefined ? {} : { expiresIn: record.tokens.expires_in }),
    };
  }

  async logout(): Promise<boolean> {
    const deleted = await this.store.delete(this.account);
    this.recordPromise = Promise.resolve({ version: 1 });
    return deleted;
  }

  private async load(): Promise<StoredOAuthRecord> {
    this.recordPromise ??= this.store.get(this.account).then((value) => {
      if (!value) return { version: 1 };
      const parsed: unknown = JSON.parse(value);
      if (typeof parsed !== 'object' || parsed === null) throw new Error('Invalid OAuth Keychain record');
      return parsed as StoredOAuthRecord;
    });
    return structuredClone(await this.recordPromise);
  }

  private async update(patch: Partial<StoredOAuthRecord>): Promise<void> {
    const record = { ...(await this.load()), ...patch, version: 1 as const };
    await this.save(record);
  }

  private async save(record: StoredOAuthRecord): Promise<void> {
    await this.store.set(this.account, JSON.stringify(record));
    this.recordPromise = Promise.resolve(structuredClone(record));
  }
}

export interface OAuthCallback {
  redirectUrl: URL;
  state: string;
  code: Promise<string>;
  close: () => Promise<void>;
}

export async function createOAuthCallback(): Promise<OAuthCallback> {
  const state = randomBytes(24).toString('base64url');
  let resolveCode: ((code: string) => void) | undefined;
  let rejectCode: ((error: Error) => void) | undefined;
  const code = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });

  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== '/callback') {
      response.writeHead(404).end('Not found');
      return;
    }
    const error = url.searchParams.get('error');
    const returnedState = url.searchParams.get('state');
    const authorizationCode = url.searchParams.get('code');
    if (error) {
      response.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
      response.end('<h1>Authorization failed</h1><p>You can close this window.</p>');
      rejectCode?.(new Error(`OAuth authorization failed: ${error}`));
      return;
    }
    if (!authorizationCode || returnedState !== state) {
      response.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
      response.end('<h1>Invalid OAuth callback</h1><p>You can close this window.</p>');
      rejectCode?.(new Error('OAuth callback did not contain a valid code and state'));
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<h1>Authorization complete</h1><p>You can close this window and return to mcp-cli.</p>');
    resolveCode?.(authorizationCode);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  const redirectUrl = new URL(`http://127.0.0.1:${address.port}/callback`);

  return {
    redirectUrl,
    state,
    code,
    close: async () => {
      if (!server.listening) return;
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

export async function openBrowser(url: URL): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('open', [url.toString()], { detached: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}
