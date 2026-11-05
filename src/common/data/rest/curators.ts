import "server-only";

import { type Address, zeroAddress } from "viem";
import { toCuratorInfo } from "@/common/data/adapters/entity";
import type { CuratorInfo } from "@/common/data/types";
import { fetchMorphoRestResource, restSelector } from "@/common/utils/fetchMorphoRest";
import { tryCatch } from "@/common/utils/tryCatch";

interface RestCuratorDetails {
  data: {
    curators: { name: string; logo_uri: string | null; socials: { type: string; url: string }[] }[];
  };
}

/**
 * The curator behind a vault's curator role address: name, logo and link from the first listed
 * entity, as GraphQL's `curators(first: 1)` gave. `null` for no curator, an unknown one, or a
 * failed read (logged as a warning): the row renders without the curator.
 */
export async function getCuratorInfo(chainId: number, address: Address): Promise<CuratorInfo | null> {
  if (address.toLowerCase() === zeroAddress) return null;
  const { data } = await tryCatch(
    fetchMorphoRestResource<RestCuratorDetails>(`/v0/curators/${restSelector(chainId, address)}/details`, undefined, {
      quiet: true,
    }),
  );
  const curator = data?.data.curators[0];
  return toCuratorInfo(curator && { name: curator.name, image: curator.logo_uri, socials: curator.socials });
}
