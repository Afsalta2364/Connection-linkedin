"use strict";
// Team dashboard: talks directly to Supabase (Auth + PostgREST) with the public
// publishable key and each user's own session. Database row-level rules decide
// who may read profiles and change their status.

const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const icon = name => `<svg aria-hidden="true"><use href="#icon-${name}"/></svg>`;
const cfg = window.PF_CONFIG || {};
const SESSION_KEY = "pf_dashboard_session";
const PAGE_SIZE = 1000;
const REFRESH_MS = 30000;

let session = null;          // {access_token, refresh_token, expires_at, email}
let refreshing = null;       // shared promise while a token refresh is running
let rows = [];               // [{id, name, headline, organization, source_url, contacted, connected}]
let filter = "all";
let category = localStorage.getItem("pf_category") || "all";   // profile category picker
let loaded = false, loading = false, authMode = "login";
let changes = 0;             // bumps after every saved or failed status change
let animateNext = false;     // play the row entrance animation on the next render
const pending = new Map();   // id -> number of in-flight status updates

// ---------- configuration ----------
function configProblem() {
  const url = String(cfg.supabaseUrl || ""), key = String(cfg.supabasePublishableKey || "");
  if (!url || !key || url.includes("your-project") || key.includes("replace_me")) return "Add your Supabase project URL and publishable key to config.js, then reload this page.";
  if (!/^https:\/\/[^/]+$/.test(url.replace(/\/$/, ""))) return "supabaseUrl in config.js must be your HTTPS project URL, without a path.";
  if (key.startsWith("sb_secret_")) return "config.js contains a secret key. Replace it with the publishable key right away; never publish a secret key.";
  if (!key.startsWith("sb_publishable_") && !key.startsWith("eyJ")) return "supabasePublishableKey in config.js must be the publishable key from your project's API settings.";
  return "";
}
const baseUrl = () => String(cfg.supabaseUrl).replace(/\/$/, "");
const pageUrl = () => window.location.origin + window.location.pathname;

// ---------- Supabase requests ----------
class ApiError extends Error {
  constructor(message, status, code = "") { super(message); this.status = status; this.code = code; }
}

async function call(path, {method = "GET", body, auth = true, headers = {}, retried = false} = {}) {
  const head = {apikey: cfg.supabasePublishableKey, "Content-Type": "application/json", Accept: "application/json", ...headers};
  if (auth) head.Authorization = "Bearer " + await accessToken();
  let response;
  try {
    response = await fetch(baseUrl() + path, {method, headers: head, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000)});
  } catch (_) {
    throw new ApiError("Couldn’t reach the server. Check your internet connection and try again.", 0);
  }
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (_) { data = null; }
  if (response.ok) return data;
  if (response.status === 401 && auth && !retried && session) {
    await refreshSession(true);
    return call(path, {method, body, auth, headers, retried: true});
  }
  throw new ApiError(errorMessage(path, response.status, data || {}), response.status, (data && data.code) || "");
}

function errorMessage(path, status, data) {
  if (status === 429) return "Too many attempts. Please wait a minute and try again.";
  if (path.startsWith("/auth/")) return data.msg || data.error_description || data.message || "Couldn’t sign in. Check your email and password.";
  if (path.includes("pf_profile_status") || path.includes("pf_set_status")) {
    if (["42P01", "PGRST202", "PGRST205"].includes(data.code)) return "Personal status tracking isn’t enabled yet. Ask your administrator to apply the personal status migration.";
  }
  if (["42P01", "PGRST202", "PGRST205"].includes(data.code)) return "The team database isn’t set up yet. Ask your administrator to apply the Supabase migrations.";
  if (status === 401 || status === 403 || data.code === "42501") return "You don’t have access to this team’s profiles. Ask your administrator to add your email.";
  return "Something went wrong. Please try again.";
}

