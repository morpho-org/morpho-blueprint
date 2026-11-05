import { graphql } from "@/generated/gql/morpho";

graphql(`
  fragment MorphoVaultV1SummaryFragment on Vault {
    address
    name
    asset {
      ...AssetInfoWithPriceFragment
    }
    chain {
      ...ChainInfoFragment
    }
    metadata {
      description
    }
    state {
      totalAssets
      totalAssetsUsd
      fee
      avgNetApy(lookback: $lookbackV1)
      avgNetApyExcludingRewards(lookback: $lookbackV1)
      allRewards {
        ...VaultRewardFragment
      }
      curators {
        ...CuratorInfoFragment
      }
    }
  }

  fragment MorphoVaultV1CollateralFragment on Vault {
    state {
      totalAssets
      allocation {
        ...VaultCollateralAllocationFragment
      }
    }
  }

  # Realized net APY over each range the chart offers, computed by the API from share-price
  # evolution. Detail-only: the earn list never renders a chart.
  fragment MorphoVaultV1DetailsFragment on Vault {
    liquidity {
      underlying
      usd
    }
    state {
      avgNetApy7d: avgNetApy(lookback: SEVEN_DAYS)
      avgNetApy30d: avgNetApy(lookback: THIRTY_DAYS)
      avgNetApy90d: avgNetApy(lookback: NINETY_DAYS)
      avgNetApyInception: avgNetApy(lookback: INCEPTION)
      feeRecipient
      owner
      curator
      guardian
      allocation {
        ...VaultAllocationFragment
      }
    }
  }
`);
