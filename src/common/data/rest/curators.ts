import "server-only";

import { type Address, zeroAddress } from "viem";
import { toCuratorInfo } from "@/common/data/adapters/entity";
import type { CuratorInfo } from "@/common/data/types";
import { chunk, fetchMorphoRest, fetchMorphoRestResource, restSelector } from "@/common/utils/fetchMorphoRest";
import { isBlueprintApiEnabled } from "@/common/utils/morphoApiConfig";
import { tryCatch } from "@/common/utils/tryCatch";

interface RestCuratorDetails {
  data: {
    curators: { id: string; name: string; logo_uri: string | null; socials: { type: string; url: string }[] }[];
  };
}

interface RestCuratorAum {
  data: { curator_id: string; aum_usd: number }[];
}

/** A curator's display fields and its registry id, which keys the Blueprint API AUM route. */
export interface RestCurator {
  id: string;
  info: CuratorInfo;
}

/**
 * The curator behind a vault's curator role address: name, logo and link from the first listed
 * entity, as GraphQL's `curators(first: 1)` gave. `null` for no curator, an unknown one, or a
 * failed read (logged as a warning): the row renders without the curator.
 */
export async function getCurator(chainId: number, address: Address): Promise<RestCurator | null> {
  if (address.toLowerCase() === zeroAddress) return null;
  const { data } = await tryCatch(
    fetchMorphoRestResource<RestCuratorDetails>(`/v0/curators/${restSelector(chainId, address)}/details`, undefined, {
      quiet: true,
    }),
  );
  const curator = data?.data.curators[0];
  const info = toCuratorInfo(curator && { name: curator.name, image: curator.logo_uri, socials: curator.socials });
  return curator && info ? { id: curator.id, info } : null;
}

export async function getCuratorInfo(chainId: number, address: Address): Promise<CuratorInfo | null> {
  return (await getCurator(chainId, address))?.info ?? null;
}

/**
 * Assets under curation in USD by curator registry id, from the Blueprint API (the value GraphQL's
 * `Curator.state.aum` gave), one request per 100 ids. Empty when the Blueprint API is off or the
 * read fails (logged as a warning), so the AUM stays hidden; a curator the route does not know is
 * absent.
 */
export async function getCuratorsAumUsd(curatorIds: readonly string[]): Promise<Map<string, number>> {
  const aums = new Map<string, number>();
  const ids = [...new Set(curatorIds)];
  if (!isBlueprintApiEnabled() || ids.length === 0) return aums;
  const { data } = await tryCatch(
    Promise.all(
      chunk(ids).map((batch) =>
        fetchMorphoRest<RestCuratorAum>(
          "/v0/blueprint-app-api/curators/aum",
          { curators: batch },
          { api: "blueprint", quiet: true },
        ),
      ),
    ),
  );
  for (const row of data?.flatMap((response) => response.data) ?? []) {
    if (Number.isFinite(row.aum_usd)) aums.set(row.curator_id, row.aum_usd);
  }
  return aums;
}
