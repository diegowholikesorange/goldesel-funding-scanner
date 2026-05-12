# Slice 1 — Funding Rate Scanner + Web Dashboard
## spec-4.md — adds OKX HMAC auth, integration tests, Makefile, README, TDD approach
*May 2026*

---

## Changes from spec-3

- `src/feeds/okx-auth.ts` — OKX HMAC signing (pure function, TDD first)
- Integration test layer — real API, separate vitest config, `make itest`
- Unit test approach — TDD (test first) for all pure functions
- Makefile — `install`, `clean`, `build`, `test`, `itest`
- README — setup, env vars, make commands
- **Correction:** Binance pass-1 gains a third call (`GET /fapi/v1/bookTicker`) for perp spread
- **Correction:** `computeOiTrend` accepts `number | null`; null guard skips map update
- **Correction:** `buildOkxAuthHeaders` accepts optional `timestamp` param for deterministic testing
- **Correction:** `.env.example` added to file structure
- **Correction:** `dev` target added to Makefile
- **Addition:** OKX HMAC test vectors computed and included inline

Everything else carries forward from spec-3 unchanged.

---

## Updated File Structure

```
slice1-funding-scanner/
├── doc/
├── src/
│   ├── index.ts
│   ├── types.ts
│   ├── config.ts
│   ├── state.ts
│   ├── feeds/
│   │   ├── binance.ts
│   │   ├── okx.ts
│   │   └── okx-auth.ts           # HMAC signing (pure, no I/O)
│   ├── evaluator.ts
│   ├── ranker.ts
│   ├── logger.ts
│   └── server.ts
├── src/__tests__/                 # unit tests (co-located is fine too)
│   ├── evaluator.test.ts
│   ├── ranker.test.ts
│   ├── state.test.ts
│   └── feeds/
│       ├── okx-auth.test.ts
│       ├── binance.integration.test.ts
│       └── okx.integration.test.ts
├── dashboard/
│   ├── index.html
│   ├── main.ts
│   └── style.css
├── logs/
├── .env                      # gitignored
├── .env.example              # committed; empty values, documents required vars
├── fees.json
├── config.json
├── Makefile
├── README.md
├── package.json
├── tsconfig.json
├── vitest.config.ts              # unit tests only (excludes *.integration.test.ts)
└── vitest.integration.config.ts  # integration tests only
```

---

## Corrections to spec-3

### Binance pass-1: perp spread source was missing

`/fapi/v1/premiumIndex` has no bid/ask fields — it carries mark price, index price, and funding rate only. Without a separate perp bid/ask call, `perpSpreadPct` is either always zero or a runtime error depending on implementation.

Fix: add a third bulk call to Binance pass-1.

**Binance pass-1 — three bulk calls (replaces the two-call table in spec-3):**

| Call | Endpoint | Data extracted |
|---|---|---|
| Perp tickers | `GET /fapi/v1/premiumIndex` | `markPrice`, `indexPrice`, `lastFundingRate`, `nextFundingTime` per symbol |
| Perp best bid/ask | `GET /fapi/v1/bookTicker` | `bidPrice`, `askPrice` per symbol → `perpSpreadPct` |
| Spot best bid/ask | `GET /api/v3/bookTicker` | `bidPrice`, `askPrice` per symbol → `spotSpreadPct` |

All three are single bulk calls (no symbol parameter). Join all three by normalised pair name; drop any symbol missing from any of the three responses.

### `computeOiTrend` null guard

`oiRaw` is `number | null` (the OI call may fail). The spec-3 signature accepted only `number`. Passing `null` would store `NaN` in `oiHistory` and corrupt every subsequent trend comparison for that pair.

Fix: updated signature and null guard (replaces the `state.ts` code block in spec-3):

