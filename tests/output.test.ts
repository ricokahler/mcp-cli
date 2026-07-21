import { createHash } from 'node:crypto';
import { mkdtemp, readFile, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { INLINE_LIMIT_BYTES, writeFailure, writeSuccess } from '../src/output.js';

function capture(): { stream: Writable; text: () => string } {
  let value = '';
  return {
    stream: new Writable({
      write(chunk: Buffer, _encoding, callback): void {
        value += chunk.toString();
        callback();
      },
    }),
    text: () => value,
  };
}

describe('output contract', () => {
  it('writes one inline success envelope', async () => {
    const output = capture();
    const envelope = await writeSuccess('test', { value: 1 }, undefined, { stdout: output.stream });
    expect(JSON.parse(output.text())).toEqual(envelope);
    expect(output.text().trim().split('\n')).toHaveLength(1);
    expect(envelope).toMatchObject({ ok: true, operation: 'test', delivery: { mode: 'inline' } });
  });

  it('writes one failure envelope', () => {
    const output = capture();
    writeFailure(
      'tools.call',
      { code: 'AUTH_REQUIRED', message: 'Login required', remediation: { command: 'mcp-cli auth login x' } },
      { stdout: output.stream },
    );
    expect(JSON.parse(output.text())).toEqual({
      ok: false,
      operation: 'tools.call',
      error: {
        code: 'AUTH_REQUIRED',
        message: 'Login required',
        remediation: { command: 'mcp-cli auth login x' },
      },
    });
  });

  it('spills large JSON unchanged with a private mode, size, and digest', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mcp-cli-output-'));
    const data = { value: 'x'.repeat(INLINE_LIMIT_BYTES + 1) };
    const serialized = JSON.stringify(data);
    const output = capture();
    const envelope = await writeSuccess('large', data, undefined, {
      stdout: output.stream,
      tempDirectory: directory,
    });
    expect(envelope.delivery.mode).toBe('file');
    if (envelope.delivery.mode !== 'file') throw new Error('expected file delivery');
    expect(await readFile(envelope.delivery.path, 'utf8')).toBe(serialized);
    expect((await stat(envelope.delivery.path)).mode & 0o777).toBe(0o600);
    expect(envelope.delivery.bytes).toBe(Buffer.byteLength(serialized));
    expect(envelope.delivery.sha256).toBe(createHash('sha256').update(serialized).digest('hex'));
    expect(JSON.parse(output.text()).data).toBeNull();
  });

  it('removes spills older than 24 hours opportunistically', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mcp-cli-output-cleanup-'));
    const oldPath = join(directory, 'old.json');
    await writeFile(oldPath, '{}');
    const old = new Date('2025-01-01T00:00:00Z');
    await utimes(oldPath, old, old);
    await writeSuccess('large', { value: 'x'.repeat(INLINE_LIMIT_BYTES + 1) }, undefined, {
      stdout: capture().stream,
      tempDirectory: directory,
      now: new Date('2025-01-03T00:00:00Z'),
    });
    await expect(stat(oldPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
