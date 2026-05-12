import { readFileSync } from "fs";
import { resolve } from "path";
import type { AppConfig, FeeConfig, ScanConfig } from "./types";

function loadJson<T>(filePath: string): T {
  try {
    return JSON.parse(readFileSync(filePath, "utf-8")) as T;
  } catch {
    throw new Error(`Failed to load config file: ${filePath}`);
  }
}

function validateFees(fees: FeeConfig): void {
  for (const exchange of ["binance", "okx"] as const) {
    const f = fees[exchange];
    for (const key of ["spotMaker", "spotTaker", "futuresMaker", "futuresTaker"] as const) {
      if (typeof f[key] !== "number" || f[key] < 0) {
        throw new Error(`Invalid fee value for ${exchange}.${key}: ${f[key]}`);
      }
    }
  }
}

function validateScan(scan: ScanConfig): void {
  const required: (keyof ScanConfig)[] = [
    "minSpotDepthUsd",
    "minPerpDepthUsd",
    "maxBasisPct",
    "maxSpreadPct",
    "minHoldCycles",
    "minNetYieldPerCycle",
    "minFundingRate8h",
    "oiFallThresholdPct",
    "scanIntervalSeconds",
  ];
  for (const key of required) {
    if (typeof scan[key] !== "number") {
      throw new Error(`Missing or invalid scan config key: ${key}`);
    }
  }
}

export function loadConfig(): AppConfig {
  const root = resolve(__dirname, "..");
  const fees = loadJson<FeeConfig>(resolve(root, "fees.json"));
  const scan = loadJson<ScanConfig>(resolve(root, "config.json"));
  validateFees(fees);
  validateScan(scan);
  return { fees, scan };
}