```typescript
export function computeOiTrend(
  key: string,
  currentOi: number | null,   // null when OI fetch failed
  fallThresholdPct: number
): OiTrend {
  if (currentOi === null) return "unknown";  // do NOT update map; preserve last good value

  const prev = oiHistory.get(key);
  oiHistory.set(key, currentOi);
  if (prev === undefined) return "unknown";
  const changePct = ((currentOi - prev) / prev) * 100;
  if (changePct > 1) return "rising";
  if (changePct < -fallThresholdPct) return "falling";
  return "stable";
}
```

When `oiRaw` is null, the map retains the last known OI value. The next successful OI fetch computes trend against that value correctly.

---

## OKX HMAC Signing (`src/feeds/okx-auth.ts`)

OKX requires authenticated requests to be signed even for some read-only endpoints when using API keys. The signing logic is a pure function — no I/O, no side effects — making it the ideal first TDD target in this codebase.

### Signature algorithm

```
message   = timestamp + METHOD + requestPath + body
signature = Base64(HMAC-SHA256(message, apiSecret))
timestamp = ISO 8601 UTC (e.g. "2026-05-12T10:00:00.000Z")
body      = "" for GET requests
```

### Module interface

```typescript
// src/feeds/okx-auth.ts
import { createHmac } from "crypto";

export function signOkxRequest(params: {
  apiSecret: string;
  timestamp: string;   // ISO 8601 UTC
  method: "GET" | "POST";
  path: string;        // e.g. "/api/v5/market/tickers?instType=SWAP"
  body?: string;       // default ""
}): string {
  const { apiSecret, timestamp, method, path, body = "" } = params;
  const message = timestamp + method + path + body;
  return createHmac("sha256", apiSecret).update(message).digest("base64");
}

export function buildOkxAuthHeaders(params: {
  apiKey: string;
  apiSecret: string;
  passphrase: string;
  method: "GET" | "POST";
  path: string;
  body?: string;
  timestamp?: string;          // injectable for deterministic tests; defaults to now
}): Record<string, string> {
  const timestamp = params.timestamp ?? new Date().toISOString();
  const sign = signOkxRequest({ ...params, timestamp });
  return {
    "OK-ACCESS-KEY": params.apiKey,
    "OK-ACCESS-SIGN": sign,
    "OK-ACCESS-TIMESTAMP": timestamp,
    "OK-ACCESS-PASSPHRASE": params.passphrase,
    "Content-Type": "application/json",
  };
}
```

`buildOkxAuthHeaders` is called by `okx.ts` when `OKX_KEY` is present in env. When keys are absent, the adapter sends unauthenticated requests (public rate limits apply).

---

## Unit Tests — TDD Approach

Write the test file first, run it (red), implement to pass (green), refactor. Order of implementation driven by dependency graph: pure leaf modules first.

### TDD sequence

```
1. okx-auth.test.ts      → okx-auth.ts        (pure crypto, no deps)
2. state.test.ts         → state.ts            (pure map logic)
3. evaluator.test.ts     → evaluator.ts        (pure pass/fail)
4. ranker.test.ts        → ranker.ts           (pure sort + cap)
```

Feed adapters and server are not unit-tested — they are covered by integration tests and manual verification respectively.

### `okx-auth.test.ts` — required cases

Test vectors (computed with Node `crypto` — use directly in tests, no lookup needed):

```
secret:    "test-secret-key"
timestamp: "2020-12-08T09:08:57.715Z"

GET vector
  method:    "GET"
  path:      "/api/v5/account/balance?ccy=BTC"
  body:      ""
  message:   "2020-12-08T09:08:57.715ZGET/api/v5/account/balance?ccy=BTC"
  signature: "aCsBgsrAUQSCOQRSWb0FS4QZu/1RLrWcurndoXOEp+w="

POST vector
  method:    "POST"
  path:      "/api/v5/trade/order"
  body:      '{"ccy":"BTC"}'
  message:   '2020-12-08T09:08:57.715ZPOST/api/v5/trade/order{"ccy":"BTC"}'
  signature: "mwrW1sOmIR2/LNAUgOM4IltlTM6NZHCuZ9/ohLomd1k="
```

