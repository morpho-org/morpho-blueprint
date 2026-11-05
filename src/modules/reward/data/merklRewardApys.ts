import { type Address, getAddress, isAddress } from "viem";
import { z } from "zod";
import type { RewardApy, TokenInfo } from "@/common/data/types";

// The Morpho rewards backend's filters, copied so REST pages show the rewards GraphQL showed:
// hook 27 (blacklist) is ignored, hook 23 scoped to MorphoVaultV2 makes a campaign vault-V2-only,
// and any other hook skips the campaign (its APR depends on per-user state the API cannot know).
const BLACKLIST_HOOK_TYPE = 27;
const VAULT_V2_HOOK_TYPE = 23;
const VAULT_V2_PROTOCOL = "MorphoVaultV2";

// The backend's default minimum (`isCampaignDurationEligible`): shorter campaigns are not shown.
const MIN_CAMPAIGN_DURATION_SECONDS = 86_400;
// The backend's `isRewardChainSupported`: its fully supported chains plus TAC (reward-only).
const REWARD_CHAIN_IDS = new Set([
  1, 10, 130, 137, 143, 196, 239, 480, 988, 999, 4217, 4663, 5042, 8453, 42161, 747474,
]);

const VAULT_CAMPAIGN_TYPES = new Set(["MORPHOVAULT", "ERC20LOGPROCESSOR"]);
const MULTILEND_LEND_CAMPAIGN_TYPE = 24;
const MULTILEND_BORROW_CAMPAIGN_TYPE = 45;

// Merkl may serve lowercase or checksummed addresses; only the hex shape matters here.
const isAnyCaseAddress = (value: string) => isAddress(value, { strict: false });

const hookSchema = z.looseObject({ hookType: z.number(), protocols: z.array(z.string()).nullish() });

const campaignSchema = z.looseObject({
  id: z.string(),
  type: z.string(),
  subType: z.number().nullish(),
  computeChainId: z.number().nullish(),
  startTimestamp: z.number(),
  endTimestamp: z.number(),
  /** A percentage: 5 means 5%. */
  apr: z.number(),
  isPrivate: z.boolean().nullish(),
  rewardToken: z.looseObject({
    chainId: z.number().nullish(),
    address: z.string().refine(isAnyCaseAddress),
    symbol: z.string(),
    name: z.string().nullish(),
    decimals: z.number().int().nonnegative(),
    icon: z.string().nullish(),
    type: z.string(),
    isTest: z.boolean().nullish(),
  }),
  params: z.looseObject({
    hooks: z.array(hookSchema).nullish(),
    whitelist: z.array(z.unknown()).nullish(),
    targetToken: z.string().nullish(),
    marketId: z.string().nullish(),
    market: z.string().nullish(),
    markets: z.array(z.unknown()).nullish(),
  }),
});

const multilendMarketSchema = z.object({
  campaignType: z.number(),
  campaignParameters: z.object({ market: z.string() }),
});

const opportunitySchema = z.looseObject({ campaigns: z.array(z.unknown()).nullish() });

/** The top-level shape of one `/v4/opportunities` page; campaigns are checked one by one. */
export const merklOpportunitiesPageSchema = z.array(opportunitySchema);

type Campaign = z.infer<typeof campaignSchema>;

interface IndexedReward {
  asset: TokenInfo;
  apr: number;
  vaultV2Only: boolean;
}

/** Live public reward campaigns of one chain, keyed by what they reward. */
export interface MerklRewardIndex {
  /** By lowercased vault address: the vault's own campaigns and the child campaigns forwarded to it. */
  vaults: Map<string, IndexedReward[]>;
  /** By lowercased market id: supply campaigns on that market. */
  marketSupply: Map<string, IndexedReward[]>;
  /** By lowercased loan token: supply campaigns on every market lending that token. */
  loanTokenSupply: Map<string, IndexedReward[]>;
  /** By lowercased market id: borrow campaigns on that market. */
  marketBorrow: Map<string, IndexedReward[]>;
  /** By lowercased loan token: borrow campaigns on every market lending that token. */
  loanTokenBorrow: Map<string, IndexedReward[]>;
}

