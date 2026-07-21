import { randomUUID } from 'node:crypto';
import { MacOsKeychainStore } from '../src/keychain.js';

describe('real macOS Keychain integration', () => {
  it.runIf(process.env.MCP_CLI_REAL_KEYCHAIN === '1')(
    'creates, reads, and removes a unique credential',
    async () => {
      const store = new MacOsKeychainStore();
      const account = `integration-test:${randomUUID()}`;
      try {
        await store.set(account, 'temporary-secret');
        expect(await store.get(account)).toBe('temporary-secret');
      } finally {
        await store.delete(account);
      }
      expect(await store.get(account)).toBeUndefined();
    },
  );
});
