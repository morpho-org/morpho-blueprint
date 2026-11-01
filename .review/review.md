# Blueprint review

Use `CLAUDE.md` for the architecture, configuration boundaries and verification commands.

- Preserve the server-only GraphQL executor and app-owned data types/adapters; components must not depend on generated GraphQL types.
- Keep configuration-driven branding, chains and feature flags in `src/config/`. Every configured chain must be supported by the selected API.
- Mainnet RPC is required for OFAC screening; screening failures must remain fail-closed.
- For server routes, check input boundaries, bounded upstream calls and sanitized failure responses. Do not expose credentials or forward optional API keys to unrelated services.
- Workflow changes must retain trusted-base execution, immutable shared-workflow pins and least-privilege job permissions. Review execution must not run untrusted PR code with write credentials.

Biome, TypeScript and Vitest own mechanical checks. A green configuration check is not evidence of a completed review or a deployed runtime request.