Test cases:
- `signOkxRequest` with GET vector inputs produces `"aCsBgsrAUQSCOQRSWb0FS4QZu/1RLrWcurndoXOEp+w="`
- `signOkxRequest` with POST vector inputs produces `"mwrW1sOmIR2/LNAUgOM4IltlTM6NZHCuZ9/ohLomd1k="`
- `buildOkxAuthHeaders` with injected `timestamp` returns deterministic `OK-ACCESS-SIGN` matching GET vector
- `buildOkxAuthHeaders` returns all four required OKX headers: `OK-ACCESS-KEY`, `OK-ACCESS-SIGN`, `OK-ACCESS-TIMESTAMP`, `OK-ACCESS-PASSPHRASE`
- `OK-ACCESS-TIMESTAMP` in returned headers is a valid ISO 8601 string

### `state.test.ts` — required cases

- First call for a new key returns `"unknown"`
- `null` input returns `"unknown"` and does NOT update the map (subsequent non-null call still computes trend against last good value)
- OI increase > 1% returns `"rising"`
- OI decrease beyond threshold returns `"falling"`
- OI change within bounds returns `"stable"`
- `"falling"` threshold uses `oiFallThresholdPct` config, not a hardcoded value
- Multiple keys are tracked independently

### `evaluator.test.ts` — required cases (from spec-3, carried forward)

- Passes when all thresholds are met
- `FUNDING_NOT_POSITIVE` when rate ≤ 0; `FUNDING_BELOW_MINIMUM` is NOT also raised
- `FUNDING_BELOW_MINIMUM` when `0 < rate < minFundingRate8h`; `FUNDING_NOT_POSITIVE` is NOT raised
- `INSUFFICIENT_SPOT_DEPTH`
- `INSUFFICIENT_PERP_DEPTH`
- `BASIS_TOO_STRETCHED`
- `SPREAD_TOO_WIDE` on spot spread
- `SPREAD_TOO_WIDE` on perp spread
- `OI_UNWINDING` when `oiTrend === "falling"`
- `YIELD_BELOW_THRESHOLD`
- Multiple flags returned simultaneously
- `minCyclesToBreakeven` is never `Infinity` (funding guard fires first)

### `ranker.test.ts` — required cases (from spec-3, carried forward)

- Passing pairs sorted descending by `projectedNetYieldPerCycle`
- Failing pairs sorted descending by `fundingRate8h`
- Failing array capped at 20 when input has > 20 entries
- Passing array is not capped

---

## Integration Tests

Integration tests call the real Binance and OKX APIs. They are not mocked, not fast, and must not run in CI by default.

### When to run

- Manually before first deploy: `make itest`
- After any change to a feed adapter
- Periodically to catch API schema drift (monthly is sufficient)

### What they verify

- The adapter returns a non-empty `PreFilterSnapshot[]` (pass 1 succeeds)
- A sample of pairs survive to `PairSnapshot[]` (pass 2 succeeds)
- All required fields are present and correctly typed (no `undefined`, no `NaN`)
- `fundingRate8h` is a number (not a string — exchange APIs sometimes return numeric strings)
- `nextFundingTime` parses as a valid ISO 8601 date
- `oiRaw` is a positive number (USD value, not contracts)
- Canonical pair format matches `^[A-Z]+-[A-Z]+$`

### `binance.integration.test.ts` structure

```typescript
// Requires no env vars — Binance pass-1 endpoints are fully public
describe("Binance feed — integration", () => {
  it("returns pre-filter snapshots for BTC-USDT and ETH-USDT", async () => { ... });
  it("all fundingRate8h values are numbers", async () => { ... });
  it("all pair names match canonical format", async () => { ... });
  it("pass-2 depth fetch returns valid depth for BTC-USDT", async () => { ... });
});
```

### `okx.integration.test.ts` structure