function saveSession(tokens, email) {
  session = {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: Date.now() + Number(tokens.expires_in || 3600) * 1000,
    email: email || tokens.user?.email || session?.email || "",
  };
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

function dropSession() {
  session = null;
  localStorage.removeItem(SESSION_KEY);
}

async function accessToken() {
  if (!session) throw new ApiError("Please sign in to continue.", 401);
  if (session.expires_at - Date.now() < 60000) await refreshSession();
  return session.access_token;
}

async function refreshSession(force = false) {
  if (!session) throw new ApiError("Please sign in to continue.", 401);
  if (!force && session.expires_at - Date.now() >= 60000) return;
  if (!refreshing) {
    const token = session.refresh_token;
    refreshing = call("/auth/v1/token?grant_type=refresh_token", {method: "POST", body: {refresh_token: token}, auth: false})
      .then(tokens => saveSession(tokens))
      .catch(error => {
        dropSession();
        showAuth("Your session has ended. Please sign in again.");
        throw error;
      })
      .finally(() => { refreshing = null; });
  }
  return refreshing;
}

// ---------- views ----------
function show(view) {
  for (const id of ["bootView", "setupView", "authView", "dashboardView"]) $(id).hidden = id !== view;
  $("account").hidden = view !== "dashboardView";
}

function authMessage(text, success = false) {
  $("authMessage").textContent = text;
  $("authMessage").classList.toggle("success", success);
  $("authMessage").hidden = !text;
}

function setAuthMode(mode) {
  authMode = mode;
  const copy = {
    login:   ["Sign in", "Use your approved team email.", "Sign in", "New here?", "Create account"],
    signup:  ["Create account", "Use your approved work email.", "Create account", "Have an account?", "Sign in"],
    forgot:  ["Reset password", "We’ll email you a reset link.", "Send link", "Remembered?", "Sign in"],
    recover: ["New password", "Choose a new password.", "Save", "", ""],
  }[mode];
  $("authTitle").textContent = copy[0];
  $("authDescription").textContent = copy[1];
  $("authSubmit").textContent = copy[2];
  $("switchText").textContent = copy[3];
  $("switchMode").textContent = copy[4];
  $("switchMode").hidden = mode === "recover";
  $("forgotLink").hidden = mode !== "login";
  $("emailField").hidden = mode === "recover";
  $("passwordField").hidden = mode === "forgot";
  $("passwordLabel").textContent = mode === "recover" ? "New password" : "Password";
  $("authPassword").autocomplete = mode === "login" ? "current-password" : "new-password";
  $("authPassword").value = "";
}

function showAuth(message = "", success = false) {
  rows = []; loaded = false; pending.clear();
  show("authView");
  if (authMode === "recover") setAuthMode("login");
  authMessage(message, success);
}

async function enterDashboard() {
  $("accountEmail").textContent = session.email;
  show("dashboardView");
  render();
  await loadRows();
}

// ---------- data ----------
async function loadRows({quiet = false} = {}) {
  if (loading || !session) return;
  loading = true;
  const startedAt = changes;
  let reloadAgain = false;
  if (!quiet) $("refresh").disabled = true;
  try {
    // Shared profile list, plus this user's own statuses (the database returns only theirs).
    const [profiles, statuses] = await Promise.all([
      fetchProfiles(),
      fetchAll("pf_profile_status", {select: "profile_id,contacted,connected", order: "profile_id.asc"}),
    ]);
    if (changes !== startedAt) { reloadAgain = true; return; }  // a save finished mid-load; this data may be stale
    const mine = new Map(statuses.map(s => [s.profile_id, s]));
    const all = profiles.map(p => ({...p, contacted: !!mine.get(p.id)?.contacted, connected: !!mine.get(p.id)?.connected}));
    // Keep local values for rows whose switch is still being saved.
    const local = new Map(rows.map(r => [r.id, r]));
    rows = all.map(r => pending.has(r.id) && local.has(r.id) ? {...r, contacted: local.get(r.id).contacted, connected: local.get(r.id).connected} : r);
    if (!loaded) animateNext = true;  // stagger rows in on first load
    loaded = true;
    $("updated").textContent = "Updated " + new Date().toLocaleTimeString([], {hour: "2-digit", minute: "2-digit"});
    render();
  } catch (error) {
    if (error.status === 401 && !session) return;
    if (!loaded) { $("rows").innerHTML = emptyRow("Couldn’t load profiles", esc(error.message), '<button class="btn secondary" type="button" data-action="reload">Try again</button>'); $("summary").textContent = "Unable to load profiles"; }
    else if (!quiet) toast(error.message);
  } finally {
    loading = false;
    $("refresh").disabled = false;
    if (reloadAgain) loadRows({quiet: true});
  }
}

// Profiles with their category. Until the category migration is applied the
// column does not exist; fall back so the dashboard keeps working.
async function fetchProfiles() {
  const base = "id,name,headline,organization,source_url";
  try {
    return await fetchAll("pf_profiles", {select: base + ",category", order: "created_at.asc,id.asc"});
  } catch (error) {
    if (error.code !== "42703") throw error;
    return fetchAll("pf_profiles", {select: base, order: "created_at.asc,id.asc"});
  }
}

async function fetchAll(table, params) {
  const all = [];
  for (let offset = 0; ; offset = all.length) {
    const page = await call(`/rest/v1/${table}?` + new URLSearchParams({...params, limit: PAGE_SIZE, offset}));
    if (!Array.isArray(page)) throw new ApiError("The server returned an unexpected response.", 502);
    all.push(...page);
    // Stop only on an empty page: a project may cap responses below PAGE_SIZE.
    if (page.length === 0) return all;
  }
}

async function setStatus(id, field, value, {auto = false} = {}) {
  const row = rows.find(r => r.id === id);
  if (!row || row[field] === value) return;
  const previous = row[field];
  row[field] = value;
  pending.set(id, (pending.get(id) || 0) + 1);
  render();
  try {
    // Saves only this user's status; other users' switches are unaffected.
    const result = await call("/rest/v1/rpc/pf_set_status", {method: "POST", body: {p_profile_id: id, ["p_" + field]: value}});
    if (!Array.isArray(result) || result.length !== 1 || result[0][field] !== value) throw new ApiError("The change wasn’t confirmed. Please try again.", 502);
    const name = row.name || "This profile";
    const label = field === "connected" ? "Connected" : "Contacted";
    toast(auto ? `Connected · ${name}` : `${label} ${value ? "on" : "off"} · ${name}`);
  } catch (error) {
    row[field] = previous;
    toast(error.status === 401 ? error.message : `Not saved. ${error.message}`);
  } finally {
    changes += 1;
    const left = (pending.get(id) || 1) - 1;
    if (left) pending.set(id, left); else pending.delete(id);
    render();
  }
}

// ---------- rendering ----------
// Phones: open the LinkedIn app when it is installed.
// Android: an intent link opens the app directly and falls back to the website.
// iPhone/iPad: the normal https link is a "universal link" that iOS hands to the app.
// Desktop: LinkedIn offers no way to open its desktop app, so the browser is used.
const PLATFORM = /Android/i.test(navigator.userAgent) ? "android"
  : (/iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)) ? "ios" : "desktop";

