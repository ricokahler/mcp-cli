# Repository guide

- Runtime: macOS with Node.js 24 or newer.
- Package manager: pnpm. Keep `pnpm-lock.yaml` committed.
- Run `pnpm validate` before handing off changes.
- Keep stdout machine-readable for operational commands; diagnostics belong on stderr.
- Never persist OAuth credentials outside macOS Keychain.
- Third-party MCP configuration files are read-only inputs.
- Do not add permission prompts or policy gates to this CLI; the invoking harness owns policy.
