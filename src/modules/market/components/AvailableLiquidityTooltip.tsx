import { Metric } from "@/common/components/Metric";
import { TooltipPopover, TooltipPopoverContent, TooltipPopoverTrigger } from "@/common/components/ui/tooltip-popover";
import { formatNumber } from "@/common/utils/format";

type AvailableLiquidityTooltipContentProps = {
  marketLiquidity: number;
  publicAllocatorLiquidity: number;
};

function AvailableLiquidityTooltipContent({
  marketLiquidity,
  publicAllocatorLiquidity,
}: AvailableLiquidityTooltipContentProps) {
  return (
    <div className="body-small flex flex-col gap-4">
      <div className="flex flex-col gap-3">
        <span className="body-medium-plus">Available to borrow</span>
        <span>Liquidity in this market, plus what vaults can move into it through the Public Allocator V2</span>
      </div>
      <div className="flex flex-col gap-2">
        <span className="flex justify-between">
          <span>In this market</span>
          <span className="body-small-plus">{formatNumber(marketLiquidity, { currency: "USD" })}</span>
        </span>
        <span className="flex justify-between">
          <span>Via Public Allocator V2</span>
          <span className="body-small-plus">{formatNumber(publicAllocatorLiquidity, { currency: "USD" })}</span>
        </span>
      </div>
      <div className="h-[1px] bg-border" />
      <span className="flex justify-between">
        <span>Total available</span>
        <span className="body-small-plus">
          {formatNumber(marketLiquidity + publicAllocatorLiquidity, { currency: "USD" })}
        </span>
      </span>
    </div>
  );
}

type AvailableLiquidityTooltipProps = AvailableLiquidityTooltipContentProps;

function AvailableLiquidityTooltip({ marketLiquidity, publicAllocatorLiquidity }: AvailableLiquidityTooltipProps) {
  return (
    <TooltipPopover>
      <TooltipPopoverTrigger>
        <Metric label="Available Liquidity">
          <h4>{formatNumber(marketLiquidity + publicAllocatorLiquidity, { currency: "USD" })}</h4>
        </Metric>
      </TooltipPopoverTrigger>
      <TooltipPopoverContent>
        <AvailableLiquidityTooltipContent
          marketLiquidity={marketLiquidity}
          publicAllocatorLiquidity={publicAllocatorLiquidity}
        />
      </TooltipPopoverContent>
    </TooltipPopover>
  );
}

export { AvailableLiquidityTooltip, AvailableLiquidityTooltipContent };
