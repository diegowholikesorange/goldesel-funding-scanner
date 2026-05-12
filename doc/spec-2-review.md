# spec-2.md — Technical Review
*Reviewed May 2026*

---

## Summary

spec-2.md resolves every substantive issue raised in spec-1-review.md. The type system is now correct, the OI state mechanism is specified, the fee formula is explicit, the two-pass strategy is documented, error handling and shutdown are defined, and tests are required. This is a buildable spec.

What remains are **four issues that will produce wrong data or runtime failures**, plus a cluster of smaller gaps. None require redesigning the architecture — most are single-sentence clarifications or one-line code guards.

---

## 1. Substantive Issues (Will Produce Wrong Behaviour)

### 1.1 `oiRaw` is in the wrong type

`PreFilterSnapshot` includes `oiRaw: number | null`. But per the adapter tables, OI is a pass-2 fetch for both exchanges:

- **Binance pass 1**: `/fapi/v1/premiumIndex` + `/api/v3/bookTicker` — no OI data
- **OKX pass 1**: `/api/v5/market/tickers?instType=SWAP` — no OI data (volume, not OI)

`oiRaw` will always be `null` in `PreFilterSnapshot`. Its logical home is the `PairSnapshot` extension (pass 2), where it belongs alongside the other depth fields. As specified, the field is dead in the type where it sits and will confuse implementors.

**Fix:** move `oiRaw` from `PreFilterSnapshot` to `PairSnapshot`.

### 1.2 Binance `fundingRate8h` is the *previous* period rate, not the current one

`/fapi/v1/premiumIndex` returns `lastFundingRate` — the rate that settled at the most recent 8h mark. OKX's `/api/v5/market/tickers?instType=SWAP` returns `fundingRate` — the rate currently accruing toward the *next* settlement. These are different data points.

For a trade decision, you want the current-period rate. Using Binance's `lastFundingRate` means the scanner is acting on a rate that has already settled and may not reflect current market conditions. In trending markets this produces meaningful errors.

Binance does not publish the predicted next rate in a public bulk endpoint. The options are:
- Use `lastFundingRate` and document the limitation explicitly ("Binance rates are 1 period lagged")
- Use the mark price premium formula to infer the current accruing rate (complex, out of scope for Phase 1)

The spec must acknowledge this asymmetry. The silence here will cause confusion when Binance and OKX rates for the same pair diverge and the implementor doesn't know why.

**Also:** `predictedNextRate` is documented as "collected and displayed, not used in pass/fail." For Binance, there is no predicted rate endpoint — this field will always be `null` for Binance pairs. Document this explicitly; otherwise the dashboard will show blank predicted rates for Binance and no one will know if that is a bug or expected.

### 1.3 Basis calculation uses ambiguous price source on Binance

`basisPct = (perpPrice - spotPrice) / spotPrice * 100`

