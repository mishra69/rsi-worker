// RSI Stock Tracker — Cloudflare Worker
// Serves the dashboard UI and RSI API. Persists tickers in KV.

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const DEFAULT_TICKERS = "AAPL,MSFT,GOOGL,AMZN,TSLA,NVDA,META,SPY,QQQ,AMD";
const TICKERS_KV_KEY = "tickers";
const INDEX_TICKERS_KV_KEY = "index_tickers";

function computeRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;

  let gainSum = 0;
  let lossSum = 0;

  for (let i = 1; i <= period; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) gainSum += change;
    else lossSum += Math.abs(change);
  }

  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;

  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? Math.abs(change) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function getZone(rsi) {
  if (rsi === null) return "no_data";
  if (rsi <= 30) return "oversold";
  if (rsi >= 70) return "overbought";
  if (rsi < 50) return "below_midline";
  return "above_midline";
}

async function fetchRSI(ticker) {
  const now = Math.floor(Date.now() / 1000);
  const fourMonthsAgo = now - 120 * 24 * 60 * 60;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?period1=${fourMonthsAgo}&period2=${now}&interval=1d`;

  try {
    const resp = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; RSI-Tracker/1.0)" },
    });

    if (!resp.ok) {
      return { ticker, rsi: null, zone: "error", error: `HTTP ${resp.status}` };
    }

    const data = await resp.json();
    const result = data?.chart?.result?.[0];

    if (!result || !result.indicators?.quote?.[0]?.close) {
      return { ticker, rsi: null, zone: "error", error: "No price data" };
    }

    const closes = result.indicators.quote[0].close.filter((c) => c !== null);

    if (closes.length < 15) {
      return { ticker, rsi: null, zone: "error", error: "Insufficient data" };
    }

    const rsi = computeRSI(closes, 14);
    const lastClose = closes[closes.length - 1];
    const prevClose = closes[closes.length - 2];
    const changePercent = prevClose ? ((lastClose - prevClose) / prevClose) * 100 : 0;

    return {
      ticker: ticker.toUpperCase(),
      rsi: rsi !== null ? Math.round(rsi * 100) / 100 : null,
      zone: getZone(rsi),
      price: Math.round(lastClose * 100) / 100,
      changePercent: Math.round(changePercent * 100) / 100,
      marketState: result.meta?.marketState ?? null,
      currency: result.meta?.currency ?? null,
      error: null,
    };
  } catch (err) {
    return { ticker, rsi: null, zone: "error", error: err.message };
  }
}

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>RSI Tracker</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    :root {
      --bg: #0a0e17;
      --surface: rgba(255,255,255,0.02);
      --border: rgba(255,255,255,0.06);
      --border-light: rgba(255,255,255,0.08);
      --text: #e2e8f0;
      --text-dim: #94a3b8;
      --text-muted: #475569;
      --text-faint: #334155;
      --green: #00e676;
      --orange: #ffa726;
      --red: #ff5252;
      --neutral: #90a4ae;
      --mono: 'JetBrains Mono', 'SF Mono', 'Fira Code', monospace;
      --sans: 'Inter', -apple-system, system-ui, sans-serif;
    }

    body {
      background: var(--bg);
      color: var(--text);
      font-family: var(--sans);
      min-height: 100vh;
      padding: 32px 24px;
      -webkit-font-smoothing: antialiased;
    }

    .container { max-width: 920px; margin: 0 auto; }

    .header { display: flex; align-items: baseline; gap: 12px; margin-bottom: 4px; }
    .header h1 {
      font-family: var(--mono);
      font-size: 22px;
      font-weight: 700;
      letter-spacing: -0.5px;
    }
    .header .badge {
      font-family: var(--mono);
      font-size: 10px;
      color: var(--text-muted);
      letter-spacing: 1px;
    }

    .status-bar {
      display: flex; align-items: center; gap: 16px;
      margin-bottom: 24px;
      font-family: var(--mono); font-size: 11px; color: var(--text-muted);
    }
    .status-bar .green { color: var(--green); }
    .status-bar .red { color: var(--red); }
    .status-bar .orange { color: var(--orange); }

    .config-panel {
      margin-bottom: 24px;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 8px;
    }
    .config-toggle {
      width: 100%; padding: 12px 20px;
      background: none; border: none; cursor: pointer;
      display: flex; justify-content: space-between; align-items: center;
      font-family: var(--mono); font-size: 11px; color: var(--text-dim);
      letter-spacing: 1px; border-radius: 8px 8px 0 0;
    }
    .config-toggle .arrow { font-size: 14px; transition: transform 0.2s; }
    .config-toggle .arrow.open { transform: rotate(180deg); }
    .config-body {
      padding: 0 20px 20px;
      display: flex; flex-direction: column; gap: 14px;
    }
    .config-body.hidden { display: none; }
    .field-label {
      display: block;
      font-family: var(--mono); font-size: 10px;
      color: #64748b; margin-bottom: 6px; letter-spacing: 1px;
    }
    .field-input {
      width: 100%; padding: 10px 14px;
      background: rgba(255,255,255,0.03);
      border: 1px solid var(--border-light);
      border-radius: 6px; color: var(--text);
      font-family: var(--mono); font-size: 13px;
      outline: none; transition: border-color 0.2s;
    }
    .field-input:focus { border-color: rgba(255,255,255,0.25); }
    .field-input::placeholder { color: var(--text-muted); }
    .field-textarea { resize: none; overflow: hidden; line-height: 1.6; }
    .search-dropdown {
      position: absolute; top: 100%; left: 0; right: 0; z-index: 100;
      background: #1e293b; border: 1px solid var(--border-light);
      border-radius: 0 0 6px 6px; overflow: hidden;
    }
    .search-result {
      display: flex; align-items: center; gap: 10px;
      padding: 9px 14px; border-bottom: 1px solid rgba(255,255,255,0.04);
      cursor: default;
    }
    .search-result:last-child { border-bottom: none; }
    .search-result:hover { background: rgba(255,255,255,0.05); }
    .search-symbol { font-family: var(--mono); font-weight: 700; font-size: 13px; min-width: 100px; }
    .search-name { font-size: 12px; color: var(--text-dim); flex: 1; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
    .search-add-btn { font-family: var(--mono); font-size: 10px; padding: 3px 7px; border-radius: 3px; border: 1px solid var(--border-light); background: none; color: var(--text-dim); cursor: pointer; white-space: nowrap; }
    .search-add-btn:hover { border-color: var(--text-dim); color: var(--text); }

    .btn {
      align-self: flex-start;
      padding: 10px 28px;
      background: rgba(255,255,255,0.08);
      border: 1px solid rgba(255,255,255,0.12);
      border-radius: 6px; cursor: pointer;
      font-family: var(--mono); font-size: 12px; font-weight: 600;
      color: var(--text); letter-spacing: 0.5px;
      transition: all 0.2s;
    }
    .btn:hover { background: rgba(255,255,255,0.12); }
    .btn:disabled { color: var(--text-muted); cursor: wait; background: #1e293b; }
    .btn-refresh { padding: 6px 16px; font-size: 11px; }

    .checkbox-label {
      display: flex; align-items: center; gap: 8px; cursor: pointer;
      font-family: var(--mono); font-size: 10px; color: var(--text-muted);
      letter-spacing: 0.5px;
    }
    .checkbox-label input[type="checkbox"] { accent-color: var(--green); cursor: pointer; }

    .saved-flash {
      font-family: var(--mono); font-size: 10px;
      color: var(--green); opacity: 0;
      transition: opacity 0.3s;
    }
    .saved-flash.show { opacity: 1; }

    .error-box {
      margin-bottom: 20px; padding: 12px 20px;
      background: rgba(255,82,82,0.06);
      border: 1px solid rgba(255,82,82,0.2);
      border-radius: 8px;
      font-family: var(--mono); font-size: 12px; color: var(--red);
    }

    .alert-banner {
      margin: 0 0 20px; padding: 14px 20px;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 8px;
      display: flex; flex-wrap: wrap; gap: 10px; align-items: center;
    }
    .alert-banner .label {
      font-family: var(--mono); font-size: 11px;
      color: var(--orange); font-weight: 600; letter-spacing: 1px;
    }
    .alert-chip {
      display: inline-flex; align-items: center; gap: 6px;
      border-radius: 4px; padding: 4px 10px;
      font-family: var(--mono); font-size: 12px; font-weight: 600;
    }
    .alert-chip .rsi-small { font-size: 10px; opacity: 0.7; }

    .table-wrap {
      border: 1px solid var(--border);
      border-radius: 8px; overflow: hidden;
    }
    .help-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 20px;
    }
    .help-block { display: flex; flex-direction: column; gap: 8px; }
    .help-title {
      font-family: var(--mono); font-size: 10px; font-weight: 600;
      color: var(--text-dim); letter-spacing: 1px; text-transform: uppercase;
    }
    .help-text {
      font-family: var(--sans); font-size: 12px;
      color: var(--text-muted); line-height: 1.7;
    }
    .help-text b { color: var(--text-dim); font-weight: 600; }
    @media (max-width: 600px) { .help-grid { grid-template-columns: 1fr; } }

    .section-header {
      display: flex; align-items: baseline; gap: 12px;
      padding: 20px 4px 10px;
    }
    .section-header.buy .section-title { color: var(--green); }
    .section-header.sell .section-title { color: var(--red); }
    .section-header.index .section-title { color: var(--orange); }

    .all-toggle {
      width: 100%; margin-top: 20px;
      background: none; border: none; cursor: pointer;
      display: flex; justify-content: space-between; align-items: center;
      padding: 10px 4px;
    }
    .all-toggle .arrow { font-size: 14px; transition: transform 0.2s; color: var(--text-muted); }
    .all-toggle .arrow.open { transform: rotate(180deg); }
    .sort-btn {
      font-family: var(--mono); font-size: 10px; letter-spacing: 1px;
      color: var(--text-muted); cursor: pointer; user-select: none;
      padding: 3px 8px; border: 1px solid var(--border); border-radius: 4px;
    }
    .sort-btn:hover { border-color: var(--border-light); color: var(--text); }
    .section-title {
      font-family: var(--mono); font-size: 18px; font-weight: 700; letter-spacing: 1px;
    }
    .section-sub {
      font-family: var(--mono); font-size: 10px; color: var(--text-muted); letter-spacing: 1px;
    }

    .table-header, .table-row {
      display: grid;
      grid-template-columns: 120px 84px 68px 1fr 80px;
      gap: 12px; padding: 10px 20px; align-items: center;
    }
    .table-header {
      background: var(--surface);
      border-bottom: 1px solid var(--border);
      font-family: var(--mono); font-size: 9px;
      color: var(--text-muted); letter-spacing: 1.5px; text-transform: uppercase;
    }
    .table-row {
      padding: 14px 20px;
      border-bottom: 1px solid rgba(255,255,255,0.04);
      border-left: 3px solid transparent;
      transition: background 0.3s;
      animation: rowIn 0.3s ease both;
    }
    .table-row.alert-oversold { background: rgba(0,230,118,0.06); border-left-color: var(--green); }
    .table-row.alert-overbought { background: rgba(255,82,82,0.06); border-left-color: var(--red); }

    .col-ticker { font-family: var(--mono); font-weight: 700; font-size: 14px; letter-spacing: 0.5px; display: flex; align-items: center; gap: 4px; overflow: hidden; }
    .ticker-text { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; min-width: 0; }
    .col-price { font-family: var(--mono); font-size: 13px; color: var(--text-dim); }
    .col-change { font-family: var(--mono); font-size: 12px; }
    .col-change.up { color: var(--green); }
    .col-change.down { color: var(--red); }
    .col-change.flat { color: #616161; }
    .col-rsi { font-family: var(--mono); font-size: 20px; font-weight: 700; text-align: right; }
    .rsi-bar {
      position: relative; height: 6px;
      background: #1e293b; border-radius: 3px;
      width: 100%; overflow: hidden;
    }
    .rsi-bar .marker { position: absolute; width: 1px; height: 100%; background: rgba(255,255,255,0.08); }
    .rsi-bar .fill { height: 100%; border-radius: 3px; transition: width 0.6s cubic-bezier(0.22,1,0.36,1), background 0.4s; }

    .empty {
      text-align: center; padding: 60px 20px;
      font-family: var(--mono); font-size: 13px; color: var(--text-faint);
    }

    .legend {
      margin-top: 24px; padding: 16px 20px;
      display: flex; flex-wrap: wrap; gap: 20px;
      font-family: var(--mono); font-size: 10px; color: var(--text-muted);
    }
    .legend .auto { margin-left: auto; }

    @keyframes rowIn {
      from { opacity: 0; transform: translateY(8px); }
      to { opacity: 1; transform: translateY(0); }
    }

    .table-header-all, .table-row-all {
      grid-template-columns: 120px 84px 68px 1fr 80px 90px !important;
    }
    .col-signal {
      font-family: var(--mono); font-size: 10px; font-weight: 600;
      letter-spacing: 1px; text-align: center;
    }
    .index-tag {
      font-family: var(--mono); font-size: 8px; font-weight: 700;
      color: var(--orange); opacity: 0.7; vertical-align: middle;
      border: 1px solid var(--orange); border-radius: 3px;
      padding: 1px 3px; margin-left: 3px;
    }

    @media (max-width: 700px) {
      body { padding: 16px 12px; }
      .table-header, .table-row {
        grid-template-columns: 90px 68px 56px 1fr 60px;
        gap: 6px; padding: 10px 12px;
      }
      .table-header-all, .table-row-all {
        grid-template-columns: 90px 64px 48px 1fr 52px 52px !important;
      }
      .col-ticker { font-size: 12px; }
      .col-rsi { font-size: 16px; }
    }
  </style>
</head>
<body>
  <div class="container" id="app">
    <div class="header">
      <h1>RSI TRACKER</h1>
      <span class="badge">RSI(14) · DAILY</span>
    </div>
    <div class="status-bar" id="statusBar"></div>

    <div class="config-panel">
      <button class="config-toggle" id="configToggle">
        <span>CONFIGURATION</span>
        <span class="arrow open" id="configArrow">▾</span>
      </button>
      <div class="config-body hidden" id="configBody">
        <div style="position:relative;">
          <label class="field-label">SEARCH — find ticker by company name</label>
          <input class="field-input" id="searchInput" type="text" placeholder="e.g. Apple, Reliance, HDFC" autocomplete="off">
          <div id="searchDropdown" class="search-dropdown" style="display:none;"></div>
        </div>
        <div>
          <label class="field-label">TICKERS — alert below 30 or above 70</label>
          <textarea class="field-input field-textarea" id="tickersInput"
            placeholder="AAPL,MSFT,GOOGL,TSLA" rows="3"></textarea>
        </div>
        <div>
          <label class="field-label">INDEX TICKERS — also alert below 50</label>
          <textarea class="field-input field-textarea" id="indexTickersInput"
            placeholder="BHP,CBA,WBC" rows="3"></textarea>
        </div>
        <div>
          <label class="field-label">YOUR SESSION URL — bookmark or share to restore on any device</label>
          <div style="display:flex;gap:8px;">
            <input class="field-input" id="sessionUrlInput" type="text" readonly style="color:var(--text-muted);cursor:default;">
            <button class="btn" id="copyUrlBtn" style="align-self:stretch;white-space:nowrap;">COPY</button>
          </div>
        </div>
        <div style="display:flex;align-items:center;gap:12px;">
          <button class="btn" id="fetchBtn">UPDATE LIST</button>
          <span class="saved-flash" id="savedFlash">✓ Saved</span>
        </div>
      </div>
    </div>

    <div class="config-panel" id="telegramPanel">
      <button class="config-toggle" id="telegramToggle">
        <span>TELEGRAM ALERTS</span>
        <span class="arrow" id="telegramArrow">▾</span>
      </button>
      <div class="config-body hidden" id="telegramBody">
        <div id="subStatusBox"></div>
        <div id="subInstructions" style="display:none;">
          <p class="hint" style="margin-bottom:12px;">To subscribe, send this command to <b style="color:var(--text)">@abhi_284_rsi_alert_bot</b> on Telegram:</p>
          <div style="display:flex;gap:8px;align-items:center;">
            <input class="field-input" id="subCommandInput" type="text" readonly style="color:var(--text-muted);cursor:default;font-size:12px;">
            <button class="btn" id="copySubBtn" style="align-self:stretch;white-space:nowrap;">COPY</button>
          </div>
          <p class="hint" style="margin-top:10px;">After sending the command, click <b style="color:var(--text)">Check status</b> below to confirm.</p>
          <div style="display:flex;gap:8px;margin-top:4px;">
            <button class="btn" id="checkSubBtn">CHECK STATUS</button>
          </div>
        </div>
        <div id="subConfirmed" style="display:none;">
          <p class="hint" style="margin-bottom:14px;color:var(--green);">✓ Subscribed — you'll receive alerts when a ticker enters BUY or SELL territory.</p>
          <label class="checkbox-label" style="margin-bottom:14px;">
            <input type="checkbox" id="testModeChk">
            <span>Test mode — send a full RSI snapshot on every check regardless of crossings</span>
          </label>
          <div style="display:flex;gap:8px;margin-bottom:14px;">
            <button class="btn" id="sendTestNowBtn">SEND TEST NOW</button>
            <span class="saved-flash" id="testSentFlash">✓ Sent</span>
          </div>
          <button class="btn" id="unsubBtn">UNSUBSCRIBE</button>
        </div>
      </div>
    </div>

    <div class="config-panel">
      <button class="config-toggle" id="helpToggle">
        <span>HOW TO USE</span>
        <span class="arrow" id="helpArrow">▾</span>
      </button>
      <div class="config-body hidden" id="helpBody">
        <div class="help-grid">
          <div class="help-block">
            <div class="help-title">Two ticker lists</div>
            <div class="help-text">
              <b>TICKERS</b> — your individual stocks. Shows a <span style="color:var(--green)">BUY</span> signal when RSI drops below 30 (oversold), and a <span style="color:var(--red)">SELL</span> signal when RSI rises above 70 (overbought).<br><br>
              <b>INDEX TICKERS</b> — slow-moving ETFs and broad market instruments. Same SELL threshold (≥70), but a lower BUY threshold — triggers when RSI drops below 50, since these instruments move more gradually.
            </div>
          </div>
          <div class="help-block">
            <div class="help-title">What is RSI?</div>
            <div class="help-text">
              RSI (Relative Strength Index) is a 0–100 momentum indicator based on the last 14 daily closes.<br><br>
              <span style="color:var(--green)">≤ 30</span> — oversold, potential reversal upward<br>
              <span style="color:var(--orange)">30–50</span> — weak momentum<br>
              <span style="color:var(--neutral)">50–70</span> — firm momentum<br>
              <span style="color:var(--red)">≥ 70</span> — overbought, potential reversal downward
            </div>
          </div>
          <div class="help-block">
            <div class="help-title">Your session URL</div>
            <div class="help-text">
              Your ticker lists are saved to a unique URL (the <b>?s=...</b> part). Bookmark it or copy it from the config panel above to restore your lists on any device.<br><br>
              Share the URL with a friend and they'll see your exact setup. Visit the base URL without <b>?s=</b> to start a fresh session.
            </div>
          </div>
          <div class="help-block">
            <div class="help-title">Data &amp; refresh</div>
            <div class="help-text">
              Price data comes from Yahoo Finance (unofficial API, free). The page auto-refreshes every 5 minutes while open — closing the tab stops it.<br><br>
              Data may be delayed during market hours and stale on weekends. Up to 30 tickers recommended before you risk hitting rate limits.
            </div>
          </div>
        </div>
      </div>
    </div>

    <div class="error-box" id="errorBox" style="display:none;"></div>

    <div id="buySection" style="display:none;">
      <div class="section-header buy">
        <span class="section-title">BUY</span>
        <span class="section-sub">RSI ≤ 30 · Oversold</span>
      </div>
      <div class="table-wrap">
        <div class="table-header">
          <span>Ticker</span><span>Price</span><span>Chg</span>
          <span>RSI Bar</span><span style="text-align:right">RSI</span>
        </div>
        <div id="buyBody"></div>
      </div>
    </div>

    <div id="sellSection" style="display:none;">
      <div class="section-header sell">
        <span class="section-title">SELL</span>
        <span class="section-sub">RSI ≥ 70 · Overbought</span>
      </div>
      <div class="table-wrap">
        <div class="table-header">
          <span>Ticker</span><span>Price</span><span>Chg</span>
          <span>RSI Bar</span><span style="text-align:right">RSI</span>
        </div>
        <div id="sellBody"></div>
      </div>
    </div>

    <div class="empty" id="emptyState">Loading tickers...</div>

    <div id="allSection" style="display:none;">
      <button class="all-toggle" id="allToggle">
        <div style="display:flex;align-items:baseline;gap:12px;">
          <span class="section-title" style="color:var(--text-dim)">ALL</span>
          <span class="section-sub" id="allSub">All scanned tickers</span>
        </div>
        <div style="display:flex;align-items:center;gap:10px;">
          <span id="rsiSortBtn" class="sort-btn">RSI <span id="rsiSortArrow">↕</span></span>
          <span class="arrow open" id="allArrow">▾</span>
        </div>
      </button>
      <div id="allBody" class="table-wrap">
        <div class="table-header table-header-all">
          <span>Ticker</span><span>Price</span><span>Chg</span>
          <span>RSI Bar</span><span style="text-align:right">RSI</span>
          <span style="text-align:center">Signal</span>
        </div>
        <div id="allRows"></div>
      </div>
    </div>

    <div class="legend">
      <span><span style="color:var(--green)">●</span> Buy ≤ 30</span>
      <span><span style="color:var(--orange)">●</span> Weak &lt; 50</span>
      <span><span style="color:var(--neutral)">●</span> Firm ≥ 50</span>
      <span><span style="color:var(--red)">●</span> Sell ≥ 70</span>
      <label class="checkbox-label auto">
        <input type="checkbox" id="autoRefreshChk" checked>
        <span>Auto-refresh (5 min)</span>
      </label>
    </div>
  </div>

  <script>
    // Session ID — get from URL or generate a new one
    const params = new URLSearchParams(window.location.search);
    let sessionId = params.get("s");
    if (!sessionId) {
      sessionId = crypto.randomUUID().replace(/-/g, "").slice(0, 20);
      params.set("s", sessionId);
      history.replaceState(null, "", "?" + params.toString());
    }
    const sessionUrl = window.location.href;

    let state = {
      tickers: "",
      indexTickers: "",
      stocks: [],
      lastUpdated: null,
      configOpen: true,
      allOpen: true,
      allSort: null, // null = zone order, 'asc' = RSI low→high, 'desc' = RSI high→low
      loading: false,
      error: null,
    };
    let refreshInterval = null;
    const REFRESH_MS = 5 * 60 * 1000;
    let hiddenAt = null;

    function autoResize(el) {
      el.style.height = "auto";
      el.style.height = el.scrollHeight + "px";
    }

    function currencySymbol(c) {
      if (c === "INR") return "₹";
      if (c === "EUR") return "€";
      if (c === "GBP") return "£";
      if (c === "JPY") return "¥";
      return "$";
    }

    const $ = (sel) => document.querySelector(sel);
    const tickersInput = $("#tickersInput");
    const indexTickersInput = $("#indexTickersInput");
    const sessionUrlInput = $("#sessionUrlInput");
    const copyUrlBtn = $("#copyUrlBtn");
    const fetchBtn = $("#fetchBtn");
    const configToggle = $("#configToggle");
    const configBody = $("#configBody");
    const configArrow = $("#configArrow");
    const errorBox = $("#errorBox");
    const buySection = $("#buySection");
    const sellSection = $("#sellSection");
    const allSection = $("#allSection");
    const buyBody = $("#buyBody");
    const sellBody = $("#sellBody");
    const allBody = $("#allBody");
    const allRows = $("#allRows");
    const allToggle = $("#allToggle");
    const allArrow = $("#allArrow");
    const allSub = $("#allSub");
    const rsiSortBtn = $("#rsiSortBtn");
    const rsiSortArrow = $("#rsiSortArrow");
    const emptyState = $("#emptyState");
    const statusBar = $("#statusBar");
    const savedFlash = $("#savedFlash");

    async function loadTickers() {
      try {
        const qs = "?s=" + sessionId;
        const [r1, r2] = await Promise.all([fetch("/tickers" + qs), fetch("/index-tickers" + qs)]);
        const [d1, d2] = await Promise.all([r1.json(), r2.json()]);
        state.tickers = d1.tickers || "";
        state.indexTickers = d2.tickers || "";
      } catch (e) {
        state.tickers = "";
        state.indexTickers = "";
      }
    }

    async function saveTickers(tickers) {
      try {
        await fetch("/tickers?s=" + sessionId, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tickers }),
        });
      } catch (e) {}
    }

    async function saveIndexTickers(tickers) {
      try {
        await fetch("/index-tickers?s=" + sessionId, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tickers }),
        });
      } catch (e) {}
    }

    function flashSaved() {
      savedFlash.classList.add("show");
      setTimeout(() => savedFlash.classList.remove("show"), 1500);
    }

    const ZONE_META = {
      oversold:      { color: "var(--green)",   label: "BUY"  },
      below_midline: { color: "var(--orange)",  label: "WEAK" },
      above_midline: { color: "var(--neutral)", label: "FIRM" },
      overbought:    { color: "var(--red)",     label: "SELL" },
      error:         { color: "#616161",        label: "ERR"  },
      no_data:       { color: "#616161",        label: "—"    },
    };
    function zoneColor(zone) {
      return (ZONE_META[zone] || ZONE_META.no_data).color;
    }

    function renderRows(stocks, indexSet) {
      return stocks.map((s, i) => {
        const color = zoneColor(s.zone);
        const isIndex = indexSet && indexSet.has(s.ticker);
        const chgClass = s.changePercent > 0 ? "up" : s.changePercent < 0 ? "down" : "flat";
        const chgStr = s.changePercent != null ? (s.changePercent > 0 ? "+" : "") + s.changePercent + "%" : "";
        const rsiPct = s.rsi != null ? Math.min(100, Math.max(0, s.rsi)) : 0;
        return '<div class="table-row" style="animation-delay:' + (i * 40) + 'ms">' +
          '<span class="col-ticker"><span class="ticker-text">' + s.ticker + '</span>' + (isIndex ? '<span class="index-tag">I</span>' : '') + '</span>' +
          '<span class="col-price">' + (s.price != null ? currencySymbol(s.currency) + s.price.toLocaleString() : "—") + '</span>' +
          '<span class="col-change ' + chgClass + '">' + chgStr + '</span>' +
          '<div class="rsi-bar">' +
            '<div class="marker" style="left:30%"></div>' +
            '<div class="marker" style="left:50%"></div>' +
            '<div class="marker" style="left:70%"></div>' +
            '<div class="fill" style="width:' + rsiPct + '%;background:' + color + '"></div>' +
          '</div>' +
          '<span class="col-rsi" style="color:' + color + '">' + (s.rsi != null ? s.rsi.toFixed(1) : "—") + '</span>' +
        '</div>';
      }).join("");
    }

    function render() {
      tickersInput.value = state.tickers;
      indexTickersInput.value = state.indexTickers;
      autoResize(tickersInput);
      autoResize(indexTickersInput);
      sessionUrlInput.value = sessionUrl;
      configBody.classList.toggle("hidden", !state.configOpen);
      configArrow.classList.toggle("open", state.configOpen);

      fetchBtn.disabled = state.loading;
      fetchBtn.textContent = state.loading ? "FETCHING..." : "UPDATE LIST";

      if (state.error) {
        errorBox.style.display = "block";
        errorBox.textContent = state.error;
      } else {
        errorBox.style.display = "none";
      }

      const indexSet = new Set(state.indexTickers.split(",").map(t => t.trim().toUpperCase()).filter(Boolean));
      // BUY: regular tickers ≤30, plus watch tickers <50
      const buys = state.stocks.filter(s =>
        s.zone === "oversold" ||
        (indexSet.has(s.ticker) && (s.zone === "below_midline" || s.zone === "oversold"))
      );
      // SELL: all tickers ≥70
      const sells = state.stocks.filter(s => s.zone === "overbought");

      const parts = [];
      if (state.lastUpdated) parts.push("Updated " + new Date(state.lastUpdated).toLocaleTimeString());
      if (state.stocks.length) parts.push(state.stocks.length + " scanned");
      if (buys.length) parts.push('<span class="green">' + buys.length + ' buy</span>');
      if (sells.length) parts.push('<span class="red">' + sells.length + ' sell</span>');
      if (state.stocks.length && !state.loading) {
        parts.push('<button class="btn btn-refresh" onclick="fetchData()">↻ REFRESH</button>');
      }
      statusBar.innerHTML = parts.join('<span style="color:var(--text-muted)">·</span>');

      const hasSignals = buys.length || sells.length;

      if (buys.length) {
        buySection.style.display = "block";
        buyBody.innerHTML = renderRows(buys, indexSet);
      } else {
        buySection.style.display = "none";
      }

      if (sells.length) {
        sellSection.style.display = "block";
        sellBody.innerHTML = renderRows(sells, indexSet);
      } else {
        sellSection.style.display = "none";
      }

      if (state.stocks.length) {
        allSection.style.display = "block";
        allBody.style.display = state.allOpen ? "block" : "none";
        allArrow.classList.toggle("open", state.allOpen);
        allSub.textContent = state.stocks.length + " tickers";

        // Sort
        let sorted;
        if (state.allSort === "asc") {
          sorted = [...state.stocks].sort((a, b) => (a.rsi ?? 999) - (b.rsi ?? 999));
          rsiSortArrow.textContent = "↑";
        } else if (state.allSort === "desc") {
          sorted = [...state.stocks].sort((a, b) => (b.rsi ?? -1) - (a.rsi ?? -1));
          rsiSortArrow.textContent = "↓";
        } else {
          const order = { oversold: 0, overbought: 1, below_midline: 2, above_midline: 3, error: 4, no_data: 5 };
          sorted = [...state.stocks].sort((a, b) => (order[a.zone] ?? 9) - (order[b.zone] ?? 9));
          rsiSortArrow.textContent = "↕";
        }

        allRows.innerHTML = sorted.map((s, i) => {
          const zm = ZONE_META[s.zone] || ZONE_META.no_data;
          const isIndex = indexSet.has(s.ticker);
          const chgClass = s.changePercent > 0 ? "up" : s.changePercent < 0 ? "down" : "flat";
          const chgStr = s.changePercent != null ? (s.changePercent > 0 ? "+" : "") + s.changePercent + "%" : "";
          const rsiPct = s.rsi != null ? Math.min(100, Math.max(0, s.rsi)) : 0;
          return '<div class="table-row table-row-all" style="animation-delay:' + (i * 30) + 'ms">' +
            '<span class="col-ticker"><span class="ticker-text">' + s.ticker + '</span>' + (isIndex ? '<span class="index-tag">I</span>' : '') + '</span>' +
            '<span class="col-price">' + (s.price != null ? currencySymbol(s.currency) + s.price.toLocaleString() : "—") + '</span>' +
            '<span class="col-change ' + chgClass + '">' + chgStr + '</span>' +
            '<div class="rsi-bar">' +
              '<div class="marker" style="left:30%"></div>' +
              '<div class="marker" style="left:50%"></div>' +
              '<div class="marker" style="left:70%"></div>' +
              '<div class="fill" style="width:' + rsiPct + '%;background:' + zm.color + '"></div>' +
            '</div>' +
            '<span class="col-rsi" style="color:' + zm.color + '">' + (s.rsi != null ? s.rsi.toFixed(1) : "—") + '</span>' +
            '<span class="col-signal" style="color:' + zm.color + '">' + zm.label + '</span>' +
          '</div>';
        }).join("");
      } else {
        allSection.style.display = "none";
      }

      if (state.stocks.length && !state.loading) {
        emptyState.style.display = hasSignals ? "none" : "block";
        if (!hasSignals) emptyState.textContent = "No buy or sell signals right now. " + state.stocks.length + " tickers scanned.";
      } else if (!state.loading && !state.error) {
        emptyState.style.display = "block";
      } else {
        emptyState.style.display = "none";
      }
    }

    async function fetchData() {
      if (state.loading) return;
      state.loading = true;
      state.error = null;
      render();

      try {
        const allTickers = [...new Set([
          ...state.tickers.split(",").map(t => t.trim().toUpperCase()).filter(Boolean),
          ...state.indexTickers.split(",").map(t => t.trim().toUpperCase()).filter(Boolean),
        ])].join(",");
        const url = "/rsi?tickers=" + encodeURIComponent(allTickers);
        const res = await fetch(url);
        if (!res.ok) throw new Error("Server returned " + res.status);
        const data = await res.json();
        if (data.error) throw new Error(data.error);

        state.stocks = data.stocks || [];
        state.lastUpdated = Date.now();
        state.configOpen = false;
      } catch (err) {
        state.error = err.message;
      } finally {
        state.loading = false;
        render();
        scheduleRefresh();
      }
    }

    function scheduleRefresh() {
      if (refreshInterval) clearInterval(refreshInterval);
      const autoRefreshChk = $("#autoRefreshChk");
      if (state.stocks.length && autoRefreshChk && autoRefreshChk.checked) {
        refreshInterval = setInterval(fetchData, REFRESH_MS);
      }
    }

    document.addEventListener("visibilitychange", () => {
      const autoRefreshChk = $("#autoRefreshChk");
      if (!autoRefreshChk?.checked || !state.stocks.length) return;
      if (document.visibilityState === "hidden") {
        hiddenAt = Date.now();
        if (refreshInterval) { clearInterval(refreshInterval); refreshInterval = null; }
      } else {
        const elapsed = hiddenAt ? Date.now() - hiddenAt : 0;
        hiddenAt = null;
        if (elapsed >= REFRESH_MS) {
          fetchData();
        } else {
          refreshInterval = setTimeout(() => {
            fetchData();
            refreshInterval = setInterval(fetchData, REFRESH_MS);
          }, REFRESH_MS - elapsed);
        }
      }
    });

    const helpToggle = $("#helpToggle");
    const helpBody = $("#helpBody");
    const helpArrow = $("#helpArrow");
    helpToggle.addEventListener("click", () => {
      helpBody.classList.toggle("hidden");
      helpArrow.classList.toggle("open");
    });

    copyUrlBtn.addEventListener("click", () => {
      navigator.clipboard.writeText(sessionUrl).then(() => {
        copyUrlBtn.textContent = "COPIED!";
        setTimeout(() => { copyUrlBtn.textContent = "COPY"; }, 1500);
      });
    });

    // --- Ticker search ---
    const searchInput = $("#searchInput");
    const searchDropdown = $("#searchDropdown");

    function addTickerToList(symbol, listType) {
      if (listType === "index") {
        const cur = state.indexTickers ? state.indexTickers.split(",").map(t => t.trim()).filter(Boolean) : [];
        if (!cur.includes(symbol)) {
          state.indexTickers = [...cur, symbol].join(",");
          indexTickersInput.value = state.indexTickers;
          autoResize(indexTickersInput);
          saveIndexTickers(state.indexTickers);
        }
      } else {
        const cur = state.tickers ? state.tickers.split(",").map(t => t.trim()).filter(Boolean) : [];
        if (!cur.includes(symbol)) {
          state.tickers = [...cur, symbol].join(",");
          tickersInput.value = state.tickers;
          autoResize(tickersInput);
          saveTickers(state.tickers);
        }
      }
      searchInput.value = "";
      searchDropdown.style.display = "none";
      fetchData();
    }

    function renderSearchResults(results) {
      if (!results.length) { searchDropdown.style.display = "none"; return; }
      searchDropdown.innerHTML = results.map(r =>
        '<div class="search-result">' +
        '<span class="search-symbol">' + r.symbol + '</span>' +
        '<span class="search-name">' + r.name + '</span>' +
        '<button class="search-add-btn" data-symbol="' + r.symbol + '" data-list="tickers">+ TICKERS</button>' +
        '<button class="search-add-btn" data-symbol="' + r.symbol + '" data-list="index">+ INDEX</button>' +
        '</div>'
      ).join("");
      searchDropdown.style.display = "block";
      searchDropdown.querySelectorAll(".search-add-btn").forEach(btn => {
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          addTickerToList(btn.dataset.symbol, btn.dataset.list);
        });
      });
    }

    let searchTimeout;
    searchInput.addEventListener("input", () => {
      clearTimeout(searchTimeout);
      const q = searchInput.value.trim();
      if (!q) { searchDropdown.style.display = "none"; return; }
      searchTimeout = setTimeout(async () => {
        try {
          const res = await fetch("/search?q=" + encodeURIComponent(q));
          const data = await res.json();
          renderSearchResults(data.results || []);
        } catch (e) { searchDropdown.style.display = "none"; }
      }, 300);
    });

    document.addEventListener("click", (e) => {
      if (!searchInput.contains(e.target) && !searchDropdown.contains(e.target)) {
        searchDropdown.style.display = "none";
      }
    });

    configToggle.addEventListener("click", () => {
      state.configOpen = !state.configOpen;
      render();
      if (state.configOpen) {
        autoResize(tickersInput);
        autoResize(indexTickersInput);
      }
    });

    allToggle.addEventListener("click", () => {
      state.allOpen = !state.allOpen;
      render();
    });

    rsiSortBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      state.allSort = state.allSort === "asc" ? "desc" : state.allSort === "desc" ? null : "asc";
      render();
    });

    fetchBtn.addEventListener("click", async () => {
      state.tickers = tickersInput.value.trim();
      state.indexTickers = indexTickersInput.value.trim();
      await Promise.all([saveTickers(state.tickers), saveIndexTickers(state.indexTickers)]);
      flashSaved();
      fetchData();
    });

    let saveTimeout;
    tickersInput.addEventListener("input", () => {
      autoResize(tickersInput);
      clearTimeout(saveTimeout);
      saveTimeout = setTimeout(async () => {
        state.tickers = tickersInput.value.trim();
        await saveTickers(state.tickers);
      }, 800);
    });

    let indexSaveTimeout;
    indexTickersInput.addEventListener("input", () => {
      autoResize(indexTickersInput);
      clearTimeout(indexSaveTimeout);
      indexSaveTimeout = setTimeout(async () => {
        state.indexTickers = indexTickersInput.value.trim();
        await saveIndexTickers(state.indexTickers);
      }, 800);
    });

    // Auto-refresh checkbox
    $("#autoRefreshChk").addEventListener("change", (e) => {
      if (e.target.checked) {
        scheduleRefresh();
      } else {
        if (refreshInterval) clearInterval(refreshInterval);
        refreshInterval = null;
      }
    });

    // --- Telegram panel ---
    const telegramToggle = $("#telegramToggle");
    const telegramArrow = $("#telegramArrow");
    const telegramBody = $("#telegramBody");
    const subInstructions = $("#subInstructions");
    const subConfirmed = $("#subConfirmed");
    const subCommandInput = $("#subCommandInput");
    const copySubBtn = $("#copySubBtn");
    const checkSubBtn = $("#checkSubBtn");
    const unsubBtn = $("#unsubBtn");
    const testModeChk = $("#testModeChk");

    telegramToggle.addEventListener("click", () => {
      telegramBody.classList.toggle("hidden");
      telegramArrow.classList.toggle("open");
    });

    async function checkSubStatus() {
      const res = await fetch("/sub-status?s=" + sessionId);
      const data = await res.json();
      if (data.subscribed) {
        subInstructions.style.display = "none";
        subConfirmed.style.display = "block";
        testModeChk.checked = !!data.testMode;
      } else {
        const cmd = "/subscribe " + sessionId;
        subCommandInput.value = cmd;
        subInstructions.style.display = "block";
        subConfirmed.style.display = "none";
      }
    }

    testModeChk.addEventListener("change", async (e) => {
      await fetch("/sub-test-mode?s=" + sessionId, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ testMode: e.target.checked }),
      });
    });

    telegramToggle.addEventListener("click", async () => {
      if (!telegramBody.classList.contains("hidden")) return; // about to open
      await checkSubStatus();
    }, { capture: true });

    copySubBtn.addEventListener("click", () => {
      navigator.clipboard.writeText(subCommandInput.value).then(() => {
        copySubBtn.textContent = "COPIED!";
        setTimeout(() => { copySubBtn.textContent = "COPY"; }, 1500);
      });
    });

    checkSubBtn.addEventListener("click", async () => {
      checkSubBtn.textContent = "CHECKING...";
      await checkSubStatus();
      checkSubBtn.textContent = "CHECK STATUS";
    });

    const sendTestNowBtn = $("#sendTestNowBtn");
    const testSentFlash = $("#testSentFlash");
    sendTestNowBtn.addEventListener("click", async () => {
      sendTestNowBtn.textContent = "SENDING...";
      sendTestNowBtn.disabled = true;
      const res = await fetch("/test-alert?s=" + sessionId, { method: "POST" });
      const data = await res.json();
      sendTestNowBtn.textContent = "SEND TEST NOW";
      sendTestNowBtn.disabled = false;
      if (data.ok) {
        testSentFlash.classList.add("show");
        setTimeout(() => testSentFlash.classList.remove("show"), 2000);
      }
    });

    unsubBtn.addEventListener("click", async () => {
      unsubBtn.textContent = "UNSUBSCRIBING...";
      await fetch("/unsubscribe?s=" + sessionId, { method: "POST" });
      await checkSubStatus();
      unsubBtn.textContent = "UNSUBSCRIBE";
    });

    // Init: load tickers from server, then auto-fetch
    (async () => {
      await loadTickers();
      if (!state.tickers) {
        state.configOpen = true; // new user — open config so they can add tickers
        emptyState.textContent = "Add tickers above and click FETCH to get started.";
        emptyState.style.display = "block";
      }
      render();
      if (state.tickers) {
        fetchData();
      }
    })();
  </script>
</body>
</html>`;

async function sendTelegram(env, chatId, text, parseMode = null) {
  const body = { chat_id: chatId, text };
  if (parseMode) body.parse_mode = parseMode;
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function processSubscriber(sub, env) {
  const { sessionId, chatId } = sub;
  try {
    const [t1, t2] = await Promise.all([
      env.RSI_KV.get(`s:${sessionId}:tickers`),
      env.RSI_KV.get(`s:${sessionId}:index_tickers`),
    ]);
    const tickers = (t1 || "").split(",").map(t => t.trim().toUpperCase()).filter(Boolean);
    const indexTickers = new Set((t2 || "").split(",").map(t => t.trim().toUpperCase()).filter(Boolean));
    const allTickers = [...new Set([...tickers, ...indexTickers])];
    if (allTickers.length === 0) return;

    const results = await Promise.all(allTickers.map(fetchRSI));
    const currentSnap = {};
    results.forEach(r => { if (r.rsi !== null) currentSnap[r.ticker] = r.rsi; });

    const prevSnap = JSON.parse((await env.RSI_KV.get(`snap:${sessionId}`)) || "{}");
    await env.RSI_KV.put(`snap:${sessionId}`, JSON.stringify(currentSnap));

    const buys = [], sells = [];
    for (const r of results) {
      if (r.rsi === null) continue;
      if (r.marketState !== "REGULAR") continue; // only alert on actively trading tickers
      const prev = prevSnap[r.ticker];
      if (prev === undefined) continue; // no previous data, skip first run
      const isIndex = indexTickers.has(r.ticker);
      const buyThreshold = isIndex ? 50 : 30;

      if (r.rsi < buyThreshold && prev >= buyThreshold) {
        buys.push({ ...r, isIndex });
      }
      if (r.rsi >= 70 && prev < 70) {
        sells.push({ ...r, isIndex });
      }
    }

    const dashUrl = `https://rsi-stock-tracker.mishabhi.workers.dev/?s=${sessionId}`;

    if (sub.testMode) {
      // Test mode: send full snapshot regardless of crossings
      const lines = ["🧪 <b>TEST MODE — RSI Snapshot</b>"];
      const order = { oversold: 0, overbought: 1, below_midline: 2, above_midline: 3 };
      const sorted = results.filter(r => r.rsi !== null).sort((a, b) => (order[a.zone] ?? 9) - (order[b.zone] ?? 9));
      sorted.forEach(r => {
        const labels = { oversold: "BUY", overbought: "SELL", below_midline: "WEAK", above_midline: "FIRM" };
        const tag = indexTickers.has(r.ticker) ? " [I]" : "";
        lines.push(`• <b>${r.ticker}</b>${tag} — RSI ${r.rsi.toFixed(1)} (${labels[r.zone] || r.zone})`);
      });
      lines.push(`\n<a href="${dashUrl}">📊 Open dashboard</a>`);
      await sendTelegram(env, chatId, lines.join("\n"), "HTML");
      return;
    }

    if (buys.length === 0 && sells.length === 0) return;

    const lines = ["🔔 <b>RSI Alert</b>"];
    if (buys.length) {
      lines.push("\n📈 <b>BUY signals:</b>");
      buys.forEach(s => {
        const tag = s.isIndex ? " (index, &lt;50)" : " (&lt;30)";
        lines.push(`• <b>${s.ticker}</b> — RSI ${s.rsi.toFixed(1)}${tag}`);
      });
    }
    if (sells.length) {
      lines.push("\n📉 <b>SELL signals:</b>");
      sells.forEach(s => lines.push(`• <b>${s.ticker}</b> — RSI ${s.rsi.toFixed(1)} (&gt;70)`));
    }
    lines.push(`\n<a href="${dashUrl}">📊 Open dashboard</a>`);

    await sendTelegram(env, chatId, lines.join("\n"), "HTML");
  } catch (err) {
    console.error(`Error processing subscriber ${sessionId}:`, err);
  }
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);

    // Serve the dashboard
    if (url.pathname === "/" || url.pathname === "") {
      return new Response(HTML, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    // GET /tickers?s=SESSION_ID
    if (url.pathname === "/tickers" && request.method === "GET") {
      const sid = url.searchParams.get("s") || "";
      const key = sid ? `s:${sid}:tickers` : TICKERS_KV_KEY;
      const tickers = (await env.RSI_KV.get(key)) ?? DEFAULT_TICKERS;
      return new Response(JSON.stringify({ tickers }), {
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    // POST /tickers?s=SESSION_ID
    if (url.pathname === "/tickers" && request.method === "POST") {
      const sid = url.searchParams.get("s") || "";
      const key = sid ? `s:${sid}:tickers` : TICKERS_KV_KEY;
      const body = await request.json();
      const tickers = (body.tickers || "").trim();
      await env.RSI_KV.put(key, tickers);
      return new Response(JSON.stringify({ ok: true, tickers }), {
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    // GET /index-tickers?s=SESSION_ID
    if (url.pathname === "/index-tickers" && request.method === "GET") {
      const sid = url.searchParams.get("s") || "";
      const key = sid ? `s:${sid}:index_tickers` : INDEX_TICKERS_KV_KEY;
      const tickers = (await env.RSI_KV.get(key)) ?? "";
      return new Response(JSON.stringify({ tickers }), {
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    // POST /index-tickers?s=SESSION_ID
    if (url.pathname === "/index-tickers" && request.method === "POST") {
      const sid = url.searchParams.get("s") || "";
      const key = sid ? `s:${sid}:index_tickers` : INDEX_TICKERS_KV_KEY;
      const body = await request.json();
      const tickers = (body.tickers || "").trim();
      await env.RSI_KV.put(key, tickers);
      return new Response(JSON.stringify({ ok: true, tickers }), {
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    // Health check
    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ status: "ok" }), {
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    // GET /search?q=QUERY
    if (url.pathname === "/search" && request.method === "GET") {
      const q = url.searchParams.get("q") || "";
      if (!q.trim()) {
        return new Response(JSON.stringify({ results: [] }), {
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
        });
      }
      try {
        const resp = await fetch(
          `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=8&newsCount=0`,
          { headers: { "User-Agent": "Mozilla/5.0 (compatible; RSI-Tracker/1.0)" } }
        );
        const data = await resp.json();
        const results = (data?.quotes || [])
          .filter(r => r.symbol && r.quoteType === "EQUITY")
          .map(r => ({ symbol: r.symbol, name: r.shortname || r.longname || "" }));
        return new Response(JSON.stringify({ results }), {
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
        });
      } catch (err) {
        return new Response(JSON.stringify({ results: [] }), {
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
        });
      }
    }

    // GET /rsi?tickers=AAPL,MSFT,...
    if (url.pathname === "/rsi") {
      const tickersParam = url.searchParams.get("tickers");

      if (!tickersParam) {
        return new Response(
          JSON.stringify({ error: "Missing ?tickers= parameter" }),
          { status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
        );
      }

      const tickers = tickersParam
        .split(",")
        .map((t) => t.trim().toUpperCase())
        .filter((t) => t.length > 0)
        .slice(0, 30);

      const results = await Promise.all(tickers.map(fetchRSI));

      return new Response(
        JSON.stringify({
          updated: new Date().toISOString(),
          count: results.length,
          stocks: results,
        }),
        {
          headers: {
            ...CORS_HEADERS,
            "Content-Type": "application/json",
            "Cache-Control": "public, max-age=300",
          },
        }
      );
    }

    // POST /telegram — webhook from Telegram bot
    if (url.pathname === "/telegram" && request.method === "POST") {
      const body = await request.json();
      const msg = body?.message;
      if (!msg) return new Response("ok");

      const chatId = msg.chat?.id;
      const text = (msg.text || "").trim();

      if (text.startsWith("/subscribe")) {
        const parts = text.split(/\s+/);
        const sid = parts[1] || "";
        if (!sid) {
          await sendTelegram(env, chatId, "Please include your session ID:\n<code>/subscribe YOUR_SESSION_ID</code>\n\nFind it in the Configuration panel on your dashboard.", "HTML");
        } else {
          // Add to subscribers list
          const subs = JSON.parse((await env.RSI_KV.get("subscribers")) || "[]");
          const existing = subs.findIndex(s => s.sessionId === sid);
          if (existing >= 0) {
            subs[existing].chatId = chatId;
          } else {
            subs.push({ sessionId: sid, chatId });
          }
          await env.RSI_KV.put("subscribers", JSON.stringify(subs));
          const dashUrl = new URL(request.url).origin + "/?s=" + sid;
          await sendTelegram(env, chatId, `✅ Subscribed!\n\nYou'll receive alerts when a ticker enters <b>BUY</b> or <b>SELL</b> territory.\n\n📊 <a href="${dashUrl}">Open your dashboard</a>`, "HTML");
        }
      } else if (text.startsWith("/unsubscribe")) {
        const subs = JSON.parse((await env.RSI_KV.get("subscribers")) || "[]");
        const filtered = subs.filter(s => s.chatId !== chatId);
        await env.RSI_KV.put("subscribers", JSON.stringify(filtered));
        await sendTelegram(env, chatId, "✅ Unsubscribed. You won't receive any more alerts.");
      } else if (text.startsWith("/start") || text.startsWith("/help")) {
        await sendTelegram(env, chatId, "👋 <b>RSI Alert Bot</b>\n\nCommands:\n• <code>/subscribe SESSION_ID</code> — start alerts for your dashboard\n• <code>/unsubscribe</code> — stop alerts\n\nFind your session ID in the Configuration panel on your dashboard.", "HTML");
      }

      return new Response("ok");
    }

    // GET /sub-status?s=SESSION_ID
    if (url.pathname === "/sub-status" && request.method === "GET") {
      const sid = url.searchParams.get("s") || "";
      const subs = JSON.parse((await env.RSI_KV.get("subscribers")) || "[]");
      const sub = subs.find(s => s.sessionId === sid);
      return new Response(JSON.stringify({ subscribed: !!sub, testMode: sub?.testMode || false }), {
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    // POST /test-alert?s=SESSION_ID — immediately send a test message
    if (url.pathname === "/test-alert" && request.method === "POST") {
      const sid = url.searchParams.get("s") || "";
      const subs = JSON.parse((await env.RSI_KV.get("subscribers")) || "[]");
      const sub = subs.find(s => s.sessionId === sid);
      if (!sub) {
        return new Response(JSON.stringify({ ok: false, error: "Not subscribed" }), {
          status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
        });
      }
      await processSubscriber({ ...sub, testMode: true }, env);
      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    // POST /sub-test-mode?s=SESSION_ID
    if (url.pathname === "/sub-test-mode" && request.method === "POST") {
      const sid = url.searchParams.get("s") || "";
      const body = await request.json();
      const subs = JSON.parse((await env.RSI_KV.get("subscribers")) || "[]");
      const idx = subs.findIndex(s => s.sessionId === sid);
      if (idx >= 0) {
        subs[idx].testMode = !!body.testMode;
        await env.RSI_KV.put("subscribers", JSON.stringify(subs));
      }
      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    // POST /unsubscribe?s=SESSION_ID — unsubscribe from page
    if (url.pathname === "/unsubscribe" && request.method === "POST") {
      const sid = url.searchParams.get("s") || "";
      const subs = JSON.parse((await env.RSI_KV.get("subscribers")) || "[]");
      const sub = subs.find(s => s.sessionId === sid);
      const filtered = subs.filter(s => s.sessionId !== sid);
      await env.RSI_KV.put("subscribers", JSON.stringify(filtered));
      if (sub) await sendTelegram(env, sub.chatId, "✅ Unsubscribed via dashboard. You won't receive any more alerts.");
      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    // Health check
    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ status: "ok" }), {
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    // GET /rsi?tickers=AAPL,MSFT,...
    if (url.pathname === "/rsi") {
      const tickersParam = url.searchParams.get("tickers");

      if (!tickersParam) {
        return new Response(
          JSON.stringify({ error: "Missing ?tickers= parameter" }),
          { status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
        );
      }

      const tickers = tickersParam
        .split(",")
        .map((t) => t.trim().toUpperCase())
        .filter((t) => t.length > 0)
        .slice(0, 30);

      const results = await Promise.all(tickers.map(fetchRSI));

      return new Response(
        JSON.stringify({
          updated: new Date().toISOString(),
          count: results.length,
          stocks: results,
        }),
        {
          headers: {
            ...CORS_HEADERS,
            "Content-Type": "application/json",
            "Cache-Control": "public, max-age=300",
          },
        }
      );
    }

    return new Response("Not found", { status: 404 });
  },

  async scheduled(event, env, ctx) {
    const subs = JSON.parse((await env.RSI_KV.get("subscribers")) || "[]");
    if (subs.length === 0) return;

    // No market hours gate — per-ticker marketState filters crossings in processSubscriber.
    // This allows alerts to work correctly for any exchange (US, India, etc.).
    ctx.waitUntil(Promise.all(subs.map(sub => processSubscriber(sub, env))));
  },
};
