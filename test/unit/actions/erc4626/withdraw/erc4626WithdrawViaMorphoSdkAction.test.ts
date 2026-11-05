import { getChainAddress } from "@morpho-org/blue-sdk";
import { metaMorphoAbi } from "@morpho-org/blue-sdk-viem";
import { maxUint256, parseEther, parseUnits } from "viem";
import { beforeAll, describe, expect } from "vitest";
import { erc4626WithdrawViaMorphoSdkAction } from "@/actions/erc4626/withdraw/erc4626WithdrawViaMorphoSdkAction";
import { APP_CONFIG } from "@/config";
import { test } from "../../../../config";
import { extractApprovalEvents } from "../../../../helpers/logs";
import { configureTestVaults, V2_WETH_VAULT } from "../../../../helpers/vaultFixtures";
import { failureTestCases, runErc4626WithdrawTest, successTestCases } from "./shared";

describe("erc4626WithdrawViaMorphoSdkAction", () => {
  beforeAll(configureTestVaults);

  for (const withdrawAmount of [parseEther("0.01"), maxUint256]) {
    test(`V2 withdraw ${withdrawAmount === maxUint256 ? "full" : "partial"} with unwrap`, async ({ client }) => {
      const vaultBundlesV1 = getChainAddress(client.chain.id, "bundles.vaultBundlesV1");
      await runErc4626WithdrawTest({
        client,
        initialState: { vaultPositionBalance: parseEther("0.02") },
        inputs: { vaultAddress: V2_WETH_VAULT, withdrawAmount, unwrapNativeAssets: true },
        withdrawActionFn: erc4626WithdrawViaMorphoSdkAction,
        expectedApprovalTargets: [vaultBundlesV1],
        expectedZeroBalanceAddresses: [vaultBundlesV1],
        fullRedeemSlippageTolerance: APP_CONFIG.actionParameters.bundler3Config.slippageToleranceWad,
      });
    });
  }
  describe("happy path", () => {
    successTestCases.map((testCase) => {
      test(testCase.name, async ({ client }) => {
        const vaultBundlesV1 = getChainAddress(client.chain.id, "bundles.vaultBundlesV1");

        await runErc4626WithdrawTest({
          client,
          ...testCase,
          withdrawActionFn: erc4626WithdrawViaMorphoSdkAction,
          fullRedeemSlippageTolerance: APP_CONFIG.actionParameters.bundler3Config.slippageToleranceWad,
          expectedApprovalTargets: [vaultBundlesV1], // Only approves the vault bundler (using approval tx, not permit2)
          expectedZeroBalanceAddresses: [vaultBundlesV1], // Check bundler/adapter have no leftover funds
        });
      });
    });

    test("skips approval if it already has enough allowance", async ({ client }) => {
      const vaultAddress = "0xBEEF01735c132Ada46AA9aA4c54623cAA92A64CB";

      const vaultBundlesV1 = getChainAddress(client.chain.id, "bundles.vaultBundlesV1");

      // Create an existing approval (simulates existing allowance)
      await client.writeContract({
        address: vaultAddress,
        abi: metaMorphoAbi,
        functionName: "approve",
        args: [vaultBundlesV1, maxUint256],
      });

      const logs = await runErc4626WithdrawTest({
        client,
        initialState: {
          vaultPositionBalance: parseUnits("10000", 6),
        },
        inputs: {
          vaultAddress,
          accountAddress: client.account.address,
          withdrawAmount: parseUnits("1000", 6),
          unwrapNativeAssets: false,
        },
        withdrawActionFn: erc4626WithdrawViaMorphoSdkAction,
        expectedApprovalTargets: [vaultBundlesV1],
        expectedZeroBalanceAddresses: [vaultBundlesV1],
      });

      const approvals = await extractApprovalEvents(logs, client.account.address);

      expect(approvals).toHaveLength(0);
    });
  });

  describe("sad path", () => {
    failureTestCases.map((testCase) => {
      test(testCase.name, async ({ client }) => {
        const vaultBundlesV1 = getChainAddress(client.chain.id, "bundles.vaultBundlesV1");

        await expect(
          runErc4626WithdrawTest({
            client,
            ...testCase,
            withdrawActionFn: erc4626WithdrawViaMorphoSdkAction,
            expectedApprovalTargets: [vaultBundlesV1],
            expectedZeroBalanceAddresses: [vaultBundlesV1],
          }),
        ).rejects.toThrow(testCase.expectedError);
      });
    });
  });
});
