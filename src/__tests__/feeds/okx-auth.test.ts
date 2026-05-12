import { describe, it, expect } from "vitest";
import { signOkxRequest, buildOkxAuthHeaders } from "../../feeds/okx-auth";

const FIXTURE = {
  secret: "test-secret-key",
  timestamp: "2020-12-08T09:08:57.715Z",
  apiKey: "test-api-key",
  passphrase: "test-passphrase",
};

describe("signOkxRequest", () => {
  it("produces correct signature for GET with empty body", () => {
    const sig = signOkxRequest({
      apiSecret: FIXTURE.secret,
      timestamp: FIXTURE.timestamp,
      method: "GET",
      path: "/api/v5/account/balance?ccy=BTC",
    });
    expect(sig).toBe("aCsBgsrAUQSCOQRSWb0FS4QZu/1RLrWcurndoXOEp+w=");
  });

  it("produces correct signature for POST with JSON body", () => {
    const sig = signOkxRequest({
      apiSecret: FIXTURE.secret,
      timestamp: FIXTURE.timestamp,
      method: "POST",
      path: "/api/v5/trade/order",
      body: '{"ccy":"BTC"}',
    });
    expect(sig).toBe("mwrW1sOmIR2/LNAUgOM4IltlTM6NZHCuZ9/ohLomd1k=");
  });

  it("treats missing body as empty string", () => {
    const withBody = signOkxRequest({
      apiSecret: FIXTURE.secret,
      timestamp: FIXTURE.timestamp,
      method: "GET",
      path: "/api/v5/account/balance?ccy=BTC",
      body: "",
    });
    const withoutBody = signOkxRequest({
      apiSecret: FIXTURE.secret,
      timestamp: FIXTURE.timestamp,
      method: "GET",
      path: "/api/v5/account/balance?ccy=BTC",
    });
    expect(withBody).toBe(withoutBody);
  });
});

describe("buildOkxAuthHeaders", () => {
  it("returns all four required OKX headers", () => {
    const headers = buildOkxAuthHeaders({
      apiKey: FIXTURE.apiKey,
      apiSecret: FIXTURE.secret,
      passphrase: FIXTURE.passphrase,
      method: "GET",
      path: "/api/v5/account/balance?ccy=BTC",
      timestamp: FIXTURE.timestamp,
    });
    expect(headers["OK-ACCESS-KEY"]).toBe(FIXTURE.apiKey);
    expect(headers["OK-ACCESS-SIGN"]).toBeDefined();
    expect(headers["OK-ACCESS-TIMESTAMP"]).toBeDefined();
    expect(headers["OK-ACCESS-PASSPHRASE"]).toBe(FIXTURE.passphrase);
  });

  it("produces deterministic signature when timestamp is injected", () => {
    const headers = buildOkxAuthHeaders({
      apiKey: FIXTURE.apiKey,
      apiSecret: FIXTURE.secret,
      passphrase: FIXTURE.passphrase,
      method: "GET",
      path: "/api/v5/account/balance?ccy=BTC",
      timestamp: FIXTURE.timestamp,
    });
    expect(headers["OK-ACCESS-SIGN"]).toBe("aCsBgsrAUQSCOQRSWb0FS4QZu/1RLrWcurndoXOEp+w=");
    expect(headers["OK-ACCESS-TIMESTAMP"]).toBe(FIXTURE.timestamp);
  });

  it("uses current time when timestamp is omitted", () => {
    const before = new Date().toISOString();
    const headers = buildOkxAuthHeaders({
      apiKey: FIXTURE.apiKey,
      apiSecret: FIXTURE.secret,
      passphrase: FIXTURE.passphrase,
      method: "GET",
      path: "/api/v5/market/tickers?instType=SWAP",
    });
    const after = new Date().toISOString();
    expect(headers["OK-ACCESS-TIMESTAMP"] >= before).toBe(true);
    expect(headers["OK-ACCESS-TIMESTAMP"] <= after).toBe(true);
  });
});
