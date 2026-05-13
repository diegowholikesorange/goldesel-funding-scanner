import type { AppConfig, ExchangeError, MarketSentiment, PairSnapshot, ScanResult, SymbolEntry } from "./types";
import { initBinanceSymbols, scanBinancePair } from "./feeds/binance";
import { initOkxSymbols, scanOkxPair } from "./feeds/okx";
import { rank } from "./ranker";

// Minimum pause between consecutive symbol scans, per exchange.
// Binance: 3 req/symbol @ 100ms = ~30 req/s burst max → well under 300/10s raw limit.
// OKX: no strict IP-ban policy; shorter pause is fine.
const PAUSE_MS: Record<string, number> = { BINANCE: 200, OKX: 200 };

// Symbol registry TTL: re-fetch the full symbol list this often.
const SYMBOL_TTL_MS   = 60 * 60 * 1000; // 1 hour — on clean refresh
const SYMBOL_RETRY_MS =  5 * 60 * 1000; // 5 min  — if last refresh had errors

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function computeSentiment(snapshots: PairSnapshot[]): MarketSentiment {
  if (snapshots.length === 0) {
    return { avgFunding8h: 0, avgAbsFunding8h: 0, pctPositive: 0, totalOiUsd: 0, pctRisingOi: 0, pctFallingOi: 0 };
  }
  const n = snapshots.length;
  const avgFunding8h    = snapshots.reduce((s, p) => s + p.fundingRate8h, 0) / n;
  const avgAbsFunding8h = snapshots.reduce((s, p) => s + Math.abs(p.fundingRate8h), 0) / n;
  const pctPositive     = snapshots.filter(p => p.fundingRate8h > 0).length / n;
  const totalOiUsd      = snapshots.reduce((s, p) => s + (p.oiRaw ?? 0), 0);
  const withTrend       = snapshots.filter(p => p.oiTrend !== "unknown");
  const pctRisingOi     = withTrend.length > 0 ? withTrend.filter(p => p.oiTrend === "rising").length / withTrend.length : 0;
  const pctFallingOi    = withTrend.length > 0 ? withTrend.filter(p => p.oiTrend === "falling").length / withTrend.length : 0;
  return { avgFunding8h, avgAbsFunding8h, pctPositive, totalOiUsd, pctRisingOi, pctFallingOi };
}

export interface ScannerCallbacks {
  onPair(s: PairSnapshot): void;
  onRoundStart(): void;
  onRoundEnd(result: ScanResult): void;
  onSymbolsReady(symbols: Array<{ exchange: string; pair: string }>): void;
}

export async function runScanner(
  config: AppConfig,
  cb: ScannerCallbacks,
  signal: AbortSignal,
): Promise<void> {
  let symbols: SymbolEntry[] = [];
  let lastRefreshMs = 0;
  let pendingInitErrors: ExchangeError[] = []; // surfaced in the next onRoundEnd

  async function refreshSymbols(): Promise<void> {
    const initErrors: ExchangeError[] = [];
    const [binRes, okxRes] = await Promise.allSettled([
      initBinanceSymbols(config),
      initOkxSymbols(config),
    ]);

    const next: SymbolEntry[] = [];

    if (binRes.status === "fulfilled") {
      next.push(...binRes.value.symbols);
      if (binRes.value.error) initErrors.push(binRes.value.error);
    } else {
      initErrors.push({ exchange: "BINANCE", message: String(binRes.reason), timestamp: new Date().toISOString() });
    }

    if (okxRes.status === "fulfilled") {
      next.push(...okxRes.value.symbols);
      if (okxRes.value.error) initErrors.push(okxRes.value.error);
    } else {
      initErrors.push({ exchange: "OKX", message: String(okxRes.reason), timestamp: new Date().toISOString() });
    }

    if (next.length > 0) symbols = next.sort((a, b) => a.pair.localeCompare(b.pair));
    // Always update lastRefreshMs, but use a shorter TTL if there were errors.
    lastRefreshMs = initErrors.length > 0
      ? Date.now() - SYMBOL_TTL_MS + SYMBOL_RETRY_MS
      : Date.now();

    if (next.length > 0) cb.onSymbolsReady(symbols.map(s => ({ exchange: s.exchange, pair: s.pair })));
    pendingInitErrors = initErrors;
    if (initErrors.length > 0) {
      console.warn("[scanner] Init errors:", initErrors.map(e => `${e.exchange}: ${e.message}`).join("; "));
    }
  }

  // Initial fetch
  await refreshSymbols();

  while (!signal.aborted) {
    if (symbols.length === 0) {
      await sleep(5000);
      await refreshSymbols();
      continue;
    }

    cb.onRoundStart();
    const roundSnapshots: PairSnapshot[] = [];
    const roundErrors: ExchangeError[] = [];

    for (const sym of symbols) {
      if (signal.aborted) break;

      const snapshot = sym.exchange === "BINANCE"
        ? await scanBinancePair(sym, config, roundErrors)
        : await scanOkxPair(sym, config, roundErrors);

      if (snapshot) {
        roundSnapshots.push(snapshot);
        cb.onPair(snapshot);
      }

      await sleep(PAUSE_MS[sym.exchange] ?? 100);
    }

    const passing = roundSnapshots.filter(s => s.passes);
    const failing = roundSnapshots.filter(s => !s.passes);
    const { passing: rankedPassing, failing: rankedFailing, totalPairs } = rank(passing, failing);

    const errors = [...pendingInitErrors, ...roundErrors];
    pendingInitErrors = [];

    cb.onRoundEnd({
      scannedAt: new Date().toISOString(),
      totalPairs,
      passing: rankedPassing,
      failing: rankedFailing,
      errors,
      sentiment: computeSentiment(roundSnapshots),
    });

    if (Date.now() - lastRefreshMs > SYMBOL_TTL_MS) {
      await refreshSymbols();
    }
  }
}
