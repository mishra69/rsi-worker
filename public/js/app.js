// RSI Tracker — page logic. Classic script; window.Push (webpush-edge client) is
// set by the module script in index.html, which runs before this deferred one.

const $ = (sel) => document.querySelector(sel);

// ── API ─────────────────────────────────────────────────────────────────────

const TOKEN_KEY = "rsi.token";
const PROFILE_KEY = "rsi.profile";
const CACHE_KEY = "rsi.cache"; // last tickers + RSI table, so the app opens instantly and offline

class HttpError extends Error {
  constructor(status, body) {
    super(body?.error || "HTTP " + status);
    this.status = status;
  }
}

function authHeaders() {
  const t = localStorage.getItem(TOKEN_KEY);
  return t ? { Authorization: "Bearer " + t } : {};
}

// A hung request is worse than a failed one: on an iOS cold launch fetch can
// stall rather than reject, so everything gets a deadline.
async function api(path, { method = "GET", body, auth = true, timeout = 15000 } = {}) {
  const headers = auth ? authHeaders() : {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeout);
  let res;
  try {
    res = await fetch(path, { method, headers, signal: ac.signal, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch (e) {
    throw new HttpError(0, { error: ac.signal.aborted ? "timed out" : "offline" });
  } finally {
    clearTimeout(timer);
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && auth) { signOut(); throw new HttpError(401, data); }
  if (!res.ok) throw new HttpError(res.status, data);
  return data;
}

const PUSH_OPTS = () => ({
  keyUrl: "/api/push/key",
  subscribeUrl: "/api/push/subscribe",
  unsubscribeUrl: "/api/push/unsubscribe",
  headers: authHeaders(),
});

// ── State ───────────────────────────────────────────────────────────────────

let state = {
  tickers: "",
  indexTickers: "",
  stocks: [],
  lastUpdated: null,
  configOpen: true,
  allOpen: true,
  allSort: localStorage.getItem("allSort") || null, // null = zone order, 'asc' = RSI low→high, 'desc' = RSI high→low
  loading: false,
  error: null,
  offline: false,
  editMode: false,
  selected: new Set(),
};
let refreshInterval = null;
const REFRESH_MS = 5 * 60 * 1000;
let hiddenAt = null;

function saveCache() {
  localStorage.setItem(CACHE_KEY, JSON.stringify({
    tickers: state.tickers, indexTickers: state.indexTickers, stocks: state.stocks, lastUpdated: state.lastUpdated,
  }));
}

function loadCache() {
  try {
    const c = JSON.parse(localStorage.getItem(CACHE_KEY) || "null");
    if (c) Object.assign(state, c);
  } catch (e) {}
}

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

const tickersInput = $("#tickersInput");
const indexTickersInput = $("#indexTickersInput");
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
  const d = await api("/api/tickers");
  state.tickers = d.tickers || "";
  state.indexTickers = d.indexTickers || "";
}

async function saveLists(lists) {
  try {
    await api("/api/tickers", { method: "POST", body: lists });
  } catch (e) {
    if (e.status !== 401) { state.error = "Couldn't save — " + e.message; render(); }
  }
}
const saveTickers = (tickers) => saveLists({ tickers });
const saveIndexTickers = (indexTickers) => saveLists({ indexTickers });

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

function renderRows(stocks, indexSet, isAllTable) {
  return stocks.map((s, i) => {
    const color = zoneColor(s.zone);
    const isIndex = indexSet && indexSet.has(s.ticker);
    const chgClass = s.changePercent > 0 ? "up" : s.changePercent < 0 ? "down" : "flat";
    const chgStr = s.changePercent != null ? (s.changePercent > 0 ? "+" : "") + s.changePercent + "%" : "";
    const rsiPct = s.rsi != null ? Math.min(100, Math.max(0, s.rsi)) : 0;
    const selectedClass = state.selected.has(s.ticker) ? " edit-selected" : "";
    const checkBox = state.editMode
      ? '<input type="checkbox" data-ticker="' + s.ticker + '"' + (state.selected.has(s.ticker) ? " checked" : "") + '>'
      : "";
    return '<div class="table-row' + (isAllTable ? " table-row-all" : "") + selectedClass + '" style="animation-delay:' + (i * 40) + 'ms">' +
      '<span class="col-ticker">' + checkBox + '<span class="ticker-text">' + s.ticker + '</span>' + (isIndex ? '<span class="index-tag">I</span>' : '') + '</span>' +
      '<span class="col-price">' + (s.price != null ? currencySymbol(s.currency) + s.price.toLocaleString() : "—") + '</span>' +
      '<span class="col-change ' + chgClass + '">' + chgStr + '</span>' +
      '<div class="rsi-bar">' +
        '<div class="marker" style="left:30%"></div>' +
        '<div class="marker" style="left:50%"></div>' +
        '<div class="marker" style="left:70%"></div>' +
        '<div class="fill" style="width:' + rsiPct + '%;background:' + color + '"></div>' +
      '</div>' +
      '<span class="col-rsi" style="color:' + color + '">' + (s.rsi != null ? s.rsi.toFixed(1) : "—") + '</span>' +
      (isAllTable ? '<span class="col-signal" style="color:' + color + '">' + (ZONE_META[s.zone] || ZONE_META.no_data).label + '</span>' : '') +
    '</div>';
  }).join("");
}

function render() {
  if (document.activeElement !== tickersInput) tickersInput.value = state.tickers;
  if (document.activeElement !== indexTickersInput) indexTickersInput.value = state.indexTickers;
  autoResize(tickersInput);
  autoResize(indexTickersInput);
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
  // BUY: regular tickers ≤30, plus index tickers <50
  const buys = state.stocks.filter(s =>
    s.zone === "oversold" ||
    (indexSet.has(s.ticker) && (s.zone === "below_midline" || s.zone === "oversold"))
  );
  // SELL: all tickers ≥70
  const sells = state.stocks.filter(s => s.zone === "overbought");

  const parts = [];
  if (state.offline) parts.push('<span class="offline-note">Offline</span>');
  if (state.lastUpdated) parts.push("Updated " + new Date(state.lastUpdated).toLocaleTimeString());
  if (state.stocks.length) parts.push(state.stocks.length + " scanned");
  if (buys.length) parts.push('<span class="green">' + buys.length + ' buy</span>');
  if (sells.length) parts.push('<span class="red">' + sells.length + ' sell</span>');
  if (state.stocks.length && !state.loading) {
    parts.push('<button class="btn btn-refresh" id="refreshBtn">↻ REFRESH</button>');
  }
  statusBar.innerHTML = parts.join('<span style="color:var(--text-muted)">·</span>');
  const refreshBtn = $("#refreshBtn");
  if (refreshBtn) refreshBtn.addEventListener("click", fetchData);

  const hasSignals = buys.length || sells.length;

  const editToolbar = $("#editToolbar");
  if (state.stocks.length) {
    editToolbar.style.display = "flex";
    $("#deleteSelectedBtn").style.display = state.editMode && state.selected.size > 0 ? "inline-flex" : "none";
    $("#doneEditBtn").style.display = state.editMode ? "inline-flex" : "none";
    $("#modifyListBtn").textContent = state.editMode ? "CANCEL" : "MODIFY LIST";
  } else {
    editToolbar.style.display = "none";
  }

  if (buys.length) {
    buySection.style.display = "block";
    buyBody.innerHTML = renderRows(buys, indexSet, false);
  } else {
    buySection.style.display = "none";
  }

  if (sells.length) {
    sellSection.style.display = "block";
    sellBody.innerHTML = renderRows(sells, indexSet, false);
  } else {
    sellSection.style.display = "none";
  }

  if (state.stocks.length) {
    allSection.style.display = "block";
    allBody.style.display = state.allOpen ? "block" : "none";
    allArrow.classList.toggle("open", state.allOpen);
    allSub.textContent = state.stocks.length + " tickers";

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
    allRows.innerHTML = renderRows(sorted, indexSet, true);
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
  const allTickers = [...new Set([
    ...state.tickers.split(",").map(t => t.trim().toUpperCase()).filter(Boolean),
    ...state.indexTickers.split(",").map(t => t.trim().toUpperCase()).filter(Boolean),
  ])].join(",");
  if (!allTickers) { state.stocks = []; saveCache(); render(); return; }

  state.loading = true;
  state.error = null;
  render();

  try {
    const data = await api("/api/rsi?tickers=" + encodeURIComponent(allTickers), { timeout: 30000 });
    state.stocks = data.stocks || [];
    state.lastUpdated = Date.now();
    state.offline = false;
    state.configOpen = false;
    saveCache();
  } catch (err) {
    // Offline isn't an error worth a red box — the cached table is still shown.
    if (err.status === 0 || err.status === 503) state.offline = true;
    else state.error = err.message;
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
  if (!autoRefreshChk?.checked || !state.stocks.length || $("#app").hidden) return;
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

$("#helpToggle").addEventListener("click", () => {
  $("#helpBody").classList.toggle("hidden");
  $("#helpArrow").classList.toggle("open");
});

// ── Ticker search ───────────────────────────────────────────────────────────

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
      const data = await api("/api/search?q=" + encodeURIComponent(q));
      renderSearchResults(data.results || []);
    } catch (e) { searchDropdown.style.display = "none"; }
  }, 300);
});