```typescript
// Pass-1 public; pass-2 OI call works without auth (public endpoint)
// HMAC signing tested on a lightweight authenticated endpoint if OKX_KEY is set
describe("OKX feed — integration", () => {
  it("returns pre-filter snapshots for BTC-USDT and ETH-USDT", async () => { ... });
  it("fundingRate is current-period (not lastFundingRate)", async () => { ... });
  it("predictedNextRate is non-null for at least some pairs", async () => { ... });
  it("pass-2 depth and OI fetch returns valid data for BTC-USDT", async () => { ... });

  describe("HMAC auth", () => {
    // Skipped if OKX_KEY not set
    it("authenticated request returns 200 with valid signature", async () => { ... });
    it("request with wrong signature returns 401", async () => { ... });
  });
});
```

### Vitest configs

**`vitest.config.ts`** (unit tests, no network):
```typescript
import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    exclude: ["**/*.integration.test.ts", "node_modules/**"],
  },
});
```

**`vitest.integration.config.ts`** (integration tests only):
```typescript
import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["**/*.integration.test.ts"],
    testTimeout: 15000,   // exchange calls can be slow
  },
});
```

---

## Makefile

```makefile
.PHONY: install clean build dev utest itest

install:
	npm install

clean:
	rm -rf dist dashboard/main.js

build: install
	npm run build

dev:
	npm run dev

utest:
	npm run utest

itest:
	npm run itest
```

`clean` does not remove `logs/` — log files are data, not build artefacts.

---

## README

The README covers everything needed to go from a fresh clone to a running scanner.

### Sections

1. **What this is** — one paragraph: funding rate scanner for Binance and OKX perpetuals, Phase 1 of a cash-and-carry experiment. No live trading. See `doc/spec-4.md` for full design.

2. **Prerequisites** — Node 20+, npm

3. **Setup**
   ```
   cp .env.example .env     # fill in API keys (optional but recommended)
   # edit fees.json with your actual account fees
   make install
   make build
   ```

4. **Environment variables** — table:

   | Variable | Required | Description |
   |---|---|---|
   | `BINANCE_KEY` | No | Read-only key; improves rate limits |
   | `BINANCE_SECRET` | No | Required if key is set |
   | `OKX_KEY` | No | Read-only key; required for HMAC auth |
   | `OKX_SECRET` | No | Required if key is set |
   | `OKX_PASSPHRASE` | No | Required if key is set |
   | `PORT` | No | Dashboard port (default: 3000) |

5. **Running**
   ```
   npm start           # production
   make dev            # tsx watch (resets OI state on file save)
   ```
   Dashboard at `http://localhost:3000`.

6. **Make commands**

   | Command | Description |
   |---|---|
   | `make install` | Install dependencies |
   | `make build` | Compile TypeScript + bundle dashboard |
   | `make clean` | Remove compiled output |
   | `make dev` | Run with tsx watch (dev mode) |
   | `make utest` | Run unit tests (no network) |
   | `make itest` | Run integration tests (hits real APIs, requires .env) |

7. **Fees** — short warning: wrong fees in `fees.json` produce wrong scan results. Log into each exchange and verify your actual tier before running.

8. **Logs** — `logs/scans.jsonl` (one record per pair per scan), `logs/summary.jsonl` (one record per scan cycle). Both are gitignored.

9. **Limitations** — Binance funding rates are 1 period lagged (previous settlement, not current accruing). See dashboard footnote.

---

## Updated `package.json` scripts

```json
{
  "scripts": {
    "build": "tsc && esbuild dashboard/main.ts --bundle --outfile=dashboard/main.js",
    "start": "node dist/index.js",
    "dev": "tsx watch src/index.ts",
    "utest": "vitest run --config vitest.config.ts",
    "itest": "vitest run --config vitest.integration.config.ts --reporter=verbose"
  }
}
```

Runtime dependencies: `express`, `dotenv`.
Dev dependencies: `typescript`, `tsx`, `esbuild`, `vitest`, `@types/express`, `@types/node`.

No test-specific dependencies needed — `crypto` is a Node built-in.
