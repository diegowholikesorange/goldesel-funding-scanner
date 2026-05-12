# Slice 1 — Funding Rate Scanner + Web Dashboard
## spec-3.md — revised after spec-2 review
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
- Terminal output (dropped in favour of web dashboard; stderr for errors only)

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
      │  pass 1:    │       │  pass 1:    │
      │  bulk tick  │       │  bulk tick  │
      │  pass 2:    │       │  pass 2:    │
      │  depth + OI │       │  depth + OI │
      └──────┬──────┘       └──────┬──────┘
             └──────────┬──────────┘
                        │
               ┌────────▼────────┐
               │   state.ts      │
               │  OI prev map    │
               └────────┬────────┘
                        │
               ┌────────▼────────┐
               │  Evaluator      │
               │  (fee formula   │
               │  + pass/fail)   │
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
├── src/
│   ├── index.ts              # entry point: scheduler + HTTP server + shutdown
│   ├── types.ts              # all shared types and union types
│   ├── config.ts             # loads + validates fees.json and config.json
│   ├── state.ts              # OI history map, updated each scan cycle
│   ├── feeds/
│   │   ├── binance.ts        # Binance public REST adapter (two-pass)
│   │   └── okx.ts            # OKX public REST adapter (two-pass)
│   ├── evaluator.ts          # pass/fail logic + fee formula (pure function)
│   ├── ranker.ts             # sort passing/failing; applies failing cap
│   ├── logger.ts             # JSONL writer; owns logs/ creation
│   └── server.ts             # Express: /snapshot + static dashboard/
├── dashboard/
│   ├── index.html
│   ├── main.ts               # bundled by esbuild → main.js
│   └── style.css
├── logs/                     # gitignored; created at startup by logger.ts
├── .env                      # gitignored; API keys
├── fees.json
├── config.json
├── package.json
└── tsconfig.json
```

---

## Environment Variables (`.env`)

Read-only API keys improve rate limits on authenticated tiers. They are optional — all Phase 1 endpoints are public — but should be set before running at scale.

```
BINANCE_API_KEY=
BINANCE_API_SECRET=
OKX_API_KEY=
OKX_API_SECRET=
OKX_PASSPHRASE=
PORT=3000
```

Loaded via `dotenv` at startup in `index.ts`. Feeds read `process.env.BINANCE_API_KEY` etc. and attach as request headers when present. When absent, requests proceed unauthenticated (public rate limits apply).

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

// Pass-1 shape: no depth or OI fields (fetched only for pairs that survive pre-filter)
export interface PreFilterSnapshot {
  exchange: Exchange;
  pair: string;               // canonical: "BTC-USDT"
  spotPrice: number;          // see price sources below
  perpPrice: number;
  basisPct: number;
  fundingRate8h: number;      // see rate source notes below
  nextFundingTime: string;    // ISO 8601
  predictedNextRate: number | null;
  spotSpreadPct: number;
  perpSpreadPct: number;
}

// Pass-2 shape: depth + OI added after pre-filter
export interface PairSnapshot extends PreFilterSnapshot {
  timestamp: string;          // ISO 8601, set at scan time
  fundingRateAnnualised: number;
  spotDepth10bpsUsd: number;
  perpDepth10bpsUsd: number;
  oiRaw: number | null;       // USD value; used by state.ts to compute trend
  oiTrend: OiTrend;
  entryFeeEst: number;
  exitFeeEst: number;
  roundTripFee: number;
  minCyclesToBreakeven: number;
  projectedYieldPerCycle: number;
  projectedNetYieldPerCycle: number;
  passes: boolean;
  flags: Flag[];
}

export interface ScanResult {
  scannedAt: string;
  totalPairs: number;
  passing: PairSnapshot[];
  failing: PairSnapshot[];    // top 20 by fundingRate8h; cap applied by ranker.ts
  errors: ExchangeError[];
}

export interface ExchangeError {
  exchange: Exchange;
  message: string;
  timestamp: string;
}

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
  oiFallThresholdPct: number;
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
**Fill with your actual account fees before first run.**

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

---

## Price Sources and Known Asymmetries

### Binance

| Field | Source | Endpoint | Notes |
|---|---|---|---|
| `spotPrice` | `bidPrice`/`askPrice` midpoint | `/api/v3/bookTicker` | Tradeable spot price |
| `perpPrice` | `markPrice` | `/fapi/v1/premiumIndex` | Smoothed; used for PnL and funding |
| `basisPct` | `(markPrice - indexPrice) / indexPrice * 100` | same | `indexPrice` is the spot index Binance tracks for funding |
| `fundingRate8h` | `lastFundingRate` | `/fapi/v1/premiumIndex` | **Lagged: this is the rate that settled at the previous 8h mark, not the currently accruing rate.** Binance has no public bulk endpoint for the current-period accruing rate. Binance rates are therefore 1 period behind OKX rates in the scanner. Document this caveat in the dashboard. |
| `predictedNextRate` | not available | — | Always `null` for Binance pairs. Expected and correct; the dashboard must not treat this as a bug. |

Using `markPrice` for `perpPrice` rather than the last traded price means basis appears more stable than it would at execution. This is acceptable for Phase 1 screening; Phase 2 should revisit if it matters for PnL simulation.

### OKX

| Field | Source | Endpoint | Notes |
|---|---|---|---|
| `spotPrice` | `bidPx`/`askPx` midpoint | `/api/v5/market/tickers?instType=SPOT` | |
| `perpPrice` | `last` | `/api/v5/market/tickers?instType=SWAP` | Last traded price |
| `basisPct` | `(perpPrice - spotPrice) / spotPrice * 100` | | |
| `fundingRate8h` | `fundingRate` | `/api/v5/market/tickers?instType=SWAP` | **Current-period accruing rate.** Different semantic from Binance. |
| `predictedNextRate` | `nextFundingRate` | `/api/v5/market/tickers?instType=SWAP` | Available; show in dashboard. |

---

## Exchange Adapters

All endpoints are public. API keys (from env) are attached as headers when present for rate limit headroom.

### Binance (`feeds/binance.ts`)

**Pass 1 — two bulk calls:**

| Call | Endpoint | Data extracted |
|---|---|---|
| Perp tickers | `GET /fapi/v1/premiumIndex` | `markPrice`, `indexPrice`, `lastFundingRate`, `nextFundingTime` per symbol |
| Spot best bid/ask | `GET /api/v3/bookTicker` | `bidPrice`, `askPrice` per symbol |

Filter `/fapi/v1/premiumIndex` results to `contractType === "PERPETUAL"` (excludes quarterly contracts and coin-margined `/dapi/` instruments). Inner-join perp symbols with spot symbols by normalised pair name; silently drop any perp with no matching spot entry.

**Pass 2 — per qualifying pair:**

| Call | Endpoint |
|---|---|
| Perp order book | `GET /fapi/v1/depth?symbol=BTCUSDT&limit=20` |
| Spot order book | `GET /api/v3/depth?symbol=BTCUSDT&limit=20` |
| Open interest | `GET /fapi/v1/openInterest?symbol=BTCUSDT` |

`oiRaw` = `openInterest` (contracts) × `markPrice` (USD). Store as USD value.

Base URLs: `https://fapi.binance.com` (futures), `https://api.binance.com` (spot).

