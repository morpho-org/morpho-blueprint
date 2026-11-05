import { parseUnits } from "viem";
import { describe, expect, it } from "vitest";
import type { MarketPositionChange } from "@/actions";
import { capAvailableToBorrowByLiquidity } from "@/modules/market/utils/capAvailableToBorrowByLiquidity";

const usdc = (amount: string) => parseUnits(amount, 6);

function positionChange(
  availableToBorrow: { before: bigint; after: bigint },
  loan: { before: bigint; after: bigint } = { before: 0n, after: 0n },
): MarketPositionChange {
  return {
    collateral: { before: 0n, after: 0n },
    loan,
    availableToBorrow,
    ltv: { before: 0n, after: 0n },
  };
}

describe("capAvailableToBorrowByLiquidity", () => {
  describe("borrow (form summary and review dialog)", () => {
    it("keeps the collateral headroom when the market has more liquidity", () => {
      const result = capAvailableToBorrowByLiquidity({
        positionChange: positionChange({ before: usdc("100"), after: usdc("400") }, { before: 0n, after: usdc("500") }),
        marketAvailableToBorrow: usdc("10000"),
      });

      expect(result.availableToBorrow).toEqual({ before: usdc("100"), after: usdc("400") });
    });

    it("caps at the liquidity left after the borrow when liquidity is the limit", () => {
      const result = capAvailableToBorrowByLiquidity({
        positionChange: positionChange(
          { before: usdc("2000"), after: usdc("8000") },
          { before: 0n, after: usdc("1000") },
        ),
        marketAvailableToBorrow: usdc("1500"),
      });

      expect(result.availableToBorrow).toEqual({ before: usdc("1500"), after: usdc("500") });
    });

    it("returns 0 after a borrow that consumes all the liquidity", () => {
      const result = capAvailableToBorrowByLiquidity({
        positionChange: positionChange({ before: 0n, after: usdc("5560000") }, { before: 0n, after: usdc("3490000") }),
        marketAvailableToBorrow: usdc("3490000"),
      });

      expect(result.availableToBorrow).toEqual({ before: 0n, after: 0n });
    });

    it("floors at 0 when the borrow exceeds the liquidity", () => {
      const result = capAvailableToBorrowByLiquidity({
        positionChange: positionChange({ before: usdc("10"), after: usdc("20") }, { before: 0n, after: usdc("6") }),
        marketAvailableToBorrow: usdc("5"),
      });

      expect(result.availableToBorrow).toEqual({ before: usdc("5"), after: 0n });
    });

    it("uses the loan change on an existing debt, as the simulation's position change reports it", () => {
      // Review dialog: the simulation starts from the on-chain debt (300) and adds the borrow (1,000).
      const result = capAvailableToBorrowByLiquidity({
        positionChange: positionChange(
          { before: usdc("5000"), after: usdc("6000") },
          { before: usdc("300"), after: usdc("1300") },
        ),
        marketAvailableToBorrow: usdc("2920000"),
      });

      expect(result.availableToBorrow).toEqual({ before: usdc("5000"), after: usdc("6000") });

      const tight = capAvailableToBorrowByLiquidity({
        positionChange: positionChange(
          { before: usdc("5000"), after: usdc("6000") },
          { before: usdc("300"), after: usdc("1300") },
        ),
        marketAvailableToBorrow: usdc("1500"),
      });

      expect(tight.availableToBorrow).toEqual({ before: usdc("1500"), after: usdc("500") });
    });
  });

  describe("repay and withdraw collateral", () => {
    it("adds the repaid amount back to the liquidity", () => {
      const result = capAvailableToBorrowByLiquidity({
        positionChange: positionChange(
          { before: usdc("2000"), after: usdc("3000") },
          { before: usdc("1000"), after: usdc("0") },
        ),
        marketAvailableToBorrow: usdc("500"),
      });

      expect(result.availableToBorrow).toEqual({ before: usdc("500"), after: usdc("1500") });
    });

    it("leaves the liquidity unchanged on a collateral withdrawal", () => {
      const result = capAvailableToBorrowByLiquidity({
        positionChange: positionChange(
          { before: usdc("2000"), after: usdc("900") },
          { before: usdc("1000"), after: usdc("1000") },
        ),
        marketAvailableToBorrow: usdc("500"),
      });

      expect(result.availableToBorrow).toEqual({ before: usdc("500"), after: usdc("500") });
    });

    it("keeps the collateral headroom when the liquidity after the repay is larger", () => {
      const result = capAvailableToBorrowByLiquidity({
        positionChange: positionChange(
          { before: usdc("100"), after: usdc("350") },
          { before: usdc("400"), after: usdc("150") },
        ),
        marketAvailableToBorrow: usdc("2920000"),
      });

      expect(result.availableToBorrow).toEqual({ before: usdc("100"), after: usdc("350") });
    });

    it("caps a repay and withdraw together by the liquidity plus the repaid amount", () => {
      const result = capAvailableToBorrowByLiquidity({
        positionChange: positionChange(
          { before: usdc("800"), after: usdc("700") },
          { before: usdc("1000"), after: usdc("800") },
        ),
        marketAvailableToBorrow: usdc("100"),
      });

      expect(result.availableToBorrow).toEqual({ before: usdc("100"), after: usdc("300") });
    });
  });

  it("leaves the other position fields untouched", () => {
    const input = positionChange({ before: usdc("1"), after: usdc("2") }, { before: usdc("3"), after: usdc("4") });
    const result = capAvailableToBorrowByLiquidity({ positionChange: input, marketAvailableToBorrow: 0n });

    expect(result.loan).toBe(input.loan);
    expect(result.collateral).toBe(input.collateral);
    expect(result.ltv).toBe(input.ltv);
  });
});
