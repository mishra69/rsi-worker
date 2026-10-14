// RSI Stock Tracker — one Worker serving the PWA shell (public/) and /api/*.
//
// Static assets are matched before this code runs, so anything reaching here is
// an API call, the Telegram webhook, or a 404. Same origin throughout: no CORS.
import { userFromRequest, signInWithGoogle } from "./lib/auth.js";
import { fetchRSI } from "./lib/rsi.js";
import { getUser, putUser, upsertUser, getRoster, getTickers, putTickers, parseList } from "./lib/store.js";
import { pusherFor, rotateEndpoint } from "./lib/push.js";
import { processUser, sendTelegram } from "./lib/alerts.js";

const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), {
  status,
  headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers },
});

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // The bot's webhook was registered at /telegram before the move to /api/*;
    // keeping the path means it doesn't have to be re-registered.
    if (url.pathname === "/telegram" && request.method === "POST") {
      return telegramWebhook(request, env);
    }

    if (!url.pathname.startsWith("/api/")) return new Response("Not found", { status: 404 });

    try {
      return await route(request, env, url);
    } catch (err) {
      console.error("unhandled", err?.stack || err);
      return json({ error: "internal error" }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    // No market-hours gate: per-ticker marketState filters crossings, which keeps
    // alerts correct for any exchange (US, India, ...).
    const roster = await getRoster(env);
    ctx.waitUntil(Promise.all(roster.map(id => processUser(env, id))));
  },
};

async function route(request, env, url) {
  const path = url.pathname;
  const method = request.method;

  // ── Public ──────────────────────────────────────────────────────────────────

  // The page needs the client ID before there's a session; it's public anyway.
  if (path === "/api/config" && method === "GET") {
    return json({
      google_client_id: env.GOOGLE_CLIENT_ID || null,
      configured: !!(env.GOOGLE_CLIENT_ID && env.TOKEN_SECRET),
    });
  }

  // Public by definition — gating it means the browser can't subscribe at all.
  if (path === "/api/push/key" && method === "GET") {
    return json({ key: env.VAPID_PUBLIC_KEY || null });
  }

  if (path === "/api/push/rotate" && method === "POST") {
    const { old_endpoint, subscription } = await request.json().catch(() => ({}));
    if (!old_endpoint || !subscription?.endpoint || !subscription?.keys) return json({ error: "bad request" }, 400);
    // Unknown endpoint: a probe learns only that it guessed wrong.
    return (await rotateEndpoint(env, old_endpoint, subscription)) ? json({ ok: true }) : json({ ok: false }, 404);
  }

  if (path === "/api/auth/google" && method === "POST") {
    const { id_token } = await request.json().catch(() => ({}));
    if (!id_token) return json({ error: "sign-in failed" }, 400);
    try {
      const result = await signInWithGoogle(id_token, env);
      await upsertUser(env, result.user);
      return json(result);
    } catch (err) {
      // One generic answer for every failure.
      console.warn("sign-in rejected:", err.message);
      return json({ error: "sign-in failed" }, 401);
    }
  }

  // ── Authenticated ───────────────────────────────────────────────────────────

  const userId = await userFromRequest(request, env);
  if (!userId) return json({ error: "unauthorized" }, 401);

  if (path === "/api/me" && method === "GET") {
    const user = (await getUser(env, userId)) || {};
    return json({ email: user.email, name: user.name, testMode: !!user.testMode, telegram: !!user.chatId });
  }

  if (path === "/api/tickers" && method === "GET") {
    return json(await getTickers(env, userId));
  }

  if (path === "/api/tickers" && method === "POST") {
    const { tickers, indexTickers } = await request.json().catch(() => ({}));
    await putTickers(env, userId, {
      tickers: typeof tickers === "string" ? tickers : undefined,
      indexTickers: typeof indexTickers === "string" ? indexTickers : undefined,
    });
    return json({ ok: true, ...(await getTickers(env, userId)) });
  }

  // GET /api/rsi?tickers=AAPL,MSFT,...
  if (path === "/api/rsi" && method === "GET") {
    const tickers = parseList(url.searchParams.get("tickers"));
    if (tickers.length === 0) return json({ error: "Missing ?tickers= parameter" }, 400);
    const stocks = await Promise.all(tickers.map(fetchRSI));
    return json({ updated: new Date().toISOString(), count: stocks.length, stocks });
  }

  // GET /api/search?q=QUERY
  if (path === "/api/search" && method === "GET") {
    const q = (url.searchParams.get("q") || "").trim();
    if (!q) return json({ results: [] });
    try {
      const resp = await fetch(
        `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=8&newsCount=0`,
        { headers: { "User-Agent": "Mozilla/5.0 (compatible; RSI-Tracker/1.0)" } }
      );
      const data = await resp.json();
      const results = (data?.quotes || [])
        .filter(r => r.symbol && r.quoteType === "EQUITY")
        .map(r => ({ symbol: r.symbol, name: r.shortname || r.longname || "" }));
      return json({ results });
    } catch {
      return json({ results: [] });
    }
  }

  // ── Push ──

  if (path === "/api/push/status" && method === "GET") {
    const subs = await pusherFor(env).list(userId);
    const endpoint = url.searchParams.get("endpoint");
    return json({ devices: subs.length, thisDevice: !!endpoint && subs.some(s => s.endpoint === endpoint) });
  }

  if (path === "/api/push/subscribe" && method === "POST") {
    const { subscription } = await request.json().catch(() => ({}));
    try {
      return json({ ok: true, devices: await pusherFor(env).subscribe(userId, subscription) });
    } catch (err) {
      return json({ ok: false, error: err.message }, 400);
    }
  }

  if (path === "/api/push/unsubscribe" && method === "POST") {
    const { endpoint } = await request.json().catch(() => ({}));
    return json({ ok: true, devices: await pusherFor(env).unsubscribe(userId, endpoint) });
  }

  // The hidden test trigger (tap the build stamp): a real push through the real
  // pipeline, reported as whatever the push service actually answered.
  if (path === "/api/push/test" && method === "POST") {
    const r = await pusherFor(env).send(userId, {
      title: "🔔 RSI Tracker",
      body: "Push notifications are working on this device.",
      navigate: "/", icon: "/icons/icon-192.png", badge: "/icons/icon-192.png", tag: "rsi-test",
    });
    return json({ ok: r.sent > 0, ...r });
  }

  // ── Alerts (all channels) ──

  if (path === "/api/alerts/test-mode" && method === "POST") {
    const { testMode } = await request.json().catch(() => ({}));
    const user = (await getUser(env, userId)) || {};
    await putUser(env, userId, { ...user, testMode: !!testMode });
    return json({ ok: true, testMode: !!testMode });
  }

  // Send the full RSI table right now, to every channel.
  if (path === "/api/alerts/snapshot" && method === "POST") {
    const r = await processUser(env, userId, { snapshot: true });
    if (!r) return json({ ok: false, error: "Nothing to send — add tickers and turn on notifications first" }, 400);
    return json({ ok: true, ...r });
  }

  // ── Telegram (fallback channel) ──

  if (path === "/api/telegram/link" && method === "POST") {
    const code = crypto.randomUUID().replace(/-/g, "").slice(0, 10);
    await env.RSI_KV.put(`tglink:${code}`, userId, { expirationTtl: 3600 });
    return json({ code, bot: env.TELEGRAM_BOT || null });
  }

  if (path === "/api/telegram/unlink" && method === "POST") {
    const user = (await getUser(env, userId)) || {};
    if (user.chatId) {
      await sendTelegram(env, user.chatId, "✅ Unsubscribed via the app. You won't receive any more Telegram alerts.");
      delete user.chatId;
      await putUser(env, userId, user);
    }
    return json({ ok: true });
  }

  return json({ error: "not found" }, 404);
}

