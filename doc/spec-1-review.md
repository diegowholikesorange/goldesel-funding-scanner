# spec-1.md — Technical Review
*Reviewed against round4-next-steps docs (Claude + ChatGPT analyses), May 2026*

---

## Summary

The spec is well-scoped and the architecture diagram is correct at the macro level. The data shape is solid and the pass/fail logic is clean. However, there are **six substantive flaws** that will cause bugs or incorrect results in production, plus a cluster of gaps around resilience, type safety, and testability that will make the code hard to maintain.

Verdict: **revise before implementation**. The issues below are not decoration — several will produce wrong scan results.

---

## 1. Substantive Flaws (Will Cause Wrong Behaviour)

### 1.1 `minFundingRate8h` config is dead code

`config.json` defines `minFundingRate8h: 0.01` but `evaluator.ts` only checks `funding_rate_8h <= 0`. Any rate between 0 and 0.01% passes the funding check silently. Either remove the config key or add:

```typescript
if (snapshot.fundingRate8h < config.minFundingRate8h) flags.push("FUNDING_BELOW_MINIMUM");
```

The round4 plan (`claude-first_experiment_plan.md`) and `chatgpt-funding_scanner_first_experiment.md` both describe the filter as "projected funding > entry fees + exit fees + safety buffer" — not just "greater than zero". The spec's evaluator is weaker than what both source documents require.

### 1.2 OI trend flag uses wrong discriminant

The spec defines `OI_UNWINDING: oiTrend === "falling"` but the round4 reference implementation uses `"falling_fast"`. The PairSnapshot type allows `"falling" | "stable" | "rising" | "unknown"` — it does not include `"falling_fast"`. One of these is wrong. If the evaluator rejects on plain `"falling"`, any minor OI dip triggers rejection and the scanner will be too conservative. The intent from the source docs is to catch rapid unwinding, not normal ebb.

**Decision required:** define the discriminant values and stick to one set.

### 1.3 OI trend computation has no specified state store

Computing whether OI is `rising`/`falling`/`stable` requires comparing the current value to a prior reading. The spec provides no mechanism for this:

- No in-memory state structure defined
- No mention of which component owns this state
- The JSONL logs are append-only and not queried at runtime

On the first scan, every pair will be `"unknown"`. On subsequent scans, something must hold the previous OI value. This is an architectural gap. The feeds return a raw OI figure; something upstream must diff it. Suggest: a module-level `Map<string, number>` keyed by `${exchange}:${pair}` updated each cycle, owned by `index.ts` or a new `state.ts` module.

### 1.4 OKX bulk funding rate endpoint is likely wrong

The spec lists:
```
GET /api/v5/public/funding-rate-summary?instType=SWAP
```
This endpoint does not appear in OKX's public API documentation. The correct bulk approach is:
- `/api/v5/public/funding-rate?instId=BTC-USDT-SWAP` — per-instrument (requires looping)
- There is no officially documented single-call bulk endpoint for all SWAP funding rates

The practical workaround is to first fetch all SWAP instrument IDs via `/api/v5/public/instruments?instType=SWAP`, then batch funding rate calls. Alternatively, some traders use `/api/v5/market/tickers?instType=SWAP` which returns `fundingRate` and `nextFundingTime` as ticker fields — this is a legitimate single bulk call and is already listed in the spec's ticker row. Verify which endpoint actually returns funding rate data before implementation, or the OKX feed will silently return nothing.

### 1.5 Two-pass depth fetching is not architecturally specified

The spec's OKX note says: *"Fetch tickers and funding rates in bulk first (one call), then depth per qualifying pair only."* This implies a two-pass evaluation:

1. Fetch all tickers + funding rates → pre-filter by rate and basis
2. Fetch depth only for pairs that pass pre-filter → apply depth checks

But `evaluator.ts` is shown as a single-pass function taking a fully-populated `PairSnapshot`. That means depth must be fetched for all pairs, defeating the optimisation. The spec needs to either:

- Define a `PartialSnapshot` type for pre-filter (no depth fields), or
- Document explicitly that depth is fetched for all pairs (and accept the rate-limit cost), or
- Define a two-stage evaluation function

