import { createHmac } from "crypto";

export function signOkxRequest(params: {
  apiSecret: string;
  timestamp: string;
  method: "GET" | "POST";
  path: string;
  body?: string;
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
  timestamp?: string;
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