async function telegramWebhook(request, env) {
  const body = await request.json().catch(() => ({}));
  const msg = body?.message;
  if (!msg) return new Response("ok");

  const chatId = msg.chat?.id;
  const text = (msg.text || "").trim();
  const appUrl = env.APP_URL || new URL(request.url).origin;

  if (text.startsWith("/subscribe")) {
    const code = text.split(/\s+/)[1] || "";
    const userId = code && await env.RSI_KV.get(`tglink:${code}`);
    if (!userId) {
      await sendTelegram(env, chatId, `That code is missing or expired. Open <a href="${appUrl}">the app</a> → Alerts → Telegram to get a fresh one.`, "HTML");
    } else {
      await env.RSI_KV.delete(`tglink:${code}`);
      const user = (await getUser(env, userId)) || {};
      await putUser(env, userId, { ...user, chatId });
      await sendTelegram(env, chatId, `✅ Linked!\n\nYou'll receive alerts when a ticker enters <b>BUY</b> or <b>SELL</b> territory.\n\n📊 <a href="${appUrl}">Open the app</a>`, "HTML");
    }
  } else if (text.startsWith("/unsubscribe")) {
    for (const id of await getRoster(env)) {
      const user = await getUser(env, id);
      if (user?.chatId === chatId) {
        delete user.chatId;
        await putUser(env, id, user);
      }
    }
    await sendTelegram(env, chatId, "✅ Unsubscribed. You won't receive any more Telegram alerts.");
  } else if (text.startsWith("/start") || text.startsWith("/help")) {
    await sendTelegram(env, chatId, `👋 <b>RSI Alert Bot</b>\n\nCommands:\n• <code>/subscribe CODE</code> — link alerts to your account\n• <code>/unsubscribe</code> — stop alerts\n\nGet a code in <a href="${appUrl}">the app</a> → Alerts → Telegram.`, "HTML");
  }

  return new Response("ok");
}
