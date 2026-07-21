import { createHash } from 'node:crypto';
import { AsyncEntry, findCredentialsAsync } from '@napi-rs/keyring';
import { CliError } from './errors.js';

export const KEYCHAIN_SERVICE = '@ricokahler/mcp-cli';

export interface CredentialStore {
  get(account: string): Promise<string | undefined>;
  set(account: string, value: string): Promise<void>;
  delete(account: string): Promise<boolean>;
  available(): Promise<boolean>;
}

export class MacOsKeychainStore implements CredentialStore {
  async get(account: string): Promise<string | undefined> {
    try {
      return (await new AsyncEntry(KEYCHAIN_SERVICE, account).getPassword()) ?? undefined;
    } catch (error) {
      throw keychainError(error);
    }
  }

  async set(account: string, value: string): Promise<void> {
    try {
      await new AsyncEntry(KEYCHAIN_SERVICE, account).setPassword(value);
    } catch (error) {
      throw keychainError(error);
    }
  }

  async delete(account: string): Promise<boolean> {
    try {
      return await new AsyncEntry(KEYCHAIN_SERVICE, account).deleteCredential();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/no entry|not found/i.test(message)) return false;
      throw keychainError(error);
    }
  }

  async available(): Promise<boolean> {
    try {
      await findCredentialsAsync(KEYCHAIN_SERVICE);
      return true;
    } catch {
      return false;
    }
  }
}

function keychainError(error: unknown): CliError {
  return new CliError({
    category: 'auth',
    code: 'KEYCHAIN_ERROR',
    message: `macOS Keychain operation failed: ${error instanceof Error ? error.message : String(error)}`,
    cause: error,
  });
}

export function credentialAccount(serverUrl: string): string {
  const normalizedUrl = new URL(serverUrl).toString();
  return `oauth:${createHash('sha256').update(normalizedUrl).digest('hex')}`;
}
