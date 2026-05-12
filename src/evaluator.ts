import type { AppConfig, Exchange, FeeConfig, Flag, OiTrend, PairSnapshot } from "./types";

export function computeFees(
  exchange: Exchange,
  fees: FeeConfig
): { entryFeeEst: number; exitFeeEst: number; roundTripFee: number } {
  const f = exchange === "BINANCE" ? fees.binance : fees.okx;
  const entryFeeEst = f.spotTaker + f.futuresMaker;
  const exitFeeEst = f.spotTaker + f.futuresTaker;
  return { entryFeeEst, exitFeeEst, roundTripFee: entryFeeEst + exitFeeEst };
}

export function computeYield(
  fundingRate8h: number,
  roundTripFee: number,
  minHoldCycles: number
): {
  minCyclesToBreakeven: number;
  projectedYieldPerCycle: number;
  projectedNetYieldPerCycle: number;
} {
  return {
    minCyclesToBreakeven: Math.ceil(roundTripFee / fundingRate8h),
    projectedYieldPerCycle: fundingRate8h,
    projectedNetYieldPerCycle: fundingRate8h - roundTripFee / minHoldCycles,
  };
}

export function evaluate(
  snapshot: Omit<PairSnapshot, "passes" | "flags">,
  config: AppConfig
): { passes: boolean; flags: Flag[] } {
  const flags: Flag[] = [];
  const { scan } = config;

  if (snapshot.fundingRate8h <= 0) {
    flags.push("FUNDING_NOT_POSITIVE");
  } else if (snapshot.fundingRate8h < scan.minFundingRate8h) {
    flags.push("FUNDING_BELOW_MINIMUM");
  }

  if (snapshot.spotDepth10bpsUsd < scan.minSpotDepthUsd) flags.push("INSUFFICIENT_SPOT_DEPTH");
  if (snapshot.perpDepth10bpsUsd < scan.minPerpDepthUsd) flags.push("INSUFFICIENT_PERP_DEPTH");
  if (snapshot.oiRaw !== null && snapshot.oiRaw < scan.minOiUsd) flags.push("INSUFFICIENT_OI");
  if (snapshot.basisPct > scan.maxBasisPct) flags.push("BASIS_TOO_STRETCHED");

  if (snapshot.spotSpreadPct > scan.maxSpreadPct || snapshot.perpSpreadPct > scan.maxSpreadPct) {
    flags.push("SPREAD_TOO_WIDE");
  }

  if (snapshot.oiTrend === "falling") flags.push("OI_UNWINDING");

  // Only reached when fundingRate8h > 0 (FUNDING_NOT_POSITIVE guard above prevents Infinity)
  if (!flags.includes("FUNDING_NOT_POSITIVE")) {
    if (snapshot.projectedNetYieldPerCycle < scan.minNetYieldPerCycle) {
      flags.push("YIELD_BELOW_THRESHOLD");
    }
  }

  return { passes: flags.length === 0, flags };
}
