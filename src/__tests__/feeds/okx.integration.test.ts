import { describe, it, expect, beforeAll } from "vitest";
import { loadConfig } from "../../config";
import { initOkxSymbols, scanOkxPair } from "../../feeds/okx";
import { signOkxRequest, buildOkxAuthHeaders } from "../../feeds/okx-auth";
import type { ExchangeError, PairSnapshot, SymbolEntry } from "../../types";

const config = loadConfig();

let symbols: SymbolEntry[];
let initError: ExchangeError | undefined;

beforeAll(async () => {
  ({ symbols, error: initError } = await initOkxSymbols(config));
}, 60000);

describe("OKX feed — integration", () => {
  it("init returns symbols without exchange-level error", () => {
    expect(initError).toBeUndefined();
    expect(symbols.length).toBeGreaterThan(0);
  });

  it("includes BTC-USDT and ETH-USDT in the symbol registry", () => {
    const pairs = symbols.map(s => s.pair);
    expect(pairs).toContain("BTC-USDT");
    expect(pairs).toContain("ETH-USDT");
  });

  it("all fundingRate8h values are positive finite numbers", () => {
    for (const s of symbols) {
      expect(typeof s.fundingRate8h).toBe("number");
      expect(Number.isFinite(s.fundingRate8h)).toBe(true);
      expect(s.fundingRate8h).toBeGreaterThan(0);
    }
  });

  it("all pair names match canonical BASE-QUOTE format", () => {
    const canonical = /^[A-Z0-9]+-[A-Z0-9]+$/;
    for (const s of symbols) expect(s.pair).toMatch(canonical);
  });

  it("nextFundingTime parses as a valid ISO 8601 date", () => {
    for (const s of symbols) expect(new Date(s.nextFundingTime).getTime()).not.toBeNaN();
  });

  it("predictedNextRate is null or a finite number (never NaN)", () => {
    for (const s of symbols) {
      if (s.predictedNextRate !== null) {
        expect(typeof s.predictedNextRate).toBe("number");
        expect(Number.isFinite(s.predictedNextRate)).toBe(true);
      }
    }
  });

  it("scanOkxPair returns a valid snapshot for BTC-USDT", async () => {
    const entry = symbols.find(s => s.pair === "BTC-USDT");
    if (!entry) return;

    const errors: ExchangeError[] = [];
    const snapshot = await scanOkxPair(entry, config, errors);
    expect(snapshot).not.toBeNull();
    const s = snapshot as PairSnapshot;
    expect(s.spotDepth10bpsUsd).toBeGreaterThan(0);
    expect(s.perpDepth10bpsUsd).toBeGreaterThan(0);
    expect(typeof s.passes).toBe("boolean");
  }, 10000);

  describe("HMAC auth", () => {
    const hasKeys = Boolean(process.env.OKX_KEY && process.env.OKX_SECRET && process.env.OKX_PASSPHRASE);

    it.skipIf(!hasKeys)("authenticated request to public endpoint succeeds", async () => {
      const path = "/api/v5/market/tickers?instType=SWAP";
      const headers = buildOkxAuthHeaders({
        apiKey: process.env.OKX_KEY!,
        apiSecret: process.env.OKX_SECRET!,
        passphrase: process.env.OKX_PASSPHRASE!,
        method: "GET",
        path,
      });
      const res = await fetch(`https://www.okx.com${path}`, { headers });
      expect(res.status).toBe(200);
      const body = await res.json() as { code: string };
      expect(body.code).toBe("0");
    });

    it("signOkxRequest is deterministic for same inputs", () => {
      const sig1 = signOkxRequest({ apiSecret: "s", timestamp: "t", method: "GET", path: "/p" });
      const sig2 = signOkxRequest({ apiSecret: "s", timestamp: "t", method: "GET", path: "/p" });
      expect(sig1).toBe(sig2);
    });
  });
});