document.addEventListener("click", (e) => {
  if (!searchInput.contains(e.target) && !searchDropdown.contains(e.target)) {
    searchDropdown.style.display = "none";
  }
});

// ── Edit mode ───────────────────────────────────────────────────────────────

$("#modifyListBtn").addEventListener("click", () => {
  state.editMode = !state.editMode;
  state.selected = new Set();
  render();
});

$("#doneEditBtn").addEventListener("click", () => {
  state.editMode = false;
  state.selected = new Set();
  render();
});

$("#deleteSelectedBtn").addEventListener("click", async () => {
  const toDelete = state.selected;
  state.tickers = state.tickers.split(",").map(t => t.trim().toUpperCase()).filter(t => t && !toDelete.has(t)).join(",");
  state.indexTickers = state.indexTickers.split(",").map(t => t.trim().toUpperCase()).filter(t => t && !toDelete.has(t)).join(",");
  state.editMode = false;
  state.selected = new Set();
  await saveLists({ tickers: state.tickers, indexTickers: state.indexTickers });
  fetchData();
});

// Checkbox delegation — all three table bodies
["buyBody", "sellBody", "allRows"].forEach(id => {
  $("#" + id).addEventListener("change", (e) => {
    if (e.target.type !== "checkbox") return;
    const ticker = e.target.dataset.ticker;
    if (e.target.checked) state.selected.add(ticker);
    else state.selected.delete(ticker);
    // Sync the same ticker's checkbox in other tables without full re-render
    document.querySelectorAll('input[type=checkbox][data-ticker="' + ticker + '"]').forEach(cb => {
      cb.checked = state.selected.has(ticker);
      cb.closest(".table-row").classList.toggle("edit-selected", state.selected.has(ticker));
    });
    $("#deleteSelectedBtn").style.display = state.selected.size > 0 ? "inline-flex" : "none";
  });
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
  if (state.allSort) localStorage.setItem("allSort", state.allSort);
  else localStorage.removeItem("allSort");
  render();
});

