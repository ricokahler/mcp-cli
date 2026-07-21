export interface CommandOptionDefinition {
  flags: string;
  description: string;
}

export interface CommandDefinition {
  path: string[];
  usage: string;
  description: string;
  examples: string[];
  options: CommandOptionDefinition[];
  output: string;
  exitCodes: number[];
}

const COMMON_OPTIONS: CommandOptionDefinition[] = [
  { flags: '--config <path>', description: 'Read an additional config file (repeatable).' },
  { flags: '--pretty', description: 'Render indented JSON for humans.' },
];

export const COMMAND_CATALOG: CommandDefinition[] = [
  {
    path: ['help'],
    usage: 'mcp-cli help [command...] [--json]',
    description: 'Show command documentation without reading config or external state.',
    examples: ['mcp-cli help', 'mcp-cli help tools call', 'mcp-cli help --json'],
    options: [{ flags: '--json', description: 'Emit the complete machine-readable command catalog.' }],
    output: 'Human text by default; a JSON command catalog with --json.',
    exitCodes: [0, 2],
  },
  {
    path: ['servers', 'list'],
    usage: 'mcp-cli servers list',
    description: 'List normalized configured MCP servers without connecting.',
    examples: ['mcp-cli servers list'],
    options: COMMON_OPTIONS,
    output: 'Server IDs, sources, transports, and redacted configuration.',
    exitCodes: [0, 2],
  },
  {
    path: ['servers', 'get'],
    usage: 'mcp-cli servers get <server>',
    description: 'Show one normalized, redacted server definition.',
    examples: ['mcp-cli servers get friday'],
    options: COMMON_OPTIONS,
    output: 'A normalized server definition with source metadata.',
    exitCodes: [0, 2, 3],
  },
  {
    path: ['servers', 'add'],
    usage: 'mcp-cli servers add <name> (--url <url> | -- <command> [args...])',
    description: 'Add a remote or local server to ~/.mcp-cli/config.json.',
    examples: [
      'mcp-cli servers add friday --url https://app.friday.land/api/mcp',
      'mcp-cli servers add filesystem --env-var HOME -- npx -y @modelcontextprotocol/server-filesystem "$HOME"',
    ],
    options: [
      { flags: '--url <url>', description: 'Configure a Streamable HTTP server.' },
      {
        flags: '--header-env <header=ENV>',
        description: 'Resolve an HTTP header from an environment variable.',
      },
      { flags: '--env-var <name>', description: 'Forward an environment variable to a stdio server.' },
      { flags: '--force', description: 'Replace an existing mcp-cli-owned definition.' },
    ],
    output: 'The newly normalized mcp-cli-owned server.',
    exitCodes: [0, 2],
  },
  {
    path: ['servers', 'remove'],
    usage: 'mcp-cli servers remove <name>',
    description: 'Remove an mcp-cli-owned server definition.',
    examples: ['mcp-cli servers remove friday'],
    options: [{ flags: '--pretty', description: 'Render indented JSON for humans.' }],
    output: 'The removed server name.',
    exitCodes: [0, 2, 3],
  },
  {
    path: ['sources', 'list'],
    usage: 'mcp-cli sources list',
    description: 'List every considered config source and its parse status.',
    examples: ['mcp-cli sources list'],
    options: COMMON_OPTIONS,
    output: 'Source paths, existence, load status, server counts, and errors.',
    exitCodes: [0, 2],
  },
  {
    path: ['doctor'],
    usage: 'mcp-cli doctor',
    description: 'Check the runtime, config directory, Keychain binding, and source health.',
    examples: ['mcp-cli doctor'],
    options: COMMON_OPTIONS,
    output: 'A list of diagnostic checks and an overall status.',
    exitCodes: [0, 2],
  },
  {
    path: ['inspect'],
    usage: 'mcp-cli inspect <server>',
    description: 'Connect and report MCP server identity, instructions, and capabilities.',
    examples: ['mcp-cli inspect friday'],
    options: COMMON_OPTIONS,
    output: 'Negotiated server metadata and capabilities.',
    exitCodes: [0, 2, 3, 4, 5],
  },
  {
    path: ['tools', 'list'],
    usage: 'mcp-cli tools list [server] [--all]',
    description: 'List complete tool schemas for one server or all servers.',
    examples: ['mcp-cli tools list friday', 'mcp-cli tools list --all'],
    options: [...COMMON_OPTIONS, { flags: '--all', description: 'Connect to every discovered server.' }],
    output: 'Complete paginated MCP tool definitions.',
    exitCodes: [0, 2, 3, 4, 5],
  },
  {
    path: ['tools', 'get'],
    usage: 'mcp-cli tools get <server> <tool>',
    description: 'Get one tool definition and its input/output schemas.',
    examples: ['mcp-cli tools get friday friday_mcp_auth_status'],
    options: COMMON_OPTIONS,
    output: 'One MCP tool definition.',
    exitCodes: [0, 2, 3, 4, 5],
  },
  {
    path: ['tools', 'call'],
    usage: 'mcp-cli tools call <server> <tool> [--input <json> | --input-file <path>]',
    description: 'Call an MCP tool with JSON arguments.',
    examples: [
      "mcp-cli tools call friday friday_mcp_auth_status --input '{}'",
      "printf '{}' | mcp-cli tools call friday friday_mcp_auth_status",
    ],
    options: [
      ...COMMON_OPTIONS,
      { flags: '--input <json>', description: 'Inline JSON arguments.' },
      { flags: '--input-file <path>', description: 'Read JSON arguments from a file.' },
    ],
    output: 'The exact MCP tool result.',
    exitCodes: [0, 2, 3, 4, 5],
  },
  {
    path: ['resources', 'list'],
    usage: 'mcp-cli resources list <server>',
    description: 'List every resource exposed by a server.',
    examples: ['mcp-cli resources list docs'],
    options: COMMON_OPTIONS,
    output: 'Complete paginated MCP resource definitions.',
    exitCodes: [0, 2, 3, 4, 5],
  },
  {
    path: ['resources', 'templates'],
    usage: 'mcp-cli resources templates <server>',
    description: 'List every resource template exposed by a server.',
    examples: ['mcp-cli resources templates docs'],
    options: COMMON_OPTIONS,
    output: 'Complete paginated MCP resource templates.',
    exitCodes: [0, 2, 3, 4, 5],
  },
  {
    path: ['resources', 'read'],
    usage: 'mcp-cli resources read <server> <uri>',
    description: 'Read an MCP resource URI.',
    examples: ['mcp-cli resources read docs file:///guide.md'],
    options: COMMON_OPTIONS,
    output: 'The exact MCP resource contents.',
    exitCodes: [0, 2, 3, 4, 5],
  },
  {
    path: ['prompts', 'list'],
    usage: 'mcp-cli prompts list <server>',
    description: 'List every prompt exposed by a server.',
    examples: ['mcp-cli prompts list docs'],
    options: COMMON_OPTIONS,
    output: 'Complete paginated MCP prompt definitions.',
    exitCodes: [0, 2, 3, 4, 5],
  },
  {
    path: ['prompts', 'get'],
    usage: 'mcp-cli prompts get <server> <prompt> [--input <json> | --input-file <path>]',
    description: 'Get a rendered MCP prompt using string arguments.',
    examples: ['mcp-cli prompts get docs explain --input \'{"topic":"OAuth"}\''],
    options: [
      ...COMMON_OPTIONS,
      { flags: '--input <json>', description: 'Inline JSON string arguments.' },
      { flags: '--input-file <path>', description: 'Read JSON string arguments from a file.' },
    ],
    output: 'The exact MCP prompt result.',
    exitCodes: [0, 2, 3, 4, 5],
  },
  {
    path: ['auth', 'login'],
    usage: 'mcp-cli auth login <server>',
    description: 'Open the explicit browser OAuth flow for a Streamable HTTP server.',
    examples: ['mcp-cli auth login friday'],
    options: COMMON_OPTIONS,
    output: 'Sanitized OAuth completion status.',
    exitCodes: [0, 2, 3, 4, 5],
  },
  {
    path: ['auth', 'status'],
    usage: 'mcp-cli auth status <server>',
    description: 'Report whether Keychain contains OAuth material for a server.',
    examples: ['mcp-cli auth status friday'],
    options: COMMON_OPTIONS,
    output: 'Credential presence and non-secret token metadata.',
    exitCodes: [0, 2, 3, 4],
  },
  {
    path: ['auth', 'logout'],
    usage: 'mcp-cli auth logout <server>',
    description: 'Delete local OAuth material for a server from macOS Keychain.',
    examples: ['mcp-cli auth logout friday'],
    options: COMMON_OPTIONS,
    output: 'Whether a Keychain credential was deleted.',
    exitCodes: [0, 2, 3, 4],
  },
];

export function findCommandDefinition(path: string[]): CommandDefinition | undefined {
  return COMMAND_CATALOG.find(
    (definition) =>
      definition.path.length === path.length && definition.path.every((part, index) => part === path[index]),
  );
}

export function renderCommandHelp(definition: CommandDefinition): string {
  const options = definition.options.length
    ? `\nOptions:\n${definition.options.map((option) => `  ${option.flags.padEnd(30)} ${option.description}`).join('\n')}\n`
    : '';
  return [
    `Usage: ${definition.usage}`,
    '',
    definition.description,
    options,
    'Examples:',
    ...definition.examples.map((example) => `  ${example}`),
    '',
    `Output: ${definition.output}`,
    `Exit codes: ${definition.exitCodes.join(', ')}`,
  ].join('\n');
}

export function renderTopLevelHelp(): string {
  const groups = [...new Set(COMMAND_CATALOG.map((command) => command.path[0]))];
  return [
    'Usage: mcp-cli <command> [options]',
    '',
    'A JSON-first MCP client for bash-capable agents.',
    '',
    'Commands:',
    ...groups.map((group) => `  ${group}`),
    '',
    'Run `mcp-cli help <command...>` for details or `mcp-cli help --json` for the full command catalog.',
  ].join('\n');
}
