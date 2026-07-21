import type { CredentialStore } from '../src/keychain.js';
import { createOAuthCallback, KeychainOAuthProvider } from '../src/oauth.js';

class MemoryStore implements CredentialStore {
  readonly values = new Map<string, string>();

  async get(account: string): Promise<string | undefined> {
    return this.values.get(account);
  }

  async set(account: string, value: string): Promise<void> {
    this.values.set(account, value);
  }

  async delete(account: string): Promise<boolean> {
    return this.values.delete(account);
  }

  async available(): Promise<boolean> {
    return true;
  }
}

describe('OAuth provider', () => {
  it('stores token, registration, verifier, and discovery state only through the credential store', async () => {
    const store = new MemoryStore();
    const provider = new KeychainOAuthProvider({
      serverUrl: 'https://example.test/mcp',
      redirectUrl: new URL('http://127.0.0.1/callback'),
      store,
    });
    await provider.saveClientInformation({ client_id: 'client' });
    await provider.saveTokens({
      access_token: 'access',
      token_type: 'Bearer',
      refresh_token: 'refresh',
      scope: 'a b',
    });
    await provider.saveCodeVerifier('verifier');
    await provider.saveDiscoveryState({ authorizationServerUrl: 'https://auth.example.test' });
    expect(await provider.status()).toEqual({
      authenticated: true,
      hasClientInformation: true,
      hasRefreshToken: true,
      tokenType: 'Bearer',
      scope: 'a b',
    });
    expect(await provider.codeVerifier()).toBe('verifier');
    expect([...store.values.values()][0]).toContain('refresh');
    expect(await provider.logout()).toBe(true);
    expect(await provider.status()).toMatchObject({ authenticated: false });
  });

  it('does not launch authorization from a non-interactive operation', async () => {
    const provider = new KeychainOAuthProvider({
      serverUrl: 'https://example.test/mcp',
      redirectUrl: new URL('http://127.0.0.1/callback'),
      store: new MemoryStore(),
    });
    await expect(
      provider.redirectToAuthorization(new URL('https://auth.test/authorize')),
    ).rejects.toMatchObject({
      code: 'AUTH_REQUIRED',
      exitCode: 4,
    });
  });

  it('re-registers an interactive client when the loopback redirect changes', async () => {
    const store = new MemoryStore();
    const nonInteractive = new KeychainOAuthProvider({
      serverUrl: 'https://example.test/mcp',
      redirectUrl: new URL('http://127.0.0.1/callback'),
      store,
    });
    await nonInteractive.saveClientInformation({ client_id: 'stale-client' });

    const interactive = new KeychainOAuthProvider({
      serverUrl: 'https://example.test/mcp',
      redirectUrl: new URL('http://127.0.0.1:54321/callback'),
      interactive: true,
      store,
    });

    await expect(interactive.clientInformation()).resolves.toBeUndefined();
    await expect(interactive.status()).resolves.toMatchObject({ hasClientInformation: false });
  });

  it('keeps the registered client while OAuth tokens are present', async () => {
    const store = new MemoryStore();
    const registered = new KeychainOAuthProvider({
      serverUrl: 'https://example.test/mcp',
      redirectUrl: new URL('http://127.0.0.1:54321/callback'),
      store,
    });
    await registered.saveClientInformation({ client_id: 'authenticated-client' });
    await registered.saveTokens({ access_token: 'access', token_type: 'Bearer' });

    const interactive = new KeychainOAuthProvider({
      serverUrl: 'https://example.test/mcp',
      redirectUrl: new URL('http://127.0.0.1:54322/callback'),
      interactive: true,
      store,
    });

    await expect(interactive.clientInformation()).resolves.toMatchObject({
      client_id: 'authenticated-client',
    });
  });

  it('accepts a valid loopback callback and rejects an invalid state', async () => {
    const valid = await createOAuthCallback();
    await fetch(`${valid.redirectUrl.toString()}?code=ok&state=${valid.state}`);
    await expect(valid.code).resolves.toBe('ok');
    await valid.close();

    const invalid = await createOAuthCallback();
    const rejected = expect(invalid.code).rejects.toThrow('valid code and state');
    await fetch(`${invalid.redirectUrl.toString()}?code=nope&state=wrong`);
    await rejected;
    await invalid.close();
  });

  it('surfaces credential store failures', async () => {
    const store: CredentialStore = {
      get: async () => {
        throw new Error('keychain denied');
      },
      set: async () => undefined,
      delete: async () => false,
      available: async () => false,
    };
    const provider = new KeychainOAuthProvider({
      serverUrl: 'https://example.test/mcp',
      redirectUrl: new URL('http://127.0.0.1/callback'),
      store,
    });
    await expect(provider.status()).rejects.toThrow('keychain denied');
  });
});
