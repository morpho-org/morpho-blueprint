import { getChainAddress } from "@morpho-org/blue-sdk";
import { type ActionRequirement, encodeErc20Approval } from "@morpho-org/morpho-sdk";
import { maxUint256 } from "viem";
import { describe, expect, test } from "vitest";
import { UserFacingError } from "@/actions/types";
import { transactionRequestsFromMorphoAction } from "@/actions/utils/morphoAction";

const approval = encodeErc20Approval({
  token: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
  spender: getChainAddress(1, "bundles.vaultBundlesV1"),
  amount: maxUint256,
  chainId: 1,
});
const finalTx = { to: approval.to, data: "0x1234" as const, value: 0n };

describe("transactionRequestsFromMorphoAction", () => {
  test("maps an approval before the final transaction", async () => {
    const transactions = await transactionRequestsFromMorphoAction(
      { getRequirements: async () => [approval], buildTx: () => finalTx },
      "Supply to vault",
    );
    expect(transactions.map(({ name }) => name)).toEqual(["Approve supply amount", "Supply to vault"]);
    expect(transactions.map(({ tx }) => tx())).toEqual([approval, finalTx]);
  });

  test("keeps the final transaction when no requirements are needed", async () => {
    const transactions = await transactionRequestsFromMorphoAction(
      { getRequirements: async () => [], buildTx: () => finalTx },
      "Supply to vault",
    );
    expect(transactions).toHaveLength(1);
    expect(transactions[0]!.tx()).toEqual(finalTx);
  });

  test("rejects a signature requirement", async () => {
    const signature = { sign: async () => undefined } as unknown as ActionRequirement;
    await expect(
      transactionRequestsFromMorphoAction(
        { getRequirements: async () => [signature], buildTx: () => finalTx },
        "Supply to vault",
      ),
    ).rejects.toThrow(UserFacingError);
  });

  test("rejects a requirement without transaction fields", async () => {
    const malformed = { action: { type: "erc20Approval" } } as unknown as ActionRequirement;
    await expect(
      transactionRequestsFromMorphoAction(
        { getRequirements: async () => [malformed], buildTx: () => finalTx },
        "Supply to vault",
      ),
    ).rejects.toThrow(UserFacingError);
  });

  test.each([
    { ...approval, to: "invalid" },
    { ...approval, data: undefined },
    { ...approval, value: -1n },
  ])("rejects malformed transaction fields: %s", async (requirement) => {
    await expect(
      transactionRequestsFromMorphoAction(
        { getRequirements: async () => [requirement as unknown as ActionRequirement], buildTx: () => finalTx },
        "Supply to vault",
      ),
    ).rejects.toThrow(UserFacingError);
  });
});