This gap means developers will either break the rate-limit safety or implement an undocumented design.

### 1.6 Dashboard TypeScript compilation will not work as specified

`dashboard/main.ts` needs to import `PairSnapshot` and `ScanResult` from `src/types.ts`. The spec says "no build tool beyond `tsc`" and that `main.ts` compiles to `main.js`. Plain `tsc` does not bundle — it produces one `.js` file per `.ts` file with `import` statements intact. Browser JS cannot resolve Node-style `../src/types` imports.

Options:
- Duplicate the relevant types in `dashboard/main.ts` (simple, acceptable for this phase)
- Add a bundler step (e.g., `esbuild` — single binary, zero config, fast)
- Use `tsc` with `"module": "es2020"` and serve as ES modules from the same origin (works but fragile)

The spec must pick one. "Compile with tsc" as written will produce a file the browser cannot run.

---

## 2. Missing Resilience (Will Cause Silent Failures)

### 2.1 No error handling strategy for feed failures

If Binance returns a 429 or OKX times out mid-scan, the spec does not define:

- Whether to skip the exchange and log partial results or abort the whole scan
- Whether to retry, and if so how many times with what backoff
- Whether `ScanResult` should carry an `errors` field

Without this, a transient network issue causes an unhandled exception that crashes the scheduler. Define a per-feed failure policy: recommended is "log the error, mark the exchange's pairs as unavailable for this cycle, continue with available data."

### 2.2 No HTTP request timeouts

REST calls to exchange APIs have no timeout specified. A hung connection will block the scheduler indefinitely. All `fetch` / `axios` calls must carry explicit timeouts (suggest 5s).

### 2.3 No graceful shutdown

No `SIGTERM`/`SIGINT` handling. If the process is killed mid-write to a JSONL file, the last line may be malformed. The logger should flush and close file handles on shutdown.

---

## 3. Type Safety Gaps

### 3.1 `flags: string[]` loses compile-time safety

The evaluator appends string literals to `flags`. This is stringly-typed. Define a union type:

```typescript
export type Flag =
  | "FUNDING_NOT_POSITIVE"
  | "FUNDING_BELOW_MINIMUM"
  | "INSUFFICIENT_SPOT_DEPTH"
  | "INSUFFICIENT_PERP_DEPTH"
  | "BASIS_TOO_STRETCHED"
  | "OI_UNWINDING"
  | "YIELD_BELOW_THRESHOLD";
```

Then `PairSnapshot.flags: Flag[]`. Typos become compile errors instead of silent wrong results.

### 3.2 Pair normalisation is unspecified

OKX uses `BTC-USDT-SWAP` instrument IDs, Binance uses `BTCUSDT`. The `PairSnapshot.pair` field is shown as `"BTC-USDT"` (canonical). The normalisation logic — stripping `-SWAP`, inserting hyphens — is not assigned to any module. Both adapters must agree on the canonical format or cross-exchange deduplication and dashboard display will be inconsistent.

### 3.3 Config type is not defined

`config.ts` loads and validates `fees.json` and `config.json` but no TypeScript type for the merged config is defined in `types.ts`. Without this, every consumer of config gets `any`. Add:

```typescript
export interface FeeConfig { ... }
export interface ScanConfig { ... }
export interface AppConfig { fees: FeeConfig; scan: ScanConfig; }
```

---

## 4. Architectural Issues

### 4.1 `ranker.ts` is unspecified

The file appears in the file structure and the dashboard shows a `rank` column, but the spec contains no description of ranking logic. Questions left open:

- Ranked by `projectedNetYieldPerCycle`? `fundingRateAnnualised`? `fundingRate8h`?
- Are passing and failing pairs ranked on the same scale or separately?
- Does rank change between scans, and does the dashboard show movement?

This is a functional gap. The spec must define the sort key(s).

### 4.2 `entryFeeEst` / `exitFeeEst` computation not specified

The spec defines these fields and their fee structure in `fees.json`, but never specifies the formula. The round4 reference shows `entry_fee_est: 0.04` described as "spot maker + perp maker, both sides." For Binance non-VIP that would be `0.001 + 0.0002 = 0.0012` (0.12%), not 0.04%. The example data in the round4 doc appears to be placeholder, not real.

