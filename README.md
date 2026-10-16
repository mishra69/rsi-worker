# RSI Stock Tracker

An installable RSI(14) momentum dashboard with push-notification alerts, served
from a single Cloudflare Worker. Built with the `pwa-cloudflare` skill.

---

## For Users

### Getting started

1. Open the app and **sign in with Google** — your lists are tied to your account and follow you to any device
2. Open **Configuration** and add your tickers
3. **Install it**: on iPhone/iPad tap Share → Add to Home Screen; on desktop Chrome use the install prompt
4. Tap **Turn on** in the banner, or later: tap your **avatar** → Settings → **Turn on notifications** (on iPhone this only works from the Home Screen app)

### Ticker lists

**TICKERS** — Individual stocks. Signals fire at:
- **BUY** when RSI ≤ 30 (oversold)
- **SELL** when RSI ≥ 70 (overbought)

**INDEX TICKERS** — Slow-moving ETFs and broad market instruments. Same SELL threshold but a lower BUY threshold:
- **BUY** when RSI < 50 (these move gradually, 30 is too late)
- **SELL** when RSI ≥ 70

### Alerts

Alert settings live in **Settings** (tap your avatar). Checked every 15 min. A notification fires when a ticker **crosses** a threshold while its market is in regular session (works for any exchange — US, NSE, ...). Every device you turn notifications on for gets the alert.

- **Test mode** — sends a full RSI snapshot every 15 min regardless of crossings
- **Send snapshot now** — one immediate snapshot to every channel
- **Tap the build stamp** at the bottom of Settings — sends a test push and shows the push service's raw status (201 ok, 403 VAPID mismatch, 410 subscription gone)
- **Telegram (fallback)** — tap *Get link code* and send `/subscribe CODE` to the bot; Telegram then gets the same alerts
- **Alert log** — at the bottom of the main page: every BUY/SELL crossing from the last 30 days

### Offline

The app opens offline and shows the last RSI table it fetched. Sign-in needs a connection.

---

## For Developers

### Stack

| Layer | Technology |
|---|---|
| Runtime | One Cloudflare Worker — static assets (`public/`) + `/api/*` |
| Scheduled jobs | Cron Trigger, every 15 min |
| Storage | Workers KV |
| Data source | Yahoo Finance chart API (unofficial, free) |
| Sign-in | Google Identity Services ID-token flow (no client secret), HMAC session tokens |
| Notifications | Web Push via [`webpush-edge`](https://github.com/mishra69/webpush-edge); Telegram Bot API as fallback |
| Frontend | Vanilla HTML/CSS/JS, service worker, no build step |

### Project structure

```
rsi-worker/
├── src/
│   ├── index.js          # router: /api/*, /telegram webhook, cron
│   └── lib/
│       ├── auth.js       # Google sign-in → HMAC session tokens
│       ├── oidc.js       # ID-token verification (skill asset)
│       ├── rsi.js        # Yahoo fetch + Wilder RSI
│       ├── store.js      # KV layout (documented at the top)
│       ├── push.js       # webpush-edge + endpoint index for rotation
│       └── alerts.js     # per-user crossing detection + delivery
├── public/               # the PWA shell (index.html, sw.js, manifest, icons, js/, css/, fonts/)
├── scripts/make-icons.py # regenerates public/icons/
├── deploy.sh + deploy.conf
├── .skill-assets         # which files are verbatim skill copies (check drift with sync-assets.sh)
└── wrangler.jsonc
```

### API

Public: `GET /api/config`, `GET /api/push/key`, `POST /api/push/rotate`, `POST /api/auth/google`, `POST /telegram` (bot webhook).

Bearer-token: `GET /api/me`, `GET|POST /api/tickers`, `GET /api/rsi?tickers=`, `GET /api/search?q=`,
`GET /api/push/status`, `POST /api/push/subscribe|unsubscribe|test`,
`GET /api/alerts/log`, `POST /api/alerts/test-mode|snapshot`, `POST /api/telegram/link|unlink`.

### Setup

```bash
npm install

# One-time: Google OAuth client (Web application), no secret needed.
# Authorized JavaScript origins: https://rsi-stock-tracker.mishabhi.workers.dev, http://localhost:8787
# Put the client ID in wrangler.jsonc → vars.GOOGLE_CLIENT_ID

# Secrets
npx wrangler secret put TOKEN_SECRET        # openssl rand -hex 32
npx wrangler secret put VAPID_PRIVATE_JWK   # from `npx webpush-edge-vapid`; public half is in wrangler.jsonc
npx wrangler secret put TELEGRAM_TOKEN      # fallback channel

# Deploy (stamps the version, deploys, waits for propagation, commits the stamp)
./deploy.sh
```

Local dev: put `TOKEN_SECRET` and `VAPID_PRIVATE_JWK` in `.dev.vars` (gitignored), then
`npx wrangler dev --test-scheduled` and trigger the cron with `curl localhost:8787/__scheduled`.

### Limits

- **Yahoo Finance**: unofficial API, no published rate limit. ~50 tickers per user is safe.
- **Workers free tier**: 100k requests/day. **KV free tier**: 100k reads/day, 1k writes/day — the cron writes one snapshot per user per run (~96/day/user).
