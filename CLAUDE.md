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
- Uses pnpm (the version pinned in `packageManager` in package.json)
- Dependencies include Morpho SDKs, Next.js 15, React 19, Radix UI, Tailwind CSS
- Uses Biome for linting and formatting

## Architecture

**Configuration-Driven Approach:**
The app is designed as a whitelabel frontend where all customization happens in `src/config/`:
- `src/config/index.ts` - Main app configuration (chains, vaults, feature flags, branding)
- `src/config/theme.css` - Color and typography theming (follows shadcn patterns)
- `src/config/types.ts` - TypeScript definitions for configuration

**Data Layer:**
- Read-only data comes from the Morpho Core REST API (`/v0`, `/v1`) behind the server-only `fetchMorphoRest`
  chokepoint; `src/common/utils/morphoApiConfig.ts` picks the host:
  - With `MORPHO_INTERNAL_API_KEY` set, Core REST and the Blueprint API routes (descriptions, price history) both go
    to `MORPHO_INTERNAL_API_URL` with that key.
  - Without it, Core REST goes to `MORPHO_REST_API_URL`, else the host of the legacy `MORPHO_API_URL` (the former
    GraphQL endpoint), else the public `https://api.morpho.org`, with `MORPHO_API_KEY` when set (keyless public
    access ends after Feb 28, 2026). The Blueprint API routes are off and their callers use fallbacks.
  - `morphoApi.requireInternal` (false here) makes the internal deployment mandatory: reads throw without it.
- Reward APRs come from Merkl (`src/modules/reward/data/`)
- App-owned data types in `src/common/data/types.ts`; adapters mapping API responses onto them in
  `src/common/data/adapters/` and each module's `data/adapters.ts`. Components never see a raw API response type.
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
