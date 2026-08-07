import { DataChart } from "@/common/components/DataChart/DataChart";
import { CHART_RANGES, DATA_RANGES, type DataRange } from "@/common/utils/chart-ranges";
import { rateLabel, vaultV1HistoryApyWindow, vaultV2HistoryApyWindow } from "@/common/utils/timeframe";
import { APP_CONFIG } from "@/config";
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

  // This tab carries two differently-sourced numbers: the headline `totalApy`, averaged over the
  // configured window, and the plotted line, whose smoothing the API bounds per protocol — V2
  // history caps a point at 24h, V1 history has nothing averaged below daily. With a 7d/30d
  // `apyWindow` on a V2 vault, or a 6h one on a V1 vault, those windows diverge, and one label
  // cannot honestly name both — labelling it with the series window mislabels the headline, and
  // vice versa.
  //
  // The label tracks the headline, since that is the number sitting directly against it, and the
  // description discloses the series window when it differs. A deployment configured at 1d never
  // diverges on either protocol.
  const isV2 = vault.__typename === "MorphoVaultV2";
  const seriesWindow = isV2 ? vaultV2HistoryApyWindow : vaultV1HistoryApyWindow;
  const seriesWindowReason = isV2
    ? `${seriesWindow}, the longest window the API serves for a vault V2 history point`
    : `${seriesWindow}, the shortest averaged window the API serves for a vault V1 history point`;
  const description =
    seriesWindow === APP_CONFIG.apyWindow
      ? "Net supply APY, after fees and including rewards."
      : `Net supply APY, after fees and including rewards. The headline is averaged over ${APP_CONFIG.apyWindow}; the plotted line is smoothed over ${seriesWindowReason}.`;

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
          description,
          title: rateLabel("Net APY"),
          totalApy: vault.apy.total,
          averageApy,
        },
      ]}
    />
  );
}
