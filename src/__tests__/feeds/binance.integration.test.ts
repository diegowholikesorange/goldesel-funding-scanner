import { describe, it, expect, beforeAll } from "vitest";
import { loadConfig } from "../../config";
import { initBinanceSymbols, scanBinancePair } from "../../feeds/binance";
import type { PairSnapshot, SymbolEntry } from "../../types";

const config = loadConfig();

let symbols: SymbolEntry[];
let initError: { exchange: string; message: string } | undefined;

beforeAll(async () => {
  ({ symbols, error: initError } = await initBinanceSymbols(config));
}, 30000);

describe("Binance feed — integration", () => {
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

  it("predictedNextRate is always null for Binance", () => {
    for (const s of symbols) expect(s.predictedNextRate).toBeNull();
  });

  it("scanBinancePair returns a valid snapshot for BTC-USDT", async () => {
    const entry = symbols.find(s => s.pair === "BTC-USDT");
    if (!entry) return; // BTC-USDT filtered by thresholds — skip

    const errors: ReturnType<typeof Array>[] = [];
    const snapshot = await scanBinancePair(entry, config, errors as never);
    expect(snapshot).not.toBeNull();
    const s = snapshot as PairSnapshot;
    expect(s.spotDepth10bpsUsd).toBeGreaterThan(0);
    expect(s.perpDepth10bpsUsd).toBeGreaterThan(0);
    expect(s.oiRaw).toBeGreaterThan(0);
    expect(typeof s.passes).toBe("boolean");
  }, 10000);
});
