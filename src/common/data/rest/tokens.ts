import "server-only";

import type { Address } from "viem";
import { SECONDS_PER_DAY } from "@/common/utils/constants";
import { fetchMorphoRestResource, restSelector } from "@/common/utils/fetchMorphoRest";

/** ERC-20 decimals are a uint8. Anything else (null, a float, a string) is unknown, never a default. */
export function parseTokenDecimals(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 255 ? value : null;
}

/** A token's decimals, or `null` when Core REST does not know them. Immutable, so cached. */
export async function getTokenDecimals(chainId: number, address: Address): Promise<number | null> {
  const response = await fetchMorphoRestResource<{ data: { decimals: unknown } }>(
    `/v0/tokens/${restSelector(chainId, address)}`,
    undefined,
    { revalidate: SECONDS_PER_DAY },
  );
  return parseTokenDecimals(response?.data.decimals);
}

/**
 * A token's current USD price, or `null` when it has none. A failed price read also degrades to
 * `null` (logged as a warning by the client), as a missing GraphQL price did: the row still renders.
 */
export async function getTokenPriceUsd(chainId: number, address: Address): Promise<number | null> {
  try {
    const response = await fetchMorphoRestResource<{ data: { price: number | null } }>(
      `/v0/tokens/${restSelector(chainId, address)}/price`,
      undefined,
      { quiet: true },
    );
    return response?.data.price ?? null;
  } catch {
    return null;
  }
}