### OKX (`feeds/okx.ts`)

**Pass 1 — two bulk calls:**

| Call | Endpoint | Data extracted |
|---|---|---|
| SWAP tickers | `GET /api/v5/market/tickers?instType=SWAP` | `last`, `fundingRate`, `nextFundingTime`, `nextFundingRate`, `bidPx`, `askPx` per instrument |
| SPOT tickers | `GET /api/v5/market/tickers?instType=SPOT` | `bidPx`, `askPx` per instrument |

**Pass 2 — per qualifying pair:**

| Call | Endpoint |
|---|---|
| Perp order book | `GET /api/v5/market/books?instId=BTC-USDT-SWAP&sz=20` |
| Spot order book | `GET /api/v5/market/books?instId=BTC-USDT&sz=20` |
| Open interest | `GET /api/v5/public/open-interest?instType=SWAP&instId=BTC-USDT-SWAP` |

`oiRaw` = `oiCcy` field (USD value). This matches the Binance USD unit for cross-exchange comparability.

Base URL: `https://www.okx.com`.

### Canonical Pair Normalisation

Applied in each adapter before any downstream processing:

- OKX: `BTC-USDT-SWAP` → strip `-SWAP` → `BTC-USDT`
- Binance: `BTCUSDT` → insert hyphen before known quote assets (`USDT`, `BUSD`, `BTC`, `ETH`, `BNB`) → `BTC-USDT`

### Request Policy