export const emptyMerklRewardIndex = (): MerklRewardIndex => ({
  vaults: new Map(),
  marketSupply: new Map(),
  loanTokenSupply: new Map(),
  marketBorrow: new Map(),
  loanTokenBorrow: new Map(),
});

/** `{ skip }` for a hook the backend does not handle, else whether the campaign is vault-V2-only. */
function analyzeHooks(hooks: Campaign["params"]["hooks"]): { skip: boolean; vaultV2Only: boolean } {
  let vaultV2Only = false;
  for (const hook of hooks ?? []) {
    if (hook.hookType === BLACKLIST_HOOK_TYPE) continue;
    if (hook.hookType === VAULT_V2_HOOK_TYPE && hook.protocols?.includes(VAULT_V2_PROTOCOL)) {
      vaultV2Only = true;
      continue;
    }
    return { skip: true, vaultV2Only };
  }
  return { skip: false, vaultV2Only };
}

const isPublic = (campaign: Campaign) => campaign.isPrivate !== true && (campaign.params.whitelist ?? []).length === 0;

const isVaultCampaign = (campaign: Campaign) =>
  VAULT_CAMPAIGN_TYPES.has(campaign.type) || (campaign.type === "MORPHO" && campaign.subType === 0);

const isDirectMarketSupplyCampaign = (campaign: Campaign) =>
  campaign.type === "MORPHOSUPPLY" || (campaign.type === "MORPHO" && campaign.subType === 1);

const isDirectMarketBorrowCampaign = (campaign: Campaign) =>
  campaign.type === "MORPHOBORROW" || (campaign.type === "MORPHO" && campaign.subType === 2);

function push(map: Map<string, IndexedReward[]>, key: string, reward: IndexedReward) {
  const existing = map.get(key.toLowerCase());
  if (existing) existing.push(reward);
  else map.set(key.toLowerCase(), [reward]);
}

/**
 * Indexes the live, public, token-paying campaigns of the opportunity pages, as of `nowSeconds`.
 * A malformed campaign is dropped alone, with a warning.
 */
