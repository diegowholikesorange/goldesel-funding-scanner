import { describe, it, expect, beforeEach } from "vitest";
import { computeOiTrend, resetOiHistory } from "../state";

beforeEach(() => {
  resetOiHistory();
});

describe("computeOiTrend", () => {
  it("returns unknown on first call for a new key", () => {
    expect(computeOiTrend("BINANCE:BTC-USDT", 1000000, 5)).toBe("unknown");
  });

  it("returns unknown for null input and does not update the map", () => {
    computeOiTrend("OKX:BTC-USDT", 1000000, 5); // seed
    const trend = computeOiTrend("OKX:BTC-USDT", null, 5);
    expect(trend).toBe("unknown");
    // next non-null call should compare against the original seed, not NaN
    const next = computeOiTrend("OKX:BTC-USDT", 1050000, 5); // +5%
    expect(next).toBe("rising");
  });

  it("returns rising when OI increases by more than 1%", () => {
    computeOiTrend("BINANCE:ETH-USDT", 1000000, 5);
    expect(computeOiTrend("BINANCE:ETH-USDT", 1015000, 5)).toBe("rising");
  });

  it("returns stable when OI change is within bounds", () => {
    computeOiTrend("BINANCE:ETH-USDT", 1000000, 5);
    expect(computeOiTrend("BINANCE:ETH-USDT", 1005000, 5)).toBe("stable");
  });

  it("returns falling when OI drops beyond threshold", () => {
    computeOiTrend("BINANCE:SOL-USDT", 1000000, 5);
    expect(computeOiTrend("BINANCE:SOL-USDT", 940000, 5)).toBe("falling");
  });

  it("returns stable when OI drop is below threshold", () => {
    computeOiTrend("BINANCE:SOL-USDT", 1000000, 5);
    expect(computeOiTrend("BINANCE:SOL-USDT", 960000, 5)).toBe("stable");
  });

  it("uses oiFallThresholdPct from config, not a hardcoded value", () => {
    computeOiTrend("OKX:ETH-USDT", 1000000, 10);
    // 8% drop — falls below 10% threshold, so stable
    expect(computeOiTrend("OKX:ETH-USDT", 920000, 10)).toBe("stable");
    computeOiTrend("OKX:ETH-USDT", 1000000, 10); // reset to known value
    // 11% drop — exceeds 10% threshold, so falling
    expect(computeOiTrend("OKX:ETH-USDT", 890000, 10)).toBe("falling");
  });

  it("tracks multiple keys independently", () => {
    computeOiTrend("BINANCE:BTC-USDT", 1000000, 5);
    computeOiTrend("OKX:BTC-USDT", 2000000, 5);
    expect(computeOiTrend("BINANCE:BTC-USDT", 1020000, 5)).toBe("rising");
    expect(computeOiTrend("OKX:BTC-USDT", 1800000, 5)).toBe("falling");
  });
});
