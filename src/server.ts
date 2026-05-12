import express from "express";
import { resolve } from "path";
import type { PairSnapshot, ScanResult } from "./types";

const DASHBOARD_DIR = resolve(__dirname, "../dashboard");
const STARTUP_ID = Date.now().toString();

let latestResult: ScanResult | null = null;
let latestSymbols: Array<{ exchange: string; pair: string }> = [];
const streamClients = new Set<express.Response>();

export function updateSymbols(symbols: Array<{ exchange: string; pair: string }>): void {
  latestSymbols = symbols;
}

export function updateSnapshot(result: ScanResult): void {
  latestResult = result;
}

export function broadcastPair(snapshot: PairSnapshot): void {
  if (streamClients.size === 0) return;
  const data = JSON.stringify(snapshot);
  for (const res of streamClients) {
    res.write(`event: pair\ndata: ${data}\n\n`);
  }
}

export function broadcastScanStart(): void {
  for (const res of streamClients) {
    res.write("event: scan-start\ndata: {}\n\n");
  }
}

export function broadcastScanEnd(result: ScanResult): void {
  const payload = {
    scannedAt: result.scannedAt,
    totalPairs: result.totalPairs,
    passingCount: result.passing.length,
    skipCount: result.errors.filter(e => /^[A-Z0-9]+-USDT/.test(e.message)).length,
    errors: result.errors,
    sentiment: result.sentiment,
  };
  const data = JSON.stringify(payload);
  for (const res of streamClients) {
    res.write(`event: scan-end\ndata: ${data}\n\n`);
  }
}

export function createServer(): ReturnType<typeof express> {
  const app = express();
  app.use(express.static(DASHBOARD_DIR));

  app.get("/symbols", (_req, res) => {
    res.json([...latestSymbols].sort((a, b) => a.pair.localeCompare(b.pair)));
  });

  app.get("/snapshot", (_req, res) => {
    if (!latestResult) {
      res.status(404).json({ error: "No scan available yet" });
    } else {
      res.json(latestResult);
    }
  });

  app.get("/stream", (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();
    if (latestResult) {
      for (const s of [...latestResult.passing, ...latestResult.failing]) {
        res.write(`event: pair\ndata: ${JSON.stringify(s)}\n\n`);
      }
      const payload = {
        scannedAt: latestResult.scannedAt,
        totalPairs: latestResult.totalPairs,
        passingCount: latestResult.passing.length,
        skipCount: latestResult.errors.filter(e => /^[A-Z0-9]+-USDT/.test(e.message)).length,
        errors: latestResult.errors,
        sentiment: latestResult.sentiment,
      };
      res.write(`event: scan-end\ndata: ${JSON.stringify(payload)}\n\n`);
    }
    streamClients.add(res);
    const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), 15000);
    req.on("close", () => { streamClients.delete(res); clearInterval(heartbeat); });
  });

  app.get("/dev/reload", (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();
    res.write(`data: ${STARTUP_ID}\n\n`);
    const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), 15000);
    req.on("close", () => clearInterval(heartbeat));
  });

  return app;
}

export function startServer(port: number): ReturnType<ReturnType<typeof express>["listen"]> {
  const app = createServer();
  const server = app.listen(port, () => {
    console.log(`[server] Dashboard at http://localhost:${port}`);
  });
  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(`[server] Port ${port} is already in use. Set PORT env var to use a different port.`);
      process.exit(1);
    }
    throw err;
  });
  return server;
}
