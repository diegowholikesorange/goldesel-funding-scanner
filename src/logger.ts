import { appendFileSync, mkdirSync } from "fs";
import { resolve } from "path";
import type { PairSnapshot, ScanResult } from "./types";

const LOGS_DIR = resolve(process.cwd(), "logs");

mkdirSync(LOGS_DIR, { recursive: true });

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function scanFile(): string  { return resolve(LOGS_DIR, `scans-${today()}.jsonl`); }
function summaryFile(): string { return resolve(LOGS_DIR, `summary-${today()}.jsonl`); }

export function log(snapshot: PairSnapshot): void {
  if (!snapshot.passes) return;
  try {
    appendFileSync(scanFile(), JSON.stringify(snapshot) + "\n");
  } catch (err) {
    console.error("[logger] Failed to write scan record:", err);
  }
}

export function logSummary(result: ScanResult): void {
  try {
    appendFileSync(summaryFile(), JSON.stringify(result) + "\n");
  } catch (err) {
    console.error("[logger] Failed to write summary record:", err);
  }
}

export async function flush(): Promise<void> {
  // appendFileSync is synchronous; nothing to drain
}
