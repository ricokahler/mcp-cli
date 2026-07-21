#!/usr/bin/env node

import { constants, realpathSync } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { Command, CommanderError, Option } from 'commander';
import { COMMAND_CATALOG, findCommandDefinition, renderCommandHelp, renderTopLevelHelp } from './catalog.js';
import {
  addOwnedServer,
  discoverServers,
  inspectPathMode,
  ownConfigPath,
  redactServer,
  removeOwnedServer,
  resolveServer,
  serverReference,
} from './config.js';
import { asCliError, CliError } from './errors.js';
import { MacOsKeychainStore } from './keychain.js';
import {
  authStatus,
  connectServer,
  listAllPrompts,
  listAllResources,
  listAllResourceTemplates,
  listAllTools,
  loginServer,
  logoutServer,
  withClient,
} from './mcp.js';
import { writeFailure, writeSuccess } from './output.js';
import type { DiscoveredServer } from './types.js';

const VERSION = '0.1.0';

interface CommonOptions {
  config: string[];
  pretty?: boolean;
}

interface InputOptions extends CommonOptions {
  input?: string;
  inputFile?: string;
}

let currentOperation = 'cli';

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function withCommonOptions(command: Command): Command {
  return command
    .addOption(
      new Option('--config <path>', 'Read an additional config file (repeatable).')
        .argParser(collect)
        .default([]),
    )
    .option('--pretty', 'Render indented JSON for humans.');
}

function withInputOptions(command: Command): Command {
  return withCommonOptions(command)
    .option('--input <json>', 'Use inline JSON input.')
    .option('--input-file <path>', 'Read JSON input from a file.');
}

function operation<TArgs extends unknown[]>(
  name: string,
  action: (...args: TArgs) => Promise<void>,
): (...args: TArgs) => Promise<void> {
  return async (...args: TArgs): Promise<void> => {
    currentOperation = name;
    await action(...args);
  };
}

async function discovery(options: CommonOptions) {
  return discoverServers({ explicitPaths: options.config });
}

async function resolvedServer(reference: string, options: CommonOptions): Promise<DiscoveredServer> {
  return resolveServer((await discovery(options)).servers, reference);
}

