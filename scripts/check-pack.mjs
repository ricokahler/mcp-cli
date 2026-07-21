import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { URL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const root = resolve(new URL('..', import.meta.url).pathname);
const { version: expectedVersion } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const directory = await mkdtemp(join(tmpdir(), 'mcp-cli-pack-check-'));
const packDirectory = join(directory, 'pack');
const installPrefix = join(directory, 'install');
try {
  await mkdir(packDirectory);
  const { stdout } = await execFileAsync('npm', ['pack', '--json', '--pack-destination', packDirectory], {
    cwd: root,
    maxBuffer: 10 * 1024 * 1024,
  });
  const [{ filename, files }] = JSON.parse(stdout);
  const paths = new Set(files.map((file) => file.path));
  for (const required of ['dist/cli.js', 'README.md', 'LICENSE', 'config.schema.json']) {
    if (!paths.has(required)) throw new Error(`Packed artifact is missing ${required}`);
  }
  const tarball = join(packDirectory, filename);
  await readFile(tarball);
  await execFileAsync('npm', ['install', '--global', '--prefix', installPrefix, tarball], {
    cwd: directory,
    maxBuffer: 10 * 1024 * 1024,
  });
  const binary = join(installPrefix, 'bin', 'mcp-cli');
  const installedEntry = await realpath(binary);
  if (installedEntry.startsWith(`${root}/`))
    throw new Error('Installed binary unexpectedly resolves into the checkout');
  const run = async (...args) =>
    execFileAsync(process.execPath, [binary, ...args], { cwd: directory, maxBuffer: 10 * 1024 * 1024 });
  const version = (await run('--version')).stdout.trim();
  if (version !== expectedVersion)
    throw new Error(`Installed tarball returned unexpected version ${version}`);
  const help = (await run('help')).stdout;
  if (!help.includes('mcp-cli help --json'))
    throw new Error('Installed tarball did not render top-level help');
  const commandHelp = (await run('help', 'tools', 'call')).stdout;
  if (!commandHelp.includes('mcp-cli tools call'))
    throw new Error('Installed tarball did not render command help');
  const catalog = JSON.parse((await run('help', '--json')).stdout);
  if (!Array.isArray(catalog.commands) || catalog.commands.length === 0) {
    throw new Error('Installed tarball did not emit the JSON help catalog');
  }
  process.stdout.write(`Verified packed install at ${dirname(binary)}\n`);
} finally {
  await rm(directory, { force: true, recursive: true });
}
