import { getChainAddress, getChainAddresses, type MarketId, MathLib } from "@morpho-org/blue-sdk";
import { fetchMarket } from "@morpho-org/blue-sdk-viem";
import { BorrowExceedsSafeLtvError } from "@morpho-org/morpho-sdk";
import { blueBundlesV1Abi } from "@morpho-org/morpho-sdk/abis";
import type { AnvilTestClient } from "@morpho-org/test";
import { type Address, decodeFunctionData, type Hex, maxUint256, parseUnits } from "viem";
import { describe, expect } from "vitest";
import { type MarketAction, marketSupplyCollateralAndBorrowAction } from "@/actions";
import { UserFacingError } from "@/actions/types";

import { test } from "../../config";
import { expectZeroErc20Balances, getErc20BalanceOf } from "../../helpers/erc20";
import { executeAction } from "../../helpers/executeAction";
import { expectOnlyAllowedApprovals } from "../../helpers/logs";
import { createMarketPosition, getMorphoMarketPosition, seedMarketLiquidity } from "../../helpers/morpho";

const WBTC_USDC_MARKET_ID = "0x3a85e619751152991742810df6ec69ce473daef99e28a64ab2340d7b7ccfee49" as MarketId;

test("borrows with a mainnet V2 public allocator reallocation", async ({ client }) => {
  const marketId = "0xb25c41cd266fa6cb9c581d526ac9d8c0137c92cd06847f7e1ee511764ee3d42f" as MarketId;
  const market = await fetchMarket(marketId, client);
  const borrowAmount = market.totalSupplyAssets - market.totalBorrowAssets + parseUnits("1", 6);
  expect(market.price).toBeGreaterThan(0n);
  const collateralAmount = MathLib.mulDivUp(borrowAmount * 2n, 10n ** 36n, market.price!);
  const action = await runMarketSupplyCollateralAndBorrowTest({
    client,
    marketId,
    allocatingVaultAddresses: ["0x069662D2588fcaC24B5c209456Db965D151556f0"],
    intitialState: { walletCollateralAmount: collateralAmount, positionCollateralAmount: 0n, skipMarketSeed: true },
    collateralAmount,
    borrowAmount,
  });
  const tx = action.transactionRequests.at(-1)!.tx();
  const decoded = decodeFunctionData({ abi: blueBundlesV1Abi, data: tx.data });
  expect(decoded.functionName).toBe("blueBundlesV1SupplyCollateralAndBorrow");
  if (decoded.functionName !== "blueBundlesV1SupplyCollateralAndBorrow") throw new Error("Unexpected bundle");
  expect(decoded.args[6].length).toBeGreaterThan(0);
});

interface MarketSupplyCollateralAndBorrowTestParameters {
  client: AnvilTestClient;
  marketId: Hex;
  allocatingVaultAddresses: Address[];

  intitialState: {
    walletCollateralAmount: bigint;
    positionCollateralAmount: bigint;
    skipMarketSeed?: boolean;
  };

  collateralAmount: bigint;
  borrowAmount: bigint;

  beforeExecutionCb?: (client: AnvilTestClient) => Promise<void>;
  callerType?: "eoa" | "contract";
}

async function runMarketSupplyCollateralAndBorrowTest({
  client,
  marketId,
  allocatingVaultAddresses,

  intitialState,

  collateralAmount,
  borrowAmount,

  beforeExecutionCb,
  callerType = "eoa",
}: MarketSupplyCollateralAndBorrowTestParameters): Promise<MarketAction> {
  // Arrange
  const market = await fetchMarket(marketId as MarketId, client);
  const { collateralToken: collateralAssetAddress, loanToken: loanAssetAddress } = market.params;

  if (callerType === "contract") {
    await client.setCode({ address: client.account.address, bytecode: "0x60006000fd" });
  }

  // Intitial state
  if (intitialState.walletCollateralAmount > 0n) {
    await client.deal({ erc20: collateralAssetAddress, amount: intitialState.walletCollateralAmount });
  }
  if (!intitialState.skipMarketSeed) {
    await seedMarketLiquidity(client, marketId, borrowAmount * 2n);
  }
  if (intitialState.positionCollateralAmount > 0n) {
    await createMarketPosition(client, marketId, intitialState.positionCollateralAmount, 0n);
  }

  const { permit2 } = getChainAddresses(client.chain.id);
  const blueBundlesV1 = getChainAddress(client.chain.id, "bundles.blueBundlesV1");

  // Act
  const action = await marketSupplyCollateralAndBorrowAction({
    publicClient: client,
    marketId: marketId as MarketId,
    allocatingVaultAddresses,
    accountAddress: client.account.address,
    collateralAmount,
    borrowAmount,
  });

  await beforeExecutionCb?.(client);

  const logs = await executeAction(client, action);

  // Assert
  await expectOnlyAllowedApprovals(
    client,
    logs,
    client.account.address,
    [...(permit2 ? [permit2] : []), blueBundlesV1], // Only ever allowed to apporve GA1 or permit2
    [blueBundlesV1], // Only ever allowed to permit GA1
  );

  const marketPosition = await getMorphoMarketPosition(client, marketId);
  const userWalletLoanAssetBalance = await getErc20BalanceOf(client, loanAssetAddress, client.account.address);
  const userWalletCollateralAssetBalance = await getErc20BalanceOf(
    client,
    collateralAssetAddress,
    client.account.address,
  );

  if (collateralAmount === maxUint256) {
    expect(marketPosition.collateralBalance).toEqual(
      intitialState.positionCollateralAmount + intitialState.walletCollateralAmount,
    );
    expect(userWalletCollateralAssetBalance).toEqual(0n);
  } else {
    expect(marketPosition.collateralBalance).toEqual(intitialState.positionCollateralAmount + collateralAmount);
    expect(userWalletCollateralAssetBalance).toEqual(intitialState.walletCollateralAmount - collateralAmount);
  }

  expect(marketPosition.loanBalance).toBeWithinRange(borrowAmount, borrowAmount + 1n);
  expect(userWalletLoanAssetBalance).toEqual(borrowAmount);

  // Make sure no funds left in bundler or adapters (underlying assets or shares)
  await expectZeroErc20Balances(client, [blueBundlesV1], collateralAssetAddress);
  await expectZeroErc20Balances(client, [blueBundlesV1], loanAssetAddress);

  return action;
}