function parseJsonObject(text: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new CliError({
      category: 'config',
      code: 'INVALID_JSON_INPUT',
      message: `${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new CliError({
      category: 'config',
      code: 'INVALID_JSON_INPUT',
      message: `${label} must contain a JSON object.`,
    });
  }
  return parsed as Record<string, unknown>;
}

async function readJsonInput(options: InputOptions, required: boolean): Promise<Record<string, unknown>> {
  const explicitSourceCount = Number(options.input !== undefined) + Number(options.inputFile !== undefined);
  if (explicitSourceCount > 1) {
    throw new CliError({
      category: 'config',
      code: 'INPUT_SOURCE_INVALID',
      message: 'Provide exactly one input source: --input, --input-file, or piped JSON.',
    });
  }
  if (options.input !== undefined) return parseJsonObject(options.input, '--input');
  if (options.inputFile !== undefined) {
    return parseJsonObject(await readFile(options.inputFile, 'utf8'), '--input-file');
  }
  if (process.stdin.isTTY) {
    if (!required) return {};
    throw new CliError({
      category: 'config',
      code: 'INPUT_SOURCE_INVALID',
      message: 'Provide exactly one input source: --input, --input-file, or piped JSON.',
    });
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk as Uint8Array));
  }
  const pipedInput = Buffer.concat(chunks).toString('utf8');
  if (pipedInput.trim().length === 0 && !required) return {};
  return parseJsonObject(pipedInput, 'piped input');
}

function promptArguments(input: Record<string, unknown>): Record<string, string> {
  const invalid = Object.entries(input).find((entry) => typeof entry[1] !== 'string');
  if (invalid) {
    throw new CliError({
      category: 'config',
      code: 'INVALID_PROMPT_INPUT',
      message: `Prompt argument ${invalid[0]} must be a string.`,
    });
  }
  return input as Record<string, string>;
}

function definitionPathFromArgs(args: string[]): string[] | undefined {
  const words = args.filter((argument) => !argument.startsWith('-'));
  for (let length = Math.min(words.length, 3); length > 0; length -= 1) {
    const path = words.slice(0, length);
    if (findCommandDefinition(path)) return path;
  }
  return undefined;
}

function handleStaticHelp(argv: string[]): boolean {
  if (argv[0] === 'help') {
    if (argv.includes('--json')) {
      process.stdout.write(`${JSON.stringify({ version: 1, commands: COMMAND_CATALOG })}\n`);
      return true;
    }
    const path = argv.slice(1).filter((argument) => !argument.startsWith('-'));
    if (path.length === 0) {
      process.stdout.write(`${renderTopLevelHelp()}\n`);
      return true;
    }
    const definition = findCommandDefinition(path);
    if (!definition) {
      throw new CliError({
        category: 'config',
        code: 'HELP_COMMAND_NOT_FOUND',
        message: `No command matches ${path.join(' ')}.`,
      });
    }
    process.stdout.write(`${renderCommandHelp(definition)}\n`);
    return true;
  }
  if (argv.includes('--help') || argv.includes('-h')) {
    const index = argv.findIndex((argument) => argument === '--help' || argument === '-h');
    const path = definitionPathFromArgs(argv.slice(0, index));
    const definition = path ? findCommandDefinition(path) : undefined;
    process.stdout.write(`${definition ? renderCommandHelp(definition) : renderTopLevelHelp()}\n`);
    return true;
  }
  if (argv.length === 0) {
    process.stdout.write(`${renderTopLevelHelp()}\n`);
    return true;
  }
  return false;
}

function addServersCommands(program: Command): void {
  const servers = program.command('servers').description('Manage configured MCP servers.');

  withCommonOptions(servers.command('list').description('List configured servers.')).action(
    operation('servers.list', async (options: CommonOptions) => {
      const result = await discovery(options);
      await writeSuccess('servers.list', result.servers.map(redactServer), undefined, options);
    }),
  );

  withCommonOptions(
    servers.command('get').argument('<server>').description('Get one configured server.'),
  ).action(
    operation('servers.get', async (reference: string, options: CommonOptions) => {
      const server = await resolvedServer(reference, options);
      await writeSuccess('servers.get', redactServer(server), serverReference(server), options);
    }),
  );

  withCommonOptions(
    servers
      .command('add')
      .argument('<name>')
      .argument('[stdioCommand...]')
      .description('Add an mcp-cli-owned server.')
      .option('--url <url>', 'Configure a Streamable HTTP server.')
      .addOption(
        new Option('--header-env <header=ENV>', 'Resolve an HTTP header from an environment variable.')
          .argParser(collect)
          .default([]),
      )
      .addOption(
        new Option('--env-var <name>', 'Forward an environment variable to a stdio server.')
          .argParser(collect)
          .default([]),
      )
      .option('--force', 'Replace an existing owned definition.'),
  ).action(
    operation(
      'servers.add',
      async (
        name: string,
        stdioCommand: string[],
        options: CommonOptions & {
          url?: string;
          headerEnv: string[];
          envVar: string[];
          force?: boolean;
        },
      ) => {
        const hasUrl = options.url !== undefined;
        const hasCommand = stdioCommand.length > 0;
        if (hasUrl === hasCommand) {
          throw new CliError({
            category: 'config',
            code: 'SERVER_TRANSPORT_INVALID',
            message: 'Specify exactly one transport: --url <url> or -- <command> [args...].',
          });
        }
        const headerEnv = Object.fromEntries(
          options.headerEnv.map((value) => {
            const separator = value.indexOf('=');
            if (separator < 1 || separator === value.length - 1) {
              throw new CliError({
                category: 'config',
                code: 'HEADER_ENV_INVALID',
                message: `Invalid --header-env ${value}; expected Header=ENV.`,
              });
            }
            return [value.slice(0, separator), value.slice(separator + 1)];
          }),
        );
        const rawConfig: Record<string, unknown> = hasUrl
          ? { type: 'http', url: options.url, headerEnv }
          : { command: stdioCommand[0], args: stdioCommand.slice(1), envVars: options.envVar };
        await addOwnedServer({
          name,
          rawConfig,
          ...(options.force === undefined ? {} : { force: options.force }),
        });
        const created = resolveServer((await discoverServers()).servers, `mcp-cli:user/${name}`);
        await writeSuccess('servers.add', redactServer(created), serverReference(created), options);
      },
    ),
  );

  withCommonOptions(
    servers.command('remove').argument('<name>').description('Remove an mcp-cli-owned server.'),
  ).action(
    operation('servers.remove', async (name: string, options: CommonOptions) => {
      await removeOwnedServer({ name });
      await writeSuccess('servers.remove', { removed: name }, undefined, options);
    }),
  );
}

function addDiscoveryCommands(program: Command): void {
  const sources = program.command('sources').description('Inspect config sources.');
  withCommonOptions(sources.command('list').description('List all considered config sources.')).action(
    operation('sources.list', async (options: CommonOptions) => {
      await writeSuccess('sources.list', (await discovery(options)).sources, undefined, options);
    }),
  );

  withCommonOptions(program.command('doctor').description('Check the local mcp-cli environment.')).action(
    operation('doctor', async (options: CommonOptions) => {
      const result = await discovery(options);
      const path = ownConfigPath();
      const directory = dirname(path);
      const writable = await (async (): Promise<boolean> => {
        try {
          await access(directory, constants.W_OK);
          return true;
        } catch {
          try {
            await access(dirname(directory), constants.W_OK);
            return true;
          } catch {
            return false;
          }
        }
      })();
      const checks = {
        platform: { ok: process.platform === 'darwin', actual: process.platform, required: 'darwin' },
        node: {
          ok: Number(process.versions.node.split('.')[0]) >= 24,
          actual: process.versions.node,
          required: '>=24',
        },
        config: {
          ok: writable,
          path,
          writable,
          mode: await inspectPathMode(path),
        },
        keychain: { ok: await new MacOsKeychainStore().available() },
        sources: {
          ok: result.sources.every((source) => source.error === undefined),
          errors: result.sources.filter((source) => source.error !== undefined),
        },
      };
      await writeSuccess(
        'doctor',
        { ok: Object.values(checks).every((check) => check.ok), checks },
        undefined,
        options,
      );
    }),
  );
}

function addMcpCommands(program: Command): void {
  withCommonOptions(
    program.command('inspect').argument('<server>').description('Inspect one MCP server.'),
  ).action(
    operation('inspect', async (reference: string, options: CommonOptions) => {
      const server = await resolvedServer(reference, options);
      const connected = await connectServer(server);
      let data: unknown;
      try {
        data = {
          serverInfo: connected.client.getServerVersion(),
          protocolVersion: connected.protocolVersion,
          capabilities: connected.client.getServerCapabilities(),
          instructions: connected.client.getInstructions(),
        };
      } finally {
        await connected.close().catch(() => undefined);
      }
      await writeSuccess('inspect', data, serverReference(server), options);
    }),
  );

  const tools = program.command('tools').description('Discover and call MCP tools.');
  withCommonOptions(
    tools.command('list').argument('[server]').option('--all', 'Connect to every discovered server.'),
  ).action(
    operation(
      'tools.list',
      async (reference: string | undefined, options: CommonOptions & { all?: boolean }) => {
        if ((reference === undefined) === !options.all) {
          throw new CliError({
            category: 'config',
            code: 'SERVER_SELECTION_INVALID',
            message: 'Specify exactly one server or pass --all.',
          });
        }
        const result = await discovery(options);
        if (!options.all) {
          const server = resolveServer(result.servers, reference ?? '');
          const data = await withClient(server, (client) =>
            listAllTools(client, server.config.toolTimeoutMs),
          );
          await writeSuccess('tools.list', { tools: data }, serverReference(server), options);
          return;
        }
        const successes: unknown[] = [];
        const failures: unknown[] = [];
        for (const server of result.servers) {
          try {
            const definitions = await withClient(server, (client) =>
              listAllTools(client, server.config.toolTimeoutMs),
            );
            successes.push({ server: serverReference(server), tools: definitions });
          } catch (error) {
            const cliError = asCliError(error);
            failures.push({
              server: serverReference(server),
              error: { code: cliError.code, message: cliError.message },
            });
          }
        }
        if (failures.length > 0) {
          throw new CliError({
            category: 'protocol',
            code: 'PARTIAL_FAILURE',
            message: `${failures.length} server(s) failed while listing tools.`,
            details: { successes, failures },
          });
        }
        await writeSuccess('tools.list', { servers: successes }, undefined, options);
      },
    ),
  );

  withCommonOptions(tools.command('get').argument('<server>').argument('<tool>')).action(
    operation('tools.get', async (reference: string, toolName: string, options: CommonOptions) => {
      const server = await resolvedServer(reference, options);
      const definitions = await withClient(server, (client) =>
        listAllTools(client, server.config.toolTimeoutMs),
      );
      const tool = definitions.find((definition) => {
        return (
          typeof definition === 'object' &&
          definition !== null &&
          'name' in definition &&
          definition.name === toolName
        );
      });
      if (!tool) {
        throw new CliError({
          category: 'resolution',
          code: 'TOOL_NOT_FOUND',
          message: `Server ${server.name} has no tool named ${toolName}.`,
        });
      }
      await writeSuccess('tools.get', tool, serverReference(server), options);
    }),
  );

  withInputOptions(tools.command('call').argument('<server>').argument('<tool>')).action(
    operation('tools.call', async (reference: string, toolName: string, options: InputOptions) => {
      const input = await readJsonInput(options, true);
      const server = await resolvedServer(reference, options);
      const result = await withClient(server, (client) =>
        client.callTool({ name: toolName, arguments: input }, undefined, {
          timeout: server.config.toolTimeoutMs,
        }),
      );
      await writeSuccess('tools.call', result, serverReference(server), options);
    }),
  );

  const resources = program.command('resources').description('List and read MCP resources.');
  withCommonOptions(resources.command('list').argument('<server>')).action(
    operation('resources.list', async (reference: string, options: CommonOptions) => {
      const server = await resolvedServer(reference, options);
      const data = await withClient(server, (client) =>
        listAllResources(client, server.config.toolTimeoutMs),
      );
      await writeSuccess('resources.list', { resources: data }, serverReference(server), options);
    }),
  );
  withCommonOptions(resources.command('templates').argument('<server>')).action(
    operation('resources.templates', async (reference: string, options: CommonOptions) => {
      const server = await resolvedServer(reference, options);
      const data = await withClient(server, (client) =>
        listAllResourceTemplates(client, server.config.toolTimeoutMs),
      );
      await writeSuccess(
        'resources.templates',
        { resourceTemplates: data },
        serverReference(server),
        options,
      );
    }),
  );
  withCommonOptions(resources.command('read').argument('<server>').argument('<uri>')).action(
    operation('resources.read', async (reference: string, uri: string, options: CommonOptions) => {
      const server = await resolvedServer(reference, options);
      const data = await withClient(server, (client) =>
        client.readResource({ uri }, { timeout: server.config.toolTimeoutMs }),
      );
      await writeSuccess('resources.read', data, serverReference(server), options);
    }),
  );

  const prompts = program.command('prompts').description('List and retrieve MCP prompts.');
  withCommonOptions(prompts.command('list').argument('<server>')).action(
    operation('prompts.list', async (reference: string, options: CommonOptions) => {
      const server = await resolvedServer(reference, options);
      const data = await withClient(server, (client) => listAllPrompts(client, server.config.toolTimeoutMs));
      await writeSuccess('prompts.list', { prompts: data }, serverReference(server), options);
    }),
  );
  withInputOptions(prompts.command('get').argument('<server>').argument('<prompt>')).action(
    operation('prompts.get', async (reference: string, promptName: string, options: InputOptions) => {
      const server = await resolvedServer(reference, options);
      const input = promptArguments(await readJsonInput(options, false));
      const data = await withClient(server, (client) =>
        client.getPrompt({ name: promptName, arguments: input }, { timeout: server.config.toolTimeoutMs }),
      );
      await writeSuccess('prompts.get', data, serverReference(server), options);
    }),
  );
}

function addAuthCommands(program: Command): void {
  const auth = program.command('auth').description('Manage MCP OAuth credentials in macOS Keychain.');
  withCommonOptions(auth.command('login').argument('<server>')).action(
    operation('auth.login', async (reference: string, options: CommonOptions) => {
      const server = await resolvedServer(reference, options);
      const result = await loginServer(server, {
        onAuthorizationUrl: async (url) => {
          process.stderr.write(`Opening OAuth authorization URL: ${url.toString()}\n`);
          const { openBrowser } = await import('./oauth.js');
          await openBrowser(url);
        },
      });
      await writeSuccess('auth.login', result, serverReference(server), options);
    }),
  );
  withCommonOptions(auth.command('status').argument('<server>')).action(
    operation('auth.status', async (reference: string, options: CommonOptions) => {
      const server = await resolvedServer(reference, options);
      await writeSuccess('auth.status', await authStatus(server), serverReference(server), options);
    }),
  );
  withCommonOptions(auth.command('logout').argument('<server>')).action(
    operation('auth.logout', async (reference: string, options: CommonOptions) => {
      const server = await resolvedServer(reference, options);
      await writeSuccess('auth.logout', await logoutServer(server), serverReference(server), options);
    }),
  );
}

function buildProgram(): Command {
  const program = new Command()
    .name('mcp-cli')
    .description('A JSON-first MCP client for bash-capable agents.')
    .version(VERSION)
    .helpOption(false)
    .allowExcessArguments(false)
    .exitOverride();
  addServersCommands(program);
  addDiscoveryCommands(program);
  addMcpCommands(program);
  addAuthCommands(program);
  return program;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  try {
    if (argv.includes('--version') || argv.includes('-V')) {
      process.stdout.write(`${VERSION}\n`);
      return 0;
    }
    if (handleStaticHelp(argv)) return 0;
    await buildProgram().parseAsync(argv, { from: 'user' });
    return 0;
  } catch (error) {
    const cliError =
      error instanceof CommanderError
        ? new CliError({ category: 'config', code: 'USAGE_ERROR', message: error.message, cause: error })
        : asCliError(error);
    writeFailure(
      currentOperation,
      {
        code: cliError.code,
        message: cliError.message,
        ...(cliError.details === undefined ? {} : { details: cliError.details }),
        ...(cliError.remediation === undefined ? {} : { remediation: cliError.remediation }),
      },
      { pretty: argv.includes('--pretty') },
    );
    return cliError.exitCode;
  }
}

const invokedPath = process.argv[1];
const isEntryPoint =
  invokedPath !== undefined &&
  (() => {
    try {
      return realpathSync(invokedPath) === fileURLToPath(import.meta.url);
    } catch {
      return false;
    }
  })();

if (isEntryPoint) {
  process.exitCode = await main();
}
