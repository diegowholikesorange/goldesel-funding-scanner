import "dotenv/config";
import { loadConfig } from "./config";
import * as logger from "./logger";
import { startServer, updateSnapshot, updateSymbols, broadcastPair, broadcastScanStart, broadcastScanEnd } from "./server";
import { runScanner } from "./scanner";

const config = loadConfig();
const port   = parseInt(process.env.PORT ?? "3000", 10);
const server = startServer(port);
const ac     = new AbortController();

runScanner(config, {
  onPair: (s) => {
    broadcastPair(s);
    logger.log(s);
  },
  onSymbolsReady: updateSymbols,
  onRoundStart: broadcastScanStart,
  onRoundEnd: (result) => {
    updateSnapshot(result);
    broadcastScanEnd(result);
    logger.logSummary(result);
    console.log(`[scan] ${result.scannedAt} — ${result.totalPairs} pairs, ${result.passing.length} passing, ${result.errors.length} errors`);
  },
}, ac.signal).catch((err) => {
  console.error("[scanner] Fatal:", err);
  process.exit(1);
});

async function shutdown(): Promise<void> {
  console.log("[shutdown] Stopping...");
  ac.abort();
  await logger.flush();
  server.close(() => process.exit(0));
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
