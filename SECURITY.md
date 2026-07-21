# Security

Report vulnerabilities privately through GitHub Security Advisories for this repository.

`mcp-cli` executes configured stdio server commands and sends requests to configured remote servers. It does not
apply permission gates. Only use configuration from sources you trust, and rely on the invoking agent harness for
command and tool authorization.

OAuth material is stored only in macOS Keychain. Static secrets embedded in imported third-party configuration are
used in memory and redacted from CLI inspection output, but remain subject to the security of their source file.
