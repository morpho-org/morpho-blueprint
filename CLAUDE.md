# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Common Commands

**Development:**
- `pnpm dev` - Start the Next.js development server
- `pnpm build` - Build for production
- `pnpm check` - Lint and auto-fix codebase with Biome
- `pnpm check:types` - TypeScript type checking without emit
- `pnpm test` - Run Vitest tests

**Testing:**
- Tests use Vitest with jsdom environment
- Test files are in `test/` directory with `.test.ts` extension
- Tests run sequentially (not concurrent) due to anvil fork state leakage
- 120s timeout for tests

**Package Manager:**
- Uses pnpm (pinned in `package.json` `packageManager`, currently 10.34.9)
- Dependencies include Morpho SDKs, Next.js 15, React 19, Radix UI, Tailwind CSS
- Uses Biome for linting and formatting

## Architecture

**Configuration-Driven Approach:**
The app is designed as a whitelabel frontend where all customization happens in `src/config/`:
- `src/config/index.ts` - Main app configuration (chains, vaults, feature flags, branding)
- `src/config/theme.css` - Color and typography theming (follows shadcn patterns)
- `src/config/types.ts` - TypeScript definitions for configuration

**Data Layer:**
- Powered by the Morpho Core REST API (`api.morpho.org/v0`) for read-only data, behind the server-only
  `fetchMorphoRest` chokepoint; Blueprint API routes (descriptions, price history) only when their key is set.
  The public endpoint is keyless; `MORPHO_REST_API_URL`/`MORPHO_API_KEY` are optional overrides for a dedicated
  instance.
- Reward APRs come from Merkl (`src/modules/reward/data/`)
- App-owned data types in `src/common/data/types.ts`; adapters mapping API responses onto them in
  `src/common/data/adapters/` and each module's `data/adapters.ts`. Components never see a generated type.
- Data fetching functions organized by domain in module-specific `data/` directories
- Wallet ERC-20 balances are joined in via a server-side multicall (`src/common/data/rpc/`), not the Morpho API
- Chain icons are not served by the Morpho API; they come from the Morpho CDN via the per-chain `iconSlug` config,
  which does not cover every chain (missing ones render without an icon)

**Action System:**
Blockchain interactions use a standardized action pattern:
- Actions in `src/actions/` return either success (with signature/transaction requests) or error status
- Two main action types: `VaultAction` and `MarketAction` 
- Actions include position change calculations for UI updates
- Uses Morpho's bundler SDK for transaction bundling

**Component Structure:**
- Module-based architecture in `src/modules/` organized by domain:
  - `market/`, `vault/`, `token/`, `wallet/`, `reward/`, `compliance/`, `action-flow/`
  - Each module contains its own `components/`, `hooks/`, `data/`, and `utils/` subdirectories
- Shared UI components in `src/common/components/` (shadcn-based)
- Shared utilities, hooks, and providers in `src/common/`
- Form components use react-hook-form with Zod validation
- Responsive design with mobile-first approach using drawer/popover patterns

**State Management:**
- React Query for server state and caching
- React Hook Form for form state
- Context providers for wallet connection (wagmi) and theming

**Supported Chains:**
- Demo config: Mainnet, Base, Polygon, Unichain, Katana, Arbitrum, World Chain, HyperEVM
- Every configured chain must be indexed by the configured Morpho API instance
- Chain configuration includes RPC URLs and supported vaults per chain
- Type-safe chain IDs via `SUPPORTED_CHAIN_IDS` constant
- A mainnet RPC URL is required for all deployments: the OFAC screening reads Chainalysis's on-chain
  oracle on mainnet and fails closed

**Feature Flags:**
Configurable features in `APP_CONFIG.featureFlags`:
- `enableDarkModeToggle` - Enable dark mode switching in the footer
- `hideCurator` - Hide the vault curators throughout the app
