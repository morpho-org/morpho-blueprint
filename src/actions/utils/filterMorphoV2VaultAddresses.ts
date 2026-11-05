import type { Address } from "viem";
import { Erc4626VaultProtocol } from "@/config/vault-protocol";

export function filterMorphoV2VaultAddresses(
  allocations: readonly {
    protocol: Erc4626VaultProtocol;
    vault: { vaultAddress: Address };
  }[],
): Address[] {
  return allocations
    .filter(({ protocol }) => protocol === Erc4626VaultProtocol.MorphoV2)
    .map(({ vault }) => vault.vaultAddress);
}