For Binance, `/fapi/v1/premiumIndex` returns two usable prices: `markPrice` (the exchange's mark price, used to calculate unrealised PnL) and `indexPrice` (the index of underlying spot price). Neither is the last *traded* price on the futures market.

For a cash-and-carry strategy, basis should be computed from the prices you actually execute at — i.e., the last traded perp price vs. the best spot offer. Using `markPrice` overstates basis stability (mark price is smoothed) and understates entry cost. If the spec intends to use `markPrice` as `perpPrice`, say so and explain why. If it intends the last traded price, specify `/fapi/v1/ticker/price` or the `price` field in a different endpoint.

### 1.4 `logs/` directory is not guaranteed to exist

`logger.ts` appends to `logs/scans.jsonl` and `logs/summary.jsonl`. `fs.appendFile` will throw `ENOENT` if the `logs/` directory has never been created (e.g., fresh clone, gitignored). The spec says the directory is gitignored but does not specify who creates it. Add to `index.ts` startup: `fs.mkdirSync("logs", { recursive: true })`, or document this as the logger's responsibility.

---

## 2. Logic Gaps

### 2.1 Double-flagging on negative rates

Both `FUNDING_NOT_POSITIVE` (`<= 0`) and `FUNDING_BELOW_MINIMUM` (`< minFundingRate8h`) fire simultaneously for a negative rate (assuming `minFundingRate8h > 0`, which it always is). The pair gets two redundant flags. This is cosmetic but pollutes the log with noise and makes flag frequency analysis misleading.

**Fix:** make `FUNDING_BELOW_MINIMUM` check `fundingRate8h > 0 && fundingRate8h < minFundingRate8h`. The two flags become mutually exclusive.

### 2.2 Pre-filter spread check is ambiguous

The two-pass section states: "Apply pre-filter: `fundingRate8h > 0`, `basisPct <= maxBasisPct`, `spreadPct <= maxSpreadPct`"

`PreFilterSnapshot` has `spotSpreadPct` and `perpSpreadPct`. The pre-filter refers to `spreadPct` (singular). Which one? Both should be checked in pass 1 or the `SPREAD_TOO_WIDE` flag in pass 2 becomes the only gate, defeating the "avoid depth calls for wide-spread pairs" optimisation.

**Fix:** state explicitly "pre-filter applies `maxSpreadPct` to both `spotSpreadPct` and `perpSpreadPct`."

### 2.3 Division-by-zero in `minCyclesToBreakeven`

```
minCyclesToBreakeven = Math.ceil(roundTripFee / fundingRate8h)
```

If `fundingRate8h` is 0, this produces `Infinity`. The evaluator's `FUNDING_NOT_POSITIVE` guard should prevent reaching this computation, but the guard and the formula are in the same function body with no guaranteed ordering documented. Add an explicit comment or guard:

```typescript
// Only reached when fundingRate8h > 0 (FUNDING_NOT_POSITIVE exits early)
```

Or compute `minCyclesToBreakeven` only after all hard-rejection checks.

### 2.4 OI history freezes for pairs that temporarily drop below pre-filter

Pairs that fail pass 1 (e.g., low funding rate) skip pass 2, so their `oiHistory` entry in `state.ts` is never updated. If a pair oscillates in and out of the pre-filter across cycles, its OI baseline becomes stale. When it re-enters, the trend comparison is against an old value — potentially triggering a false `OI_UNWINDING` or masking a real one.

This is an inherent trade-off of the two-pass design, not a flaw per se, but it needs to be documented as a known limitation so the implementor doesn't treat `"falling"` OI on a re-entering pair as reliable.

---

## 3. Missing Specifications

### 3.1 `oiRaw` unit is unspecified

`state.ts` computes:
```typescript
const changePct = ((currentOi - prev) / prev) * 100;
```

For this to be meaningful, both the current and previous OI must be in the same unit. OKX's `/api/v5/public/open-interest` returns `oi` (contracts) and `oiCcy` (USD value). Binance's `/fapi/v1/openInterest` returns `openInterest` (contracts). If one adapter stores contracts and another stores USD, the 5% threshold means different things.

**Specify:** which field from each endpoint is used as `oiRaw`, and ensure both adapters store the same unit (USD value is preferable for cross-exchange comparability).

### 3.2 Binance perp-to-spot symbol matching is unspecified

Binance has perpetuals like `BTCUSDT`, `ETHUSDT`, `BTCBUSD`. The corresponding spot markets are named identically. But some perps (e.g., coin-margined contracts) have no USDT spot pair. The two-pass strategy needs to join the perp symbols from `/fapi/v1/premiumIndex` with spot symbols from `/api/v3/bookTicker`. The join key is symbol name (after normalisation), but:
- Some perps will have no matching spot entry — these should be silently skipped
- Coin-margined perpetuals (`/dapi/`) are not in scope but may appear if the adapter doesn't filter by `contractType`

**Specify:** filter `/fapi/v1/premiumIndex` to `contractType == "PERPETUAL"` and USDT-margined only, then inner-join with spot bookTicker by normalised symbol.

### 3.3 `ExchangeError` display in the dashboard is unspecified

`ScanResult.errors: ExchangeError[]` exists and errors are included in `/snapshot`. The dashboard spec defines what to show for passing/failing pairs and staleness, but says nothing about how to render exchange errors. If OKX is down for a cycle, the user sees fewer rows but no explanation.

**Specify:** show a dismissible banner per entry in `errors` (e.g., "OKX unavailable this cycle — results incomplete").

### 3.4 `logger.ts` public API is referenced but not defined

`index.ts` shutdown calls `await logger.flush()`. The spec doesn't define `logger.ts`'s exported interface. At minimum document:
- `logger.log(snapshot: PairSnapshot): void`
- `logger.logSummary(result: ScanResult): void`
- `logger.flush(): Promise<void>`

This is a one-paragraph addition that prevents each implementor from inventing their own interface.

### 3.5 Static file path resolution from `dist/`

`server.ts` compiles to `dist/server.js`. Routes like `GET /main.js` will serve `dashboard/main.js`. From `__dirname` in `dist/`, the relative path `../dashboard/main.js` works in a standard layout, but `express.static` or `path.resolve(__dirname, '../dashboard')` is the standard pattern. The spec should show the path idiom explicitly — it's a common source of "file not found" on first run.

---

## 4. Minor Issues

- **`oiHistory` grows indefinitely.** New perpetuals are listed, old ones delisted. `state.ts` never prunes stale keys. Negligible memory impact for hundreds of pairs, but worth a comment: `// keyed entries are never removed; acceptable for Phase 1 pair counts`.

- **Type duplication drift.** Dashboard `main.ts` duplicates `PairSnapshot` types from `src/types.ts`. Document this explicitly with a comment like `// Keep in sync with src/types.ts — no build-time check enforces this`.

- **`tsx watch` resets OI state on reload.** In `dev` mode, every file save clears `oiHistory`. Pairs will always show `"unknown"` for one cycle after a reload. Not a production issue; note it in development docs or a code comment in `state.ts`.

- **`ranker.ts` owns the failing cap but this isn't stated.** The types say `ScanResult.failing` is "capped at top 20" and the ranker section says "failing pairs are capped at top 20 in `ScanResult.failing`". Confirm explicitly: the cap is applied by `ranker.ts`, not by the server or logger.

---

## 5. What Is Well Done

These issues from spec-1-review were cleanly resolved and the solutions are correct:

- `Flag` union type replaces `string[]` — correct approach
- `oiFallThresholdPct` config replaces hardcoded threshold — correct
- Two-pass architecture is now explicit and logical
- `state.ts` with `Map<string, number>` is the right minimal solution for OI history
- Fee formula is unambiguous and consistent with the cash-and-carry model
- `FUNDING_BELOW_MINIMUM` added alongside `FUNDING_NOT_POSITIVE`
- esbuild resolves the dashboard bundling gap cleanly
- Error handling policy is practical and correctly scoped
- `SIGTERM`/`SIGINT` shutdown pattern is correct
- Testing section is minimal but covers the right cases
- `paperTradeSizeUsd` correctly removed from Phase 1 config
- All config keys are now typed via `AppConfig`
