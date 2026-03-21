# RSI Stock Tracker

A serverless RSI(14) momentum dashboard with Telegram alerts, built entirely on Cloudflare Workers.

---

## For Users

### Getting started

1. Visit the app URL and a session is automatically created for you (`?s=` in the URL)
2. Bookmark or copy your session URL — this is how you restore your list on any device or share it
3. Open **Configuration** and add your tickers

### Ticker lists

**TICKERS** — Individual stocks. Signals fire at:
- **BUY** when RSI ≤ 30 (oversold)
- **SELL** when RSI ≥ 70 (overbought)

**INDEX TICKERS** — Slow-moving ETFs and broad market instruments. Same SELL threshold but a lower BUY threshold:
- **BUY** when RSI < 50 (these move gradually, 30 is too late)
- **SELL** when RSI ≥ 70

### Dashboard

- **BUY / SELL** tables show only actionable signals. Index tickers are tagged with `I`.
- **ALL** table shows every ticker's current RSI — collapsible, sortable by RSI value.
- **Auto-refresh** checkbox (bottom of page) — enabled by default, refreshes every 5 min while the tab is open.

### Telegram alerts

1. Open **Telegram Alerts** panel on the dashboard
2. Copy the `/subscribe ...` command shown and send it to the bot
3. Click **Check Status** to confirm subscription
4. Alerts fire every 15 min during US market hours (Mon–Fri, 9:30am–4pm ET) when a ticker **crosses** a threshold in that window

**Test mode** — tick the checkbox to receive a full RSI snapshot on every 15 min cron run, regardless of crossings or market hours. Use **Send Test Now** to trigger an immediate message without waiting for the cron.

To unsubscribe, click the button on the dashboard or send `/unsubscribe` to the bot.

---

## For Developers

### Stack

| Layer | Technology |
|---|---|
| Runtime | Cloudflare Workers (V8 isolates, edge) |
| Scheduled jobs | Cloudflare Cron Triggers |
| Storage | Cloudflare KV (key-value) |
| Data source | Yahoo Finance chart API (unofficial, free) |
| Notifications | Telegram Bot API |
| Frontend | Vanilla HTML/CSS/JS, inlined into the Worker |
| Deployment | Wrangler CLI |

Everything runs on Cloudflare's free tier. No server, no database, no build step.

### Project structure

```
rsi-worker/
├── src/
│   └── index.js        # Single file: Worker, HTML, all logic
├── wrangler.jsonc       # Cloudflare config (KV binding, cron schedule)
├── package.json
└── package-lock.json
```

### KV key schema

| Key | Value | Purpose |
|---|---|---|
| `s:{sid}:tickers` | `AAPL,MSFT,...` | Session ticker list |
| `s:{sid}:index_tickers` | `SPY,QQQ,...` | Session index ticker list |
| `snap:{sid}` | JSON `{TICKER: rsi}` | Last RSI snapshot for crossing detection |
| `subscribers` | JSON array | All Telegram subscribers |
| `tickers` | `AAPL,MSFT,...` | Legacy global ticker list (fallback) |
| `index_tickers` | `SPY,QQQ,...` | Legacy global index list (fallback) |

Subscriber object shape:
```json
{ "sessionId": "abc123", "chatId": 123456789, "testMode": false }
```

### API endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/` | Serves the dashboard HTML |
| `GET` | `/rsi?tickers=AAPL,MSFT` | Fetch RSI for tickers (max 30) |
| `GET` | `/tickers?s=SESSION` | Get session's ticker list |
| `POST` | `/tickers?s=SESSION` | Save session's ticker list |
| `GET` | `/index-tickers?s=SESSION` | Get session's index ticker list |
| `POST` | `/index-tickers?s=SESSION` | Save session's index ticker list |
| `GET` | `/sub-status?s=SESSION` | Get subscription status + testMode flag |
| `POST` | `/sub-test-mode?s=SESSION` | Toggle test mode for a session |
| `POST` | `/test-alert?s=SESSION` | Immediately send a test Telegram message |
| `POST` | `/unsubscribe?s=SESSION` | Unsubscribe from alerts |
| `POST` | `/telegram` | Telegram webhook receiver |
| `GET` | `/health` | Health check |

### Cron

Schedule: `*/15 * * * 1-5` (every 15 min, Mon–Fri)

The handler checks market hours (UTC 13:00–20:30 ≈ ET 9:00am–4:30pm). Subscribers with `testMode: true` bypass the market hours check.

Alert logic: for each subscriber, fetch current RSI for all their tickers, compare against the last snapshot (`snap:{sid}`), fire a Telegram message only if a ticker **crossed** its threshold since the last run.

### Setup

```bash
npm install
npx wrangler login

# Set the Telegram bot token as an encrypted secret
npx wrangler secret put TELEGRAM_TOKEN

# Register Telegram webhook (one-time)
curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://rsi-stock-tracker.YOUR-SUBDOMAIN.workers.dev/telegram"

# Deploy
npm run deploy

# Local dev
npm run dev
```

### RSI calculation

Uses Wilder's smoothing method over 14 periods. Fetches ~4 months of daily closes from Yahoo Finance to ensure the RSI is well-stabilised before reporting the value.

### Limits

- **Yahoo Finance**: unofficial API, no published rate limit. ~50 tickers per session is safe; beyond that you risk sporadic 429s from Cloudflare's shared egress IPs.
- **Cloudflare Workers free tier**: 100k requests/day, 10ms CPU per invocation.
- **KV free tier**: 100k reads/day, 1k writes/day.
