import "server-only";

import { type Address, getAddress } from "viem";
import { toTokenInfo } from "@/common/data/adapters/entity";
import type { TokenInfo } from "@/common/data/types";
import { SECONDS_PER_DAY } from "@/common/utils/constants";
import { fetchMorphoRestResource, MorphoRestError, restSelector } from "@/common/utils/fetchMorphoRest";

/** ERC-20 decimals are a uint8. Anything else (null, a float, a string) is unknown, never a default. */
export function parseTokenDecimals(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 255 ? value : null;
}

/** Core REST's `/v0/tokens/{token}` body. */
export interface RestToken {
  address: string;
  name: string | null;
  symbol: string | null;
  decimals: unknown;
  logo_uri: string | null;
  tags: string[] | null;
}

/** A token's metadata, or `null` when Core REST does not know it. Logos and tags rarely change: a day cache. */
export async function getTokenMetadata(chainId: number, address: Address): Promise<RestToken | null> {
  const response = await fetchMorphoRestResource<{ data: RestToken }>(
    `/v0/tokens/${restSelector(chainId, address)}`,
    undefined,
    { revalidate: SECONDS_PER_DAY },
  );
  return response?.data ?? null;
}

/** A token's decimals, or `null` when Core REST does not know them. Immutable, so cached. */
export async function getTokenDecimals(chainId: number, address: Address): Promise<number | null> {
  return parseTokenDecimals((await getTokenMetadata(chainId, address))?.decimals);
}

/**
 * A vault asset's decimals: the vault root's when valid, else the token metadata's (read here unless
 * the caller passes what it already read). `null` when neither knows them; the caller must not guess.
 */
export async function getVaultAssetDecimals(
  chainId: number,
  asset: { address: string; decimals: unknown },
  token?: RestToken | null,
): Promise<number | null> {
  const rootDecimals = parseTokenDecimals(asset.decimals);
  if (rootDecimals !== null) return rootDecimals;
  const metadata = token === undefined ? await getTokenMetadata(chainId, getAddress(asset.address)) : token;
  return parseTokenDecimals(metadata?.decimals);
}

export interface TokenPriceOptions {
  /** Seconds the Next data cache may serve the price. Uncached by default. */
  revalidate?: number;
  /**
   * Throw on a 429 instead of degrading to `null`, so a rate-limited render fails and Next keeps
   * the last good page rather than caching one with no USD values.
   */
  throwWhenRateLimited?: boolean;
}

/**
 * A token's current USD price, or `null` when it has none. A failed price read also degrades to
 * `null` (logged as a warning by the client), as a missing GraphQL price did: the row still renders.
 */
export async function getTokenPriceUsd(
  chainId: number,
  address: Address,
  options: TokenPriceOptions = {},
): Promise<number | null> {
  try {
    const response = await fetchMorphoRestResource<{ data: { price: number | null } }>(
      `/v0/tokens/${restSelector(chainId, address)}/price`,
      undefined,
      { quiet: true, revalidate: options.revalidate },
    );
    return response?.data.price ?? null;
  } catch (error) {
    if (options.throwWhenRateLimited && error instanceof MorphoRestError && error.status === 429) throw error;
    return null;
  }
}

/**
 * A token's metadata as the app's `TokenInfo`, or `null` when Core REST does not know the token or
 * its decimals. Core REST types the name and symbol as nullable: each falls back to the other, then
 * to a placeholder.
 */
export async function getTokenInfo(chainId: number, address: Address): Promise<TokenInfo | null> {
  const token = await getTokenMetadata(chainId, address);
  const decimals = parseTokenDecimals(token?.decimals);
  if (!token || decimals == null) return null;
  return toTokenInfo({
    ...token,
    name: token.name ?? token.symbol ?? "UNKNOWN",
    symbol: token.symbol ?? token.name ?? "UNKNOWN",
    decimals,
    logoURI: token.logo_uri,
  });
}
