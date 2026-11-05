import { graphql } from "@/generated/gql/morpho";

graphql(`
  # Market metadata + supply-side APYs, as embedded in vault allocation rows.
  fragment MarketInfoFragment on Market {
    marketId
    lltv
    chain {
      ...ChainInfoFragment
    }
    collateralAsset {
      ...AssetInfoFragment
    }
    loanAsset {
      ...AssetInfoFragment
    }
    state {
      supplyAssets
      supplyAssetsUsd
      avgSupplyApy
      avgNetSupplyApy
      dailySupplyApy
      dailyNetSupplyApy
      weeklySupplyApy
      weeklyNetSupplyApy
      monthlySupplyApy
      monthlyNetSupplyApy
      rewards {
        ...MarketRewardFragment
      }
    }
  }

  # Market row in the borrow table.
  fragment MarketSummaryFragment on Market {
    marketId
    lltv
    chain {
      ...ChainInfoFragment
    }
    collateralAsset {
      ...AssetInfoFragment
    }
    loanAsset {
      ...AssetInfoFragment
    }
    state {
      borrowAssets
      borrowAssetsUsd
      borrowApy
      netBorrowApy
      avgBorrowApy
      avgNetBorrowApy
      dailyBorrowApy
      dailyNetBorrowApy
      weeklyBorrowApy
      weeklyNetBorrowApy
      monthlyBorrowApy
      monthlyNetBorrowApy
      rewards {
        ...MarketRewardFragment
      }
    }
  }
`);
