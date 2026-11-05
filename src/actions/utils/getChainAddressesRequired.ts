import { getChainAddresses } from "@morpho-org/blue-sdk";
import { UserFacingError } from "..";

// Will throw if unsupported chainId or a required address is missing
export function getChainAddressesRequired(chainId: number) {
  const { wNative: wrappedNativeAssetAddress } = getChainAddresses(chainId);

  if (!wrappedNativeAssetAddress) {
    throw new UserFacingError(`Unknown wrapped native asset address for chain ${chainId}.`);
  }

  return { wrappedNativeAssetAddress };
}
