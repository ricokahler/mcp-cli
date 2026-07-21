import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { COMMAND_CATALOG } from '../src/catalog.js';

const root = resolve(import.meta.dirname, '..');
const cli = join(root, 'dist', 'cli.js');
const fixtureServer = join(root, 'tests', 'fixtures', 'stdio-server.mjs');

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function run(
  args: string[],
  options: { cwd?: string; input?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<RunResult> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd: options.cwd ?? root,
      env: { ...process.env, ...options.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    child.once('error', reject);
    child.once('close', (code) => resolveRun({ code: code ?? 1, stdout, stderr }));
    child.stdin.end(options.input);
  });
}

async function build(): Promise<void> {
  await new Promise<void>((resolveBuild, reject) => {
    const child = spawn(
      process.execPath,
      [join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.build.json'],
      {
        cwd: root,
        stdio: 'inherit',
      },
    );
    child.once('error', reject);
    child.once('close', (code) => (code === 0 ? resolveBuild() : reject(new Error(`build exited ${code}`))));
  });
}

describe('installed-shape CLI over stdio MCP', () => {
  let directory: string;
  let config: string;
  const configured = (args: string[]) => [...args, '--config', config];

  beforeAll(async () => {
    await build();
    directory = await mkdtemp(join(tmpdir(), 'mcp-cli-integration-'));
    await mkdir(join(directory, '.git'));
    config = join(directory, 'mcp.json');
    await writeFile(
      config,
      `${JSON.stringify({
        mcpServers: {
          fixture: {
            command: process.execPath,
            args: [fixtureServer],
            startupTimeoutMs: 5_000,
            toolTimeoutMs: 5_000,
          },
        },
      })}\n`,
    );
  });

  it('renders human and machine help from the same catalog without reading config', async () => {
    const broken = join(directory, 'broken.json');
    await writeFile(broken, '{');
    const machine = await run(['help', '--json', '--config', broken], { cwd: directory });
    expect(machine).toMatchObject({ code: 0, stderr: '' });
    expect(JSON.parse(machine.stdout).commands).toEqual(COMMAND_CATALOG);
    const top = await run(['--help'], { cwd: directory });
    const command = await run(['help', 'tools', 'call'], { cwd: directory });
    const nestedFlag = await run(['tools', 'call', 'fixture', 'echo', '--help'], { cwd: directory });
    expect(top.stdout).toContain('help --json');
    expect(command.stdout).toContain('Exit codes: 0, 2, 3, 4, 5');
    expect(nestedFlag.stdout).toBe(command.stdout);
  });

  it('inspects server identity and capabilities', async () => {
    const result = await run(configured(['inspect', 'fixture']), { cwd: directory });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      operation: 'inspect',
      data: {
        serverInfo: { name: 'mcp-cli-fixture', version: '1.0.0' },
        capabilities: { tools: {}, resources: {}, prompts: {} },
      },
    });
  });

  it('tries conflicting bare-name configs in priority order until one connects', async () => {
    const broken = join(directory, 'a-broken.json');
    await writeFile(
      broken,
      `${JSON.stringify({
        mcpServers: {
          fixture: {
            command: join(directory, 'missing-server-command'),
            startupTimeoutMs: 500,
          },
        },
      })}\n`,
    );
    const result = await run(['inspect', 'fixture', '--config', broken, '--config', config], {
      cwd: directory,
    });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      server: { sources: [{ path: config }] },
      data: { serverInfo: { name: 'mcp-cli-fixture' } },
    });
  });

  it('exhausts tool pagination, gets a schema, and calls tools with every input form', async () => {
    const listed = JSON.parse(
      (await run(configured(['tools', 'list', 'fixture']), { cwd: directory })).stdout,
    );
    expect(listed.data.tools.map((tool: { name: string }) => tool.name)).toEqual(['echo', 'large']);
    const got = JSON.parse(
      (await run(configured(['tools', 'get', 'fixture', 'echo']), { cwd: directory })).stdout,
    );
    expect(got.data).toMatchObject({ name: 'echo', inputSchema: { type: 'object' } });

    const inline = await run(configured(['tools', 'call', 'fixture', 'echo', '--input', '{"value":1}']), {
      cwd: directory,
    });
    expect(JSON.parse(inline.stdout).data.content[0].text).toBe('{"value":1}');
    const inputFile = join(directory, 'input.json');
    await writeFile(inputFile, '{"value":2}');
    const file = await run(configured(['tools', 'call', 'fixture', 'echo', '--input-file', inputFile]), {
      cwd: directory,
    });
    expect(JSON.parse(file.stdout).data.content[0].text).toBe('{"value":2}');
    const piped = await run(configured(['tools', 'call', 'fixture', 'echo']), {
      cwd: directory,
      input: '{"value":3}',
    });
    expect(JSON.parse(piped.stdout).data.content[0].text).toBe('{"value":3}');
  });

  it('exhausts resource and prompt pagination and preserves binary content', async () => {
    const resources = JSON.parse(
      (await run(configured(['resources', 'list', 'fixture']), { cwd: directory })).stdout,
    );
    expect(resources.data.resources).toHaveLength(2);
    const templates = JSON.parse(
      (await run(configured(['resources', 'templates', 'fixture']), { cwd: directory })).stdout,
    );
    expect(templates.data.resourceTemplates[0].uriTemplate).toBe('fixture://item/{id}');
    const binary = JSON.parse(
      (await run(configured(['resources', 'read', 'fixture', 'fixture://binary']), { cwd: directory }))
        .stdout,
    );
    expect(binary.data.contents[0].blob).toBe(Buffer.from([0, 1, 2, 255]).toString('base64'));

    const prompts = JSON.parse(
      (await run(configured(['prompts', 'list', 'fixture']), { cwd: directory })).stdout,
    );
    expect(prompts.data.prompts).toHaveLength(2);
    const prompt = JSON.parse(
      (
        await run(configured(['prompts', 'get', 'fixture', 'explain', '--input', '{"topic":"OAuth"}']), {
          cwd: directory,
        })
      ).stdout,
    );
    expect(prompt.data.messages[0].content.text).toBe('Explain OAuth');
  });

  it('spills large tool results and preserves the exact payload', async () => {
    const result = await run(configured(['tools', 'call', 'fixture', 'large', '--input', '{}']), {
      cwd: directory,
    });
    const envelope = JSON.parse(result.stdout);
    expect(envelope.delivery).toMatchObject({ mode: 'file', mediaType: 'application/json' });
    expect(dirname(envelope.delivery.path)).toBe(join(tmpdir(), 'mcp-cli'));
    expect((await stat(envelope.delivery.path)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(envelope.delivery.path, 'utf8')).content[0].text).toHaveLength(
      70 * 1024,
    );
  });

  it('maps usage, resolution, and protocol errors to stable envelopes and exit codes', async () => {
    const usage = await run(
      configured(['tools', 'call', 'fixture', 'echo', '--input', '{}', '--input-file', 'x']),
      {
        cwd: directory,
      },
    );
    expect(usage.code).toBe(2);
    expect(JSON.parse(usage.stdout).error.code).toBe('INPUT_SOURCE_INVALID');
    const missing = await run(configured(['tools', 'list', 'missing']), { cwd: directory });
    expect(missing.code).toBe(3);
    expect(JSON.parse(missing.stdout).error.code).toBe('SERVER_NOT_FOUND');
    const serverError = await run(configured(['tools', 'call', 'fixture', 'missing', '--input', '{}']), {
      cwd: directory,
    });
    expect(serverError.code).toBe(5);
    expect(JSON.parse(serverError.stdout)).toMatchObject({ ok: false, operation: 'tools.call' });
  });
});
