# Slice 1 — Funding Rate Scanner + Web Dashboard
## spec-2.md — revised after spec-1 review
*May 2026*

---

## Goal

Answer one question with data, no opinions:

> Can we consistently find funding setups where expected funding income beats fees, spread, basis risk, and execution cost?

Phase 1 produces **a log file and a live dashboard**, not profit.

---

## What We Are Not Building Yet

- Live order execution
- Paper trade simulator (Phase 2)
- Authentication / private API endpoints (all data is public in Phase 1)
- Terminal output (dropped in favour of the web dashboard; terminal stdout for errors only)

---

## Architecture

```
┌──────────────────────────────────────────────────────┐
│                  Scheduler (60s loop)                 │
└───────────────────────┬──────────────────────────────┘
                        │
             ┌──────────┴──────────┐
             │                     │
      ┌──────▼──────┐       ┌──────▼──────┐
      │  OKX Feed   │       │Binance Feed │
      │  (bulk tick │       │  (bulk tick │
      │  + depth)   │       │  + depth)   │
      └──────┬──────┘       └──────┬──────┘
             └──────────┬──────────┘
                        │
               ┌────────▼────────┐
               │   state.ts      │
               │  OI prev map    │
               └────────┬────────┘
                        │
               ┌────────▼────────┐
               │  Fee Calculator │
               │  + Evaluator    │
               └────────┬────────┘
                        │
               ┌────────▼────────┐
               │    Ranker       │
               └────────┬────────┘
                        │
             ┌──────────┴──────────┐
             │                     │
      ┌──────▼──────┐       ┌──────▼──────┐
      │   Logger    │       │  HTTP API   │
      │  (JSONL)    │       │  /snapshot  │
      └─────────────┘       └──────┬──────┘
                                   │
                            ┌──────▼──────┐
                            │  Web        │
                            │  Dashboard  │
                            └─────────────┘
```

---

## File Structure

```
slice1-funding-scanner/
├── doc/
│   ├── spec-1.md
│   ├── spec-1-review.md
│   └── spec-2.md
├── src/
│   ├── index.ts              # entry point: starts scheduler + HTTP server + shutdown handler
│   ├── types.ts              # all shared types and union types
│   ├── config.ts             # loads + validates fees.json and config.json; exports AppConfig
│   ├── state.ts              # OI history map, updated each scan cycle
│   ├── feeds/
│   │   ├── binance.ts        # Binance public REST adapter (two-pass)
│   │   └── okx.ts            # OKX public REST adapter (two-pass)
│   ├── evaluator.ts          # pass/fail logic + fee formula
│   ├── ranker.ts             # sort passing by net yield desc, failing by rate desc
│   ├── logger.ts             # appends JSONL; flushes on shutdown
│   └── server.ts             # Express: GET /snapshot, serves static dashboard/
├── dashboard/
│   ├── index.html            # single page; loads main.js bundle
│   ├── main.ts               # dashboard TypeScript; bundled by esbuild
│   └── style.css
├── logs/                     # gitignored
├── fees.json
├── config.json
├── package.json
└── tsconfig.json
```

---

## Types (`src/types.ts`)

