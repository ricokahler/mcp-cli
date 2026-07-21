# Changelog

## 0.1.2

- Resolve conflicting bare server names by deterministic source priority, preferring mcp-cli config.
- Fall through connection failures to the next matching config without retrying MCP operations.

## 0.1.1

- Re-register the OAuth client when an interactive login uses a different loopback redirect URI.

## 0.1.0

- Initial public release.