function connectHref(url) {
  if (PLATFORM !== "android") return url;
  const u = new URL(url);
  return `intent://${u.host}${u.pathname}#Intent;scheme=https;package=com.linkedin.android;S.browser_fallback_url=${encodeURIComponent(url)};end`;
}

function profileUrl(source) {
  try {
    const url = new URL(source);
    if (url.protocol === "https:" && (url.hostname === "linkedin.com" || url.hostname.endsWith(".linkedin.com")) && /^\/in\/[^/]+/.test(url.pathname) && !url.username && !url.password) return url.href;
  } catch (_) {}
  return "";
}

const matches = (r, f) => f === "all" || (f === "pending" ? !r.contacted && !r.connected : !!r[f]);

function emptyRow(title, text, action = "") {
  return `<tr><td colspan="5" class="empty"><h3>${title}</h3><p>${text}</p>${action}</td></tr>`;
}

function switchHtml(r, field, name) {
  const on = !!r[field], label = field === "connected" ? "Connected" : "Contacted";
  return `<button type="button" class="switch ${field}" role="switch" aria-checked="${on}" data-id="${esc(r.id)}" data-field="${field}" aria-label="${label}: ${esc(name)}"${pending.has(r.id) ? ' aria-busy="true"' : ""}><span class="track" aria-hidden="true"><span class="knob"></span></span><span class="switch-label" aria-hidden="true">${on ? "Yes" : "No"}</span></button>`;
}

function skeletonRows(count = 7) {
  const row = '<tr class="skeleton" aria-hidden="true"><td class="num"></td><td class="name-cell"><span class="sk-name"></span><span class="sk-role"></span></td><td><span class="sk-pill"></span></td><td><span class="sk-pill"></span></td><td><span class="sk-btn"></span></td></tr>';
  return row.repeat(count);
}

