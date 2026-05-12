import type { AppConfig, Exchange, ExchangeError, PairSnapshot, SymbolEntry } from "../types";
import { computeFees, computeYield, evaluate } from "../evaluator";
import { computeOiTrend } from "../state";

const FUTURES_BASE = "https://fapi.binance.com";
const SPOT_BASE    = "https://api.binance.com";
const EXCHANGE: Exchange = "BINANCE";
const TIMEOUT_MS = 5000;

function authHeaders(): Record<string, string> {
  const key = process.env.BINANCE_KEY;
  return key ? { "X-MBX-APIKEY": key } : {};
}

async function fetchWithTimeout(url: string, headers: Record<string, string> = {}): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return res.json();
  } finally {
    clearTimeout(timer);
  }
}

function isPerpetual(symbol: string): boolean {
  return !symbol.includes("_");
}

const QUOTE_ASSETS = ["USDT"];
const ASCII_ALNUM = /^[A-Z0-9]+$/;
function normalise(symbol: string): string | null {
  for (const quote of QUOTE_ASSETS) {
    if (symbol.endsWith(quote)) {
      const base = symbol.slice(0, -quote.length);
      if (!ASCII_ALNUM.test(base)) return null;
      return `${base}-${quote}`;
    }
  }
  return null;
}

function spreadFromBook(bids: [string, string][], asks: [string, string][]): number {
  if (!bids.length || !asks.length) return 999;
  return ((parseFloat(asks[0][0]) - parseFloat(bids[0][0])) / parseFloat(bids[0][0])) * 100;
}

function depth10bps(bids: [string, string][], asks: [string, string][], mid: number): number {
  const threshold = mid * 0.001;
  let usd = 0;
  for (const [price, qty] of bids) {
    const p = parseFloat(price);
    if (mid - p > threshold) break;
    usd += p * parseFloat(qty);
  }
  for (const [price, qty] of asks) {
    const p = parseFloat(price);
    if (p - mid > threshold) break;
    usd += p * parseFloat(qty);
  }
  return usd;
}

interface PremiumIndex {
  symbol: string;
  markPrice: string;
  indexPrice: string;
  lastFundingRate: string;
  nextFundingTime: number;
}

interface OrderBook {
  bids: [string, string][];
  asks: [string, string][];
}

interface OpenInterest {
  openInterest: string;
}

// Fetches and pre-filters all Binance USDT-perp symbols.
// Call once at startup and periodically to refresh the registry.
export async function initBinanceSymbols(
  config: AppConfig,
): Promise<{ symbols: SymbolEntry[]; error?: ExchangeError }> {
  const headers = authHeaders();
  try {
    const [piRes, spotRes] = await Promise.all([
      fetchWithTimeout(`${FUTURES_BASE}/fapi/v1/premiumIndex`, headers) as Promise<PremiumIndex[]>,
      fetchWithTimeout(`${SPOT_BASE}/api/v3/ticker/price`) as Promise<{ symbol: string }[]>,
    ]);

    const spotSymbols = new Set(spotRes.map(t => t.symbol));
    const { scan } = config;
    const symbols: SymbolEntry[] = [];

    for (const pi of piRes) {
      if (!isPerpetual(pi.symbol)) continue;
      const pair = normalise(pi.symbol);
      if (!pair) continue;
      if (!spotSymbols.has(pi.symbol)) continue;

      const perpPrice    = parseFloat(pi.markPrice);
      const spotPrice    = parseFloat(pi.indexPrice);
      const fundingRate8h = parseFloat(pi.lastFundingRate) * 100;
      const basisPct     = ((perpPrice - spotPrice) / spotPrice) * 100;

      if (fundingRate8h <= 0) continue;
      if (Math.abs(basisPct) > scan.maxBasisPct) continue;

      symbols.push({
        exchange: EXCHANGE,
        pair,
        exchangeId: pi.symbol,
        spotPrice,
        perpPrice,
        basisPct,
        fundingRate8h,
        nextFundingTime: new Date(pi.nextFundingTime).toISOString(),
        predictedNextRate: null,
        spotSpreadPct: 0, // filled in by scanBinancePair
        perpSpreadPct: 0,
      });
    }

    return { symbols };
  } catch (err) {
    return {
      symbols: [],
      error: {
        exchange: EXCHANGE,
        message: err instanceof Error ? err.message : String(err),
        timestamp: new Date().toISOString(),
      },
    };
  }
}

// Scans a single symbol: fetches depth + OI, evaluates, returns a snapshot.
// Returns null on unrecoverable error (e.g. delisted); pushes recoverable errors to `errors`.
export async function scanBinancePair(
  entry: SymbolEntry,
  config: AppConfig,
  errors: ExchangeError[],
): Promise<PairSnapshot | null> {
  const headers = authHeaders();
  const { exchangeId: symbol, pair } = entry;

  try {
    const [perpBook, spotBook, oi] = await Promise.all([
      fetchWithTimeout(`${FUTURES_BASE}/fapi/v1/depth?symbol=${symbol}&limit=20`, headers) as Promise<OrderBook>,
      fetchWithTimeout(`${SPOT_BASE}/api/v3/depth?symbol=${symbol}&limit=20`) as Promise<OrderBook>,
      fetchWithTimeout(`${FUTURES_BASE}/fapi/v1/openInterest?symbol=${symbol}`, headers) as Promise<OpenInterest>,
    ]);

    const spotSpreadPct = spreadFromBook(spotBook.bids, spotBook.asks);
    const perpSpreadPct = spreadFromBook(perpBook.bids, perpBook.asks);
    const spotMid = spotBook.bids.length ? parseFloat(spotBook.bids[0][0]) : entry.spotPrice;
    const oiRaw   = parseFloat(oi.openInterest) * entry.perpPrice;
    const oiTrend = computeOiTrend(`${EXCHANGE}:${pair}`, oiRaw, config.scan.oiFallThresholdPct);

    const { entryFeeEst, exitFeeEst, roundTripFee } = computeFees(EXCHANGE, config.fees);
    const yieldFields = computeYield(entry.fundingRate8h, roundTripFee, config.scan.minHoldCycles);

    const raw: Omit<PairSnapshot, "passes" | "flags"> = {
      exchange: EXCHANGE,
      pair,
      spotPrice: spotMid,
      perpPrice: entry.perpPrice,
      basisPct: entry.basisPct,
      fundingRate8h: entry.fundingRate8h,
      fundingRateAnnualised: entry.fundingRate8h * 3 * 365,
      nextFundingTime: entry.nextFundingTime,
      predictedNextRate: null,
      spotSpreadPct,
      perpSpreadPct,
      timestamp: new Date().toISOString(),
      spotDepth10bpsUsd: depth10bps(spotBook.bids, spotBook.asks, spotMid),
      perpDepth10bpsUsd: depth10bps(perpBook.bids, perpBook.asks, entry.perpPrice),
      oiRaw,
      oiTrend,
      entryFeeEst,
      exitFeeEst,
      roundTripFee,
      ...yieldFields,
    };

    const { passes, flags } = evaluate(raw, config);
    return { ...raw, passes, flags };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("HTTP 400")) return null; // delisted/inactive symbol
    errors.push({ exchange: EXCHANGE, message: `${pair}: ${msg}`, timestamp: new Date().toISOString() });
    return null;
  }
}
