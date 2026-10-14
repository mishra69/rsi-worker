// RSI(14) from Yahoo Finance daily closes, using Wilder's smoothing.

export function computeRSI(closes, period = 14) {
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

export function getZone(rsi) {
  if (rsi === null) return "no_data";
  if (rsi <= 30) return "oversold";
  if (rsi >= 70) return "overbought";
  if (rsi < 50) return "below_midline";
  return "above_midline";
}

// The chart API stopped returning meta.marketState, which silently disabled every
// crossing alert (they're gated on "REGULAR"). Derive it from the regular
// session window, which is still there.
function marketState(meta, now) {
  if (meta?.marketState) return meta.marketState;
  const regular = meta?.currentTradingPeriod?.regular;
  if (!regular?.start || !regular?.end) return null;
  return now >= regular.start && now < regular.end ? "REGULAR" : "CLOSED";
}

export async function fetchRSI(ticker) {
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
      marketState: marketState(result.meta, now),
      currency: result.meta?.currency ?? null,
      error: null,
    };
  } catch (err) {
    return { ticker, rsi: null, zone: "error", error: err.message };
  }
}