```typescript
export type Exchange = "BINANCE" | "OKX";

export type OiTrend = "rising" | "falling" | "stable" | "unknown";

export type Flag =
  | "FUNDING_NOT_POSITIVE"
  | "FUNDING_BELOW_MINIMUM"
  | "INSUFFICIENT_SPOT_DEPTH"
  | "INSUFFICIENT_PERP_DEPTH"
  | "BASIS_TOO_STRETCHED"
  | "SPREAD_TOO_WIDE"
  | "OI_UNWINDING"
  | "YIELD_BELOW_THRESHOLD";

// First-pass shape: no depth fields yet (fetched only for pairs that survive pre-filter)
export interface PreFilterSnapshot {
  exchange: Exchange;
  pair: string;               // canonical: "BTC-USDT"
  spotPrice: number;
  perpPrice: number;
  basisPct: number;
  fundingRate8h: number;
  nextFundingTime: string;    // ISO 8601
  predictedNextRate: number | null;
  spotSpreadPct: number;
  perpSpreadPct: number;
  oiRaw: number | null;       // raw OI value from exchange (for state.ts to diff)
}

// Full shape after depth fetch and evaluation
export interface PairSnapshot extends PreFilterSnapshot {
  timestamp: string;          // ISO 8601, set at scan time
  fundingRateAnnualised: number;
  spotDepth10bpsUsd: number;
  perpDepth10bpsUsd: number;
  oiTrend: OiTrend;
  entryFeeEst: number;        // % — see fee formula below
  exitFeeEst: number;
  roundTripFee: number;
  minCyclesToBreakeven: number;
  projectedYieldPerCycle: number;
  projectedNetYieldPerCycle: number;
  passes: boolean;
  flags: Flag[];
}

export interface ScanResult {
  scannedAt: string;          // ISO 8601
  totalPairs: number;
  passing: PairSnapshot[];
  failing: PairSnapshot[];    // capped at top 20 by fundingRate8h
  errors: ExchangeError[];
}

export interface ExchangeError {
  exchange: Exchange;
  message: string;
  timestamp: string;
}

// Config types
export interface FeeConfig {
  binance: {
    spotMaker: number;
    spotTaker: number;
    futuresMaker: number;
    futuresTaker: number;
    bnbDiscount: boolean;
  };
  okx: {
    spotMaker: number;
    spotTaker: number;
    futuresMaker: number;
    futuresTaker: number;
    okbDiscount: boolean;
  };
}

export interface ScanConfig {
  minSpotDepthUsd: number;
  minPerpDepthUsd: number;
  maxBasisPct: number;
  maxSpreadPct: number;
  minHoldCycles: number;
  minNetYieldPerCycle: number;
  minFundingRate8h: number;
  oiFallThresholdPct: number; // OI drop % in one cycle that triggers OI_UNWINDING
  scanIntervalSeconds: number;
}

export interface AppConfig {
  fees: FeeConfig;
  scan: ScanConfig;
}
```

---

## Config Files

### `fees.json`
```json
{
  "binance": {
    "spotMaker": 0.001,
    "spotTaker": 0.001,
    "futuresMaker": 0.0002,
    "futuresTaker": 0.0005,
    "bnbDiscount": false
  },
  "okx": {
    "spotMaker": 0.0008,
    "spotTaker": 0.001,
    "futuresMaker": 0.0002,
    "futuresTaker": 0.0005,
    "okbDiscount": false
  }
}
```
**Fill with your actual account fees before first run.** Wrong fees make the scanner hallucinate profit.

### `config.json`
```json
{
  "minSpotDepthUsd": 50000,
  "minPerpDepthUsd": 100000,
  "maxBasisPct": 0.5,
  "maxSpreadPct": 0.05,
  "minHoldCycles": 6,
  "minNetYieldPerCycle": 0.01,
  "minFundingRate8h": 0.01,
  "oiFallThresholdPct": 5,
  "scanIntervalSeconds": 60
}
```
Start conservative. The scanner should mostly output NO.

---

## Fee Formula (`evaluator.ts`)

Cash-and-carry has two legs: buy spot + short perp on entry; sell spot + close perp on exit.

```
entry fee = spotTaker + futuresMaker     (taker buy spot, maker short perp)
exit fee  = spotTaker + futuresTaker     (taker sell spot, taker close perp)
roundTripFee = entryFee + exitFee

minCyclesToBreakeven = Math.ceil(roundTripFee / fundingRate8h)
projectedYieldPerCycle = fundingRate8h
projectedNetYieldPerCycle = fundingRate8h - (roundTripFee / minHoldCycles)
```

Entry uses perp maker (limit order to open short); exit uses perp taker (market close). This is the base conservative assumption. If taker fees apply on entry, the numbers are worse — the scanner does not optimise for fee tier on entry.

---

## Pass/Fail Logic (`evaluator.ts`)

Hard rejections — any flag means FAIL:

```
FUNDING_NOT_POSITIVE    fundingRate8h <= 0
FUNDING_BELOW_MINIMUM   fundingRate8h < config.minFundingRate8h
INSUFFICIENT_SPOT_DEPTH spotDepth10bpsUsd < config.minSpotDepthUsd
INSUFFICIENT_PERP_DEPTH perpDepth10bpsUsd < config.minPerpDepthUsd
BASIS_TOO_STRETCHED     basisPct > config.maxBasisPct
SPREAD_TOO_WIDE         spotSpreadPct > config.maxSpreadPct
                        OR perpSpreadPct > config.maxSpreadPct
OI_UNWINDING            oiTrend === "falling"
YIELD_BELOW_THRESHOLD   projectedNetYieldPerCycle < config.minNetYieldPerCycle
```

The evaluator is a pure function: `(snapshot: PairSnapshot, config: AppConfig) => { passes: boolean; flags: Flag[] }`. No side effects, fully unit-testable.

---

## Two-Pass Feed Strategy

Depth calls are expensive and rate-limited. Fetch depth only for pairs that survive pre-filter.

