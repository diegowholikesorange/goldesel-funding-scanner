import { describe, it, expect } from "vitest";
import { rank } from "../ranker";
import type { PairSnapshot, ScanResult } from "../types";

function makeSnapshot(overrides: Partial<PairSnapshot>): PairSnapshot {
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
    predictedNextRate: null,
    spotSpreadPct: 0.01,
    perpSpreadPct: 0.01,
    spotDepth10bpsUsd: 100000,
    perpDepth10bpsUsd: 200000,
    oiRaw: 5000000,
    oiTrend: "stable",
    entryFeeEst: 0.0012,
    exitFeeEst: 0.0015,
    roundTripFee: 0.0027,
    minCyclesToBreakeven: 1,
    projectedYieldPerCycle: 0.05,
    projectedNetYieldPerCycle: 0.045,
    passes: true,
    flags: [],
    ...overrides,
  };
}

describe("rank", () => {
  it("sorts passing pairs descending by projectedNetYieldPerCycle", () => {
    const snapshots: PairSnapshot[] = [
      makeSnapshot({ pair: "ETH-USDT", projectedNetYieldPerCycle: 0.02, passes: true }),
      makeSnapshot({ pair: "BTC-USDT", projectedNetYieldPerCycle: 0.05, passes: true }),
      makeSnapshot({ pair: "SOL-USDT", projectedNetYieldPerCycle: 0.03, passes: true }),
    ];
    const result = rank(snapshots, []);
    expect(result.passing.map((s) => s.pair)).toEqual(["BTC-USDT", "SOL-USDT", "ETH-USDT"]);
  });

  it("sorts failing pairs descending by fundingRate8h", () => {
    const failing: PairSnapshot[] = [
      makeSnapshot({ pair: "ETH-USDT", fundingRate8h: 0.02, passes: false, flags: ["OI_UNWINDING"] }),
      makeSnapshot({ pair: "BTC-USDT", fundingRate8h: 0.08, passes: false, flags: ["OI_UNWINDING"] }),
      makeSnapshot({ pair: "SOL-USDT", fundingRate8h: 0.05, passes: false, flags: ["OI_UNWINDING"] }),
    ];
    const result = rank([], failing);
    expect(result.failing.map((s) => s.pair)).toEqual(["BTC-USDT", "SOL-USDT", "ETH-USDT"]);
  });

  it("caps failing array at 20 entries", () => {
    const failing = Array.from({ length: 25 }, (_, i) =>
      makeSnapshot({ pair: `COIN${i}-USDT`, fundingRate8h: i * 0.001, passes: false, flags: ["OI_UNWINDING"] })
    );
    const result = rank([], failing);
    expect(result.failing).toHaveLength(20);
  });

  it("does not cap passing array", () => {
    const passing = Array.from({ length: 25 }, (_, i) =>
      makeSnapshot({ pair: `COIN${i}-USDT`, projectedNetYieldPerCycle: i * 0.001, passes: true })
    );
    const result = rank(passing, []);
    expect(result.passing).toHaveLength(25);
  });

  it("returns correct totalPairs count", () => {
    const passing = [makeSnapshot({ passes: true })];
    const failing = [makeSnapshot({ passes: false, flags: ["OI_UNWINDING"] })];
    const result = rank(passing, failing);
    expect(result.totalPairs).toBe(2);
  });
});
