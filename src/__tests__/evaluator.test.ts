import { describe, it, expect } from "vitest";
import { computeFees, computeYield, evaluate } from "../evaluator";
import type { AppConfig, PairSnapshot } from "../types";

const config: AppConfig = {
  fees: {
    binance: {
      spotMaker: 0.001,
      spotTaker: 0.001,
      futuresMaker: 0.0002,
      futuresTaker: 0.0005,
      bnbDiscount: false,
    },
    okx: {
      spotMaker: 0.0008,
      spotTaker: 0.001,
      futuresMaker: 0.0002,
      futuresTaker: 0.0005,
      okbDiscount: false,
    },
  },
  scan: {
    minSpotDepthUsd: 50000,
    minPerpDepthUsd: 100000,
    minOiUsd: 50000000,
    maxBasisPct: 0.5,
    maxSpreadPct: 0.05,
    minHoldCycles: 6,
    minNetYieldPerCycle: 0.01,
    minFundingRate8h: 0.01,
    oiFallThresholdPct: 5,
    scanIntervalSeconds: 60,
  },
};

function makeSnapshot(overrides: Partial<PairSnapshot> = {}): PairSnapshot {
  return {
    timestamp: "2026-05-12T10:00:00Z",
    exchange: "BINANCE",
    pair: "BTC-USDT",
    spotPrice: 65000,
    perpPrice: 65050,
    basisPct: 0.077,
    fundingRate8h: 0.05,
    fundingRateAnnualised: 54.75,
    nextFundingTime: "2026-05-12T12:00:00Z",
    predictedNextRate: 0.04,
    spotSpreadPct: 0.01,
    perpSpreadPct: 0.01,
    spotDepth10bpsUsd: 100000,
    perpDepth10bpsUsd: 200000,
    oiRaw: 100000000,
    oiTrend: "stable",
    entryFeeEst: 0.0012,
    exitFeeEst: 0.0015,
    roundTripFee: 0.0027,
    minCyclesToBreakeven: 1,
    projectedYieldPerCycle: 0.05,
    projectedNetYieldPerCycle: 0.0495,
    passes: false,
    flags: [],
    ...overrides,
  };
}

describe("computeFees", () => {
  it("computes Binance fees: entry = spotTaker + futuresMaker, exit = spotTaker + futuresTaker", () => {
    const fees = computeFees("BINANCE", config.fees);
    expect(fees.entryFeeEst).toBeCloseTo(0.001 + 0.0002); // 0.0012
    expect(fees.exitFeeEst).toBeCloseTo(0.001 + 0.0005);  // 0.0015
    expect(fees.roundTripFee).toBeCloseTo(0.0027);
  });

  it("computes OKX fees correctly", () => {
    const fees = computeFees("OKX", config.fees);
    expect(fees.entryFeeEst).toBeCloseTo(0.001 + 0.0002); // 0.0012
    expect(fees.exitFeeEst).toBeCloseTo(0.001 + 0.0005);  // 0.0015
    expect(fees.roundTripFee).toBeCloseTo(0.0027);
  });
});

describe("computeYield", () => {
  it("calculates breakeven, yield, and net yield", () => {
    const result = computeYield(0.05, 0.0027, 6);
    expect(result.projectedYieldPerCycle).toBe(0.05);
    expect(result.minCyclesToBreakeven).toBe(1); // ceil(0.0027 / 0.05) = 1
    expect(result.projectedNetYieldPerCycle).toBeCloseTo(0.05 - 0.0027 / 6);
  });
});