fetchBtn.addEventListener("click", async () => {
  state.tickers = tickersInput.value.trim();
  state.indexTickers = indexTickersInput.value.trim();
  await saveLists({ tickers: state.tickers, indexTickers: state.indexTickers });
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

$("#autoRefreshChk").addEventListener("change", (e) => {
  if (e.target.checked) {
    scheduleRefresh();
  } else {
    if (refreshInterval) clearInterval(refreshInterval);
    refreshInterval = null;
  }
});

// ── Alerts panel ────────────────────────────────────────────────────────────

const alertsBody = $("#alertsBody");
const pushHint = $("#pushHint");
const pushOnBtn = $("#pushOnBtn");
const pushOffBtn = $("#pushOffBtn");
const testModeChk = $("#testModeChk");
const testSentFlash = $("#testSentFlash");

$("#alertsToggle").addEventListener("click", () => {
  const opening = alertsBody.classList.contains("hidden");
  alertsBody.classList.toggle("hidden");
  $("#alertsArrow").classList.toggle("open");
  if (opening) refreshAlerts();
});

const PUSH_REASONS = {
  "needs-install": "Add the app to your Home Screen first, then turn notifications on from there.",
  blocked: "Notifications are blocked for this site. Re-enable them in your browser or iOS Settings.",
  dismissed: "Permission wasn't granted — tap the button again to retry.",
  unsupported: "This browser doesn't support notifications.",
  "no-vapid-key": "The server isn't configured for notifications yet.",
};

async function pushStatus() {
  const sub = await Push.currentSubscription();
  const status = await api("/api/push/status" + (sub ? "?endpoint=" + encodeURIComponent(sub.endpoint) : ""));
  return { sub, ...status };
}

// The browser can hold a live subscription the server has never seen — it was
// made before this account signed in, the server copy was pruned, or the
// subscribe POST was lost. Nothing else would ever re-send it, so the device
// silently gets no alerts. Re-register it; permission is already granted, so
// this needs no gesture and shows no prompt.
async function syncPush() {
  let status = await pushStatus();
  if (status.sub && !status.thisDevice && Notification.permission === "granted") {
    const r = await Push.subscribe({ ...PUSH_OPTS(), prompt: false });
    if (r.ok) status = await pushStatus();
  }
  return status;
}

async function renderPush() {
  pushOnBtn.hidden = true;
  pushOffBtn.hidden = true;
  const { state: support } = window.Push ? Push.pushSupport() : { state: "unsupported" };

  if (support === "unsupported") {
    pushHint.textContent = PUSH_REASONS.unsupported + " Link Telegram below instead.";
    return;
  }
  if (support === "needs-install") {
    pushHint.innerHTML = "On iPhone and iPad, notifications only work from the installed app. Tap <b>Share → Add to Home Screen</b>, then open RSI from your Home Screen.";
    return;
  }
  if (support === "blocked") {
    pushHint.textContent = PUSH_REASONS.blocked;
    return;
  }

  let status = { devices: 0, thisDevice: false };
  try { status = await syncPush(); } catch (e) {}

  if (status.thisDevice) {
    pushHint.innerHTML = '<span class="ok">✓ On for this device.</span> ' +
      (status.devices > 1 ? status.devices + " devices get alerts." : "") +
      " Alerts fire when a ticker crosses into BUY or SELL.";
    pushOffBtn.hidden = false;
  } else {
    pushHint.textContent = "Get a notification when a ticker crosses into BUY or SELL." +
      (status.devices ? " (" + status.devices + " other device" + (status.devices > 1 ? "s" : "") + " already on.)" : "");
    pushOnBtn.hidden = false;
  }
}

// ── One-time nudge ──
// Alerts are the point of the app, but the switch lives in a collapsed panel,
// so a signed-in device can sit with no notifications and nobody notices. Ask
// once per device; whatever the answer, don't ask again — the Alerts panel
// stays the place to change it.
const PUSH_NUDGE_KEY = "rsi.pushNudged";
const pushNudge = $("#pushNudge");

function nudgeDone() {
  try { localStorage.setItem(PUSH_NUDGE_KEY, "1"); } catch (e) {}
  pushNudge.hidden = true;
}

async function maybeNudgePush() {
  try { if (localStorage.getItem(PUSH_NUDGE_KEY)) return; } catch (e) { return; }
  if (!window.Push) return;
  // needs-install is the install prompt's job; blocked can't be fixed from a button.
  const { state: support } = Push.pushSupport();
  if (support !== "prompt" && support !== "granted") return;
  try {
    const status = await syncPush();
    if (status.thisDevice) return;
  } catch (e) { return; } // offline or signed out; try again next launch
  pushNudge.hidden = false;
}

$("#pushNudgeOn").addEventListener("click", async () => {
  // Must stay inside the click: iOS refuses the permission prompt outside a gesture.
  const btn = $("#pushNudgeOn");
  const text = $("#pushNudgeText");
  btn.disabled = true;
  text.textContent = "Turning on…";
  try {
    const r = await Push.subscribe(PUSH_OPTS());
    if (r.ok) {
      nudgeDone();
      if (!alertsBody.classList.contains("hidden")) renderPush();
      return;
    }
    // A declined prompt is an answer; anything else is worth another tap.
    if (r.reason === "blocked" || r.reason === "dismissed") { nudgeDone(); return; }
    text.textContent = PUSH_REASONS[r.reason] || "Couldn't turn on: " + r.reason;
  } catch (e) {
    text.textContent = "Couldn't turn on: " + e.message;
  } finally {
    btn.disabled = false;
  }
});

$("#pushNudgeLater").addEventListener("click", nudgeDone);

pushOnBtn.addEventListener("click", async () => {
  // Must stay inside the click: iOS refuses the permission prompt outside a gesture.
  pushOnBtn.disabled = true;
  pushHint.textContent = "Turning on…";
  try {
    const r = await Push.subscribe(PUSH_OPTS());
    if (!r.ok) pushHint.textContent = PUSH_REASONS[r.reason] || "Couldn't turn on: " + r.reason;
    else { nudgeDone(); await renderPush(); }
  } catch (e) {
    pushHint.textContent = "Couldn't turn on: " + e.message;
  } finally {
    pushOnBtn.disabled = false;
  }
});

pushOffBtn.addEventListener("click", async () => {
  pushOffBtn.disabled = true;
  try { await Push.unsubscribe(PUSH_OPTS()); } catch (e) {}
  pushOffBtn.disabled = false;
  await renderPush();
});

testModeChk.addEventListener("change", async (e) => {
  try { await api("/api/alerts/test-mode", { method: "POST", body: { testMode: e.target.checked } }); }
  catch (err) { e.target.checked = !e.target.checked; }
});

function flashTest(text, ok) {
  testSentFlash.textContent = text;
  testSentFlash.style.color = ok ? "" : "var(--red)";
  testSentFlash.classList.add("show");
  setTimeout(() => testSentFlash.classList.remove("show"), 4000);
}

$("#sendTestNowBtn").addEventListener("click", async () => {
  const btn = $("#sendTestNowBtn");
  btn.textContent = "SENDING...";
  btn.disabled = true;
  try {
    const r = await api("/api/alerts/snapshot", { method: "POST", timeout: 30000 });
    flashTest("✓ Sent" + (r.sent ? " to " + r.sent + " device" + (r.sent > 1 ? "s" : "") : ""), true);
  } catch (e) {
    flashTest(e.message, false);
  } finally {
    btn.textContent = "SEND SNAPSHOT NOW";
    btn.disabled = false;
  }
});

// Telegram (fallback)
async function renderTelegram(me) {
  $("#tgLinked").hidden = !me.telegram;
  $("#tgUnlinked").hidden = !!me.telegram;
}

$("#tgLinkBtn").addEventListener("click", async () => {
  try {
    const { code, bot } = await api("/api/telegram/link", { method: "POST" });
    if (bot) $("#tgBotName").textContent = "@" + bot;
    $("#tgCommandInput").value = "/subscribe " + code;
    $("#tgCodeRow").hidden = false;
    $("#tgCheckBtn").hidden = false;
  } catch (e) {}
});

$("#tgCopyBtn").addEventListener("click", () => {
  navigator.clipboard.writeText($("#tgCommandInput").value).then(() => {
    $("#tgCopyBtn").textContent = "COPIED!";
    setTimeout(() => { $("#tgCopyBtn").textContent = "COPY"; }, 1500);
  });
});

$("#tgCheckBtn").addEventListener("click", refreshAlerts);

$("#tgUnlinkBtn").addEventListener("click", async () => {
  await api("/api/telegram/unlink", { method: "POST" }).catch(() => {});
  refreshAlerts();
});

async function refreshAlerts() {
  renderPush();
  try {
    const me = await api("/api/me");
    testModeChk.checked = !!me.testMode;
    renderTelegram(me);
  } catch (e) {}
}

// The hidden test trigger: tap the build stamp to fire a real push through the
// real pipeline and see the push service's answer — 201 accepted, 403 VAPID
// mismatch, 400 encryption, 410 subscription gone.
$("#versionTag").addEventListener("click", async () => {
  const tag = $("#versionTag");
  VersionUI.render("sending test push…");
  try {
    if (window.Push && Push.pushSupport().supported) await syncPush().catch(() => {});
    const r = await api("/api/push/test", { method: "POST" });
    const statuses = (r.results || []).map(x => x.status).join(", ");
    VersionUI.render(r.sent ? "push sent → " + statuses : "push not delivered → " +
      (statuses || "no devices — turn on alerts in this app first") + (r.pruned ? " (" + r.pruned + " pruned)" : ""));
  } catch (e) {
    VersionUI.render("push test failed: " + e.message);
  }
  setTimeout(() => VersionUI.render(), 6000);
});

// ── Alert log ───────────────────────────────────────────────────────────────

const logBody = $("#logBody");

$("#logToggle").addEventListener("click", () => {
  const opening = logBody.classList.contains("hidden");
  logBody.classList.toggle("hidden");
  $("#logArrow").classList.toggle("open");
  if (opening) loadLog();
});

function logDayLabel(d) {
  const day = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const diff = Math.round((today - day) / 86400e3);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

async function loadLog() {
  const hint = $("#logHint");
  const list = $("#logList");
  hint.hidden = false;
  hint.textContent = "Loading…";
  let data;
  try {
    data = await api("/api/alerts/log");
  } catch (e) {
    hint.textContent = e.message === "offline" ? "The log needs a connection." : "Couldn't load the log: " + e.message;
    return;
  }
  list.replaceChildren();
  if (!data.entries.length) {
    hint.textContent = "No BUY or SELL alerts in the last " + data.retentionDays + " days.";
    return;
  }
  hint.textContent = "BUY and SELL crossings from the last " + data.retentionDays + " days, newest first.";
  let lastDay = null;
  for (const e of data.entries) {
    const d = new Date(e.t);
    const day = logDayLabel(d);
    if (day !== lastDay) {
      const h = document.createElement("div");
      h.className = "log-day";
      h.textContent = day;
      list.append(h);
      lastDay = day;
    }
    const row = document.createElement("div");
    row.className = "log-row";
    const cell = (cls, text) => { const s = document.createElement("span"); s.className = cls; s.textContent = text; return s; };
    const ticker = cell("log-ticker", e.ticker);
    if (e.index) ticker.append(cell("idx", "INDEX"));
    row.append(
      cell("log-time", d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })),
      cell("log-signal " + e.signal.toLowerCase(), e.signal),
      ticker,
      cell("log-rsi", "RSI " + Number(e.rsi).toFixed(1)),
    );
    list.append(row);
  }
}

// ── Sign-in ─────────────────────────────────────────────────────────────────

function loadGoogleScript() {
  return new Promise((resolve, reject) => {
    if (window.google?.accounts?.id) return resolve();
    const s = document.createElement("script");
    s.src = "https://accounts.google.com/gsi/client";
    s.async = true;
    // A cross-origin script can stall without firing onerror; give it a deadline.
    const timer = setTimeout(() => reject(new Error("timed out")), 10000);
    s.onload = () => { clearTimeout(timer); resolve(); };
    s.onerror = () => { clearTimeout(timer); reject(new Error("could not load")); };
    document.head.append(s);
  });
}

function signinMessage(text, isError) {
  const el = $("#signinMsg");
  el.textContent = text;
  el.classList.toggle("error", !!isError);
  el.hidden = !text;
}

async function showSignIn() {
  $("#app").hidden = true;
  $("#signinScreen").hidden = false;
  if (new URLSearchParams(location.search).get("signin") === "failed") {
    history.replaceState(null, "", "/");
    signinMessage("Sign-in failed — please try again.", true);
  }
  try {
    const cfg = await api("/api/config", { auth: false });
    if (!cfg.google_client_id) {
      signinMessage("Sign-in isn't configured yet (GOOGLE_CLIENT_ID is empty).", true);
      return;
    }
    await loadGoogleScript();
    // Redirect mode, not popup: an iOS home-screen app has no popups, and the
    // popup flow dead-ends on a Google 404 there. Google POSTs the credential to
    // login_uri, which stores the session and sends the app back to "/".
    // login_uri must be listed under the OAuth client's Authorized redirect URIs.
    google.accounts.id.initialize({
      client_id: cfg.google_client_id,
      ux_mode: "redirect",
      login_uri: location.origin + "/api/auth/google/redirect",
    });
    google.accounts.id.renderButton($("#googleBtn"), {
      theme: "filled_black", size: "large", shape: "pill", text: "continue_with",
    });
  } catch (e) {
    // GIS is cross-origin and can't be vendored, so sign-in never works offline.
    signinMessage(navigator.onLine ? "Couldn't load Google sign-in." : "Sign-in needs a connection.", true);
  }
}

function renderAccount() {
  const p = JSON.parse(localStorage.getItem(PROFILE_KEY) || "{}");
  const avatar = $("#avatar");
  avatar.title = p.email || "";
  const initials = (p.name || p.email || "?").trim().charAt(0).toUpperCase();
  avatar.textContent = initials;
  if (p.picture) {
    const img = new Image();
    img.alt = "";
    img.referrerPolicy = "no-referrer";
    // Google avatar URLs rotate and are cross-origin; keep the initial on failure.
    img.onload = () => { avatar.textContent = ""; avatar.append(img); };
    img.src = p.picture;
  }
}

async function signOut() {
  // Drop this device's push subscription so the next person to sign in here
  // doesn't receive the previous account's alerts. Best-effort.
  if (window.Push && localStorage.getItem(TOKEN_KEY)) {
    try { await Push.unsubscribe(PUSH_OPTS()); } catch (e) {}
  }
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(PROFILE_KEY);
  localStorage.removeItem(CACHE_KEY);
  if (refreshInterval) { clearInterval(refreshInterval); refreshInterval = null; }
  state = { ...state, tickers: "", indexTickers: "", stocks: [], lastUpdated: null };
  showSignIn();
}

$("#signOutBtn").addEventListener("click", signOut);

// ── Boot ────────────────────────────────────────────────────────────────────

async function showApp() {
  $("#signinScreen").hidden = true;
  $("#app").hidden = false;
  renderAccount();

  // Paint the cached table immediately; the network catches up behind it.
  loadCache();
  state.configOpen = !state.tickers;
  render();

  try {
    await loadTickers();
    saveCache();
  } catch (e) {
    if (e.status === 401) return; // signOut() already swapped to the sign-in screen
    state.offline = true;
  }
  if (!state.tickers && !state.indexTickers) {
    state.configOpen = true; // new user — open config so they can add tickers
    emptyState.textContent = "Add tickers above and tap UPDATE LIST to get started.";
  }
  render();
  if (!state.offline && (state.tickers || state.indexTickers)) fetchData();
  if (!state.offline) maybeNudgePush();

  // Held until after sign-in: the install prompt would otherwise cover the sign-in button.
  PWAInstall.init({
    appName: "RSI Tracker",
    sub: "Install to get buy/sell alerts as notifications — on iPhone that only works from the Home Screen.",
    remember: 7,
  });
}

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch((e) => console.warn("[sw] register failed", e));
}
VersionUI.init();

if (localStorage.getItem(TOKEN_KEY)) showApp();
else showSignIn();