The spec needs to state explicitly: is entry fee spot-taker + perp-maker (aggressive spot, passive perp) or some other combination? This directly affects every yield calculation.

### 4.3 `paperTradeSizeUsd` is Phase 2 config in a Phase 1 spec

`config.json` includes `paperTradeSizeUsd: 1000` but the spec explicitly states paper trading is out of scope for Phase 1. Either remove it (clean boundary) or add a comment that it is reserved for Phase 2. As-is, it is dead config that will confuse future implementors.

### 4.4 Static file serving is incomplete

The server spec defines routes for `/` (index.html) and `/main.js` but not for `/style.css`. The file is listed in the dashboard directory. Either add the route or inline the CSS into `index.html`.

### 4.5 Dashboard staleness is not addressed

The dashboard polls every 10 seconds; the scanner runs every 60 seconds. Five of every six polls return unchanged data. The spec does not require the dashboard to show "last updated N seconds ago" or any staleness indicator. Users will not know if the scanner has stalled. This is a UX gap that affects usefulness.

---

## 5. Gaps vs. Source Documents

The round4 docs specify several requirements that did not make it into the spec:

| Requirement from round4 | Status in spec-1 |
|---|---|
| Spread must not be too wide (pass criterion) | `spotSpreadPct` / `perpSpreadPct` collected but never evaluated |
| Predicted next rate surfaced in output | `predictedNextRate` in type but no usage defined |
| OI trend compared "vs 1h ago" | Mentioned as a flag but computation mechanism absent |
| `min_funding_rate_8h` as a threshold | In config but not in evaluator |
| Terminal output format | Spec shows web dashboard only; terminal output from round4 plan is dropped without explanation |

The spread fields are particularly notable — they are in `PairSnapshot` but produce no flag. They add payload to every log record without any evaluation. Either add a `SPREAD_TOO_WIDE` flag or remove the fields from Phase 1.

---

## 6. Minor Issues

- **`minCyclesToBreakeven` formula not specified.** Presumably `Math.ceil(roundTripFee / fundingRate8h)` but this should be explicit.
- **`ScanResult.failing` is unbounded.** With 200+ perpetual pairs, the full failing array in `/snapshot` could be large. Consider capping at top-N or paginating.
- **Port collision unhandled.** No guidance on what happens if port 3000 is in use.
- **No test infrastructure.** The evaluator's pass/fail logic is the core of the system and is fully unit-testable with no mocks. The spec should require at minimum a test file for `evaluator.ts`.
- **Timestamp normalisation.** Both exchanges return millisecond Unix timestamps. The adapters must convert to ISO 8601 strings but this isn't specified.

---

## 7. Recommendations (Priority Order)

1. **Fix the evaluator** — add the `minFundingRate8h` check, resolve the OI flag discriminant, and add a `SPREAD_TOO_WIDE` flag or explicitly remove spread fields.

2. **Verify the OKX funding rate endpoint** — test `/api/v5/market/tickers?instType=SWAP` as the bulk source before committing to an architecture that may hit a nonexistent endpoint.

3. **Specify OI state management** — add a `state.ts` module or document that `index.ts` maintains a `Map<string, {oi: number, ts: number}>` updated each cycle. Without this, OI trend is always `"unknown"`.

4. **Resolve the dashboard compilation question** — pick one: duplicate types, add `esbuild`, or ES modules. Document the decision.

5. **Define the `ranker.ts` sort key** — one sentence is enough: "Sort passing pairs descending by `projectedNetYieldPerCycle`; sort failing pairs descending by `fundingRate8h`."

6. **Add a `Flag` union type** — replace `flags: string[]` with `flags: Flag[]` everywhere.

7. **Define fee calculation formula** — state which fee tier (maker/taker) applies to each leg of entry and exit, and write the formula explicitly in the spec.

8. **Add error handling policy** — one paragraph: what happens on exchange API failure, what the scheduler does, what gets logged.

9. **Add a test requirement** — even just "evaluator.ts must have a corresponding evaluator.test.ts with cases covering each flag" establishes the expectation.

10. **Remove `paperTradeSizeUsd` from Phase 1 config** — keep the boundary clean.