**Pass 1 — bulk, one call per exchange:**
- Fetch all tickers (spot price, perp price, funding rate, spread, next funding time)
- Apply pre-filter: `fundingRate8h > 0`, `basisPct <= maxBasisPct`, `spreadPct <= maxSpreadPct`
- Returns `PreFilterSnapshot[]`

**Pass 2 — per qualifying pair:**
- Fetch order book depth for each pair that passed pre-filter
- Compute OI trend from `state.ts`
- Build full `PairSnapshot`
- Run complete pass/fail evaluation

If pass 1 returns 200 pairs and pre-filter keeps 20, pass 2 makes 40 depth calls (spot + perp) instead of 400.

---

## Exchange Adapters

Both adapters return `PairSnapshot[]`. All endpoints are public (no API keys needed in Phase 1).

### Canonical Pair Format

All pair names are normalised to `BASE-QUOTE` (e.g., `BTC-USDT`) by the adapters before any processing. OKX `BTC-USDT-SWAP` → strip `-SWAP`. Binance `BTCUSDT` → insert hyphen before `USDT`/`BUSD`/`BTC`. Normalisation is done in the adapter, not the evaluator.

### Binance (`feeds/binance.ts`)

| Pass | Data | Endpoint |
|---|---|---|
| 1 | All perp tickers (price + funding) | `GET /fapi/v1/premiumIndex` |
| 1 | All spot best bid/ask | `GET /api/v3/bookTicker` |
| 2 | Perp order book | `GET /fapi/v1/depth?symbol=BTCUSDT&limit=20` |
| 2 | Spot order book | `GET /api/v3/depth?symbol=BTCUSDT&limit=20` |
| 2 | Open interest | `GET /fapi/v1/openInterest?symbol=BTCUSDT` |

`/fapi/v1/premiumIndex` returns `markPrice`, `lastFundingRate`, `nextFundingTime`, and `indexPrice` for all symbols in a single call.

Base URLs: `https://fapi.binance.com` (futures), `https://api.binance.com` (spot).

All timestamps from Binance are millisecond Unix integers — adapters convert to ISO 8601 strings.

### OKX (`feeds/okx.ts`)

| Pass | Data | Endpoint |
|---|---|---|
| 1 | All SWAP tickers (price + funding + spread) | `GET /api/v5/market/tickers?instType=SWAP` |
| 1 | All SPOT tickers (spot price + spread) | `GET /api/v5/market/tickers?instType=SPOT` |
| 2 | Perp order book | `GET /api/v5/market/books?instId=BTC-USDT-SWAP&sz=20` |
| 2 | Spot order book | `GET /api/v5/market/books?instId=BTC-USDT&sz=20` |
| 2 | Open interest | `GET /api/v5/public/open-interest?instType=SWAP&instId=BTC-USDT-SWAP` |

`/api/v5/market/tickers?instType=SWAP` returns `fundingRate` and `nextFundingTime` per ticker — this is the verified bulk source. There is no single-call bulk endpoint for OKX funding rates separate from tickers.

All timestamps from OKX are millisecond Unix strings — adapters parse and convert to ISO 8601.

### Request Policy (both adapters)

- All `fetch` calls carry a **5-second `AbortController` timeout**
- On timeout or non-2xx response: throw a typed `ExchangeError`; caller catches it and marks exchange unavailable for this cycle
- No automatic retry within a cycle — the next 60s cycle is the retry

---

## OI State Management (`state.ts`)

```typescript
// Keyed by "BINANCE:BTC-USDT" or "OKX:BTC-USDT"
const oiHistory = new Map<string, number>();

export function computeOiTrend(
  key: string,
  currentOi: number,
  fallThresholdPct: number
): OiTrend {
  const prev = oiHistory.get(key);
  oiHistory.set(key, currentOi);
  if (prev === undefined) return "unknown";
  const changePct = ((currentOi - prev) / prev) * 100;
  if (changePct > 1) return "rising";
  if (changePct < -fallThresholdPct) return "falling";  // triggers OI_UNWINDING flag
  return "stable";
}
```

`oiHistory` is module-level in `state.ts`. `index.ts` imports `computeOiTrend` and passes it to the feed constructors. First scan of every pair returns `"unknown"` (no flag). On the second scan, trend is computed. `"falling"` means OI dropped more than `oiFallThresholdPct`% in one cycle (default 5%).

---

## Ranker (`ranker.ts`)

- **Passing pairs**: sorted descending by `projectedNetYieldPerCycle`
- **Failing pairs**: sorted descending by `fundingRate8h` (highest rate that still failed — most useful for diagnosis)
- Failing pairs are capped at **top 20** in `ScanResult.failing` to keep `/snapshot` payload reasonable