- All `fetch` calls use a 5-second `AbortController` timeout.
- On timeout or non-2xx: throw `ExchangeError`. Caller (feed) catches it, returns `{ snapshots: [], error: ExchangeError }`. Scheduler adds the error to `ScanResult.errors`; that exchange's pairs are absent this cycle.
- No retry within a cycle — the next 60s cycle is the natural retry.
- All exchange timestamps (millisecond Unix integers or strings) are converted to ISO 8601 strings by the adapter before returning.

---

## Two-Pass Flow

**Pass 1 pre-filter criteria** (applied to `PreFilterSnapshot`):

```
fundingRate8h > 0
AND basisPct <= config.maxBasisPct
AND spotSpreadPct <= config.maxSpreadPct
AND perpSpreadPct <= config.maxSpreadPct
```

Both spread fields are checked in pass 1 so that wide-spread pairs never trigger depth calls.

**Pass 2** runs only for pairs that pass the pre-filter.

**Known limitation:** pairs that fail pass 1 in a given cycle do not update their OI history in `state.ts`. If a pair oscillates in and out of the pre-filter, its OI baseline becomes stale. When it re-enters, the OI trend comparison is against an old value and may produce a false `OI_UNWINDING` or mask a real one. This is an accepted trade-off of the two-pass design in Phase 1.

---

## OI State Management (`state.ts`)

```typescript
// Keyed by "BINANCE:BTC-USDT" or "OKX:BTC-USDT"
// Entries are never pruned — acceptable memory cost for Phase 1 pair counts (~200 keys)
const oiHistory = new Map<string, number>();

export function computeOiTrend(
  key: string,
  currentOi: number,
  fallThresholdPct: number
): OiTrend {
  const prev = oiHistory.get(key);
  oiHistory.set(key, currentOi);
  if (prev === undefined) return "unknown";  // first scan for this pair
  const changePct = ((currentOi - prev) / prev) * 100;
  if (changePct > 1) return "rising";
  if (changePct < -fallThresholdPct) return "falling";  // triggers OI_UNWINDING
  return "stable";
}
```

Note: in `dev` mode (`tsx watch`), every file save restarts the process and clears `oiHistory`. All pairs will show `"unknown"` for one cycle after a reload. This is expected.

---

## Fee Formula (`evaluator.ts`)

```
entry fee = spotTaker + futuresMaker     (taker buy spot, maker limit short perp)
exit fee  = spotTaker + futuresTaker     (taker sell spot, market close perp)
roundTripFee = entryFee + exitFee

// Only computed after FUNDING_NOT_POSITIVE guard — fundingRate8h > 0 guaranteed here
minCyclesToBreakeven = Math.ceil(roundTripFee / fundingRate8h)

projectedYieldPerCycle = fundingRate8h
projectedNetYieldPerCycle = fundingRate8h - (roundTripFee / minHoldCycles)
```

---

## Pass/Fail Logic (`evaluator.ts`)

Pure function: `(snapshot: PairSnapshot, config: AppConfig) => { passes: boolean; flags: Flag[] }`.

Flags are mutually exclusive where noted. Hard rejections — any flag = FAIL:

```
FUNDING_NOT_POSITIVE    fundingRate8h <= 0
FUNDING_BELOW_MINIMUM   fundingRate8h > 0 && fundingRate8h < config.minFundingRate8h
                        (mutually exclusive with FUNDING_NOT_POSITIVE)
INSUFFICIENT_SPOT_DEPTH spotDepth10bpsUsd < config.minSpotDepthUsd
INSUFFICIENT_PERP_DEPTH perpDepth10bpsUsd < config.minPerpDepthUsd
BASIS_TOO_STRETCHED     basisPct > config.maxBasisPct
SPREAD_TOO_WIDE         spotSpreadPct > config.maxSpreadPct
                        OR perpSpreadPct > config.maxSpreadPct
OI_UNWINDING            oiTrend === "falling"
YIELD_BELOW_THRESHOLD   projectedNetYieldPerCycle < config.minNetYieldPerCycle
```

Evaluation order: compute `FUNDING_NOT_POSITIVE` first. If set, skip `minCyclesToBreakeven` and `projectedNetYieldPerCycle` computation (avoids division-by-zero). Continue checking all other flags regardless — multiple flags are informative.

---

## Ranker (`ranker.ts`)

- Passing pairs: sorted descending by `projectedNetYieldPerCycle`
- Failing pairs: sorted descending by `fundingRate8h`; **capped at 20 entries** by `ranker.ts` before returning `ScanResult` (not by the server or logger)

---

## Logger (`src/logger.ts`)

Creates `logs/` directory on first call (`fs.mkdirSync("logs", { recursive: true })`).

