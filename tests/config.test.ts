import { mkdtemp, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  addOwnedServer,
  discoverServers,
  redactServer,
  removeOwnedServer,
  resolveServer,
  resolveServerCandidates,
} from '../src/config.js';

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function fixture(): Promise<{ home: string; project: string }> {
  const root = await mkdtemp(join(tmpdir(), 'mcp-cli-config-'));
  const home = join(root, 'home');
  const project = join(root, 'project');
  await mkdir(join(project, '.git'), { recursive: true });
  await mkdir(home, { recursive: true });
  return { home, project };
}

describe('configuration discovery', () => {
  it('adapts every supported macOS config location', async () => {
    const { home, project } = await fixture();
    const stdio = (name: string) => ({ command: 'node', args: [name] });
    await writeJson(join(home, '.mcp-cli', 'config.json'), {
      version: 1,
      mcpServers: { own: stdio('own') },
    });
    await writeJson(join(project, '.mcp.json'), { mcpServers: { project: stdio('project') } });
    await writeJson(join(project, '.cursor', 'mcp.json'), { mcpServers: { cursorProject: stdio('cp') } });
    await writeJson(join(project, '.vscode', 'mcp.json'), { servers: { vscodeProject: stdio('vp') } });
    await writeJson(join(project, '.gemini', 'settings.json'), {
      mcpServers: { geminiProject: stdio('gp') },
    });
    await mkdir(join(project, '.codex'), { recursive: true });
    await writeFile(
      join(project, '.codex', 'config.toml'),
      '[mcp_servers.codexProject]\ncommand = "node"\nargs = ["cproj"]\n',
    );
    await writeJson(join(home, '.claude.json'), {
      mcpServers: { claudeUser: stdio('cu') },
      projects: { [project]: { mcpServers: { claudeProject: stdio('cpj') } } },
    });
    await writeJson(join(home, 'Library/Application Support/Claude/claude_desktop_config.json'), {
      mcpServers: { claudeDesktop: stdio('cd') },
    });
    await writeJson(join(home, '.cursor', 'mcp.json'), { mcpServers: { cursorUser: stdio('cur') } });
    await mkdir(join(home, '.codex'), { recursive: true });
    await writeFile(
      join(home, '.codex', 'config.toml'),
      '[mcp_servers.codexUser]\ncommand = "node"\nargs = ["cuser"]\n',
    );
    await writeJson(join(home, 'Library/Application Support/Code/User/mcp.json'), {
      servers: { vscodeUser: stdio('vu') },
    });
    await writeJson(join(home, 'Library/Application Support/Code/User/profiles/a/mcp.json'), {
      servers: { vscodeProfile: stdio('vprof') },
    });
    await writeJson(join(home, '.gemini', 'settings.json'), { mcpServers: { geminiUser: stdio('gu') } });
    const explicit = join(home, 'extra.json');
    await writeJson(explicit, { mcpServers: { explicit: stdio('ex') } });

    const result = await discoverServers({ cwd: project, homeDirectory: home, explicitPaths: [explicit] });
    expect(result.servers.map((server) => server.name)).toEqual([
      'claudeDesktop',
      'claudeProject',
      'claudeUser',
      'codexProject',
      'codexUser',
      'cursorProject',
      'cursorUser',
      'explicit',
      'geminiProject',
      'geminiUser',
      'own',
      'project',
      'vscodeProfile',
      'vscodeProject',
      'vscodeUser',
    ]);
    expect(result.sources.filter((source) => source.loaded)).toHaveLength(15);
  });

  it('interpolates environment, fallback, workspace, and home variables', async () => {
    const { home, project } = await fixture();
    const explicit = join(home, 'interpolation.json');
    await writeJson(explicit, {
      mcpServers: {
        expanded: {
          command: '${RUNNER}',
          args: ['$TOKEN', '${MISSING:-fallback}', '${workspaceFolder}', '${userHome}'],
          env: { SECRET: '${env:TOKEN}' },
        },
      },
    });
    const result = await discoverServers({
      cwd: project,
      homeDirectory: home,
      explicitPaths: [explicit],
      env: { RUNNER: 'node', TOKEN: 'secret' },
    });
    const server = resolveServer(result.servers, 'expanded');
    expect(server.config).toMatchObject({
      command: 'node',
      args: ['secret', 'fallback', project, home],
      env: { SECRET: 'secret' },
    });
    expect(redactServer(server)).toMatchObject({ config: { env: { SECRET: '[REDACTED]' } } });
  });

  it('deduplicates identical definitions and orders conflicting bare names by source preference', async () => {
    const { home, project } = await fixture();
    const same = { command: 'node', args: ['same'] };
    await writeJson(join(home, '.mcp-cli', 'config.json'), {
      version: 1,
      mcpServers: { duplicate: same, conflict: { command: 'node', args: ['own'] } },
    });
    await writeJson(join(project, '.mcp.json'), {
      mcpServers: { duplicate: same, conflict: { command: 'node', args: ['one'] } },
    });
    const explicit = join(home, 'extra.json');
    await writeJson(explicit, { mcpServers: { conflict: { command: 'node', args: ['two'] } } });
    const result = await discoverServers({ cwd: project, homeDirectory: home, explicitPaths: [explicit] });
    expect(result.servers.filter((server) => server.name === 'duplicate')).toHaveLength(1);
    expect(resolveServer(result.servers, 'duplicate').sources).toHaveLength(2);
    expect(resolveServerCandidates(result.servers, 'conflict').map((server) => server.id)).toEqual([
      'mcp-cli:user/conflict',
      'explicit:user/conflict',
      'project:project/conflict',
    ]);
    expect(resolveServer(result.servers, 'conflict').config).toMatchObject({ args: ['own'] });
    expect(resolveServer(result.servers, 'explicit:user/conflict').config).toMatchObject({ args: ['two'] });
  });

  it('reports malformed, unresolved, and legacy SSE sources without hiding healthy sources', async () => {
    const { home, project } = await fixture();
    await writeFile(join(project, '.mcp.json'), '{ broken');
    const unresolved = join(home, 'unresolved.json');
    const sse = join(home, 'sse.json');
    const healthy = join(home, 'healthy.json');
    await writeJson(unresolved, { mcpServers: { bad: { command: '${NOT_SET}' } } });
    await writeJson(sse, { mcpServers: { old: { type: 'sse', url: 'https://example.test/sse' } } });
    await writeJson(healthy, { mcpServers: { good: { command: 'node' } } });
    const result = await discoverServers({
      cwd: project,
      homeDirectory: home,
      explicitPaths: [unresolved, sse, healthy],
      env: {},
    });
    expect(result.servers.map((server) => server.name)).toContain('good');
    const errors = result.sources.flatMap((source) => (source.error ? [source.error] : []));
    expect(errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining('JSON parse failed'),
        expect.stringContaining('NOT_SET'),
        expect.stringContaining('Legacy SSE'),
      ]),
    );
  });

  it('writes and removes only the owned config with private modes', async () => {
    const { home } = await fixture();
    await addOwnedServer({
      homeDirectory: home,
      name: 'friday',
      rawConfig: { type: 'http', url: 'https://app.friday.land/api/mcp' },
    });
    const path = join(home, '.mcp-cli', 'config.json');
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(join(home, '.mcp-cli'))).mode & 0o777).toBe(0o700);
    expect(JSON.parse(await readFile(path, 'utf8')).mcpServers.friday).toMatchObject({ type: 'http' });
    await expect(
      addOwnedServer({ homeDirectory: home, name: 'friday', rawConfig: { command: 'node' } }),
    ).rejects.toMatchObject({ code: 'SERVER_ALREADY_EXISTS', exitCode: 2 });
    await removeOwnedServer({ homeDirectory: home, name: 'friday' });
    expect(JSON.parse(await readFile(path, 'utf8')).mcpServers).toEqual({});
  });
});