---

## Logger (`logger.ts`)

- Appends one JSON line per `PairSnapshot` to `logs/scans.jsonl` on every scan
- Appends one summary line per `ScanResult` to `logs/summary.jsonl`
- On `SIGTERM`/`SIGINT`: flushes any buffered writes and closes file handles before exit

---

## HTTP Server (`server.ts`)

| Route | Description |
|---|---|
| `GET /snapshot` | Returns latest `ScanResult` as JSON |
| `GET /` | Serves `dashboard/index.html` |
| `GET /main.js` | Serves `dashboard/main.js` (esbuild output) |
| `GET /style.css` | Serves `dashboard/style.css` |

Port: `3000` (override with `PORT` env var). On `EADDRINUSE`, log a clear error and exit — no silent retry.

---

## Dashboard (`dashboard/`)

Single-page TypeScript app. **Built with esbuild** (`esbuild dashboard/main.ts --bundle --outfile=dashboard/main.js`). No framework. Types shared with backend by duplicating the relevant interfaces in `dashboard/main.ts` — no cross-origin module resolution needed.

**Behaviour:**
- Polls `GET /snapshot` every 10 seconds
- Shows: last scan time, "updated N seconds ago" counter (refreshed every second), pairs scanned, passing count
- **Passing table**: rank, pair, exchange, rate/8h, annualised %, net/cycle, basis, predicted next rate, flags
- **Failing table** (collapsed by default, toggle to expand): top 20 by rate, with flag reasons
- Row colours: green row = passes, amber = failed on single flag, red = multiple flags
- If no snapshot available yet (scanner still on first run): show "Waiting for first scan…"
- If last scan is >90s old (scanner stalled): show a staleness warning banner

---

## Error Handling Policy

- **Per-exchange failure** (timeout, 429, 5xx): catch in feed, return `ExchangeError`. That exchange's pairs are absent from the current cycle's results. Log the error to stderr and include it in `ScanResult.errors`. The other exchange continues normally.
- **Config validation failure** (malformed `fees.json` or `config.json`): throw on startup before the scheduler starts. Do not start with defaults — wrong fees produce wrong results.
- **Logger failure**: log to stderr, continue scanning. Do not crash the scheduler over a write error.
- **HTTP server failure**: log to stderr and exit — the server is the product; a silent crash is worse than a clean exit.

---

## Graceful Shutdown (`index.ts`)

```typescript
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

async function shutdown() {
  clearInterval(schedulerHandle);
  await logger.flush();
  server.close(() => process.exit(0));
}
```

---

## Build & Run

```bash
npm install
npm run build         # tsc + esbuild dashboard/main.ts --bundle --outfile=dashboard/main.js
npm start             # node dist/index.js
# dashboard at http://localhost:3000
```

### `package.json` scripts

```json
{
  "scripts": {
    "build": "tsc && esbuild dashboard/main.ts --bundle --outfile=dashboard/main.js",
    "start": "node dist/index.js",
    "dev": "tsx watch src/index.ts",
    "test": "vitest run"
  }
}
```

Dependencies: `express`. Dev dependencies: `typescript`, `tsx`, `esbuild`, `vitest`, `@types/express`, `@types/node`.

---

## Testing

`evaluator.ts` is a pure function with no I/O — it must have a corresponding `src/evaluator.test.ts`. Minimum test cases:

- Passes when all thresholds are met
- `FUNDING_NOT_POSITIVE` when rate is 0 or negative
- `FUNDING_BELOW_MINIMUM` when rate is positive but below `minFundingRate8h`
- `INSUFFICIENT_SPOT_DEPTH` / `INSUFFICIENT_PERP_DEPTH`
- `BASIS_TOO_STRETCHED`
- `SPREAD_TOO_WIDE` (spot spread exceeds threshold)
- `OI_UNWINDING` when oiTrend is "falling"
- `YIELD_BELOW_THRESHOLD` when net yield is below minimum
- Multiple flags returned when multiple conditions fail simultaneously

`ranker.ts` should also have tests verifying sort order and the 20-pair failing cap.

---

## Out of Scope for This Slice

- Paper trade simulator (Phase 2) — `paperTradeSizeUsd` is not in Phase 1 config
- Live order execution (Phase 3)
- WebSockets (polling every 10s is sufficient for a 60s scan interval)
- Any database (JSONL flat files only)
- Predicted next rate evaluation (collected and displayed, not used in pass/fail)
