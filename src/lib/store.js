// KV layout, keyed on Google `sub`:
//
//   users                 JSON array of user ids — the cron roster
//   user:{id}             { email, name, chatId?, testMode?, createdAt }
//   u:{id}:tickers        "AAPL,MSFT,..."
//   u:{id}:index_tickers  "SPY,QQQ,..."
//   push:{id}             webpush-edge subscription list (one per device)
//   pushep:{sha256}       user id owning a push endpoint, for /api/push/rotate
//   snap:{id}             { TICKER: rsi } from the last cron run, for crossing detection
//   tglink:{code}         user id, 1h TTL — the one-time /subscribe code for Telegram
//   log:{id}              [{ t, signal, ticker, rsi, index }] newest first — alert history
//
// Pre-PWA keys (s:{sessionId}:*, subscribers, tickers, index_tickers) are left
// alone and no longer read.

export function parseList(s) {
  return (s || "").split(",").map(t => t.trim().toUpperCase()).filter(Boolean);
}

export async function getUser(env, id) {
  const raw = await env.RSI_KV.get(`user:${id}`);
  return raw ? JSON.parse(raw) : null;
}

export async function putUser(env, id, user) {
  await env.RSI_KV.put(`user:${id}`, JSON.stringify(user));
}

/** Create or refresh the profile on sign-in, and make sure the cron sees this user. */
export async function upsertUser(env, { id, email, name }) {
  const existing = await getUser(env, id);
  await putUser(env, id, { ...existing, email, name, createdAt: existing?.createdAt || Date.now() });
  if (!existing) {
    const roster = await getRoster(env);
    if (!roster.includes(id)) await env.RSI_KV.put("users", JSON.stringify([...roster, id]));
  }
}

export async function getRoster(env) {
  return JSON.parse((await env.RSI_KV.get("users")) || "[]");
}

export async function getTickers(env, id) {
  const [tickers, indexTickers] = await Promise.all([
    env.RSI_KV.get(`u:${id}:tickers`),
    env.RSI_KV.get(`u:${id}:index_tickers`),
  ]);
  return { tickers: tickers || "", indexTickers: indexTickers || "" };
}

export async function putTickers(env, id, { tickers, indexTickers }) {
  const jobs = [];
  if (tickers !== undefined) jobs.push(env.RSI_KV.put(`u:${id}:tickers`, tickers.trim()));
  if (indexTickers !== undefined) jobs.push(env.RSI_KV.put(`u:${id}:index_tickers`, indexTickers.trim()));
  await Promise.all(jobs);
}

// The alert log: what Telegram used to keep by accident. Entries age out after
// LOG_RETENTION_DAYS; the cap only matters if a long list crosses a lot at once.
export const LOG_RETENTION_DAYS = 30;
const LOG_MAX = 500;

export async function getLog(env, id, now = Date.now()) {
  const raw = await env.RSI_KV.get(`log:${id}`);
  const cutoff = now - LOG_RETENTION_DAYS * 86400e3;
  return (raw ? JSON.parse(raw) : []).filter(e => e.t >= cutoff);
}

export async function appendLog(env, id, entries, now = Date.now()) {
  if (entries.length === 0) return;
  const log = [...entries, ...(await getLog(env, id, now))].slice(0, LOG_MAX);
  // The TTL clears the key for a user whose alerts stop altogether.
  await env.RSI_KV.put(`log:${id}`, JSON.stringify(log), { expirationTtl: LOG_RETENTION_DAYS * 86400 });
}
