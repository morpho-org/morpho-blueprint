import "server-only";

import { MathLib, ORACLE_PRICE_SCALE, SharesMath } from "@morpho-org/blue-sdk";
import { type Address, getAddress, type Hex, zeroAddress } from "viem";
import { toAmountWithPrice, toRatio } from "@/common/data/adapters/amount";
import { getTokenDecimals, getTokenPriceUsd } from "@/common/data/rest/tokens";
import { getWalletTokenBalances } from "@/common/data/rpc/getWalletTokenBalances";
import { SECONDS_PER_DAY } from "@/common/utils/constants";
import { chunk, fetchAllMorphoRestPages, fetchMorphoRestResource, restSelector } from "@/common/utils/fetchMorphoRest";
import type { SupportedChainId } from "@/config/types";
import type { MarketPosition } from "@/modules/market/market.types";
import { getSupportedMarketIds } from "./getSupportedMarketIds";

export type { MarketPosition };

/** ChainId -> MarketId -> MarketPosition */
export type MarketPositionMap = Record<SupportedChainId, Record<Hex, MarketPosition>>;

interface RestMarketPosition {
  chain_id: number;
  market_id: string;
  borrow_shares: string;
  collateral_assets: string;
}

interface RestMarketRoot {
  chain_id: number;
  market_id: Hex;
  loan_token: Address;
  collateral_token: Address;
  oracle_address: Address;
}

interface RestMarketState {
  data: { total_borrow_assets: string; total_borrow_shares: string };
}

interface RestOracleState {
  data: { price: string | null };
}

interface TokenInfo {
  decimals: number;
  priceUsd: number | null;
}

export const getMarketPositions = async (accountAddress: Address): Promise<MarketPositionMap> => {
  const supportedMarketIds = await getSupportedMarketIds();

  const byChain = Object.entries(supportedMarketIds)
    .map(([chainId, ids]) => [Number.parseInt(chainId) as SupportedChainId, Array.from(ids)] as const)
    .filter(([, ids]) => ids.length > 0);

  const data = {} as MarketPositionMap;
  const perChain = await Promise.all(
    byChain.map(
      async ([chainId, ids]) => [chainId, await getMarketPositionsForChain(chainId, ids, accountAddress)] as const,
    ),
  );
  for (const [chainId, positions] of perChain) {
    if (Object.keys(positions).length > 0) data[chainId] = positions;
  }
  return data;
};