const successTestCases: ({ name: string } & Omit<MarketSupplyCollateralAndBorrowTestParameters, "client">)[] = [
  {
    name: "partial collateral supply, no borrow",
    marketId: WBTC_USDC_MARKET_ID,
    allocatingVaultAddresses: [],
    intitialState: {
      walletCollateralAmount: parseUnits("12", 8),
      positionCollateralAmount: 0n,
    },
    collateralAmount: parseUnits("10", 8),
    borrowAmount: parseUnits("0", 6),
  },
  {
    name: "Full collateral supply, no borrow",
    marketId: WBTC_USDC_MARKET_ID,
    allocatingVaultAddresses: [],
    intitialState: {
      walletCollateralAmount: parseUnits("12", 8),
      positionCollateralAmount: 0n,
    },
    collateralAmount: maxUint256,
    borrowAmount: parseUnits("0", 6),
  },
  {
    name: "partial collateral supply and borrow",
    marketId: WBTC_USDC_MARKET_ID,
    allocatingVaultAddresses: [],
    intitialState: {
      walletCollateralAmount: parseUnits("12", 8),
      positionCollateralAmount: 0n,
    },
    collateralAmount: parseUnits("10", 8),
    borrowAmount: parseUnits("2000", 6),
  },
  {
    name: "full collateral supply and borrow",
    marketId: WBTC_USDC_MARKET_ID,
    allocatingVaultAddresses: [],
    intitialState: {
      walletCollateralAmount: parseUnits("12", 8),
      positionCollateralAmount: 0n,
    },
    collateralAmount: maxUint256,
    borrowAmount: parseUnits("2000", 6),
  },
  {
    name: "borrow against previously supplied collateral",
    marketId: WBTC_USDC_MARKET_ID,
    allocatingVaultAddresses: [],
    intitialState: {
      walletCollateralAmount: 0n,
      positionCollateralAmount: parseUnits("10", 8),
    },
    collateralAmount: 0n,
    borrowAmount: parseUnits("2000", 6),
  },
];

describe("marketSupplyCollateralAndBorrowAction", () => {
  describe("happy path", () => {
    successTestCases.map((testCase) => {
      test(`${testCase.name} - eoa`, async ({ client }) => {
        await runMarketSupplyCollateralAndBorrowTest({
          client,
          ...testCase,
          callerType: "eoa",
        });
      });

      test(`${testCase.name} - contract`, async ({ client }) => {
        await runMarketSupplyCollateralAndBorrowTest({
          client,
          ...testCase,
          callerType: "contract",
        });
      });
    });
  });

  describe("sad path", () => {
    test("insufficient wallet collateral balance", async ({ client }) => {
      await expect(
        runMarketSupplyCollateralAndBorrowTest({
          client,
          marketId: WBTC_USDC_MARKET_ID,
          allocatingVaultAddresses: [],
          intitialState: {
            walletCollateralAmount: 0n,
            positionCollateralAmount: parseUnits("10", 8),
          },
          collateralAmount: parseUnits("100", 8),
          borrowAmount: 0n,
        }),
      ).rejects.toThrow(UserFacingError);
    });
    test("collateral and borrow both 0", async ({ client }) => {
      await expect(
        runMarketSupplyCollateralAndBorrowTest({
          client,
          marketId: WBTC_USDC_MARKET_ID,
          allocatingVaultAddresses: [],
          intitialState: {
            walletCollateralAmount: 0n,
            positionCollateralAmount: 0n,
          },
          collateralAmount: 0n,
          borrowAmount: 0n,
        }),
      ).rejects.toThrow("Collateral and borrow amounts cannot both be 0.");
    });
    test("prepare error if loan is not sufficently collateralized", async ({ client }) => {
      await expect(
        runMarketSupplyCollateralAndBorrowTest({
          client,
          marketId: WBTC_USDC_MARKET_ID,
          allocatingVaultAddresses: [],
          intitialState: {
            walletCollateralAmount: parseUnits("10", 8),
            positionCollateralAmount: 0n,
          },
          collateralAmount: parseUnits("1", 8),
          borrowAmount: parseUnits("1000000", 6),
        }),
      ).rejects.toThrow(BorrowExceedsSafeLtvError);
    });
  });
});
