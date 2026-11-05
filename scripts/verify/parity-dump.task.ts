import { writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "vitest";

// Run through `node scripts/verify/parity-dump.mjs`, which sets these. The providers are imported
// from the target checkout (`@/` is aliased to it), so nothing here is typed against them.
const outFile = process.env.PARITY_OUT ?? "";
const maxRequests = Number(process.env.PARITY_MAX_REQUESTS ?? "50");
const account = process.env.PARITY_ACCOUNT || undefined;
const list = (value: string | undefined) =>
  (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
const vaultFilter = list(process.env.PARITY_VAULTS).map((key) => key.toLowerCase());
const providers = new Set(list(process.env.PARITY_PROVIDERS || "summaries,vaults"));
const marketKeys = list(process.env.PARITY_MARKETS);

const KNOWN_PROVIDERS = ["summaries", "vaults", "vault-positions", "market-positions", "market-summaries", "markets"];

type Provider = (...args: unknown[]) => Promise<unknown>;
interface ConfiguredVault {
  address: string;
  protocol: string;
}

// Every upstream call goes through global fetch (the Morpho API helpers, viem's http transport).
// Counting there includes retries, which is what the API's rate limit sees. A request past the cap
// is refused, not sent; some providers degrade on a failed read (wallet balances), so a refusal
// still fails the run rather than leave a partial dump.
const requestsByHost = new Map<string, number>();
// By the Next data-cache lifetime the call asks for ("none" = read on every render): a warm render
// only repeats the calls whose lifetime has run out.
const requestsByRevalidate = new Map<string, number>();
let requestCount = 0;
let refused = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (requestCount >= maxRequests) {
    refused += 1;
    throw new Error(`Request cap of ${maxRequests} reached (refused: ${url.host}${url.pathname})`);
  }
  requestCount += 1;
  requestsByHost.set(url.host, (requestsByHost.get(url.host) ?? 0) + 1);
  const revalidate = String(init?.next?.revalidate ?? "none");
  requestsByRevalidate.set(revalidate, (requestsByRevalidate.get(revalidate) ?? 0) + 1);
  return realFetch(input, init);
};

// The app's amounts are strings already; a bigint can only come from a provider that leaks one.
function toJson(value: unknown): string {
  return JSON.stringify(value, (_key, v) => (typeof v === "bigint" ? v.toString() : v), 2);
}

async function load<T>(modulePath: string): Promise<T> {
  return (await import(/* @vite-ignore */ modulePath)) as T;
}

test("parity dump", async () => {
  if (!outFile) throw new Error("PARITY_OUT is not set; run node scripts/verify/parity-dump.mjs");
  const unknown = [...providers].filter((name) => !KNOWN_PROVIDERS.includes(name));
  if (unknown.length > 0) throw new Error(`Unknown provider ${unknown.join(",")}; known: ${KNOWN_PROVIDERS}`);
  const needsAccount = providers.has("vault-positions") || providers.has("market-positions");
  if (needsAccount && !account) throw new Error("vault-positions and market-positions need --account");
  if (providers.has("markets") && marketKeys.length === 0) throw new Error("markets needs --markets 1:0x...");

  const { APP_CONFIG } = await load<{ APP_CONFIG: { supportedVaults: Record<string, ConfiguredVault[]> } }>("@/config");
  const vaults = Object.entries(APP_CONFIG.supportedVaults)
    .flatMap(([chainId, configured]) =>
      configured.map((vault) => ({ key: `${chainId}:${vault.address}`, chainId, ...vault })),
    )
    .filter((vault) => vaultFilter.length === 0 || vaultFilter.includes(vault.key.toLowerCase()));
  if (vaultFilter.length > 0 && vaults.length !== vaultFilter.length) {
    throw new Error(`--vaults names a vault that is not configured: ${vaultFilter.join(",")}`);
  }

  const data: Record<string, unknown> = {};
  try {
    if (providers.has("summaries")) {
      const { getVaultSummaries } = await load<{ getVaultSummaries: Provider }>(
        "@/modules/vault/data/getVaultSummaries",
      );
      data.vaultSummaries = await getVaultSummaries();
    }
    if (providers.has("vaults")) {
      const { getVault } = await load<{ getVault: Provider }>("@/modules/vault/data/getVault");
      const details: Record<string, unknown> = {};
      // Sequential: one vault's burst at a time keeps the request rate low.
      for (const vault of vaults) {
        details[vault.key] = await getVault(Number(vault.chainId), vault.address, vault.protocol);
      }
      data.vaults = details;
    }
    if (providers.has("vault-positions")) {
      const { getVaultPositions } = await load<{ getVaultPositions: Provider }>(
        "@/modules/vault/data/getVaultPositions",
      );
      data.vaultPositions = await getVaultPositions(account);
    }
    if (providers.has("market-positions")) {
      const { getMarketPositions } = await load<{ getMarketPositions: Provider }>(
        "@/modules/market/data/getMarketPositions",
      );
      data.marketPositions = await getMarketPositions(account);
    }
    if (providers.has("market-summaries")) {
      // Keyed by chain and id: one market id can exist on two chains. Idle markets (no collateral)
      // apart, since the borrow table never shows them.
      type Row = { chain: { id: number }; marketId: string; collateralAsset: unknown };
      const { getMarketSummaries } = await load<{ getMarketSummaries: () => Promise<Row[]> }>(
        "@/modules/market/data/getMarketSummaries",
      );
      const markets: Record<string, Row> = {};
      const idleMarkets: Record<string, Row> = {};
      for (const row of await getMarketSummaries()) {
        (row.collateralAsset ? markets : idleMarkets)[`${row.chain.id}:${row.marketId}`] = row;
      }
      data.marketSummaries = { markets, idleMarkets };
    }
    if (providers.has("markets")) {
      const { getMarket } = await load<{ getMarket: Provider }>("@/modules/market/data/getMarket");
      const markets: Record<string, unknown> = {};
      // Sequential, like vaults: one market page's burst at a time.
      for (const key of marketKeys) {
        const [chainId, marketId] = key.split(":");
        markets[key] = await getMarket(Number(chainId), marketId);
      }
      data.markets = markets;
    }
  } finally {
    const hosts = [...requestsByHost].map(([host, n]) => `${host}=${n}`).join(", ");
    const lifetimes = [...requestsByRevalidate].map(([seconds, n]) => `${seconds}=${n}`).join(", ");
    console.log(`requests: ${requestCount} sent, ${refused} refused (${hosts}; revalidate ${lifetimes})`);
  }
  if (refused > 0) {
    throw new Error(`Request cap of ${maxRequests} reached; narrow the run with --vaults or --providers`);
  }

  const meta = {
    app: path.resolve(process.env.PARITY_APP ?? "."),
    gitSha: process.env.PARITY_GIT_SHA || null,
    generatedAt: new Date().toISOString(),
    providers: [...providers],
    account: account ?? null,
    vaults: vaults.map((vault) => vault.key),
    requests: {
      total: requestCount,
      byHost: Object.fromEntries(requestsByHost),
      byRevalidate: Object.fromEntries(requestsByRevalidate),
    },
  };
  writeFileSync(outFile, `${toJson({ meta, data })}\n`);
  console.log(`wrote ${outFile}`);
});