async function getMarketPositionsForChain(chainId: SupportedChainId, marketIds: Hex[], accountAddress: Address) {
  // The market list rides along so that a market the account has no position in still resolves its
  // assets, and therefore its wallet balances: the table's "in wallet" columns depend on it.
  const [positions, roots] = await Promise.all([
    Promise.all(
      chunk(marketIds).map((ids) =>
        fetchAllMorphoRestPages<RestMarketPosition>(`/v0/blue/users/${accountAddress}/positions`, {
          chain_ids: [chainId],
          market_ids: ids,
        }),
      ),
    ),
    Promise.all(
      chunk(marketIds).map((ids) =>
        // Market params never change.
        fetchAllMorphoRestPages<RestMarketRoot>(
          "/v0/blue/markets",
          { chain_id: [chainId], market_id: ids },
          { revalidate: SECONDS_PER_DAY },
        ),
      ),
    ),
  ]);

  const rootById = new Map<string, RestMarketRoot>();
  for (const root of roots.flat()) {
    if (root.chain_id === chainId) rootById.set(root.market_id.toLowerCase(), root);
  }

  // Kept in the supported order. A market the API does not know is absent from the list: skipped.
  const markets = marketIds.flatMap((marketId) => {
    const root = rootById.get(marketId.toLowerCase());
    if (!root) return [];
    const collateral = getAddress(root.collateral_token);
    return [
      {
        marketId: root.market_id,
        loanToken: getAddress(root.loan_token),
        // An idle market has no collateral token.
        collateralToken: collateral === zeroAddress ? null : collateral,
        oracle: getAddress(root.oracle_address),
      },
    ];
  });

  const positionByMarket = new Map<string, RestMarketPosition>();
  for (const position of positions.flat()) {
    if (position.chain_id === chainId) positionByMarket.set(position.market_id.toLowerCase(), position);
  }

  const tokenAddresses = Array.from(
    new Set(markets.flatMap((market) => [market.loanToken, market.collateralToken].filter((token) => token != null))),
  );

  const [tokens, balances, borrowAndCollateralValues] = await Promise.all([
    Promise.all(
      tokenAddresses.map(async (address) => {
        const [decimals, priceUsd] = await Promise.all([
          getTokenDecimals(chainId, address),
          getTokenPriceUsd(chainId, address),
        ]);
        return [address, decimals == null ? null : { decimals, priceUsd }] as const;
      }),
    ),
    getWalletTokenBalances(chainId, accountAddress, tokenAddresses),
    Promise.all(
      markets.map(async (market) => {
        const position = positionByMarket.get(market.marketId.toLowerCase());
        return [
          market.marketId,
          position ? await toBorrowAndCollateralValue(chainId, market, position) : null,
        ] as const;
      }),
    ),
  ]);
  const tokenByAddress = new Map<Address, TokenInfo | null>(tokens);
  const valuesByMarket = new Map(borrowAndCollateralValues);

  const result: Record<Hex, MarketPosition> = {};

  for (const market of markets) {
    const loan = tokenByAddress.get(market.loanToken);
    const collateral = market.collateralToken ? tokenByAddress.get(market.collateralToken) : null;
    if (!loan) {
      console.warn(`Loan token not returned by the API, skipping position: ${chainId}:${market.marketId}`);
      continue;
    }
    // Amounts can't be formatted without decimals; an idle market (no collateral token) needs none.
    if (market.collateralToken && !collateral) {
      console.warn(`Collateral token not returned by the API, skipping position: ${chainId}:${market.marketId}`);
      continue;
    }

    const position = positionByMarket.get(market.marketId.toLowerCase());
    const values = valuesByMarket.get(market.marketId);
    const borrowAssets = values?.borrowAssets ?? 0n;
    const collateralValue = values?.collateralValue ?? 0n;

    const collateralDecimals = collateral?.decimals ?? 0;
    const collateralPriceUsd = collateral?.priceUsd ?? null;

    const loanBalance = balances.get(market.loanToken.toLowerCase());
    const collateralBalance = market.collateralToken ? balances.get(market.collateralToken.toLowerCase()) : undefined;

    result[market.marketId] = {
      market: { chain: { id: chainId }, marketId: market.marketId },
      // REST serves positions in token units only; USD is priced here from each token's price.
      collateralAmount: toAmountWithPrice(position?.collateral_assets ?? 0, collateralDecimals, collateralPriceUsd),
      borrowAmount: toAmountWithPrice(borrowAssets, loan.decimals, loan.priceUsd),
      // Borrow value over the oracle value of the collateral, rounding up, matching the action
      // layer's position-change math.
      ltv: toRatio(collateralValue > 0n ? MathLib.wDivUp(borrowAssets, collateralValue) : 0n),
      walletLoanAssetHolding:
        loanBalance === undefined ? null : { balance: toAmountWithPrice(loanBalance, loan.decimals, loan.priceUsd) },
      walletCollateralAssetHolding:
        collateralBalance === undefined
          ? null
          : { balance: toAmountWithPrice(collateralBalance, collateralDecimals, collateralPriceUsd) },
    };
  }

  return result;
}

/**
 * REST positions carry borrow shares and raw collateral. Borrow assets come from the market's
 * share price (rounded up, as Morpho Blue owes them), and the collateral's value in loan assets
 * from the oracle price, which the LTV divides by.
 */
async function toBorrowAndCollateralValue(
  chainId: SupportedChainId,
  market: { marketId: Hex; oracle: Address },
  position: RestMarketPosition,
): Promise<{ borrowAssets: bigint; collateralValue: bigint }> {
  const borrowShares = BigInt(position.borrow_shares);
  const collateral = BigInt(position.collateral_assets);

  const [state, oracle] = await Promise.all([
    borrowShares > 0n
      ? fetchMorphoRestResource<RestMarketState>(`/v0/blue/markets/${restSelector(chainId, market.marketId)}/state`)
      : null,
    collateral > 0n && market.oracle !== zeroAddress
      ? fetchMorphoRestResource<RestOracleState>(`/v0/oracles/${restSelector(chainId, market.oracle)}/state`)
      : null,
  ]);

  const borrowAssets = state
    ? SharesMath.toAssets(borrowShares, state.data.total_borrow_assets, state.data.total_borrow_shares, "Up")
    : 0n;
  const oraclePrice = oracle?.data.price;
  const collateralValue = oraclePrice ? MathLib.mulDivDown(collateral, oraclePrice, ORACLE_PRICE_SCALE) : 0n;

  return { borrowAssets, collateralValue };
}
