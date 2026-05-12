export type Exchange = "BINANCE" | "OKX";

export type OiTrend = "rising" | "falling" | "stable" | "unknown";

export type Flag =
  | "FUNDING_NOT_POSITIVE"
  | "FUNDING_BELOW_MINIMUM"
  | "INSUFFICIENT_SPOT_DEPTH"
  | "INSUFFICIENT_PERP_DEPTH"
  | "INSUFFICIENT_OI"
  | "BASIS_TOO_STRETCHED"
  | "SPREAD_TOO_WIDE"
  | "OI_UNWINDING"
  | "YIELD_BELOW_THRESHOLD";

export interface SymbolEntry {
  exchange: Exchange;
  pair: string;       // "BTC-USDT"
  exchangeId: string; // exchange-native id: "BTCUSDT" (Binance) | "BTC-USDT-SWAP" (OKX)
  spotPrice: number;
  perpPrice: number;
  basisPct: number;
  fundingRate8h: number;
  nextFundingTime: string;
  predictedNextRate: number | null;
  spotSpreadPct: number;
  perpSpreadPct: number;
}

export interface PreFilterSnapshot {
  exchange: Exchange;
  pair: string;
  spotPrice: number;
  perpPrice: number;
  basisPct: number;
  fundingRate8h: number;
  nextFundingTime: string;
  predictedNextRate: number | null;
  spotSpreadPct: number;
  perpSpreadPct: number;
}

export interface PairSnapshot extends PreFilterSnapshot {
  timestamp: string;
  fundingRateAnnualised: number;
  spotDepth10bpsUsd: number;
  perpDepth10bpsUsd: number;
  oiRaw: number | null;
  oiTrend: OiTrend;
  entryFeeEst: number;
  exitFeeEst: number;
  roundTripFee: number;
  minCyclesToBreakeven: number;
  projectedYieldPerCycle: number;
  projectedNetYieldPerCycle: number;
  passes: boolean;
  flags: Flag[];
}

export interface MarketSentiment {
  avgFunding8h: number;
  avgAbsFunding8h: number;
  pctPositive: number;
  totalOiUsd: number;
  pctRisingOi: number;
  pctFallingOi: number;
}

export interface ScanResult {
  scannedAt: string;
  totalPairs: number;
  passing: PairSnapshot[];
  failing: PairSnapshot[];
  errors: ExchangeError[];
  sentiment: MarketSentiment;
}

export interface ExchangeError {
  exchange: Exchange;
  message: string;
  timestamp: string;
}

export interface FeeConfig {
  binance: {
    spotMaker: number;
    spotTaker: number;
    futuresMaker: number;
    futuresTaker: number;
    bnbDiscount: boolean;
  };
  okx: {
    spotMaker: number;
    spotTaker: number;
    futuresMaker: number;
    futuresTaker: number;
    okbDiscount: boolean;
  };
}

export interface ScanConfig {
  minSpotDepthUsd: number;
  minPerpDepthUsd: number;
  minOiUsd: number;
  maxBasisPct: number;
  maxSpreadPct: number;
  minHoldCycles: number;
  minNetYieldPerCycle: number;
  minFundingRate8h: number;
  oiFallThresholdPct: number;
  scanIntervalSeconds: number;
}

export interface AppConfig {
  fees: FeeConfig;
  scan: ScanConfig;
}
