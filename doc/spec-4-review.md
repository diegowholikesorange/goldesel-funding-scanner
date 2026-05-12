# spec-4.md — Technical Review
*Reviewed May 2026*

---

## Summary

Both spec-3 blockers are correctly resolved. The TDD sequence, integration test structure, Makefile, and README are all solid. Three small gaps prevent a clean sign-off: one undermines the TDD claim for `okx-auth.ts`, and two are broken references (a command that doesn't exist, a file referenced but never defined).

---

## 1. `buildOkxAuthHeaders` is not testable as specified

The spec defines `okx-auth.ts` as a "pure function, no I/O" and puts it first in the TDD sequence precisely because it's deterministic. But `buildOkxAuthHeaders` calls `new Date()` internally:

```typescript
export function buildOkxAuthHeaders(params: { ... }): Record<string, string> {
  const timestamp = new Date().toISOString();  // non-deterministic
  const sign = signOkxRequest({ ...params, timestamp });
  ...
}
```

You cannot write a "known vector" test against this function — the timestamp changes on every call, so the signature changes on every call. The test spec lists `"OK-ACCESS-TIMESTAMP in returned headers is a valid ISO 8601 string"` as the only header-level assertion, which is all you *can* test when the timestamp is internal.

This means: `signOkxRequest` is properly testable (timestamp is a parameter), but `buildOkxAuthHeaders` cannot be tested for signature correctness — only for header key presence. For a module that is the sole auth safety gate for OKX, that gap is worth closing.

**Fix:** inject the timestamp:

```typescript
export function buildOkxAuthHeaders(params: {
  apiKey: string;
  apiSecret: string;
  passphrase: string;
  method: "GET" | "POST";
  path: string;
  body?: string;
  timestamp?: string;   // default: new Date().toISOString()
}): Record<string, string> {
  const timestamp = params.timestamp ?? new Date().toISOString();
  const sign = signOkxRequest({ ...params, timestamp });
  ...
}
```

Production callers omit `timestamp` (gets current time). Tests pass a fixed value and assert the exact signature. The function is now deterministic under test.

Update `okx-auth.test.ts` accordingly: the "known vector" test should call `buildOkxAuthHeaders` with a fixed timestamp and assert the full expected signature, not just header key presence.

---

## 2. `.env.example` is referenced but never defined

README section 3:
```
cp .env.example .env
```

`.env.example` does not appear in the file structure. It should be committed (unlike `.env`, which is gitignored) so a fresh clone has a record of what variables are needed.

**Fix:** add to file structure:
```
├── .env.example          # committed; documents required env vars with empty values
├── .env                  # gitignored; actual values
```

Contents mirror the env var table already in spec-3/spec-4:
```
BINANCE_API_KEY=
BINANCE_API_SECRET=
OKX_API_KEY=
OKX_API_SECRET=
OKX_PASSPHRASE=
PORT=3000
```

---

## 3. `make dev` is in the README but not in the Makefile

README section 5 (Running):
```
make dev            # tsx watch (resets OI state on file save)
```

The Makefile has `.PHONY: install clean build test itest` — no `dev` target. Running `make dev` will fail with "No rule to make target 'dev'".

**Fix:** add to Makefile:
```makefile
dev:
	npx tsx watch src/index.ts
```

And add `dev` to the `.PHONY` line.

---

## 4. OKX test vector not included (minor)

`okx-auth.test.ts` requires a "known vector: fixed inputs produce the expected base64 signature." The spec defers this to "verify against OKX docs example or a reference implementation" — pushing research to implementation time.

OKX publishes a test vector in their API authentication docs. Include it in the spec so the test can be written directly. Without it, the implementor either skips the test or spends time sourcing the vector mid-implementation (breaking TDD flow). Not a blocker, but it's the easiest thing to fix now.

---

## What Is Correct

- Both spec-3 blockers resolved cleanly (Binance `/fapi/v1/bookTicker` added; `computeOiTrend` null guard correct)
- TDD sequence order (pure leaf modules first) is right
- Vitest config split (unit vs integration) is clean and correct
- Integration test `testTimeout: 15000` is appropriate for exchange calls
- `make clean` preserving `logs/` is correct (data, not artefacts)
- `dashboard/main.js` excluded from `clean` target via `rm -rf dist dashboard/main.js` — correct
- OKX auth HMAC algorithm matches OKX's documented signing scheme
- All previously identified issues from spec-1 through spec-3 remain resolved

---

## Verdict

Fix the three gaps above (injectable timestamp in `buildOkxAuthHeaders`, add `.env.example` to file structure, add `make dev` to Makefile), include the OKX test vector if possible, then **approved for implementation**.