// Counters lift briefly when their number changes.
function setCount(el, value) {
  const text = value.toLocaleString();
  if (el.textContent === text) return;
  const changed = loaded && el.textContent !== "0" && el.textContent !== "";
  el.textContent = text;
  if (changed) { el.classList.remove("bump"); void el.offsetWidth; el.classList.add("bump"); }
}

// Category filter: shown whenever profiles have categories (after the category migration).
function renderCategories() {
  const select = $("categoryFilter");
  const tally = new Map();
  for (const r of rows) if (r.category) tally.set(r.category, (tally.get(r.category) || 0) + 1);
  if (category !== "all" && !tally.has(category)) category = "all";
  select.hidden = tally.size === 0;
  const options = [["all", `All categories · ${rows.length.toLocaleString()}`],
    ...[...tally].sort((a, b) => a[0].localeCompare(b[0])).map(([name, n]) => [name, `${name} · ${n.toLocaleString()}`])];
  const html = options.map(([value, label]) => `<option value="${esc(value)}"${value === category ? " selected" : ""}>${esc(label)}</option>`).join("");
  if (select._html !== html) { select.innerHTML = html; select._html = html; }
}

function render() {
  if (loaded) renderCategories();
  const scope = category === "all" ? rows : rows.filter(r => r.category === category);
  const counts = {all: scope.length, pending: 0, contacted: 0, connected: 0};
  for (const r of scope) { if (r.contacted) counts.contacted++; if (r.connected) counts.connected++; if (!r.contacted && !r.connected) counts.pending++; }
  document.querySelectorAll("[data-count]").forEach(el => setCount(el, counts[el.dataset.count]));
  document.querySelectorAll(".status-tab").forEach(tab => tab.setAttribute("aria-pressed", String(tab.dataset.filter === filter)));
  const query = $("search").value.trim().toLowerCase();
  $("clearSearch").hidden = !query;
  if (!loaded) { $("rows").innerHTML = skeletonRows(); $("summary").textContent = "Loading…"; return; }
  const list = scope.map((r, i) => ({r, n: i + 1})).filter(({r}) => matches(r, filter) && (!query || `${r.name} ${r.headline} ${r.organization}`.toLowerCase().includes(query)));
  const label = category === "all" ? "profiles" : category;
  $("summary").textContent = (filter !== "all" || query) ? `${list.length.toLocaleString()} / ${scope.length.toLocaleString()}` : `${scope.length.toLocaleString()} ${label}`;
  const focused = document.activeElement?.classList.contains("switch") ? document.activeElement.dataset.id + ":" + document.activeElement.dataset.field : null;
  if (!rows.length) { $("rows").innerHTML = emptyRow("No profiles yet", "New profiles appear here."); return; }
  if (!list.length) {
    $("rows").innerHTML = query
      ? emptyRow("No matches", "Try another name or keyword.", '<button class="btn secondary" type="button" data-action="clear-search">Clear search</button>')
      : emptyRow("Nothing here yet", filter === "pending" ? "Everyone is contacted or connected." : `No one marked ${filter === "connected" ? "Connected" : "Contacted"} yet.`, '<button class="btn secondary" type="button" data-action="all">Show all</button>');
    return;
  }
  $("rows").innerHTML = list.map(({r, n}) => {
    const name = String(r.name || "Unnamed profile").trim() || "Unnamed profile";
    const parts = name.split(/\s+/);
    const initials = (Array.from(parts[0])[0] + (parts.length > 1 ? Array.from(parts[parts.length - 1])[0] : "")).toUpperCase();
    const role = [r.headline, r.organization && r.organization !== "Check profile" ? r.organization : ""].filter(Boolean).join(" · ");
    const url = profileUrl(r.source_url);
    const connect = url
      ? `<a class="btn connect" href="${esc(connectHref(url))}" target="_blank" rel="noopener noreferrer" data-id="${esc(r.id)}" aria-label="Connect with ${esc(name)} on LinkedIn">Connect ${icon("arrow")}</a>`
      : '<span class="unavailable">No link</span>';
    return `<tr><td class="num">${n}</td><td class="name-cell"><div class="person"><span class="avatar tone-${(n - 1) % 4}" aria-hidden="true">${esc(initials)}</span><span class="person-text"><span class="person-name">${esc(name)}</span>${role ? `<span class="person-role" title="${esc(role)}">${esc(role)}</span>` : ""}</span></div></td><td>${switchHtml(r, "contacted", name)}</td><td>${switchHtml(r, "connected", name)}</td><td>${connect}</td></tr>`;
  }).join("");
  if (animateNext) {
    animateNext = false;
    const body = $("rows");
    body.classList.remove("entering"); void body.offsetWidth; body.classList.add("entering");
    clearTimeout(body._entering);
    body._entering = setTimeout(() => body.classList.remove("entering"), 900);
  }
  if (focused) {
    const [id, field] = focused.split(":");
    Array.from(document.querySelectorAll(".switch")).find(el => el.dataset.id === id && el.dataset.field === field)?.focus();
  }
}

