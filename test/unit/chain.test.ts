import { getChainAddress, getChainAddresses } from "@morpho-org/blue-sdk";
import { createPublicClient, http } from "viem";
import { getCode, readContract } from "viem/actions";
import { describe, expect, test } from "vitest";
import { merklDistributorAbi } from "@/actions/abis/merklDistributorAbi";
import { wrappedNativeAssetAbi } from "@/actions/abis/wrappedNativeAssetAbi";
import { MERKL_DISTRIBUTOR_ADDRESS } from "@/actions/constants";
import { APP_CONFIG, SUPPORTED_CHAIN_IDS } from "@/config";

describe("chain", async () => {
  for (const chainId of SUPPORTED_CHAIN_IDS) {
    describe(`id: ${chainId}`, () => {
      const chainConfig = APP_CONFIG.chainConfig[chainId];
      const client = createPublicClient({ chain: chainConfig.chain, transport: http(chainConfig.rpcUrls[0]) });

      test("rpc reports the matching chain id", async () => {
        await expect(client.getChainId()).resolves.toEqual(chainConfig.chain.id);
      });

      test("valid merkl distributor contract", async () => {
        // Verify the distributor contract has the expected interface by calling a view function
        // This will throw if the contract doesn't exist or doesn't have the getMerkleRoot function
        await readContract(client, {
          address: MERKL_DISTRIBUTOR_ADDRESS,
          abi: merklDistributorAbi,
          functionName: "getMerkleRoot",
        });
      });

      test("valid morpho SDK addresses", async () => {
        // Will throw if the id is not even supported by the SDK
        const { wNative } = getChainAddresses(chainConfig.chain.id);
        const vaultBundlesV1 = getChainAddress(chainConfig.chain.id, "bundles.vaultBundlesV1");
        const blueBundlesV1 = getChainAddress(chainConfig.chain.id, "bundles.blueBundlesV1");

        // Check wNative address is present, and contract has the name function
        expect(wNative).toBeDefined();
        await readContract(client, {
          address: wNative!,
          abi: wrappedNativeAssetAbi,
          functionName: "name",
        });

        for (const address of [vaultBundlesV1, blueBundlesV1]) {
          expect(address).toBeDefined();
          const code = await getCode(client, { address });
          expect(code).toBeDefined();
          expect(code).not.toEqual("0x");
        }
      });

      test("supports multicall3", async () => {
        const multicall3Address = chainConfig.chain.contracts?.multicall3?.address;
        expect(multicall3Address).toBeDefined();
      });
    });
  }
});
