# Morpho Blueprint

![Morpho Blueprint](/public/opengraph-image.png)

Morpho Blueprint is an open-source [Next.js](https://nextjs.org/) white-label frontend template for the [Morpho protocol](https://morpho.org/), originally built by [Paperclip Labs](https://paperclip.xyz/) and maintained as the reference implementation of a Blueprint app on the public [Morpho API](https://docs.morpho.org/tools/offchain/api/). It enables anyone to deploy their own custom Morpho interface in hours instead of weeks or months.

## Quickstart

The app reads all protocol data from the public, keyless Morpho GraphQL API, so no data credential is needed:

```bash
pnpm i
cp .env.example .env   # populate RPC URLs and a Reown project id
pnpm dev
```

## Configuration

All configuration happens via files in the [config folder](src/config/), which should be the only folder you need to touch to create a custom deployment. The config files are:

-   [index.ts](src/config/index.ts): App configuration controlling things like:
    -   Which chains your app supports
    -   Which vaults your app supports
    -   Action parameters
    -   App metadata
    -   Feature flags
    -   ...
    -   Check out the [`AppConfig` type definition](src/config/types.ts) for full parameter documentation
-   [theme.css](src/config/theme.css): Customize all colors and typography to match your brand. This closely follows the standard [shadcn theming](https://ui.shadcn.com/themes).

> If the provided customization parameters are insufficient for your use case, you can modify code outside the `/config` folder, but this will be harder to pick up additional future features and patches from this canonical template repo.

## Data

Read-only data comes from Morpho's API, through two server-only chokepoints: the Core REST API (`/v0` routes) via [fetchMorphoRest](src/common/utils/fetchMorphoRest.ts) for positions, the supported-market list and Vault V1 history, and the [Morpho GraphQL API](https://api.morpho.org/graphql) via [executeMorphoQuery](src/common/utils/executeMorphoQuery.ts) for everything else. The browser only ever talks to the app's own `/api/*` routes.

The public endpoints are keyless, so the app runs as-is with no data credential. To point a deployment at a dedicated API instance, set `MORPHO_API_URL` (GraphQL), `MORPHO_REST_API_URL` (REST) and `MORPHO_API_KEY` (sent to both as an `x-api-key` header).

GraphQL types are generated from a committed schema snapshot in [`schema/`](schema/), so builds never depend on a live upstream. See [`schema/README.md`](schema/README.md) for how to refresh it.

Two things the API does not serve are sourced elsewhere:

-   Wallet ERC-20 balances are joined in server-side with a multicall `balanceOf` against the configured RPC URLs.
-   Chain icons come from the Morpho CDN (`https://cdn.morpho.org/assets/chains/<slug>.svg`), configured per chain via `iconSlug` in the chain config; a chain without a slug renders without an icon.

Every chain in `SUPPORTED_CHAIN_IDS` must be indexed by the configured API instance — the public endpoint rejects queries for chains it does not serve. You can check the served set with `{ chains { id network } }` against the endpoint.

## Environment

See [.env.example](.env.example) for the full list. Notes:

-   `MORPHO_API_URL` / `MORPHO_API_KEY` are optional; without them the app uses the public keyless endpoint.
-   `MORPHO_REST_API_URL` is optional: the Core REST host, `https://api.morpho.org` by default, or the host of `MORPHO_API_URL` when only that is set. `MORPHO_API_KEY` is sent there too.
-   A mainnet RPC URL (`MAINNET_RPC_URL_1`) is **required for all deployments, even ones that don't serve mainnet vaults or markets**: the OFAC sanctions screening reads Chainalysis's on-chain oracle on mainnet and fails closed, so without a mainnet RPC every transaction flow is blocked.
-   Each supported chain needs its RPC URLs (`<CHAIN>_RPC_URL_1`, optionally `<CHAIN>_RPC_URL_2`).

## Local Development

Install Dependencies

```bash
pnpm i
```

Create and populate environment variables

```bash
cp .env.example .env
# Now populate the .env file
```

Start the development server

```bash
pnpm dev
```

Run tests

```bash
pnpm test
```

Build

```bash
pnpm build
```

## Parity and screenshot checks

A data-layer change proves it serves the same data as before with the scripts in [`scripts/verify/`](scripts/verify/). They are tooling only: nothing under `src/` imports them, so they never reach the app bundle.

### Parity dump

`parity-dump.mjs` runs a checkout's own data providers outside Next.js (through Vitest, with `server-only`, `next/cache` and `next/font` stubbed) and writes what they return to JSON. It runs on any checkout with `node_modules` installed, so the same script dumps `main` and a branch:

```bash
git worktree add ../morpho-blueprint-main origin/main
(cd ../morpho-blueprint-main && pnpm install && pnpm codegen)

node scripts/verify/parity-dump.mjs --app ../morpho-blueprint-main --out /tmp/parity/base.json
node scripts/verify/parity-dump.mjs --app . --out /tmp/parity/head.json
```

-   `--providers`: `summaries` (`getVaultSummaries`) and `vaults` (`getVault` for every configured vault) by default; `market-summaries` (`getMarketSummaries`, the borrow table); `vault-positions` and `market-positions` need `--account 0x...`. The request count is also split by the Next data-cache lifetime each call asks for (`none` is read on every render).
-   `--vaults 1:0xabc,1:0xdef`: only these configured vaults.
-   `--max-requests` (default 50): every `fetch` counts, retries included. A request past the cap is refused and the run fails without writing a dump. The public API locks a client out for 10 minutes above 750 requests a minute. Raise the cap for a large provider such as `market-positions`, and run it on its own.
-   The upstream is whatever the shell sets (`MORPHO_API_URL`, `MORPHO_REST_API_URL`, `MORPHO_API_KEY`), the public API otherwise. Positions read wallet balances from `MAINNET_RPC_URL_1`.

### Parity compare

```bash
node scripts/verify/parity-compare.mjs /tmp/parity/base.json /tmp/parity/head.json --report /tmp/parity/report.md
```

Checks the two dumps field by field. Token amounts and ratios (LTV, LLTV, caps, supply shares) match within 1e-5, USD values within 0.1% relative, everything else exactly. Lists are matched by identity (vault, adapter, market, token address, bucket timestamp), not position. Chart series are compared on the window both dumps cover: each side may lose one bucket at each end (a rolling window moves between dumps), more is reported as lost coverage. Every other difference must match an entry of [`accepted-differences.json`](scripts/verify/accepted-differences.json), which gives its path, an optional bound and the reason. Exit code 1 means at least one unexpected difference. Take the base and head dumps back to back: USD values follow live prices, and ETH can move more than 0.1% within a minute (rerun both when only `usd` leaves differ).

### Screenshots

`screenshots.mjs` takes full-page screenshots on desktop (1440x900) and mobile (390x844) and writes `<name>-report.json` with each page's HTTP status, console errors and failed requests. The Vercel toolbar and Intercom are blocked. Playwright is not a dependency of this repo; install it anywhere and point at it:

```bash
npm i --prefix /tmp/pw @playwright/test && npx --prefix /tmp/pw playwright install chromium

pnpm build && pnpm start   # local build on http://localhost:3000
node scripts/verify/screenshots.mjs --url http://localhost:3000 --name local --out /tmp/screens --playwright-from /tmp/pw
node scripts/verify/screenshots.mjs --url https://morpho-blueprint.vercel.app --name prod --out /tmp/screens --playwright-from /tmp/pw
```

`--paths /earn,/earn/1/0x...` picks the pages (the earn page and one vault page by default).

## Acknowledgement

This open-source project was created by [Paperclip Labs](https://paperclip.xyz/) and made possible through the support of [Morpho](https://morpho.org/) and [Steakhouse Financial](https://www.steakhouse.financial/).

Initial development was partially funded through a Morpho DAO grant ([MIP-93](https://forum.morpho.org/t/mip-93-call-for-grants/1177/23)), administered by [Re7 Labs](https://www.re7labs.xyz/).

## Licensing

The code is under the MIT License, see [`LICENSE`](./LICENSE).
