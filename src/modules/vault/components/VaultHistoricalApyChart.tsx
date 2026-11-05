import { DataChart } from "@/common/components/DataChart/DataChart";
import { CHART_RANGES, DATA_RANGES, type DataRange } from "@/common/utils/chart-ranges";
import { rateLabel } from "@/common/utils/timeframe";
import type { Vault } from "@/modules/vault/data/getVault";

interface VaultHistoricalApyChartProps {
  vaultPromise: Promise<Vault>;
}

export async function VaultHistoricalApyChart({ vaultPromise }: VaultHistoricalApyChartProps) {
  const vault = await vaultPromise;

  if (!vault || !("historical" in vault) || !vault.historical) {
    return null;
  }

  // Which realized average labels which range comes from the shared range table, so a new range
  // cannot be offered by the selector without an average behind it.
  const averageApy = Object.fromEntries(
    DATA_RANGES.map((range) => [range, vault.apyAverages[CHART_RANGES[range].apyAverageKey]]),
  ) as Record<DataRange, number | null>;

  return (
    <DataChart
      data={vault.historical}
      // Card title names the section, the tab label names the metric — same split as the deposits
      // chart ("Deposits" / "Total Deposits (USDC)"). The window belongs on the label that sits
      // against the number and carries the description tooltip.
      title="APY"
      defaultTab="netApy"
      tabOptions={[
        {
          type: "apy",
          key: "netApy",
          // As in the Vaults app: the REST series as served, so no smoothing window or rewards to name.
          description: "Net supply APY, after fees.",
          title: rateLabel("Net APY"),
          totalApy: vault.apy.total,
          averageApy,
        },
      ]}
    />
  );
}
