# spec-3.md — Technical Review
*Reviewed May 2026*

---

## Summary

All issues from spec-2-review are resolved. Spec-3 is nearly implementation-ready. Two things will break at build or runtime if not addressed first; one more is a scoping question that should be settled before writing the feed adapters.

---

## 1. Blockers

### 1.1 Binance has no bulk perp bid/ask in pass 1 — `perpSpreadPct` has no source

`/fapi/v1/premiumIndex` returns `markPrice`, `indexPrice`, `lastFundingRate`, `nextFundingTime`. It does not return bid or ask prices.

`perpSpreadPct` is required by the pass-1 pre-filter:
```
AND perpSpreadPct <= config.maxSpreadPct
```
Without a source, a Binance adapter either:
- Sets `perpSpreadPct = 0` (silently bypasses the perp spread filter for all Binance pairs), or
- Crashes attempting to read a field that isn't there

The missing call is `/fapi/v1/bookTicker` — analogous to the spot `/api/v3/bookTicker`, it returns best bid/ask for all perp symbols in one request.

**Fix:** add to Binance pass 1:

| Call | Endpoint | Data extracted |
|---|---|---|
| Perp best bid/ask | `GET /fapi/v1/bookTicker` | `bidPrice`, `askPrice` per symbol |

OKX is unaffected — `/api/v5/market/tickers?instType=SWAP` returns `bidPx` and `askPx` per instrument.

### 1.2 `computeOiTrend` type mismatch with `oiRaw: number | null`

`PairSnapshot.oiRaw` is typed `number | null`. If the OI endpoint call fails during pass 2, the adapter sets `oiRaw = null`.

`state.ts` signature:
```typescript
export function computeOiTrend(key: string, currentOi: number, fallThresholdPct: number): OiTrend
```

`currentOi` is `number`, not `number | null`. Passing `null` is a TypeScript compile error; if bypassed (e.g., `!`), `((null - prev) / prev) * 100` is `NaN`, which stores `NaN` in `oiHistory` and breaks all future trend comparisons for that pair.

**Fix:** update the signature and add a null guard:
```typescript
export function computeOiTrend(
  key: string,
  currentOi: number | null,
  fallThresholdPct: number
): OiTrend {
  if (currentOi === null) return "unknown";
  // ... rest unchanged
}
```

When `currentOi` is null, do not update `oiHistory` — preserve the last known value.

---

## 2. Scoping Question (Settle Before Writing Adapters)

### 2.1 OKX API key auth requires HMAC signing — "attach as headers" is incorrect

The spec says feeds "attach [API keys] as request headers when present." For Binance this is correct: one header, `X-MBX-APIKEY`, no signing required for public endpoints.

For OKX, attaching credentials to any request (even a public endpoint) requires:
1. `OK-ACCESS-TIMESTAMP` — current Unix timestamp in ISO format
2. `OK-ACCESS-SIGN` — HMAC-SHA256 of `(timestamp + "GET" + path + body)` using API secret
3. `OK-ACCESS-KEY` — API key
4. `OK-ACCESS-PASSPHRASE` — passphrase

Attaching just the key header without the signature will be rejected by OKX. Silently omitting it leaves OKX running at unauthenticated rate limits regardless of whether env vars are set.

**Options:**
- **Simplest (recommended):** implement Binance auth only in Phase 1. Note in the spec that OKX signing infrastructure is deferred to Phase 2 (when private endpoints are needed anyway). The `.env` OKX vars are reserved but unused.
- **Full:** implement HMAC signing for OKX. ~30 lines of code, but adds `crypto` usage and test surface.

Either is fine — the choice just needs to be explicit before the adapter is written.

---

## 3. Minor (No Blockers)

- **Pre-filter could include `minFundingRate8h`**: pass 1 only filters `fundingRate8h > 0`, so rates between 0 and `minFundingRate8h` (e.g., 0.005%) trigger depth calls and are then rejected by `FUNDING_BELOW_MINIMUM`. Adding `fundingRate8h >= config.minFundingRate8h` to the pass-1 criteria eliminates these wasted calls. Not a correctness issue.

- **`latestScanResult` undefined before first scan**: `res.json(latestScanResult)` with `undefined` returns HTTP 200 with body `null` (Express behaviour), not 404. The dashboard spec says "if `/snapshot` returns 404 or empty" — the 404 case won't happen. Change to: "if response body is `null` or `totalPairs` is absent, show waiting state." Or explicitly return 503 before first scan.

- **`dashboard/main.js` should be gitignored**: it's an esbuild artifact in the source tree. Add to `.gitignore` alongside `dist/` and `logs/`.

---

## Verdict

Fix the two blockers (add `/fapi/v1/bookTicker` to Binance pass 1; add null guard to `computeOiTrend`), settle the OKX auth scope question, then this spec is approved for implementation.