describe("evaluate", () => {
  it("passes when all thresholds are met", () => {
    const result = evaluate(makeSnapshot(), config);
    expect(result.passes).toBe(true);
    expect(result.flags).toHaveLength(0);
  });

  it("flags FUNDING_NOT_POSITIVE when rate is zero", () => {
    const result = evaluate(makeSnapshot({ fundingRate8h: 0 }), config);
    expect(result.flags).toContain("FUNDING_NOT_POSITIVE");
    expect(result.flags).not.toContain("FUNDING_BELOW_MINIMUM");
  });

  it("flags FUNDING_NOT_POSITIVE when rate is negative", () => {
    const result = evaluate(makeSnapshot({ fundingRate8h: -0.01 }), config);
    expect(result.flags).toContain("FUNDING_NOT_POSITIVE");
    expect(result.flags).not.toContain("FUNDING_BELOW_MINIMUM");
  });

  it("flags FUNDING_BELOW_MINIMUM when rate is positive but below threshold", () => {
    const result = evaluate(makeSnapshot({ fundingRate8h: 0.005 }), config);
    expect(result.flags).toContain("FUNDING_BELOW_MINIMUM");
    expect(result.flags).not.toContain("FUNDING_NOT_POSITIVE");
  });

  it("flags INSUFFICIENT_SPOT_DEPTH", () => {
    const result = evaluate(makeSnapshot({ spotDepth10bpsUsd: 10000 }), config);
    expect(result.flags).toContain("INSUFFICIENT_SPOT_DEPTH");
  });

  it("flags INSUFFICIENT_PERP_DEPTH", () => {
    const result = evaluate(makeSnapshot({ perpDepth10bpsUsd: 50000 }), config);
    expect(result.flags).toContain("INSUFFICIENT_PERP_DEPTH");
  });

  it("flags INSUFFICIENT_OI when oiRaw is below minOiUsd", () => {
    const result = evaluate(makeSnapshot({ oiRaw: 2000000 }), config);
    expect(result.flags).toContain("INSUFFICIENT_OI");
  });

  it("does not flag INSUFFICIENT_OI when oiRaw is null (fetch failed)", () => {
    const result = evaluate(makeSnapshot({ oiRaw: null }), config);
    expect(result.flags).not.toContain("INSUFFICIENT_OI");
  });

  it("flags BASIS_TOO_STRETCHED", () => {
    const result = evaluate(makeSnapshot({ basisPct: 0.8 }), config);
    expect(result.flags).toContain("BASIS_TOO_STRETCHED");
  });

  it("flags SPREAD_TOO_WIDE when spot spread exceeds threshold", () => {
    const result = evaluate(makeSnapshot({ spotSpreadPct: 0.1 }), config);
    expect(result.flags).toContain("SPREAD_TOO_WIDE");
  });

  it("flags SPREAD_TOO_WIDE when perp spread exceeds threshold", () => {
    const result = evaluate(makeSnapshot({ perpSpreadPct: 0.1 }), config);
    expect(result.flags).toContain("SPREAD_TOO_WIDE");
  });

  it("flags OI_UNWINDING when oiTrend is falling", () => {
    const result = evaluate(makeSnapshot({ oiTrend: "falling" }), config);
    expect(result.flags).toContain("OI_UNWINDING");
  });

  it("flags YIELD_BELOW_THRESHOLD", () => {
    const result = evaluate(makeSnapshot({ projectedNetYieldPerCycle: 0.005 }), config);
    expect(result.flags).toContain("YIELD_BELOW_THRESHOLD");
  });

  it("returns multiple flags when multiple conditions fail", () => {
    const result = evaluate(
      makeSnapshot({ spotDepth10bpsUsd: 10000, basisPct: 0.8, oiTrend: "falling" }),
      config
    );
    expect(result.flags).toContain("INSUFFICIENT_SPOT_DEPTH");
    expect(result.flags).toContain("BASIS_TOO_STRETCHED");
    expect(result.flags).toContain("OI_UNWINDING");
    expect(result.passes).toBe(false);
  });

  it("does not check yield when FUNDING_NOT_POSITIVE (avoids Infinity breakeven)", () => {
    const result = evaluate(makeSnapshot({ fundingRate8h: 0 }), config);
    expect(result.flags).not.toContain("YIELD_BELOW_THRESHOLD");
  });
});
