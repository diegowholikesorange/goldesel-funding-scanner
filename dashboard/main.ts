// Duplicated from src/types.ts — keep in sync manually; no build-time check enforces this.
type Exchange = "BINANCE" | "OKX";
type OiTrend = "rising" | "falling" | "stable" | "unknown";
type Flag =
  | "FUNDING_NOT_POSITIVE" | "FUNDING_BELOW_MINIMUM" | "INSUFFICIENT_SPOT_DEPTH"
  | "INSUFFICIENT_PERP_DEPTH" | "INSUFFICIENT_OI" | "BASIS_TOO_STRETCHED" | "SPREAD_TOO_WIDE"
  | "OI_UNWINDING" | "YIELD_BELOW_THRESHOLD";

interface PairSnapshot {
  timestamp: string; exchange: Exchange; pair: string;
  spotPrice: number; perpPrice: number; basisPct: number;
  fundingRate8h: number; fundingRateAnnualised: number;
  nextFundingTime: string; predictedNextRate: number | null;
  spotSpreadPct: number; perpSpreadPct: number;
  spotDepth10bpsUsd: number; perpDepth10bpsUsd: number;
  oiRaw: number | null; oiTrend: OiTrend;
  entryFeeEst: number; exitFeeEst: number; roundTripFee: number;
  minCyclesToBreakeven: number; projectedYieldPerCycle: number;
  projectedNetYieldPerCycle: number; passes: boolean; flags: Flag[];
}

interface MarketSentiment {
  avgFunding8h: number; avgAbsFunding8h: number; pctPositive: number;
  totalOiUsd: number; pctRisingOi: number; pctFallingOi: number;
}

interface ScanEndPayload {
  scannedAt: string; totalPairs: number; passingCount: number; skipCount: number;
  errors: Array<{ exchange: Exchange; message: string; timestamp: string }>;
  sentiment: MarketSentiment;
}

const STALE_THRESHOLD_MS = 90_000;

let lastScannedAt: Date | null = null;
let metaBase = "";
let currentCycleKeys = new Set<string>();
const dismissedErrors = new Set<string>();

const tiles = new Map<string, HTMLElement>();
const tileSnapshots = new Map<string, PairSnapshot>();

function fmt(n: number, decimals = 4): string { return n.toFixed(decimals); }