function toast(message) {
  const t = $("toast");
  t.textContent = message;
  t.classList.add("show");
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove("show"), 4000);
}

// ---------- events ----------
$("rows").addEventListener("click", event => {
  const sw = event.target.closest(".switch");
  if (sw) { if (sw.getAttribute("aria-busy") !== "true") setStatus(sw.dataset.id, sw.dataset.field, sw.getAttribute("aria-checked") !== "true"); return; }
  const action = event.target.closest("[data-action]")?.dataset.action;
  if (action === "reload") loadRows();
  if (action === "clear-search") { $("search").value = ""; render(); $("search").focus(); }
  if (action === "all") { filter = "all"; render(); }
});

// Clicking Connect opens LinkedIn and marks the profile Connected. The update is
// deferred so re-rendering the table cannot interfere with opening the new tab.
function markConnected(event) {
  const link = event.target.closest("a.connect");
  if (!link || (event.type === "auxclick" && event.button !== 1)) return;
  setTimeout(() => setStatus(link.dataset.id, "connected", true, {auto: true}), 0);
}
$("rows").addEventListener("click", markConnected);
$("rows").addEventListener("auxclick", markConnected);

document.querySelectorAll(".status-tab").forEach(tab => tab.addEventListener("click", () => {
  if (filter !== tab.dataset.filter) animateNext = true;
  filter = tab.dataset.filter; render();
}));
$("search").addEventListener("input", render);
$("categoryFilter").addEventListener("change", event => {
  category = event.target.value;
  localStorage.setItem("pf_category", category);
  animateNext = true;
  render();
});
$("clearSearch").addEventListener("click", () => { $("search").value = ""; render(); $("search").focus(); });
$("refresh").addEventListener("click", () => loadRows());

$("switchMode").addEventListener("click", () => { setAuthMode(authMode === "login" ? "signup" : "login"); authMessage(""); });
$("forgotLink").addEventListener("click", () => { setAuthMode("forgot"); authMessage(""); });

