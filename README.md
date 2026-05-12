# Funding Rate Scanner

A funding rate scanner for Binance and OKX perpetuals. Phase 1 of a cash-and-carry experiment — no live trading. The scanner polls both exchanges every 60 seconds, evaluates each perpetual pair against configurable thresholds, and serves a live dashboard with ranked opportunities.

See `doc/spec-4.md` for the full design rationale.

## Prerequisites

- Node 20+
- npm

## Setup

```bash
cp .env.example .env        # fill in API keys (optional but recommended)
# edit fees.json with your actual account fees — wrong fees produce wrong results
make install
make build
```

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `BINANCE_KEY` | No | Read-only key; improves rate limits |
| `BINANCE_SECRET` | No | Required if key is set |
| `OKX_KEY` | No | Read-only key; enables HMAC auth |
| `OKX_SECRET` | No | Required if key is set |
| `OKX_PASSPHRASE` | No | Required if key is set |
| `PORT` | No | Dashboard port (default: 3000) |

## Running

```bash
npm start       # production
make dev        # tsx watch — resets OI state on file save
```

Dashboard at `http://localhost:3000`.

## Make Commands

| Command | Description |
|---|---|
| `make install` | Install dependencies |
| `make build` | Compile TypeScript + bundle dashboard |
| `make clean` | Remove compiled output |
| `make dev` | Run with tsx watch (dev mode) |
| `make utest` | Unit tests — no network, fast |
| `make itest` | Integration tests — hits real APIs, requires `.env` |

## Fees

Edit `fees.json` before first run. Log into each exchange and verify your actual fee tier. The values in `fees.json` are conservative placeholders — using the wrong tier makes the scanner hallucinate profit.

## Logs

- `logs/scans.jsonl` — one JSON record per pair per scan cycle
- `logs/summary.jsonl` — one JSON summary per scan cycle

Both files are gitignored and created automatically on first run.

## Known Limitations

- **Binance funding rates are 1 period lagged.** Binance's public bulk endpoint (`/fapi/v1/premiumIndex`) returns `lastFundingRate` — the rate that settled at the previous 8-hour mark, not the currently accruing rate. This is noted in the dashboard. There is no public bulk endpoint for the current-period rate.
- OI trend is only tracked for pairs that pass the pre-filter. Pairs that temporarily drop below the pre-filter will have a stale OI baseline when they re-enter.

## Phases

| Phase | Status |
|---|---|
| 1 — Scanner + dashboard | This repo |
| 2 — Paper trade simulator | Not started |
| 3 — Live capital (small) | Not started |