export function indexMerklRewards(opportunities: readonly unknown[], nowSeconds: number): MerklRewardIndex {
  const index = emptyMerklRewardIndex();
  // A campaign listed under more than one opportunity counts once.
  const seen = new Set<string>();

  for (const opportunity of opportunities) {
    const parsedOpportunity = opportunitySchema.safeParse(opportunity);
    if (!parsedOpportunity.success) continue;

    for (const raw of parsedOpportunity.data.campaigns ?? []) {
      const parsed = campaignSchema.safeParse(raw);
      if (!parsed.success) {
        console.warn(`Dropping invalid Merkl campaign: ${z.prettifyError(parsed.error)}`);
        continue;
      }
      const campaign = parsed.data;
      if (seen.has(campaign.id)) continue;
      seen.add(campaign.id);

      if (campaign.startTimestamp > nowSeconds || campaign.endTimestamp <= nowSeconds) continue;
      if (campaign.endTimestamp - campaign.startTimestamp < MIN_CAMPAIGN_DURATION_SECONDS) continue;
      if (!isPublic(campaign)) continue;
      const { rewardToken } = campaign;
      if (rewardToken.type !== "TOKEN" || rewardToken.isTest) continue;
      const rewardChainId = rewardToken.chainId ?? campaign.computeChainId;
      if (rewardChainId == null || !REWARD_CHAIN_IDS.has(rewardChainId)) continue;
      const apr = campaign.apr / 100;
      if (!(apr > 0)) continue;
      const hooks = analyzeHooks(campaign.params.hooks);
      if (hooks.skip) continue;

      const reward: IndexedReward = {
        asset: {
          address: getAddress(rewardToken.address),
          symbol: rewardToken.symbol,
          name: rewardToken.name ?? rewardToken.symbol,
          decimals: rewardToken.decimals,
          icon: rewardToken.icon || null,
          category: null,
        },
        apr,
        vaultV2Only: hooks.vaultV2Only,
      };
      const { params } = campaign;

      if (isVaultCampaign(campaign)) {
        if (params.targetToken && isAnyCaseAddress(params.targetToken)) push(index.vaults, params.targetToken, reward);
      } else if (isDirectMarketSupplyCampaign(campaign) || isDirectMarketBorrowCampaign(campaign)) {
        // The full id from the params: the opportunity identifier is truncated to 20 bytes.
        const marketId = params.marketId ?? params.market;
        const target = isDirectMarketSupplyCampaign(campaign) ? index.marketSupply : index.marketBorrow;
        if (marketId) push(target, marketId, reward);
      } else if (campaign.type === "MULTILENDBORROW") {
        for (const entry of params.markets ?? []) {
          const market = multilendMarketSchema.safeParse(entry);
          if (!market.success) continue;
          if (market.data.campaignType === MULTILEND_LEND_CAMPAIGN_TYPE) {
            push(index.marketSupply, market.data.campaignParameters.market, reward);
          } else if (market.data.campaignType === MULTILEND_BORROW_CAMPAIGN_TYPE) {
            push(index.marketBorrow, market.data.campaignParameters.market, reward);
          }
        }
      } else if (campaign.type === "MORPHOSUPPLY_SINGLETOKEN" || campaign.type === "MORPHOBORROW_SINGLETOKEN") {
        const target = campaign.type === "MORPHOSUPPLY_SINGLETOKEN" ? index.loanTokenSupply : index.loanTokenBorrow;
        if (params.targetToken && isAnyCaseAddress(params.targetToken)) push(target, params.targetToken, reward);
      }
    }
  }

  return index;
}

/** One entry per reward token, APRs summed. */
function byToken(rewards: readonly IndexedReward[]): RewardApy[] {
  const totals = new Map<Address, RewardApy>();
  for (const { asset, apr } of rewards) {
    const existing = totals.get(asset.address);
    if (existing) existing.apr += apr;
    else totals.set(asset.address, { asset, apr });
  }
  return [...totals.values()];
}

/**
 * The current reward APRs a vault pays its depositors. Rewards forwarded from the markets and
 * vaults it supplies come from Merkl's child campaigns, which target the vault itself.
 */
export function vaultRewardApys(index: MerklRewardIndex, vaultAddress: Address, kind: "v1" | "v2"): RewardApy[] {
  const rewards = index.vaults.get(vaultAddress.toLowerCase()) ?? [];
  return byToken(kind === "v2" ? rewards : rewards.filter((reward) => !reward.vaultV2Only));
}

/** The current reward APRs for supplying to a market. Vault-V2-only campaigns pay vaults, not suppliers. */
export function marketSupplyRewardApys(index: MerklRewardIndex, marketId: string, loanToken: Address): RewardApy[] {
  const rewards = [
    ...(index.marketSupply.get(marketId.toLowerCase()) ?? []),
    ...(index.loanTokenSupply.get(loanToken.toLowerCase()) ?? []),
  ];
  return byToken(rewards.filter((reward) => !reward.vaultV2Only));
}

/**
 * The current reward APRs for borrowing from a market, as positive APRs: the borrow rate net of
 * rewards is the native rate minus their sum.
 */
export function marketBorrowRewardApys(index: MerklRewardIndex, marketId: string, loanToken: Address): RewardApy[] {
  const rewards = [
    ...(index.marketBorrow.get(marketId.toLowerCase()) ?? []),
    ...(index.loanTokenBorrow.get(loanToken.toLowerCase()) ?? []),
  ];
  return byToken(rewards.filter((reward) => !reward.vaultV2Only));
}