$("authForm").addEventListener("submit", async event => {
  event.preventDefault();
  const email = $("authEmail").value.trim().toLowerCase(), password = $("authPassword").value, mode = authMode;
  if (mode !== "recover" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return authMessage("Enter a valid email address.");
  if (mode !== "forgot" && !password) return authMessage("Enter your password.");
  if ((mode === "signup" || mode === "recover") && password.length < 8) return authMessage("Use a password with at least 8 characters.");
  $("authSubmit").disabled = true;
  authMessage("");
  try {
    if (mode === "login") {
      saveSession(await call("/auth/v1/token?grant_type=password", {method: "POST", body: {email, password}, auth: false}), email);
      await requireMember();
    } else if (mode === "signup") {
      const result = await call("/auth/v1/signup?redirect_to=" + encodeURIComponent(pageUrl()), {method: "POST", body: {email, password}, auth: false});
      if (result?.access_token) { saveSession(result, email); await requireMember(); }
      else { setAuthMode("login"); $("authEmail").value = email; authMessage("Check your inbox to confirm your email, then sign in here.", true); }
    } else if (mode === "forgot") {
      await call("/auth/v1/recover?redirect_to=" + encodeURIComponent(pageUrl()), {method: "POST", body: {email}, auth: false});
      setAuthMode("login"); $("authEmail").value = email;
      authMessage("If that email has an account, a reset link is on its way.", true);
    } else if (mode === "recover") {
      await call("/auth/v1/user", {method: "PUT", body: {password}});
      setAuthMode("login");
      toast("Password updated");
      await requireMember();
    }
  } catch (error) {
    if (!$("authView").hidden) authMessage(error.message);
  } finally {
    $("authSubmit").disabled = false;
    $("authPassword").value = "";
  }
});

async function requireMember() {
  const member = await call("/rest/v1/rpc/pf_is_member", {method: "POST", body: {}});
  if (member !== true) {
    await signOut(false);
    showAuth("This email doesn’t have team access yet. Ask your administrator to add it, and make sure you’ve confirmed your email.");
    return;
  }
  await enterDashboard();
}

async function signOut(showMessage = true) {
  const token = session?.access_token;
  dropSession();
  if (token) fetch(baseUrl() + "/auth/v1/logout?scope=local", {method: "POST", headers: {apikey: cfg.supabasePublishableKey, Authorization: "Bearer " + token}}).catch(() => {});
  if (showMessage) showAuth("You’ve signed out.", true);
}
$("signOut").addEventListener("click", () => signOut());

// Keep the list fresh while the tab is visible, so teammates see each other's changes.
setInterval(() => { if (!document.hidden && loaded && session) loadRows({quiet: true}); }, REFRESH_MS);
document.addEventListener("visibilitychange", () => { if (!document.hidden && loaded && session) loadRows({quiet: true}); });
window.addEventListener("storage", event => { if (event.key === SESSION_KEY && !event.newValue && session) { session = null; showAuth("You signed out in another tab."); } });

// ---------- start ----------
async function boot() {
  $("workspaceName").textContent = cfg.workspaceName ? `${cfg.workspaceName} · Team dashboard` : "Team dashboard";
  const problem = configProblem();
  if (problem) { $("setupMessage").textContent = problem; show("setupView"); return; }

  // App shortcut: open straight to the Pending filter.
  if (window.location.hash === "#pending") {
    filter = "pending";
    history.replaceState(null, "", window.location.pathname + window.location.search);
  }

  // Links from confirmation and password-reset emails return here with tokens in the URL fragment.
  const fragment = new URLSearchParams(window.location.hash.slice(1));
  if (fragment.has("access_token") || fragment.has("error_description") || fragment.has("error")) {
    history.replaceState(null, "", window.location.pathname + window.location.search);
  }
  if (fragment.has("error_description") || fragment.has("error")) {
    showAuth(fragment.get("error_description") || "That link is invalid or has expired. Please try again.");
    return;
  }
  try {
    if (fragment.has("access_token") && fragment.has("refresh_token")) {
      saveSession({access_token: fragment.get("access_token"), refresh_token: fragment.get("refresh_token"), expires_in: fragment.get("expires_in")}, "");
      const user = await call("/auth/v1/user");
      session.email = user?.email || ""; localStorage.setItem(SESSION_KEY, JSON.stringify(session));
      if (fragment.get("type") === "recovery") { show("authView"); setAuthMode("recover"); authMessage(""); return; }
      await requireMember();
      return;
    }
    const stored = JSON.parse(localStorage.getItem(SESSION_KEY) || "null");
    if (stored?.access_token && stored?.refresh_token) {
      session = stored;
      await requireMember();
      return;
    }
  } catch (error) {
    if (session && error.status !== 401) { $("bootMessage").textContent = error.message; show("bootView"); setTimeout(boot, 5000); return; }
    dropSession();
  }
  showAuth();
}

// ---------- installable app ----------
let installPrompt = null;
window.addEventListener("beforeinstallprompt", event => {
  event.preventDefault();          // show our own Install button instead of the browser banner
  installPrompt = event;
  $("installApp").hidden = false;
});
window.addEventListener("appinstalled", () => {
  installPrompt = null;
  $("installApp").hidden = true;
  toast("Installed · open Profiles from your apps");
});
$("installApp").addEventListener("click", async () => {
  if (!installPrompt) return;
  installPrompt.prompt();
  await installPrompt.userChoice.catch(() => null);
  installPrompt = null;
  $("installApp").hidden = true;
});
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
}

setAuthMode("login");
boot();
