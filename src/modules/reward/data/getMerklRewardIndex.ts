import "server-only";

import { cache } from "react";
import { z } from "zod";
import { fetchJsonResponse } from "@/common/utils/fetch";
import { trackEvent } from "@/common/utils/trackEvent";
import { tryCatch } from "@/common/utils/tryCatch";
import {
  emptyMerklRewardIndex,
  indexMerklRewards,
  type MerklRewardIndex,
  merklOpportunitiesPageSchema,
} from "./merklRewardApys";

const MERKL_OPPORTUNITIES_URL = "https://api.merkl.xyz/v4/opportunities";
const PAGE_SIZE = 100;
// Mainnet lists about 40 Morpho opportunities: five pages leave ample room before truncating.
const MAX_PAGES = 5;
// Reward APRs move with TVL and prices; a few minutes old is what the rewards backend serves too.
const REVALIDATE_SECONDS = 240;
// One budget for every page, with no retry: a slow Merkl must not stall the earn page or the
// health check (10 s); the pages fall back to native APYs instead.
const TIMEOUT_MS = 3_000;

async function fetchOpportunities(chainId: number): Promise<unknown[]> {
  const opportunities: unknown[] = [];
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = new URL(MERKL_OPPORTUNITIES_URL);
    url.searchParams.set("mainProtocolId", "morpho");
    url.searchParams.set("chainId", String(chainId));
    url.searchParams.set("status", "LIVE");
    url.searchParams.set("campaigns", "true");
    url.searchParams.set("items", String(PAGE_SIZE));
    url.searchParams.set("page", String(page));

    const response = await fetchJsonResponse<unknown>(url, {
      requestOptions: { signal, next: { revalidate: REVALIDATE_SECONDS } },
      retryOptionOverrides: "disabled",
      // The handled fallback reports once, below.
      suppressFailureEvent: true,
    });
    const parsed = merklOpportunitiesPageSchema.safeParse(response);
    if (!parsed.success) throw new Error(`Unexpected Merkl opportunities shape: ${z.prettifyError(parsed.error)}`);
    opportunities.push(...parsed.data);
    if (parsed.data.length < PAGE_SIZE) return opportunities;
  }
  console.warn(`Merkl opportunities truncated at ${MAX_PAGES * PAGE_SIZE} on chain ${chainId}`);
  return opportunities;
}

/**
 * Rejects after `ms` whatever the request does: Next drops a fetch's `signal` when it revalidates a
 * stale cache entry, so the abort signal alone cannot bound an ISR regeneration.
 */
async function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Merkl did not answer within ${ms} ms`)), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/**
 * The live Merkl reward campaigns of one chain, read once per render. Merkl being down is not a page
 * error: the index is empty, so pages show native APYs with no reward chips.
 */
export const getMerklRewardIndex = cache(async (chainId: number): Promise<MerklRewardIndex> => {
  const { data, error } = await tryCatch(withDeadline(fetchOpportunities(chainId), TIMEOUT_MS));
  if (error) {
    console.error(`Merkl reward APRs request failed on chain ${chainId}, rendering native APYs - ${error}`);
    trackEvent("data-fetch-error", { url: MERKL_OPPORTUNITIES_URL, chainId, error: `${error}` }).catch(() => {});
    return emptyMerklRewardIndex();
  }
  return indexMerklRewards(data, Math.floor(Date.now() / 1000));
});