function fmtUsd(n: number): string {
  if (n >= 1e12) return `$${(n / 1e12).toFixed(1)}T`;
  if (n >= 1e9)  return `$${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6)  return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3)  return `$${(n / 1e3).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}

function td(text: string, className?: string): HTMLTableCellElement {
  const el = document.createElement("td");
  el.textContent = text;
  if (className) el.className = className;
  return el;
}

function rowKey(s: PairSnapshot): string { return `${s.exchange}:${s.pair}`; }
function ticker(pair: string): string { return pair.split("-")[0]; }

function flash(el: HTMLElement): void {
  el.classList.remove("flash");
  void el.offsetWidth;
  el.classList.add("flash");
  el.addEventListener("animationend", () => el.classList.remove("flash"), { once: true });
}

// ─── Market Sentiment ─────────────────────────────────────────────────────────

function sentimentLabel(avg: number): string {
  if (avg < 0.003) return "FLAT";
  if (avg < 0.008) return "DRIFTING LONG";
  if (avg < 0.02)  return "BULLISH";
  if (avg < 0.05)  return "STRONG BULL";
  return "EUPHORIC";
}

function heatLabel(avg: number): [string, number] {
  if (avg < 0.003) return ["DORMANT",  1];
  if (avg < 0.01)  return ["QUIET",    2];
  if (avg < 0.03)  return ["MODERATE", 3];
  if (avg < 0.08)  return ["ACTIVE",   4];
  return             ["HEATED",   5];
}

function renderSentiment(s: MarketSentiment): void {
  // Direction meter: avg maps [-0.1%, +0.1%] → [0%, 100%]
  const meterPct = Math.min(100, Math.max(0, (s.avgFunding8h + 0.1) / 0.2 * 100));
  (document.getElementById("sentiment-needle") as HTMLElement).style.left = `${meterPct}%`;
  document.getElementById("sentiment-label")!.textContent = sentimentLabel(s.avgFunding8h);
  document.getElementById("sentiment-sub")!.textContent = `avg ${fmt(s.avgFunding8h)}% / 8h · ${Math.round(s.pctPositive * 100)}% positive`;

  // Heat segments
  const [label, segs] = heatLabel(s.avgAbsFunding8h);
  for (let i = 1; i <= 5; i++) {
    const seg = document.getElementById(`hs${i}`)!;
    seg.className = `heat-seg${i <= segs ? ` on-${i}` : ""}`;
  }
  document.getElementById("heat-label")!.textContent = label;
  document.getElementById("heat-sub")!.textContent = `avg |${fmt(s.avgAbsFunding8h)}%| / 8h`;

  // Open interest
  document.getElementById("oi-total")!.textContent = s.totalOiUsd > 0 ? fmtUsd(s.totalOiUsd) : "—";
  const risePct  = Math.round(s.pctRisingOi  * 100);
  const fallPct  = Math.round(s.pctFallingOi * 100);
  const stablePct = 100 - risePct - fallPct;
  document.getElementById("oi-rise")!.textContent   = `↑ ${risePct}% rising`;
  document.getElementById("oi-stable")!.textContent = `→ ${stablePct}% stable`;
  document.getElementById("oi-fall")!.textContent   = `↓ ${fallPct}% falling`;
}

// ─── Tooltip ──────────────────────────────────────────────────────────────────

const tooltipEl = document.getElementById("tile-tooltip")!;

function showTooltip(e: MouseEvent, s: PairSnapshot): void {
  const oi = s.oiRaw !== null ? `<div class="tt-stat">OI ${fmtUsd(s.oiRaw)} · Ann ${fmt(s.fundingRateAnnualised, 1)}%</div>` : "";
  const statusHtml = s.passes
    ? `<div class="tt-pass">All criteria met</div>`
    : s.flags.map(f => `<div class="tt-flag">${f.replace(/_/g, " ")}</div>`).join("");
  tooltipEl.innerHTML = `
    <div class="tt-header">
      <span class="tt-pair">${s.pair}</span>
      <span class="tt-exch">${s.exchange}</span>
    </div>
    <div class="tt-stat">Rate/8h <span class="pos">${fmt(s.fundingRate8h)}%</span></div>
    ${oi}
    <div class="tt-divider"></div>
    ${statusHtml}
  `;
  tooltipEl.hidden = false;
  positionTooltip(e);
}

function positionTooltip(e: MouseEvent): void {
  const pad = 14;
  let x = e.clientX + pad;
  let y = e.clientY - tooltipEl.offsetHeight - pad;
  if (x + tooltipEl.offsetWidth > window.innerWidth - 8) x = e.clientX - tooltipEl.offsetWidth - pad;
  if (y < 8) y = e.clientY + pad;
  tooltipEl.style.left = `${x}px`;
  tooltipEl.style.top = `${y}px`;
}

function hideTooltip(): void { tooltipEl.hidden = true; }

// ─── Tile Map ─────────────────────────────────────────────────────────────────

const tileMapEl = document.getElementById("tile-map")!;

function insertTileSorted(tile: HTMLElement, pair: string): void {
  const children = Array.from(tileMapEl.children) as HTMLElement[];
  const before = children.find(el => ((el.dataset.key ?? "").split(":")[1] ?? "") > pair);
  if (before) tileMapEl.insertBefore(tile, before);
  else tileMapEl.appendChild(tile);
}

function upsertTile(s: PairSnapshot): void {
  const key = rowKey(s);
  tileSnapshots.set(key, s);

  let tile = tiles.get(key);
  if (!tile) {
    tile = document.createElement("div");
    tile.className = "tile";
    tile.dataset.key = key;
    tile.textContent = ticker(s.pair);
    insertTileSorted(tile, s.pair);
    tiles.set(key, tile);
    tile.addEventListener("mouseenter", (e) => showTooltip(e, tileSnapshots.get(key)!));
    tile.addEventListener("mousemove", positionTooltip);
    tile.addEventListener("mouseleave", hideTooltip);
  }

  tile.dataset.updatedAt = String(Date.now());
  tile.style.opacity = "1";
  tile.classList.remove("tile-pass", "tile-fail", "tile-pending");
  tile.classList.add(s.passes ? "tile-pass" : "tile-fail");
  flash(tile);
  updateProgress();
}

// ─── Passing Table ────────────────────────────────────────────────────────────

const passingTbody = document.querySelector("#passing-table tbody")!;

function buildPassingRow(s: PairSnapshot): HTMLTableRowElement {
  const tr = document.createElement("tr");
  tr.className = "pass";
  tr.dataset.key = rowKey(s);
  tr.dataset.annualised = String(s.fundingRateAnnualised);
  const netClass = s.projectedNetYieldPerCycle >= 0 ? "pos" : "neg";
  const pred = s.predictedNextRate !== null ? `${fmt(s.predictedNextRate)}%` : "—";
  const rankTd = document.createElement("td");
  rankTd.className = "rank";
  tr.append(
    rankTd, td(s.pair), td(s.exchange),
    td(`${fmt(s.fundingRate8h)}%`, "pos"),
    td(`${fmt(s.fundingRateAnnualised, 1)}%`),
    td(`${fmt(s.projectedNetYieldPerCycle)}%`, netClass),
    td(`${fmt(s.basisPct)}%`),
    td(pred),
    td(s.oiRaw !== null ? fmtUsd(s.oiRaw) : "—"),
  );
  return tr;
}

function refreshPassingRanks(): void {
  const rows = Array.from(passingTbody.querySelectorAll<HTMLTableRowElement>("tr[data-key]"));
  rows.sort((a, b) => parseFloat(b.dataset.annualised ?? "0") - parseFloat(a.dataset.annualised ?? "0"));
  rows.forEach((tr, i) => {
    const rankTd = tr.querySelector<HTMLElement>(".rank");
    if (rankTd) rankTd.textContent = String(i + 1);
    passingTbody.appendChild(tr);
  });
  document.getElementById("passing-count")!.textContent = `(${rows.length})`;
  document.getElementById("passing-empty")!.hidden = rows.length > 0;
}

// ─── Pair upsert ──────────────────────────────────────────────────────────────

function upsertPair(s: PairSnapshot): void {
  const key = rowKey(s);
  currentCycleKeys.add(key);
  upsertTile(s);
  if (s.passes) {
    const existing = passingTbody.querySelector<HTMLTableRowElement>(`tr[data-key="${key}"]`);
    const newRow = buildPassingRow(s);
    if (existing) existing.replaceWith(newRow); else passingTbody.appendChild(newRow);
    flash(newRow);
    refreshPassingRanks();
  } else {
    const removed = passingTbody.querySelector(`tr[data-key="${key}"]`);
    if (removed) { removed.remove(); refreshPassingRanks(); }
  }
}

// ─── Scan lifecycle ───────────────────────────────────────────────────────────

function onScanStart(): void {
  currentCycleKeys = new Set();
  passingTbody.querySelectorAll<HTMLElement>("tr[data-key]").forEach(tr => tr.classList.add("row-stale"));
}

function onScanEnd(payload: ScanEndPayload): void {
  lastScannedAt = new Date(payload.scannedAt);
  const skipPart = payload.skipCount > 0 ? `, ${payload.skipCount} skipped` : "";
  metaBase = `${payload.scannedAt} — ${payload.totalPairs} pairs scanned, ${payload.passingCount} passing${skipPart}`;
  document.getElementById("meta")!.textContent = metaBase;
  document.getElementById("meta")!.classList.remove("stale");

  const errorExchanges = new Set(
    payload.errors.filter(e => !/^[A-Z0-9]+-USDT/.test(e.message)).map(e => e.exchange)
  );

  for (const [key, tile] of tiles) {
    if (!currentCycleKeys.has(key)) {
      const exchange = key.split(":")[0] as Exchange;
      if (!errorExchanges.has(exchange)) { tile.remove(); tiles.delete(key); tileSnapshots.delete(key); }
    }
  }

  passingTbody.querySelectorAll<HTMLTableRowElement>("tr[data-key]").forEach(tr => {
    if (!currentCycleKeys.has(tr.dataset.key!)) tr.remove();
    else tr.classList.remove("row-stale");
  });

  refreshPassingRanks();

  const passCount = Array.from(tiles.values()).filter(t => t.classList.contains("tile-pass")).length;
  const summaryEl = document.getElementById("tile-summary");
  if (summaryEl) {
    summaryEl.innerHTML = passCount > 0
      ? `${tiles.size} pairs · <span class="pos">${passCount} passing</span>`
      : `${tiles.size} pairs · <span style="color:#484f58">none passing</span>`;
  }

  if (payload.sentiment) renderSentiment(payload.sentiment);
  renderErrors(payload.errors);
}

function renderErrors(errors: ScanEndPayload["errors"]): void {
  const container = document.getElementById("errors")!;
  container.textContent = "";
  for (const err of errors) {
    if (/^[A-Z0-9]+-USDT/.test(err.message)) continue;
    const key = `${err.exchange}:${err.timestamp}`;
    if (dismissedErrors.has(key)) continue;
    const div = document.createElement("div");
    div.className = "banner";
    const msg = document.createElement("span");
    msg.textContent = `${err.exchange} unavailable this cycle — results may be incomplete: ${err.message}`;
    const btn = document.createElement("button");
    btn.setAttribute("aria-label", "Dismiss");
    btn.textContent = "✕";
    btn.addEventListener("click", () => { dismissedErrors.add(key); div.remove(); });
    div.appendChild(msg);
    div.appendChild(btn);
    container.appendChild(div);
  }
}

// ─── Age ticker ───────────────────────────────────────────────────────────────

setInterval(() => {
  const now = Date.now();

  for (const tile of tiles.values()) {
    const updatedAt = parseInt(tile.dataset.updatedAt ?? "0");
    if (updatedAt > 0) {
      tile.style.opacity = String(Math.max(0.2, 1 - (now - updatedAt) / STALE_THRESHOLD_MS));
    }
  }

  if (!lastScannedAt) return;
  const ageMs = now - lastScannedAt.getTime();
  const ageSec = Math.floor(ageMs / 1000);
  const meta = document.getElementById("meta")!;
  if (ageMs > STALE_THRESHOLD_MS) {
    meta.textContent = `${metaBase} — ⚠ scanner may have stalled (${ageSec}s ago)`;
    meta.classList.add("stale");
  } else {
    meta.textContent = `${metaBase} — updated ${ageSec}s ago`;
    meta.classList.remove("stale");
  }
}, 1000);

// ─── Startup sequence ─────────────────────────────────────────────────────────

const progressEl     = document.getElementById("scan-progress") as HTMLElement;
const progressBarEl  = document.getElementById("scan-progress-bar") as HTMLElement;
const progressTextEl = document.getElementById("scan-progress-text") as HTMLElement;

function updateProgress(): void {
  if (progressEl.hidden) return;
  const total   = tiles.size;
  const pending = Array.from(tiles.values()).filter(t => t.classList.contains("tile-pending")).length;
  const done    = total - pending;
  const pct     = total > 0 ? (done / total) * 100 : 0;
  progressBarEl.style.setProperty("--pct", `${pct.toFixed(1)}%`);
  progressTextEl.textContent = `${done} / ${total}`;
}

function createPlaceholderTile(exchange: string, pair: string): void {
  const key = `${exchange}:${pair}`;
  if (tiles.has(key)) return;
  const tile = document.createElement("div");
  tile.className = "tile tile-pending";
  tile.dataset.key = key;
  tile.textContent = ticker(pair);
  insertTileSorted(tile, pair);
  tiles.set(key, tile);
  tile.addEventListener("mouseenter", (e) => { const s = tileSnapshots.get(key); if (s) showTooltip(e, s); });
  tile.addEventListener("mousemove", positionTooltip);
  tile.addEventListener("mouseleave", hideTooltip);
}

// ─── SSE ──────────────────────────────────────────────────────────────────────

// Two-phase startup:
//   symbolsReady — placeholder tiles have been drawn from /symbols
//   ready        — a scan-start arrived after symbolsReady; live pairs now update tiles
//
// When scan-start fires we DISCARD the buffer (stale mid-scan pairs from before the
// tiles existed) so the scan always proceeds in clean alphabetical order.

let symbolsReady = false;
let ready = false;
const pairBuffer: PairSnapshot[] = [];

function flushBuffer(): void {
  for (const s of pairBuffer) upsertPair(s);
  pairBuffer.length = 0;
}

const stream = new EventSource("/stream");

stream.addEventListener("pair", (e: MessageEvent) => {
  const s = JSON.parse(e.data) as PairSnapshot;
  if (ready) upsertPair(s); else pairBuffer.push(s);
});

stream.addEventListener("scan-start", async () => {
  if (!symbolsReady) return;
  if (!ready) {
    // Re-fetch the symbol list so any symbols that arrived after the initial
    // /symbols call (e.g. OKX recovered mid-session) get placeholder tiles too.
    try {
      const syms = await fetch("/symbols").then(r => r.json()) as Array<{ exchange: string; pair: string }>;
      for (const { exchange, pair } of syms) createPlaceholderTile(exchange, pair);
      if (tiles.size > 0) { progressEl.hidden = false; updateProgress(); }
    } catch {}
    pairBuffer.length = 0;  // discard stale mid-scan data accumulated so far
    ready = true;
  }
  onScanStart();
});

stream.addEventListener("scan-end", (e: MessageEvent) => {
  if (!ready) {
    if (!symbolsReady) return;  // tiles not created yet — ignore
    // scan-start was missed (arrived before symbolsReady); show partial results
    ready = true;
    flushBuffer();
  }
  progressEl.hidden = true;
  onScanEnd(JSON.parse(e.data) as ScanEndPayload);
});

// Fetch the symbol registry, build sorted placeholder tiles, then wait for scan-start.
(async () => {
  document.getElementById("meta")!.textContent = "Fetching symbol list…";
  try {
    const symbols = await fetch("/symbols").then(r => r.json()) as Array<{ exchange: string; pair: string }>;
    if (symbols.length > 0) {
      for (const { exchange, pair } of symbols) createPlaceholderTile(exchange, pair);
      progressEl.hidden = false;
      updateProgress();
    }
  } catch {
    // ignore — tiles will be created on-the-fly as pairs arrive
  }
  symbolsReady = true;
})();
