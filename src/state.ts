import type { OiTrend } from "./types";

// Keyed by "EXCHANGE:PAIR" (e.g. "BINANCE:BTC-USDT")
// Entries are never pruned — acceptable memory cost for Phase 1 pair counts (~200 keys)
const oiHistory = new Map<string, number>();

export function computeOiTrend(
  key: string,
  currentOi: number | null,
  fallThresholdPct: number
): OiTrend {
  if (currentOi === null) return "unknown";

  const prev = oiHistory.get(key);
  oiHistory.set(key, currentOi);
  if (prev === undefined) return "unknown";

  const changePct = ((currentOi - prev) / prev) * 100;
  if (changePct > 1) return "rising";
  if (changePct < -fallThresholdPct) return "falling";
  return "stable";
}

// Exported only for tests — resets module-level state between test runs
export function resetOiHistory(): void {
  oiHistory.clear();
}
