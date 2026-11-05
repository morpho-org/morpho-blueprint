import { parseUnits } from "viem";
import { describe, expect, it } from "vitest";
import type { MarketPositionChange } from "@/actions";
import { capAvailableToBorrowByLiquidity } from "@/modules/market/utils/capAvailableToBorrowByLiquidity";

const usdc = (amount: string) => parseUnits(amount, 6);

function positionChange(before: bigint, after: bigint): MarketPositionChange {
  return {
    collateral: { before: 0n, after: 0n },
    loan: { before: 0n, after: 0n },
    availableToBorrow: { before, after },
    ltv: { before: 0n, after: 0n },
  };
}

describe("capAvailableToBorrowByLiquidity", () => {
  it("keeps the collateral headroom when the market has more liquidity", () => {
    const result = capAvailableToBorrowByLiquidity({
      positionChange: positionChange(usdc("100"), usdc("400")),
      marketAvailableToBorrow: usdc("10000"),
      borrowAmount: usdc("500"),
    });

    expect(result.availableToBorrow).toEqual({ before: usdc("100"), after: usdc("400") });
  });

  it("caps at the liquidity left after the borrow when liquidity is the limit", () => {
    const result = capAvailableToBorrowByLiquidity({
      positionChange: positionChange(usdc("2000"), usdc("8000")),
      marketAvailableToBorrow: usdc("1500"),
      borrowAmount: usdc("1000"),
    });

    expect(result.availableToBorrow).toEqual({ before: usdc("1500"), after: usdc("500") });
  });

  it("returns 0 after a borrow that consumes all the liquidity", () => {
    const result = capAvailableToBorrowByLiquidity({
      positionChange: positionChange(0n, usdc("5560000")),
      marketAvailableToBorrow: usdc("3490000"),
      borrowAmount: usdc("3490000"),
    });

    expect(result.availableToBorrow).toEqual({ before: 0n, after: 0n });
  });

  it("floors at 0 when the entered borrow exceeds the liquidity", () => {
    const result = capAvailableToBorrowByLiquidity({
      positionChange: positionChange(usdc("10"), usdc("20")),
      marketAvailableToBorrow: usdc("5"),
      borrowAmount: usdc("6"),
    });

    expect(result.availableToBorrow).toEqual({ before: usdc("5"), after: 0n });
  });

  it("leaves the other position fields untouched", () => {
    const input = positionChange(usdc("1"), usdc("2"));
    input.loan = { before: usdc("3"), after: usdc("4") };
    const result = capAvailableToBorrowByLiquidity({
      positionChange: input,
      marketAvailableToBorrow: 0n,
      borrowAmount: 0n,
    });

    expect(result.loan).toBe(input.loan);
    expect(result.collateral).toBe(input.collateral);
    expect(result.ltv).toBe(input.ltv);
  });
});
