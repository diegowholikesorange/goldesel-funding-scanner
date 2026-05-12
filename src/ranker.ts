import type { PairSnapshot } from "./types";

export function rank(
  passing: PairSnapshot[],
  failing: PairSnapshot[]
): { passing: PairSnapshot[]; failing: PairSnapshot[]; totalPairs: number } {
  const sortedPassing = [...passing].sort(
    (a, b) => b.projectedNetYieldPerCycle - a.projectedNetYieldPerCycle
  );
  const sortedFailing = [...failing].sort((a, b) => b.fundingRate8h - a.fundingRate8h);

  return {
    passing: sortedPassing,
    failing: sortedFailing.slice(0, 20),
    totalPairs: passing.length + failing.length,
  };
}
