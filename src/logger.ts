import { appendFileSync, mkdirSync } from "fs";
import { resolve } from "path";
import type { PairSnapshot, ScanResult } from "./types";

const LOGS_DIR = resolve(process.cwd(), "logs");
const SCANS_FILE = resolve(LOGS_DIR, "scans.jsonl");
const SUMMARY_FILE = resolve(LOGS_DIR, "summary.jsonl");

mkdirSync(LOGS_DIR, { recursive: true });

export function log(snapshot: PairSnapshot): void {
  try {
    appendFileSync(SCANS_FILE, JSON.stringify(snapshot) + "\n");
  } catch (err) {
    console.error("[logger] Failed to write scan record:", err);
  }
}

export function logSummary(result: ScanResult): void {
  try {
    appendFileSync(SUMMARY_FILE, JSON.stringify(result) + "\n");
  } catch (err) {
    console.error("[logger] Failed to write summary record:", err);
  }
}

export async function flush(): Promise<void> {
  // appendFileSync is synchronous; nothing to drain
}
