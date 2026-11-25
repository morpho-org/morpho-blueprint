'use client';
import type { Address } from 'viem';

import { useQuery } from '@tanstack/react-query';
import { useAccount } from 'wagmi';

import type { SupportedChainId } from '@/config/types';
import type { VaultPositionMap } from '@/modules/vault/data/getVaultPositions';

import { fetchJsonResponse } from '@/common/utils/fetch';

export function useVaultPositions() {
  const { address } = useAccount();
  return useQuery({
    queryKey: ['vault-positions', address],
    queryFn: async () =>
      fetchJsonResponse<VaultPositionMap>(`/api/account/${address}/vault-positions`),
    enabled: !!address,
  });
}

export function useVaultPosition(chainId: SupportedChainId, vaultAddress: Address) {
  const { data: positions, ...rest } = useVaultPositions();
  return { data: positions?.[chainId]?.[vaultAddress], ...rest };
}
