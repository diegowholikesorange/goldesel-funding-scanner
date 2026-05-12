import type { AppConfig, Exchange, ExchangeError, PairSnapshot, SymbolEntry } from "../types";
import { computeFees, computeYield, evaluate } from "../evaluator";
import { computeOiTrend } from "../state";
import { buildOkxAuthHeaders } from "./okx-auth";
import { runCapped } from "./concurrency";

const PASS1B_CONCURRENCY = 5; // concurrent funding-rate fetches during init

const OKX_BASE = "https://www.okx.com";
const EXCHANGE: Exchange = "OKX";
const TIMEOUT_MS = 5000;

function authHeaders(method: "GET" | "POST", path: string): Record<string, string> {
  const key = process.env.OKX_KEY;
  const secret = process.env.OKX_SECRET;
  const passphrase = process.env.OKX_PASSPHRASE;
  if (!key || !secret || !passphrase) return {};
  return buildOkxAuthHeaders({ apiKey: key, apiSecret: secret, passphrase, method, path });
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

function normaliseSwap(instId: string): string {
  return instId.replace(/-SWAP$/, "");
}

function spreadPct(bid: number, ask: number): number {
  return ((ask - bid) / bid) * 100;
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

interface OkxResponse<T> { code: string; data: T[]; }
interface OkxSwapTicker { instId: string; last: string; bidPx: string; askPx: string; }
interface OkxSpotTicker { instId: string; bidPx: string; askPx: string; }
interface OkxFundingRate { fundingRate: string; nextFundingRate: string; nextFundingTime: string; }
interface OkxBook { bids: [string, string, string, string][]; asks: [string, string, string, string][]; }
interface OkxOi { oiCcy: string; }

// Fetches and pre-filters all OKX USDT-margined swap symbols.
// Pass-1a: bulk tickers (spread filter).
// Pass-1b: per-symbol funding rates (concurrent; funding + basis filter).
// Call once at startup and periodically to refresh the registry.
export async function initOkxSymbols(
  config: AppConfig,
): Promise<{ symbols: SymbolEntry[]; error?: ExchangeError }> {
  const swapPath = "/api/v5/market/tickers?instType=SWAP";
  const spotPath = "/api/v5/market/tickers?instType=SPOT";

  let swapTickers: OkxSwapTicker[];
  let spotMap: Map<string, OkxSpotTicker>;

  try {
    const [swapRes, spotRes] = await Promise.all([
      fetchWithTimeout(`${OKX_BASE}${swapPath}`, authHeaders("GET", swapPath)) as Promise<OkxResponse<OkxSwapTicker>>,
      fetchWithTimeout(`${OKX_BASE}${spotPath}`, authHeaders("GET", spotPath)) as Promise<OkxResponse<OkxSpotTicker>>,
    ]);
    swapTickers = swapRes.data;
    spotMap = new Map(spotRes.data.map(t => [t.instId, t]));
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

  const { scan } = config;

  // Pass-1a: spread pre-filter
  const tickerCandidates: Array<{
    pair: string; swapId: string;
    perpPrice: number; spotPrice: number;
    spotSpreadPct: number; perpSpreadPct: number;
  }> = [];

  for (const t of swapTickers) {
    if (!t.instId.endsWith("-USDT-SWAP")) continue;
    const pair = normaliseSwap(t.instId);
    const spotTick = spotMap.get(pair);
    if (!spotTick) continue;
    if (!t.bidPx || !t.askPx || !spotTick.bidPx || !spotTick.askPx) continue;

    const perpBid = parseFloat(t.bidPx), perpAsk = parseFloat(t.askPx);
    const spotBid = parseFloat(spotTick.bidPx), spotAsk = parseFloat(spotTick.askPx);
    const pSpread = spreadPct(perpBid, perpAsk);
    const sSpread = spreadPct(spotBid, spotAsk);
    if (pSpread > scan.maxSpreadPct || sSpread > scan.maxSpreadPct) continue;

    tickerCandidates.push({
      pair,
      swapId: t.instId,
      perpPrice: parseFloat(t.last),
      spotPrice: (spotBid + spotAsk) / 2,
      spotSpreadPct: sSpread,
      perpSpreadPct: pSpread,
    });
  }

  // Pass-1b: per-symbol funding rate (concurrent)
  const symbols: SymbolEntry[] = [];

  await runCapped(
    tickerCandidates.map(tc => async () => {
      const fundingPath = `/api/v5/public/funding-rate?instId=${tc.swapId}`;
      try {
        const res = await fetchWithTimeout(`${OKX_BASE}${fundingPath}`) as OkxResponse<OkxFundingRate>;
        const fr = res.data[0];
        if (!fr) return;

        const nextFundingMs = parseInt(fr.nextFundingTime);
        if (isNaN(nextFundingMs)) return;

        const fundingRate8h = parseFloat(fr.fundingRate) * 100;
        const predictedNextRate = fr.nextFundingRate && fr.nextFundingRate !== ""
          ? parseFloat(fr.nextFundingRate) * 100 : null;
        const basisPct = ((tc.perpPrice - tc.spotPrice) / tc.spotPrice) * 100;

        if (fundingRate8h <= 0) return;
        if (Math.abs(basisPct) > scan.maxBasisPct) return;

        symbols.push({
          exchange: EXCHANGE,
          pair: tc.pair,
          exchangeId: tc.swapId,
          spotPrice: tc.spotPrice,
          perpPrice: tc.perpPrice,
          basisPct,
          fundingRate8h,
          nextFundingTime: new Date(nextFundingMs).toISOString(),
          predictedNextRate,
          spotSpreadPct: tc.spotSpreadPct,
          perpSpreadPct: tc.perpSpreadPct,
        });
      } catch {
        // silently skip; one funding failure during init is non-fatal
      }
    }),
    PASS1B_CONCURRENCY,
  );

  symbols.sort((a, b) => a.pair.localeCompare(b.pair));
  return { symbols };
}

// Scans a single OKX symbol: fetches depth + OI, evaluates, returns a snapshot.
// Returns null on unrecoverable error; pushes recoverable errors to `errors`.
export async function scanOkxPair(
  entry: SymbolEntry,
  config: AppConfig,
  errors: ExchangeError[],
): Promise<PairSnapshot | null> {
  const swapId = entry.exchangeId;
  const perpBookPath = `/api/v5/market/books?instId=${swapId}&sz=20`;
  const spotBookPath = `/api/v5/market/books?instId=${entry.pair}&sz=20`;
  const oiPath       = `/api/v5/public/open-interest?instType=SWAP&instId=${swapId}`;

  try {
    const [perpBookRes, spotBookRes, oiRes] = await Promise.all([
      fetchWithTimeout(`${OKX_BASE}${perpBookPath}`, authHeaders("GET", perpBookPath)) as Promise<OkxResponse<OkxBook>>,
      fetchWithTimeout(`${OKX_BASE}${spotBookPath}`, authHeaders("GET", spotBookPath)) as Promise<OkxResponse<OkxBook>>,
      fetchWithTimeout(`${OKX_BASE}${oiPath}`) as Promise<OkxResponse<OkxOi>>,
    ]);

    const perpBook = perpBookRes.data?.[0];
    const spotBook = spotBookRes.data?.[0];
    if (!perpBook || !spotBook) throw new Error(`empty book response for ${entry.pair}`);

    const oiRaw   = oiRes.data[0] ? parseFloat(oiRes.data[0].oiCcy) * entry.perpPrice : null;
    const oiTrend = computeOiTrend(`${EXCHANGE}:${entry.pair}`, oiRaw, config.scan.oiFallThresholdPct);

    const normPerpBids = perpBook.bids.map(([p, s]) => [p, s] as [string, string]);
    const normPerpAsks = perpBook.asks.map(([p, s]) => [p, s] as [string, string]);
    const normSpotBids = spotBook.bids.map(([p, s]) => [p, s] as [string, string]);
    const normSpotAsks = spotBook.asks.map(([p, s]) => [p, s] as [string, string]);

    const { entryFeeEst, exitFeeEst, roundTripFee } = computeFees(EXCHANGE, config.fees);
    const yieldFields = computeYield(entry.fundingRate8h, roundTripFee, config.scan.minHoldCycles);

    const raw: Omit<PairSnapshot, "passes" | "flags"> = {
      exchange: EXCHANGE,
      pair: entry.pair,
      spotPrice: entry.spotPrice,
      perpPrice: entry.perpPrice,
      basisPct: entry.basisPct,
      fundingRate8h: entry.fundingRate8h,
      fundingRateAnnualised: entry.fundingRate8h * 3 * 365,
      nextFundingTime: entry.nextFundingTime,
      predictedNextRate: entry.predictedNextRate,
      spotSpreadPct: entry.spotSpreadPct,
      perpSpreadPct: entry.perpSpreadPct,
      timestamp: new Date().toISOString(),
      spotDepth10bpsUsd: depth10bps(normSpotBids, normSpotAsks, entry.spotPrice),
      perpDepth10bpsUsd: depth10bps(normPerpBids, normPerpAsks, entry.perpPrice),
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
    errors.push({
      exchange: EXCHANGE,
      message: `${entry.pair}: ${err instanceof Error ? err.message : String(err)}`,
      timestamp: new Date().toISOString(),
    });
    return null;
  }
}