Exported interface:

```typescript
export function log(snapshot: PairSnapshot): void;
export function logSummary(result: ScanResult): void;
export async function flush(): Promise<void>;
```

- `log()` appends one JSON line to `logs/scans.jsonl`
- `logSummary()` appends one JSON line to `logs/summary.jsonl`
- `flush()` drains any pending writes and closes file handles; called during shutdown

---

## HTTP Server (`src/server.ts`)

```typescript
import path from "path";

const DASHBOARD_DIR = path.resolve(__dirname, "../dashboard");
app.use(express.static(DASHBOARD_DIR));
app.get("/snapshot", (_req, res) => res.json(latestScanResult));
```

`express.static` serves `index.html`, `main.js`, and `style.css` from `dashboard/`. No individual route needed per file.

Port: `3000` (override with `PORT` env var). On `EADDRINUSE`: log clear error and `process.exit(1)`.

---

## Graceful Shutdown (`src/index.ts`)

```typescript
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

async function shutdown(): Promise<void> {
  clearInterval(schedulerHandle);
  await logger.flush();
  server.close(() => process.exit(0));
}
```

---

## Web Dashboard (`dashboard/`)

Single-page TypeScript app. Types are duplicated from `src/types.ts` directly in `dashboard/main.ts`.
Add this comment at the top of the duplicated block:

```typescript
// Duplicated from src/types.ts — keep in sync manually; no build-time check enforces this.
```

**Behaviour:**

- Polls `GET /snapshot` every 10 seconds
- Updates a "last updated N seconds ago" counter every second
- Shows: scan timestamp, pairs scanned, passing count, exchange error banners
- **Exchange error banner**: one dismissible banner per entry in `ScanResult.errors`, e.g. "OKX unavailable this cycle — results may be incomplete"
- **Binance rate caveat**: a persistent footnote on all Binance rows: "Rate shown is previous-period (1 cycle lagged). No current-period bulk endpoint is available."
- **Passing table**: rank, pair, exchange, rate/8h, annualised %, net/cycle, basis, predicted next rate (blank for Binance — expected), flags
- **Failing table**: collapsed by default, toggle to expand; top 20 by rate with flag reasons
- **Row colours**: green = passes; amber = 1 flag; red = 2+ flags
- **Staleness warning**: if last scan timestamp is >90s old, show a banner "Scanner may have stalled — last update was N seconds ago"
- **Pre-first-scan state**: show "Waiting for first scan…" if `/snapshot` returns 404 or empty

---

## Build & Run

```bash
npm install
npm run build    # tsc && esbuild dashboard/main.ts --bundle --outfile=dashboard/main.js
npm start        # node dist/index.js
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

Runtime dependencies: `express`, `dotenv`.
Dev dependencies: `typescript`, `tsx`, `esbuild`, `vitest`, `@types/express`, `@types/node`.

---

## Testing (`src/evaluator.test.ts`, `src/ranker.test.ts`)

`evaluator.ts` is a pure function — no mocks needed. Required test cases:

- Passes when all thresholds are met
- `FUNDING_NOT_POSITIVE` when rate ≤ 0; `FUNDING_BELOW_MINIMUM` NOT also raised
- `FUNDING_BELOW_MINIMUM` when `0 < rate < minFundingRate8h`; `FUNDING_NOT_POSITIVE` NOT raised
- `INSUFFICIENT_SPOT_DEPTH`
- `INSUFFICIENT_PERP_DEPTH`
- `BASIS_TOO_STRETCHED`
- `SPREAD_TOO_WIDE` on spot spread
- `SPREAD_TOO_WIDE` on perp spread
- `OI_UNWINDING` when `oiTrend === "falling"`
- `YIELD_BELOW_THRESHOLD`
- Multiple flags returned simultaneously when multiple conditions fail
- `minCyclesToBreakeven` is not `Infinity` when rate is 0 (guard is in place)

`ranker.ts` required cases:

- Passing pairs sorted descending by `projectedNetYieldPerCycle`
- Failing pairs sorted descending by `fundingRate8h`
- Failing array capped at 20 when input has >20 entries

---

## Out of Scope for This Slice

- Paper trade simulator (Phase 2)
- Live order execution (Phase 3)
- WebSockets (10s polling sufficient for 60s scan interval)
- Any database (JSONL flat files only)
- `predictedNextRate` used in pass/fail (collected and displayed only)
- Current-period accruing rate for Binance (no public bulk endpoint exists)
