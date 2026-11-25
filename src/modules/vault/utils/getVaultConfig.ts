import { getAddress } from 'viem';

import type { SupportedChainId, VaultConfig } from '@/config/types';

import { APP_CONFIG } from '@/config';

export function getVaultConfig(
  chainId: SupportedChainId,
  vaultAddress: string,
): VaultConfig | undefined {
  return APP_CONFIG.supportedVaults[chainId]?.find((v) => v.address === getAddress(vaultAddress));
}
