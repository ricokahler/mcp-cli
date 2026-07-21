# `@ricokahler/mcp-cli`

A JSON-first, one-shot MCP client for agent environments that can run bash but cannot host MCP servers directly.

> **Security:** `mcp-cli` has no permission gates. It can execute configured stdio commands and invoke remote tools.
> The calling harness must decide what is allowed.

## Requirements

- macOS on Apple Silicon or Intel
- Node.js 24 or newer

## Install

```bash
npm install --global @ricokahler/mcp-cli
```

Inspect the complete command surface without touching configuration or the network:

```bash
mcp-cli help
mcp-cli help tools call
mcp-cli help --json
```

## Quick start

```bash
mcp-cli servers add friday --url https://app.friday.land/api/mcp
mcp-cli auth login friday
mcp-cli tools list friday
mcp-cli tools call friday friday_mcp_auth_status --input '{}'
```

Operational commands emit JSON on stdout. Use `--pretty` for a human-readable rendering. Tool input can come from
exactly one of `--input`, `--input-file`, or stdin.

```bash
printf '{"query":"example"}' | mcp-cli tools call server search
```

## Commands

- `servers list|get|add|remove`
- `sources list`
- `doctor`
- `inspect`
- `tools list|get|call`
- `resources list|templates|read`
- `prompts list|get`
- `auth login|status|logout`
- `help [command...]`

Use `mcp-cli help <command...>` for exact arguments, options, examples, output, and exit codes.

### Exit codes

| Code | Meaning                                     |
| ---: | ------------------------------------------- |
|  `0` | Success                                     |
|  `1` | Unexpected internal failure                 |
|  `2` | Invalid command, input, or configuration    |
|  `3` | Missing or ambiguous server or tool         |
|  `4` | Authentication required or Keychain failure |
|  `5` | Connection, protocol, or MCP server failure |

## Configuration discovery

`mcp-cli` writes only `~/.mcp-cli/config.json`. It also reads project `.mcp.json`, Claude Code and Claude Desktop,
Codex, Cursor, VS Code, and Gemini CLI configuration on macOS. Imported configuration is never modified.

| Source         | User location                                                     | Project location                  |
| -------------- | ----------------------------------------------------------------- | --------------------------------- |
| mcp-cli        | `~/.mcp-cli/config.json`                                          | —                                 |
| Claude Code    | `~/.claude.json`                                                  | Project entry in `~/.claude.json` |
| Claude Desktop | `~/Library/Application Support/Claude/claude_desktop_config.json` | —                                 |
| Codex          | `~/.codex/config.toml`                                            | `.codex/config.toml`              |
| Cursor         | `~/.cursor/mcp.json`                                              | `.cursor/mcp.json`                |
| VS Code        | User/profile `mcp.json`                                           | `.vscode/mcp.json`                |
| Gemini CLI     | `~/.gemini/settings.json`                                         | `.gemini/settings.json`           |
| Generic MCP    | —                                                                 | `.mcp.json`                       |

Pass `--config <path>` repeatedly to add read-only JSON/JSONC or Codex-style TOML sources. Use `mcp-cli sources list`
to see every path considered, its scope, and any parse or interpolation error. `${VAR}`, `${VAR:-fallback}`,
`${env:VAR}`, `${workspaceFolder}`, and `${userHome}` interpolation are supported. Interactive editor placeholders are
reported as unresolved instead of prompting.

Identical definitions collapse into one server. If different sources define the same name, use the source-qualified
ID printed by `mcp-cli servers list`, such as `codex:user/github`. Environment and static header values are always
redacted from inspection output.

The owned config has a versioned [JSON Schema](./config.schema.json) and a familiar `mcpServers` map:

```json
{
  "$schema": "https://raw.githubusercontent.com/ricokahler/mcp-cli/main/config.schema.json",
  "version": 1,
  "mcpServers": {
    "local": { "command": "node", "args": ["server.mjs"], "envVars": ["TOKEN"] },
    "remote": { "type": "http", "url": "https://example.com/mcp", "headerEnv": { "X-API-Key": "API_KEY" } }
  }
}
```

## JSON output contract

Successful operations emit exactly one envelope on stdout:

```json
{
  "ok": true,
  "operation": "tools.call",
  "server": { "id": "mcp-cli:user/friday", "name": "friday", "transport": "http", "sources": [] },
  "data": {},
  "delivery": { "mode": "inline", "bytes": 2 }
}
```

Failures also emit exactly one envelope and put diagnostics on stderr:

```json
{
  "ok": false,
  "operation": "tools.call",
  "error": {
    "code": "AUTH_REQUIRED",
    "message": "Server friday requires OAuth authentication.",
    "remediation": { "command": "mcp-cli auth login friday" }
  }
}
```

When serialized `data` exceeds 64 KiB, `data` is `null` and `delivery` identifies a mode-`0600` temporary JSON file
by absolute path, media type, byte size, and SHA-256 digest. Files older than 24 hours are removed opportunistically.
Read the file before starting a later command if the calling harness may clean temporary storage.

## OAuth and Keychain

`mcp-cli auth login <server>` is the only command that opens a browser. It uses OAuth authorization code with PKCE,
protected-resource and authorization-server discovery, resource indicators, refresh tokens, and dynamic client
registration. Tokens, PKCE state, and confidential registration material are stored exclusively in macOS Keychain;
they are never written to config or stdout. `auth status` reports only non-secret presence and token metadata, and
`auth logout` deletes the protected-resource credential.

Normal MCP operations never open a browser. If credentials are absent, they exit `4` with `AUTH_REQUIRED` and the
exact `mcp-cli auth login ...` command to run.

## Supported MCP surface

- stdio and Streamable HTTP transports
- tools, resources, resource templates, and prompts
- OAuth authorization code with PKCE for Streamable HTTP

Legacy SSE, sampling, elicitation, roots, durable tasks, and persistent sessions are not supported in v0.1. Each
command creates and closes its own connection; local stdio server state and subscriptions do not survive between
commands.

The client advertises no sampling, elicitation, roots, or task capabilities. It does not implement permission gates:
the calling harness is responsible for constraining server execution and tool calls.

## Agent instruction snippet

```text
Use `mcp-cli help --json` to discover the CLI. List servers with `mcp-cli servers list`, inspect schemas with
`mcp-cli tools list <server>`, and invoke a tool with `mcp-cli tools call <server> <tool> --input '<json>'`.
All operational results are JSON. If `delivery.mode` is `file`, read the absolute path in `delivery.path`.
```

## Development and release

```bash
pnpm install --frozen-lockfile
pnpm validate
```

`validate` runs formatting, ESLint 10, strict TypeScript 6, Vitest integration fixtures, a production build, package
linting, `npm pack`, and an install-and-run smoke from a clean temporary prefix. Set `MCP_CLI_REAL_KEYCHAIN=1` when
running tests to include the temporary real-Keychain check. CI runs on macOS with Node 24. Releases are published by
the pinned GitHub Actions workflow with npm provenance.
