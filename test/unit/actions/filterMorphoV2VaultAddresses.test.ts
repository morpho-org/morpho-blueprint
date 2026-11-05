import { describe, expect, test } from "vitest";
import { filterMorphoV2VaultAddresses } from "@/actions/utils/filterMorphoV2VaultAddresses";
import { Erc4626VaultProtocol } from "@/config/vault-protocol";

describe("filterMorphoV2VaultAddresses", () => {
  test("keeps only Morpho V2 allocator vaults", () => {
    expect(
      filterMorphoV2VaultAddresses([
        {
          protocol: Erc4626VaultProtocol.MorphoV1,
          vault: { vaultAddress: "0x0000000000000000000000000000000000000001" },
        },
        {
          protocol: Erc4626VaultProtocol.MorphoV2,
          vault: { vaultAddress: "0x0000000000000000000000000000000000000002" },
        },
      ]),
    ).toEqual(["0x0000000000000000000000000000000000000002"]);
  });

  test("returns no addresses for an empty allocation list", () => {
    expect(filterMorphoV2VaultAddresses([])).toEqual([]);
  });
});
