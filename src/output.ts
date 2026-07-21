import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FailureEnvelope, ServerReference, SuccessEnvelope } from './types.js';

export const INLINE_LIMIT_BYTES = 64 * 1024;
const MAX_SPILL_AGE_MS = 24 * 60 * 60 * 1000;

export interface OutputOptions {
  pretty?: boolean;
  stdout?: NodeJS.WritableStream;
  tempDirectory?: string;
  now?: Date;
}

function stableJson(value: unknown, pretty: boolean): string {
  return `${JSON.stringify(value, null, pretty ? 2 : undefined)}\n`;
}

async function cleanupOldSpills(directory: string, now: Date): Promise<void> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    return;
  }
  await Promise.all(
    names.map(async (name) => {
      const path = join(directory, name);
      try {
        const info = await stat(path);
        if (now.getTime() - info.mtimeMs > MAX_SPILL_AGE_MS) await rm(path, { force: true });
      } catch {
        // Opportunistic cleanup must never break the command result.
      }
    }),
  );
}

export async function writeSuccess(
  operation: string,
  data: unknown,
  server?: ServerReference,
  options: OutputOptions = {},
): Promise<SuccessEnvelope> {
  const stdout = options.stdout ?? process.stdout;
  const pretty = options.pretty ?? false;
  const serializedData = JSON.stringify(data);
  const bytes = Buffer.byteLength(serializedData);
  let envelope: SuccessEnvelope;

  if (bytes <= INLINE_LIMIT_BYTES) {
    envelope = {
      ok: true,
      operation,
      ...(server ? { server } : {}),
      data,
      delivery: { mode: 'inline', bytes },
    };
  } else {
    const directory = options.tempDirectory ?? join(tmpdir(), 'mcp-cli');
    await mkdir(directory, { mode: 0o700, recursive: true });
    await cleanupOldSpills(directory, options.now ?? new Date());
    const path = join(directory, `${Date.now()}-${randomUUID()}.json`);
    await writeFile(path, serializedData, { encoding: 'utf8', mode: 0o600 });
    await chmod(path, 0o600);
    envelope = {
      ok: true,
      operation,
      ...(server ? { server } : {}),
      data: null,
      delivery: {
        mode: 'file',
        path,
        mediaType: 'application/json',
        bytes,
        sha256: createHash('sha256').update(serializedData).digest('hex'),
      },
    };
  }

  stdout.write(stableJson(envelope, pretty));
  return envelope;
}

export function writeFailure(
  operation: string,
  error: { code: string; message: string; details?: unknown; remediation?: { command: string } },
  options: OutputOptions = {},
): FailureEnvelope {
  const envelope: FailureEnvelope = {
    ok: false,
    operation,
    error: {
      code: error.code,
      message: error.message,
      ...(error.details === undefined ? {} : { details: error.details }),
      ...(error.remediation === undefined ? {} : { remediation: error.remediation }),
    },
  };
  (options.stdout ?? process.stdout).write(stableJson(envelope, options.pretty ?? false));
  return envelope;
}
