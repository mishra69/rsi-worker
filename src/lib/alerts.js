// The cron's job: for each user, fetch RSI for their lists, compare against the
// last snapshot, and alert on threshold *crossings* — on every channel they have.
// Web Push is the primary channel; Telegram is a fallback for users who link it.
import { fetchRSI } from "./rsi.js";
import { getUser, getTickers, parseList } from "./store.js";
import { pusherFor } from "./push.js";

const ZONE_ORDER = { oversold: 0, overbought: 1, below_midline: 2, above_midline: 3 };
const ZONE_LABEL = { oversold: "BUY", overbought: "SELL", below_midline: "WEAK", above_midline: "FIRM" };

export async function sendTelegram(env, chatId, text, parseMode = null) {
  const body = { chat_id: chatId, text };
  if (parseMode) body.parse_mode = parseMode;
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Fan one alert out to every channel the user has. Returns the push result. */
async function deliver(env, id, user, { title, body, telegramHtml }) {
  const [push] = await Promise.all([
    pusherFor(env).send(id, {
      title, body, navigate: "/", icon: "/icons/icon-192.png", badge: "/icons/icon-192.png", tag: "rsi-alert",
    }, { ttl: 3600 }),
    user.chatId ? sendTelegram(env, user.chatId, telegramHtml, "HTML") : null,
  ]);
  return push;
}

/**
 * @param {object} opts
 * @param {boolean} [opts.snapshot]  send the full RSI table now, ignoring crossings
 * @returns {Promise<object|null>} the push send result, or null if nothing was sent
 */
export async function processUser(env, id, { snapshot = false } = {}) {
  try {
    const user = await getUser(env, id);
    if (!user) return null;
    const devices = await pusherFor(env).list(id);
    if (devices.length === 0 && !user.chatId) return null; // nowhere to deliver

    const lists = await getTickers(env, id);
    const indexTickers = new Set(parseList(lists.indexTickers));
    const allTickers = [...new Set([...parseList(lists.tickers), ...indexTickers])];
    if (allTickers.length === 0) return null;

    const results = await Promise.all(allTickers.map(fetchRSI));
    const dashUrl = env.APP_URL || "/";

    if (snapshot || user.testMode) {
      const sorted = results.filter(r => r.rsi !== null)
        .sort((a, b) => (ZONE_ORDER[a.zone] ?? 9) - (ZONE_ORDER[b.zone] ?? 9));
      const line = r => `${r.ticker}${indexTickers.has(r.ticker) ? " [I]" : ""} — RSI ${r.rsi.toFixed(1)} (${ZONE_LABEL[r.zone] || r.zone})`;
      return deliver(env, id, user, {
        title: "🧪 RSI Snapshot",
        body: sorted.map(line).join("\n") || "No RSI data available.",
        telegramHtml: ["🧪 <b>TEST MODE — RSI Snapshot</b>", ...sorted.map(r => "• " + line(r)),
          `\n<a href="${dashUrl}">📊 Open dashboard</a>`].join("\n"),
      });
    }

    const currentSnap = {};
    results.forEach(r => { if (r.rsi !== null) currentSnap[r.ticker] = r.rsi; });
    const prevSnap = JSON.parse((await env.RSI_KV.get(`snap:${id}`)) || "{}");
    await env.RSI_KV.put(`snap:${id}`, JSON.stringify(currentSnap));

    const buys = [], sells = [];
    for (const r of results) {
      if (r.rsi === null) continue;
      if (r.marketState !== "REGULAR") continue; // only alert on actively trading tickers
      const prev = prevSnap[r.ticker];
      if (prev === undefined) continue; // no previous data, skip first run
      const isIndex = indexTickers.has(r.ticker);
      const buyThreshold = isIndex ? 50 : 30;
      if (r.rsi < buyThreshold && prev >= buyThreshold) buys.push({ ...r, isIndex });
      if (r.rsi >= 70 && prev < 70) sells.push({ ...r, isIndex });
    }
    if (buys.length === 0 && sells.length === 0) return null;

    const tg = ["🔔 <b>RSI Alert</b>"];
    const lines = [];
    if (buys.length) {
      tg.push("\n📈 <b>BUY signals:</b>");
      buys.forEach(s => {
        tg.push(`• <b>${s.ticker}</b> — RSI ${s.rsi.toFixed(1)}${s.isIndex ? " (index, &lt;50)" : " (&lt;30)"}`);
        lines.push(`📈 BUY ${s.ticker} — RSI ${s.rsi.toFixed(1)}${s.isIndex ? " (index)" : ""}`);
      });
    }
    if (sells.length) {
      tg.push("\n📉 <b>SELL signals:</b>");
      sells.forEach(s => {
        tg.push(`• <b>${s.ticker}</b> — RSI ${s.rsi.toFixed(1)} (&gt;70)`);
        lines.push(`📉 SELL ${s.ticker} — RSI ${s.rsi.toFixed(1)}`);
      });
    }
    tg.push(`\n<a href="${dashUrl}">📊 Open dashboard</a>`);

    const counts = [buys.length && `${buys.length} BUY`, sells.length && `${sells.length} SELL`].filter(Boolean);
    return deliver(env, id, user, {
      title: `🔔 RSI Alert — ${counts.join(", ")}`,
      body: lines.join("\n"),
      telegramHtml: tg.join("\n"),
    });
  } catch (err) {
    console.error(`Error processing user ${id}:`, err);
    return null;
  }
}
