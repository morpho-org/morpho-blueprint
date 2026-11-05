import { getChainAddress } from "@morpho-org/blue-sdk";
import { parseEther } from "viem";
import { beforeAll, describe, expect } from "vitest";

import { erc4626SupplyViaMorphoSdkAction } from "@/actions/erc4626/supply/erc4626SupplyViaMorphoSdkAction";

import { test } from "../../../../config";
import { configureTestVaults, V2_WETH_VAULT } from "../../../../helpers/vaultFixtures";
import {
  failureTestCases,
  runErc4626SupplyRevokeApprovalNotRequiredTest,
  runErc4626SupplyRevokeApprovalRequiredTest,
  runErc4626SupplySufficientAllowanceTest,
  runErc4626SupplyTest,
  runSlippageTest,
  successTestCases,
} from "./shared";

describe("erc4626SupplyViaMorphoSdkAction", () => {
  beforeAll(configureTestVaults);

  for (const wrap of [false, true]) {
    test(`V2 deposit with wrapping ${wrap}`, async ({ client }) => {
      const vaultBundlesV1 = getChainAddress(client.chain.id, "bundles.vaultBundlesV1");
      await runErc4626SupplyTest({
        client,
        initialState: { walletUnderlyingAssetBalance: wrap ? parseEther("0.005") : parseEther("0.02") },
        inputs: { vaultAddress: V2_WETH_VAULT, supplyAmount: parseEther("0.01"), allowNativeAssetWrapping: wrap },
        supplyActionFn: erc4626SupplyViaMorphoSdkAction,
        expectedApprovalTargets: [vaultBundlesV1],
        expectedZeroBalanceAddresses: [vaultBundlesV1],
      });
    });
  }
  describe("happy path", () => {
    successTestCases.map((testCase) => {
      test(testCase.name, async ({ client }) => {
        const vaultBundlesV1 = getChainAddress(client.chain.id, "bundles.vaultBundlesV1");

        await runErc4626SupplyTest({
          client,
          ...testCase,
          supplyActionFn: erc4626SupplyViaMorphoSdkAction,
          expectedApprovalTargets: [vaultBundlesV1], // Only approves the vault bundler (using approval tx, not permit2)
          expectedZeroBalanceAddresses: [vaultBundlesV1], // Check bundler/adapter have no leftover funds
        });
      });
    });

    test("revokes approval for tokens requiring it (USDT) when existing allowance is insufficient", async ({
      client,
    }) => {
      const vaultBundlesV1 = getChainAddress(client.chain.id, "bundles.vaultBundlesV1");
      await runErc4626SupplyRevokeApprovalRequiredTest(client, erc4626SupplyViaMorphoSdkAction, vaultBundlesV1);
    });

    test("does NOT revoke approval for tokens not requiring it (USDC) when existing allowance is insufficient", async ({
      client,
    }) => {
      const vaultBundlesV1 = getChainAddress(client.chain.id, "bundles.vaultBundlesV1");
      await runErc4626SupplyRevokeApprovalNotRequiredTest(client, erc4626SupplyViaMorphoSdkAction, vaultBundlesV1);
    });

    test("skips approval entirely when sufficient allowance already exists", async ({ client }) => {
      const vaultBundlesV1 = getChainAddress(client.chain.id, "bundles.vaultBundlesV1");
      await runErc4626SupplySufficientAllowanceTest(client, erc4626SupplyViaMorphoSdkAction, vaultBundlesV1);
    });
  });

  describe("sad path", () => {
    failureTestCases.map((testCase) => {
      test(testCase.name, async ({ client }) => {
        const vaultBundlesV1 = getChainAddress(client.chain.id, "bundles.vaultBundlesV1");

        await expect(
          runErc4626SupplyTest({
            client,
            ...testCase,
            supplyActionFn: erc4626SupplyViaMorphoSdkAction,
            expectedApprovalTargets: [vaultBundlesV1],
            expectedZeroBalanceAddresses: [vaultBundlesV1],
          }),
        ).rejects.toThrow(testCase.expectedError);
      });
    });

    test("tx should revert if slippage tolerance is exceeded", async ({ client }) => {
      const vaultBundlesV1 = getChainAddress(client.chain.id, "bundles.vaultBundlesV1");

      await expect(
        runSlippageTest(client, erc4626SupplyViaMorphoSdkAction, [vaultBundlesV1], [vaultBundlesV1]),
      ).rejects.toThrow("action-tx-reverted");
    });
  });
});
