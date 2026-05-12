# Slice 1 — Funding Rate Scanner + Web Dashboard
*Derived from three rounds of Claude + ChatGPT peer review (May 2026)*

---

## Goal

Answer one question with data, no opinions:

> Can we consistently find funding setups where expected funding income beats fees, spread, basis risk, and execution cost?

Phase 1 produces **a log file and a live dashboard**, not profit.

---

## What We Are Not Building Yet

- Live order execution
- Paper trade simulator (Phase 2)
- Authentication / API keys for private endpoints (all data is public in Phase 1)

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
      │  funding    │       │  funding    │
      │  spot/perp  │       │  spot/perp  │
      │  depth      │       │  depth      │
      └──────┬──────┘       └──────┬──────┘
             └──────────┬──────────┘
                        │
               ┌────────▼────────┐
               │  Fee Calculator │
               │  (fees.json)    │
               └────────┬────────┘
                        │
               ┌────────▼────────┐
               │  Opportunity    │
               │  Evaluator      │
               │  (pass/fail)    │
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
│   └── spec-1.md
├── src/
│   ├── index.ts              # entry point, starts scheduler + HTTP server
│   ├── types.ts              # all shared types
│   ├── config.ts             # loads fees.json + config.json, validates
│   ├── feeds/
│   │   ├── binance.ts        # Binance public REST adapter
│   │   └── okx.ts            # OKX public REST adapter
│   ├── evaluator.ts          # pass/fail logic, fee maths
│   ├── ranker.ts             # sorts passing + failing opportunities
│   ├── logger.ts             # appends JSONL scan records
│   ├── server.ts             # Express HTTP server, serves /snapshot + static
│   └── dashboard/
│       ├── index.html
│       ├── main.ts           # compiled to dashboard/main.js
│       └── style.css
├── logs/                     # gitignored, JSONL output lands here
├── fees.json                 # actual account fees (fill before first run)
├── config.json               # scanner thresholds
├── package.json
└── tsconfig.json
```

---

## Shared Types (`types.ts`)

```typescript
export type Exchange = "BINANCE" | "OKX";

export interface PairSnapshot {
  timestamp: string;          // ISO 8601
  exchange: Exchange;
  pair: string;               // e.g. "BTC-USDT"
  spotPrice: number;
  perpPrice: number;
  basisPct: number;           // (perp - spot) / spot * 100
  fundingRate8h: number;      // % per 8h cycle
  fundingRateAnnualised: number;
  nextFundingTime: string;    // ISO 8601
  predictedNextRate: number | null;
  spotSpreadPct: number;
  perpSpreadPct: number;
  spotDepth10bpsUsd: number;
  perpDepth10bpsUsd: number;
  oiTrend: "rising" | "falling" | "stable" | "unknown";
  entryFeeEst: number;        // % round-trip entry
  exitFeeEst: number;         // % round-trip exit
  roundTripFee: number;
  minCyclesToBreakeven: number;
  projectedYieldPerCycle: number;
  projectedNetYieldPerCycle: number;
  passes: boolean;
  flags: string[];
}

export interface ScanResult {
  scannedAt: string;
  totalPairs: number;
  passing: PairSnapshot[];
  failing: PairSnapshot[];
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
**Fill with your actual account fees before first run.** Wrong fees make the whole scanner hallucinate profit.

### `config.json`
```json
{
  "minSpotDepthUsd": 50000,
  "minPerpDepthUsd": 100000,
  "maxBasisPct": 0.5,
  "minHoldCycles": 6,
  "minNetYieldPerCycle": 0.01,
  "minFundingRate8h": 0.01,
  "scanIntervalSeconds": 60,
  "paperTradeSizeUsd": 1000
}
```
Start conservative — the scanner should mostly output NO. That is not a failure state.

---

## Exchange Adapters

Both adapters return the same `PairSnapshot[]` shape. All endpoints are public (no API keys needed in Phase 1).

### Binance (`feeds/binance.ts`)

| Data | Endpoint |
|---|---|
| All perp funding rates | `GET /fapi/v1/premiumIndex` |
| Spot best bid/ask | `GET /api/v3/bookTicker` |
| Perp order book | `GET /fapi/v1/depth?symbol=BTCUSDT&limit=20` |
| Spot order book | `GET /api/v3/depth?symbol=BTCUSDT&limit=20` |
| Open interest | `GET /fapi/v1/openInterest?symbol=BTCUSDT` |

Base URLs: `https://fapi.binance.com` (futures), `https://api.binance.com` (spot)

### OKX (`feeds/okx.ts`)

| Data | Endpoint |
|---|---|
| All perp funding rates | `GET /api/v5/public/funding-rate-summary?instType=SWAP` |
| All perp tickers | `GET /api/v5/market/tickers?instType=SWAP` |
| All spot tickers | `GET /api/v5/market/tickers?instType=SPOT` |
| Perp order book | `GET /api/v5/market/books?instId=BTC-USDT-SWAP&sz=20` |
| Spot order book | `GET /api/v5/market/books?instId=BTC-USDT&sz=20` |
| Open interest | `GET /api/v5/public/open-interest?instType=SWAP` |

Base URL: `https://www.okx.com`

**Note:** Fetch tickers and funding rates in bulk first (one call), then depth per qualifying pair only — avoid hitting rate limits.

---

## Pass/Fail Logic (`evaluator.ts`)

```typescript
// Hard rejections (any flag = FAIL)
FUNDING_NOT_POSITIVE       funding_rate_8h <= 0
INSUFFICIENT_SPOT_DEPTH    spotDepth10bpsUsd < config.minSpotDepthUsd
INSUFFICIENT_PERP_DEPTH    perpDepth10bpsUsd < config.minPerpDepthUsd
BASIS_TOO_STRETCHED        basisPct > config.maxBasisPct
OI_UNWINDING               oiTrend === "falling"
YIELD_BELOW_THRESHOLD      projectedNetYieldPerCycle < config.minNetYieldPerCycle

// Net yield calculation
netPerCycle = fundingRate8h - (roundTripFee / minHoldCycles)
```

---

## Logger (`logger.ts`)

Appends one JSON line per `PairSnapshot` to `logs/scans.jsonl` on every scan.
Also appends one summary line per `ScanResult` to `logs/summary.jsonl`.

---

## HTTP Server (`server.ts`)

| Route | Description |
|---|---|
| `GET /snapshot` | Returns latest `ScanResult` as JSON |
| `GET /` | Serves `dashboard/index.html` |
| `GET /main.js` | Serves compiled dashboard JS |

Port: `3000` (configurable via `PORT` env var).

---

## Web Dashboard (`dashboard/`)

Single-page app. No framework — plain TypeScript compiled to JS.

- Polls `GET /snapshot` every 10 seconds
- Shows scan metadata: timestamp, pairs scanned, passing count
- **Passing table**: rank, pair, exchange, rate/8h, net/cycle, basis, depth, flags
- **Failing table** (collapsed by default): top 10 by rate, with flag reasons
- Color coding: green = passes, red = flagged
- No build tool beyond `tsc` — just compile `dashboard/main.ts` → `dashboard/main.js`

---

## Build & Run

```bash
npm install
npm run build       # tsc
npm start           # node dist/index.js
# dashboard at http://localhost:3000
```

---

## Out of Scope for This Slice

- Paper trade simulator (Phase 2)
- Live order execution (Phase 3)
- Authentication / private API endpoints
- WebSockets (polling is sufficient for 60s scan interval)
- Any database (JSONL flat files only)
