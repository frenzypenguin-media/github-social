// github-social/app.js
//
// Shared application logic. Loaded by:
//   - src/index.html (Tauri desktop app)
//   - pwa/index.html (PWA mirror at frenzypenguin-media.github.io/github-social/)
//
// Detects runtime:
//   - window.__TAURI_INTERNALS__ → Tauri mode (Rust commands available)
//   - else → browser/PWA mode (Rust commands stubbed via fetch to api.github.com)
//
// Public API exposed on window.ghsocial:
//   ghsocial.bootstrap()        render UI shell
//   ghsocial.state              shared mutable state
//   ghsocial.bumpStat(k)
//   ghsocial.setStatus(msg)
//   ghsocial.checkForUpdates()  no-op in PWA

import { check as tauriCheck } from "@tauri-apps/plugin-updater";
import { invoke as tauriInvoke } from "@tauri-apps/api/core";

const IS_TAURI = typeof window !== "undefined" && !!window.__TAURI_INTERNALS__;
const API_BASE = "https://api.github.com";
const SESSION_KEY = "gh_social_session_v1";
const LEGACY_TOKEN_KEY = "gh_social_token";
const PROFILE_REPO_KEY = "gh_social_profile_repo";
const LOGIN_KEY = "gh_social_login";
const STATS_KEY = "gh_social_stats_v1";
const MAX_QUERY = 256;
const MAX_AVATAR_LOADS = 12;
const ACTIVATOR_BRANCHES = ["main", "master"];
const SPONSOR_URL = "https://github.com/sponsors/neohiro";

const state = {
  token: "",
  myLogin: localStorage.getItem(LOGIN_KEY) || "",
  profileRepo: localStorage.getItem(PROFILE_REPO_KEY) || "",
  isTauri: IS_TAURI,
};

// ---- Session / token ----------------------------------------------------

function loadSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* corrupt */ }
  return null;
}
function saveSession(s) {
  localStorage.setItem(SESSION_KEY, JSON.stringify(s));
}

// Migrate legacy token key.
const legacyToken = localStorage.getItem(LEGACY_TOKEN_KEY) || "";
if (legacyToken) {
  state.token = legacyToken;
  localStorage.removeItem(LEGACY_TOKEN_KEY);
  saveSession({ token: state.token, saved_at: Date.now() });
} else {
  const s = loadSession();
  if (s?.token) state.token = s.token;
}

// ---- Stats bar ---------------------------------------------------------

function loadStats() {
  try { return JSON.parse(localStorage.getItem(STATS_KEY) || "{}"); }
  catch { return {}; }
}
function bumpStat(key) {
  const s = loadStats();
  s[key] = (s[key] || 0) + 1;
  s.updated_at = Date.now();
  localStorage.setItem(STATS_KEY, JSON.stringify(s));
  renderStats();
}
function renderStats() {
  const s = loadStats();
  const m = (id, k) => {
    const el = document.getElementById(id);
    if (el) el.textContent = s[k] || 0;
  };
  m("stat-searches", "searches");
  m("stat-profiles", "profiles_loaded");
  m("stat-reactions", "reactions_given");
  m("stat-issues", "issues_opened");
}

// ---- Token validation --------------------------------------------------

function isValidTokenShape(t) {
  if (!t || typeof t !== "string") return false;
  if (t.length < 30 || t.length > 200) return false;
  return /^(ghp|gho|ghu|ghs)_[A-Za-z0-9]{30,}$/.test(t);
}

async function validateToken(t) {
  const res = await fetch(`${API_BASE}/user`, {
    headers: {
      Authorization: `Bearer ${t}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28"
    }
  });
  if (!res.ok) return { ok: false, status: res.status };
  const u = await res.json();
  // GitHub's /user endpoint always returns a string `login`, but defend against
  // a malformed body (e.g., 200 with empty object from a proxy misconfig).
  if (!u || typeof u.login !== "string" || !u.login) {
    return { ok: false, status: res.status, error: "GitHub returned an unexpected response shape" };
  }
  return { ok: true, login: u.login };
}

// ---- GitHub API helpers -----------------------------------------------

function ghHeaders() {
  const h = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
  if (state.token) h["Authorization"] = `Bearer ${state.token}`;
  return h;
}

class GitHubError extends Error {
  constructor(status, message, headers) {
    super(message);
    this.status = status;
    this.headers = headers;
    this.rateLimited = status === 403 || status === 429;
  }
}

async function ghFetch(path) {
  const res = await fetch(`${API_BASE}${path}`, { headers: ghHeaders() });
  if (!res.ok) {
    const remaining = res.headers.get("x-ratelimit-remaining");
    const reset = res.headers.get("x-ratelimit-reset");
    let body = "";
    try { body = (await res.json()).message || ""; } catch { /* ignore */ }
    throw new GitHubError(res.status, body || `HTTP ${res.status}`, { remaining, reset });
  }
  return res.json();
}

// ---- XSS helpers -------------------------------------------------------

function escapeHtml(s) {
  if (s == null) return "";
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

// escapeHtml but for attributes that hold URLs (do NOT escape `&` since the
// browser will interpret `&amp;` literally inside src=, breaking the URL).
// Only escape the chars that can break out of the attribute or inject HTML.
function escapeUrlAttr(s) {
  if (s == null) return "";
  return String(s).replace(/[<>"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

// safeHtml — tagged-template helper that auto-escapes all interpolations.
// Use for any innerHTML assignment with dynamic values:
//   el.innerHTML = safeHtml`<div>${userData}</div>`;
// Interpolations are escaped; static HTML can be included with the `raw` tag:
//   safeHtml`<div>${raw(trustedHtml)}</div>`
function safeHtml(strings, ...values) {
  let out = "";
  for (let i = 0; i < strings.length; i++) {
    out += strings[i];
    if (i < values.length) {
      const v = values[i];
      if (v && v.__raw === true && typeof v.html === "string") {
        out += v.html;
      } else {
        out += escapeHtml(v);
      }
    }
  }
  return out;
}
function raw(html) {
  return { __raw: true, html: String(html == null ? "" : html) };
}

// UTF-8-safe base64 encode. btoa() alone corrupts any string with chars > 0xFF
// (emoji, CJK, Latin-1 supplement). The old btoa(unescape(encodeURIComponent(x)))
// pattern works for most Unicode but is deprecated and silently breaks on non-BMP
// chars (rare emoji). Use TextEncoder explicitly.
function utf8ToBase64(s) {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function base64ToUtf8(b64) {
  const bin = atob(b64.replace(/\n/g, ""));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function avatarUrl(login, size = 80) {
  return `https://avatars.githubusercontent.com/${encodeURIComponent(login)}?s=${size}`;
}

// ---- Activator detection ----------------------------------------------

async function checkActivator(login) {
  for (const branch of ACTIVATOR_BRANCHES) {
    const url = `https://raw.githubusercontent.com/${encodeURIComponent(login)}/${encodeURIComponent(login)}/${branch}/profile-activator.html`;
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (res.ok) {
        const text = await res.text();
        if (text.includes('name="github-social"') && text.includes("activated")) return true;
      } else if (res.status === 404) {
        continue;
      }
    } catch { /* network: unknown */ }
  }
  return false;
}

// ---- Search ------------------------------------------------------------

async function ghSearch(query, type) {
  const q = encodeURIComponent(`${query} ${type === "org" ? "type:org" : "type:user"}`);
  return (await ghFetch(`/search/${type === "org" ? "organizations" : "users"}?q=${q}&per_page=20`)).items || [];
}

function renderResult(item, type, promoted, flags) {
  const htmlType = type === "org" ? "org" : "user";
  const flagHtml = (flags || []).map(f => `<span class="flag ${escapeHtml(f.cls)}">${escapeHtml(f.text)}</span>`).join("");
  return `
    <div class="result-item" data-login="${escapeHtml(item.login)}" data-type="${htmlType}">
      <img class="avatar" src="${escapeUrlAttr(avatarUrl(item.login))}" alt="${escapeHtml(item.login)}" loading="lazy" />
      <div class="info">
        <div style="display:flex;align-items:center;gap:8px;">
          <span class="login">${escapeHtml(item.login)}</span>
          <span class="type-badge ${htmlType}">${htmlType}</span>
          ${promoted ? '<span class="promoted">★ Promoted</span>' : ""}
        </div>
        <div class="followers">${escapeUrlAttr(item.html_url || "")}</div>
        ${flagHtml ? `<div class="flags">${flagHtml}</div>` : ""}
      </div>
    </div>`;
}

async function doSearch() {
  const input = document.getElementById("search-input");
  const query = input.value.trim();
  const type = document.getElementById("search-type").value;
  const container = document.getElementById("search-results");
  const btn = document.getElementById("search-btn");

  if (!query) return;
  if (query.length > MAX_QUERY) {
    container.innerHTML = safeHtml`<div class="error-msg">Query too long (max ${MAX_QUERY} chars)</div>`;
    return;
  }
  btn.disabled = true;
  setStatus("Searching…");
  container.innerHTML = '<div class="loading">Fetching from GitHub…</div>';
  bumpStat("searches");

  try {
    const items = await ghSearch(query, type);

    const probeTargets = items.slice(0, MAX_AVATAR_LOADS);
    const probed = await Promise.all(probeTargets.map(async (it) => {
      const has = await checkActivator(it.login);
      return { item: it, hasActivator: has };
    }));

    const activatedSet = new Set(probed.filter(p => p.hasActivator).map(p => p.item.login));
    const sorted = [...items];
    sorted.sort((a, b) => {
      const ai = activatedSet.has(a.login) ? 0 : 1;
      const bi = activatedSet.has(b.login) ? 0 : 1;
      return ai - bi;
    });

    if (sorted.length === 0) {
      container.innerHTML = safeHtml`<div class="error-msg">No results found.</div>`;
    } else {
      // Use a safeHtml tagged template so DOMPurify runs on the joined HTML.
      // renderResult() does its own escaping, but defense-in-depth: any future
      // change to renderResult that introduces an unescaped dynamic value will
      // be sanitized by the bundle.
      const rows = sorted.map((it, i) => {
        const isPromoted = activatedSet.has(it.login) && i === sorted.findIndex(x => activatedSet.has(x.login));
        const flags = [];
        if (!activatedSet.has(it.login)) flags.push({ cls: "integrity", text: "Not on GitHub Social" });
        return renderResult(it, type, isPromoted, flags);
      }).join("");
      container.innerHTML = safeHtml`${raw(rows)}`;
      attachAvatarFallbacks(container);
    }
    setStatus(`${items.length} result(s)`);
  } catch (e) {
    if (e instanceof GitHubError && e.rateLimited) {
      const reset = e.headers?.reset ? new Date(Number(e.headers.reset) * 1000).toLocaleTimeString() : "soon";
      container.innerHTML = safeHtml`<div class="error-msg warn">Rate limited — resets ${reset}. Add a token in Settings for higher limits.</div>`;
    } else {
      container.innerHTML = safeHtml`<div class="error-msg">Error: ${e.message}</div>`;
    }
    setStatus("Search failed");
  } finally {
    btn.disabled = false;
  }
}

function attachAvatarFallbacks(root) {
  root.querySelectorAll("img.avatar").forEach((img) => {
    img.addEventListener("error", () => {
      img.replaceWith(Object.assign(document.createElement("div"), {
        className: "avatar",
        textContent: (img.alt || "?").slice(0, 1).toUpperCase(),
        style: "display:flex;align-items:center;justify-content:center;color:var(--muted);font-weight:600;"
      }));
    }, { once: true });
  });
}

// ---- Network panel -----------------------------------------------------

async function loadNetwork() {
  const login = document.getElementById("network-input").value.trim();
  const out = document.getElementById("network-results");
  if (!login) return;
  if (login.length > MAX_QUERY) {
    out.innerHTML = safeHtml`<div class="error-msg">Login too long</div>`;
    return;
  }

  setStatus("Loading network…");
  out.innerHTML = '<div class="loading">Fetching followers/following…</div>';
  bumpStat("profiles_loaded");
  try {
    const [followers, following] = await Promise.all([
      ghFetch(`/users/${encodeURIComponent(login)}/followers?per_page=30`).catch(() => []),
      ghFetch(`/users/${encodeURIComponent(login)}/following?per_page=30`).catch(() => []),
    ]);
    const renderList = (arr, label) => {
      if (!arr.length) return `<div style="color:var(--muted);font-size:12px;margin:8px 0;">No ${label}</div>`;
      return arr.map((u) => `
        <div class="network-user" data-login="${escapeHtml(u.login)}">
          <img class="avatar" src="${escapeUrlAttr(avatarUrl(u.login, 64))}" alt="${escapeHtml(u.login)}" loading="lazy" />
          <span class="login">${escapeHtml(u.login)}</span>
        </div>`).join("");
    };
    out.innerHTML = safeHtml`
        <h3 style="font-size:13px;color:var(--muted);margin:8px 0;">Followers</h3>
        ${raw(renderList(followers, "followers"))}
        <h3 style="font-size:13px;color:var(--muted);margin:16px 0 8px;">Following</h3>
        ${raw(renderList(following, "following"))}`;
    attachAvatarFallbacks(out);
    setStatus(`Loaded ${followers.length} followers / ${following.length} following`);
  } catch (e) {
    out.innerHTML = safeHtml`<div class="error-msg">${e.message}</div>`;
    setStatus("Network load failed");
  }
}

// ---- Prefs panel (reads own GitHubSocial.md frontmatter) ---------------

function parseFrontmatter(md) {
  const m = md.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return null;
  const out = {};
  for (const line of m[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const k = line.slice(0, idx).trim();
    let v = line.slice(idx + 1).trim();
    if (v.startsWith("[") && v.endsWith("]")) {
      try { v = JSON.parse(v); } catch { /* keep string */ }
    } else if (v === "true") v = true;
    else if (v === "false") v = false;
    else if (/^-?\d+$/.test(v)) v = Number(v);
    out[k] = v;
  }
  return out;
}

async function loadOwnPrefs() {
  const out = document.getElementById("prefs-content");
  if (!state.myLogin) {
    out.innerHTML = '<div class="error-msg">Set your GitHub username in Settings first.</div>';
    return;
  }
  const repo = state.profileRepo || `${state.myLogin}/${state.myLogin}`;
  setStatus("Loading your GitHubSocial.md…");
  out.innerHTML = '<div class="loading">Fetching…</div>';
  try {
    const data = await ghFetch(`/repos/${encodeURIComponent(repo)}/contents/GitHubSocial.md`);
    const content = base64ToUtf8(data.content);
    const fm = parseFrontmatter(content);
    if (!fm) {
      out.innerHTML = safeHtml`<div class="error-msg warn">No frontmatter found in ${repo}/GitHubSocial.md. Click "Bootstrap my GitHubSocial.md" in Settings.</div>`;
      return;
    }
    const rows = Object.entries(fm).map(([k, v]) => safeHtml`
      <div style="display:flex;gap:8px;padding:6px 0;border-bottom:1px solid var(--border);font-size:12px;">
        <span style="color:var(--accent);font-weight:600;min-width:140px;">${k}</span>
        <span style="color:var(--text);flex:1;word-break:break-all;">${typeof v === "object" ? JSON.stringify(v) : String(v)}</span>
      </div>`).join("");
    out.innerHTML = safeHtml`<div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:12px;">${raw(rows)}</div>`;
    setStatus("Prefs loaded");
  } catch (e) {
    if (e instanceof GitHubError && e.status === 404) {
      out.innerHTML = '<div class="error-msg warn">No GitHubSocial.md yet. Use Settings → "Bootstrap my GitHubSocial.md".</div>';
    } else {
      out.innerHTML = safeHtml`<div class="error-msg">${e.message}</div>`;
    }
  }
}

// ---- Bootstrap (Tauri = gh CLI; PWA = REST commit API) ----------------

async function bootstrapSocialMd() {
  if (!state.myLogin) return "Set your GitHub username first.";
  if (!state.token) return "Set a GitHub token first.";
  const repo = state.profileRepo || `${state.myLogin}/${state.myLogin}`;
  const md = buildInitialSocialMd(state.myLogin);
  if (state.isTauri) {
    try {
      return await tauriInvoke("bootstrap_social_md", { login: state.myLogin, repo, content: md });
    } catch (e) {
      return `Tauri command failed: ${e}`;
    }
  }
  // PWA: REST commit to <login>/<login>
  try {
    const filePath = "GitHubSocial.md";
    let sha = null;
    try {
      const existing = await ghFetch(`/repos/${encodeURIComponent(repo)}/contents/${filePath}`);
      sha = existing.sha;
    } catch (e) {
      if (!(e instanceof GitHubError) || e.status !== 404) throw e;
    }
    const body = {
      message: sha ? "Update GitHubSocial.md" : "Add GitHubSocial.md (activate GitHub Social)",
      content: utf8ToBase64(md),
    };
    if (sha) body.sha = sha;
    const res = await fetch(`${API_BASE}/repos/${encodeURIComponent(repo)}/contents/${filePath}`, {
      method: "PUT",
      headers: ghHeaders(),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      return `Commit failed (${res.status}): ${j.message || "unknown"}`;
    }
    return "Committed GitHubSocial.md via REST.";
  } catch (e) {
    return `Error: ${e.message}`;
  }
}

function buildInitialSocialMd(login) {
  const today = new Date().toISOString().slice(0, 10);
  return [
    "---",
    `login: ${login}`,
    `activated: ${today}`,
    `schema: 2`,
    `theme: dark`,
    `accent: "#58a6ff"`,
    `motd: "Welcome to my GitHub Social profile!"`,
    `music_url: ""`,
    `show_counters: true`,
    `show_history: true`,
    `invite_template: "Hey! I'm using GitHub Social — a decentralized social layer on top of GitHub. Add a 'profile-activator.html' or 'GitHubSocial.md' to your repo to join."`,
    `counters: [hearts_given:0, reactions_given:0, comments_written:0, profiles_visited:0, issues_opened:0]`,
    `integrity: [spoof_count:0, last_checked:"", last_alert:""]`,
    `history: []`,
    "---",
    "",
    `# GitHub Social — ${login}`,
    "",
    "This file is the source of truth for GitHub Social on this profile.",
    "Edit the frontmatter above to change your preferences. The journey log",
    "below is auto-appended by the browser extension and Tauri GUI app.",
    "",
    "## Journey Log",
    "",
  ].join("\n");
}

// ---- Settings wiring ---------------------------------------------------

function wireSettings() {
  const tok = document.getElementById("gh-token");
  if (tok) tok.value = state.token;
  const prof = document.getElementById("my-profile-repo");
  if (prof) prof.value = state.profileRepo;
  const loginEl = document.getElementById("my-login");
  if (loginEl) loginEl.value = state.myLogin;

  const saveBtn = document.getElementById("save-token-btn");
  if (saveBtn) saveBtn.addEventListener("click", async () => {
    const raw = tok.value.trim();
    const status = document.getElementById("token-status");
    status.innerHTML = "";
    if (!raw) { status.innerHTML = '<span class="bad">Token is empty</span>'; return; }
    if (!isValidTokenShape(raw)) {
      status.innerHTML = '<span class="bad">Token shape invalid (expected ghp_/gho_/ghu_/ghs_ + 30+ chars)</span>';
      return;
    }
    status.innerHTML = '<span>Validating against api.github.com…</span>';
    try {
      const v = await validateToken(raw);
      if (!v.ok) { status.innerHTML = safeHtml`<span class="bad">GitHub rejected token (HTTP ${v.status})</span>`; return; }
      state.token = raw;
      saveSession({ token: state.token, saved_at: Date.now(), login: v.login });
      if (!state.myLogin && v.login) {
        state.myLogin = v.login;
        localStorage.setItem(LOGIN_KEY, state.myLogin);
        if (loginEl) loginEl.value = state.myLogin;
      }
      status.innerHTML = safeHtml`<span class="ok">Token valid (login: ${v.login})</span>`;
      setStatus("Token saved");
    } catch (e) {
      status.innerHTML = safeHtml`<span class="bad">Network error: ${e.message}</span>`;
    }
  });

  const clearBtn = document.getElementById("clear-token-btn");
  if (clearBtn) clearBtn.addEventListener("click", () => {
    state.token = "";
    localStorage.removeItem(SESSION_KEY);
    if (tok) tok.value = "";
    document.getElementById("token-status").innerHTML = '<span>Token cleared</span>';
    setStatus("Token cleared");
  });

  if (prof) prof.addEventListener("change", (e) => {
    state.profileRepo = e.target.value.trim();
    localStorage.setItem(PROFILE_REPO_KEY, state.profileRepo);
  });
  if (loginEl) loginEl.addEventListener("change", (e) => {
    state.myLogin = e.target.value.trim();
    localStorage.setItem(LOGIN_KEY, state.myLogin);
  });

  const boot = document.getElementById("bootstrap-md-btn");
  if (boot) boot.addEventListener("click", async () => {
    const status = document.getElementById("bootstrap-status");
    status.textContent = state.isTauri ? "Bootstrapping via gh CLI…" : "Committing via REST API…";
    const r = await bootstrapSocialMd();
    status.textContent = r;
    setStatus("GitHubSocial.md bootstrap attempted");
    loadOwnPrefs();
  });
}

// ---- Panel switching + nav --------------------------------------------

function wireNav() {
  const navButtons = document.querySelectorAll("nav button");
  const panels = document.querySelectorAll(".panel");
  navButtons.forEach(btn => {
    btn.addEventListener("click", () => {
      navButtons.forEach(b => b.classList.remove("active"));
      panels.forEach(p => p.classList.remove("active"));
      btn.classList.add("active");
      const panel = document.getElementById(`${btn.dataset.panel}-panel`);
      if (panel) panel.classList.add("active");
      if (btn.dataset.panel === "prefs") loadOwnPrefs();
    });
  });
}

function setStatus(msg) {
  const el = document.getElementById("status-text");
  if (el) el.textContent = msg;
}

async function checkForUpdates() {
  if (!IS_TAURI) return;
  try {
    const update = await tauriCheck();
    if (update?.available) {
      setStatus(`Update ${update.version} available — downloading…`);
      await update.downloadAndInstall();
    }
  } catch { /* silent */ }
}

// ── Bootstrap UI ──────────────────────────────────────────────────────

function bootstrap() {
  document.querySelectorAll("[data-tauri-only]").forEach(el => {
    el.style.display = IS_TAURI ? "" : "none";
  });
  document.querySelectorAll("[data-pwa-only]").forEach(el => {
    el.style.display = IS_TAURI ? "none" : "";
  });
  const v = document.getElementById("version-label");
  if (v) v.textContent = IS_TAURI ? "v0.2.0 desktop" : "v0.2.0 web";

  wireSettings();
  wireNav();
  renderStats();
  renderSessionStats();

  document.getElementById("search-btn").addEventListener("click", doSearch);
  document.getElementById("search-input").addEventListener("keydown", e => { if (e.key === "Enter") doSearch(); });
  document.getElementById("network-btn").addEventListener("click", loadNetwork);
  document.getElementById("network-input").addEventListener("keydown", e => { if (e.key === "Enter") loadNetwork(); });

  checkForUpdates();
  setStatus("Ready — search GitHub users & organizations");
}

window.ghsocial = {
  bootstrap,
  state,
  bumpStat,
  setStatus,
  checkForUpdates,
  SPONSOR_URL,
};

if (document.readyState !== "loading") bootstrap();
else document.addEventListener("DOMContentLoaded", bootstrap);

export { bootstrap, state, SPONSOR_URL };

// github-social/app.js — v0.2.0 additions
// This module extends the base app.js with JourneyLog, Reactions, Invite,
// SpoofChecker, MusicPlayer, StatsPanel, and ExtensionBridge.
//
// Existing exports are preserved; new functionality is added at the end.
// See SPEC_ADDENDUM.md § 13 for Extension Bridge API spec.

// ─────────────────────────────────────────────────────────────────────────────
// JourneyLog class
// ─────────────────────────────────────────────────────────────────────────────

class JourneyLog {
  constructor(login, repo) {
    this.login = login;
    this.repo = repo;
    this.pending = this._loadPending();
  }

  _loadPending() {
    try {
      return JSON.parse(localStorage.getItem("ghsocial_pending_journey") || "[]");
    } catch { return []; }
  }

  _savePending() {
    localStorage.setItem("ghsocial_pending_journey", JSON.stringify(this.pending));
  }

  async appendJourneyEntry(targetLogin, entryType, metadata = {}) {
    const ts = new Date().toISOString();
    const meta = JSON.stringify(metadata).replace(/"/g, '&quot;');
    const line = `${ts} ${this.login} ${entryType} ${targetLogin} ${meta}`;

    try {
      if (state.isTauri) {
        await tauriInvoke("append_journey_entry", { login: this.login, repo: this.repo, entry: line });
      } else {
        await this._restAppend(line);
      }
      bumpStat(`${entryType}s_given`);
      sessionStats[entryType === "visit" ? "visits" : entryType === "heart" ? "hearts" : entryType === "comment" ? "comments" : "reactions"]++;
      renderSessionStats();
      return { ok: true };
    } catch (e) {
      this.pending.push({ line, ts });
      this._savePending();
      console.warn("[JourneyLog] Append failed, queued for retry:", e.message);
      return { ok: false, queued: true, error: e.message };
    }
  }

  async _restAppend(line) {
    const [owner, name] = this.repo.split("/");
    const filePath = "GitHubSocial.md";
    const repoPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/contents/${filePath}`;

    // Fetch current file (both sha and content in one call).
    let currentData;
    try {
      currentData = await ghFetch(repoPath);
    } catch (e) {
      if (!(e instanceof GitHubError) || e.status !== 404) throw e;
      currentData = null;
    }

    const sha = currentData?.sha || null;
    let currentContent = currentData
      ? base64ToUtf8(currentData.content)
      : "";
    const newContent = `${currentContent.trimEnd()}\n${line}\n`;

    // Parse entry metadata from line: "ISO TS login type target metadataJson"
    const entryParts = line.split(" ");
    const entryType = entryParts[2] || "unknown";
    const targetLogin = entryParts[3] || "";
    const body = {
      message: `journey: ${entryType} ${targetLogin}`,
      content: utf8ToBase64(newContent),
    };
    if (sha) body.sha = sha;

    const res = await fetch(`${API_BASE}${repoPath}`, {
      method: "PUT",
      headers: ghHeaders(),
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      if (res.status === 409) {
        // 409 = SHA mismatch (concurrent edit). Re-fetch and retry once.
        return this._restAppendWithRetry(line);
      }
      const j = await res.json().catch(() => ({}));
      throw new GitHubError(res.status, j.message || "Append failed", {});
    }
    return res.json();
  }

  async _restAppendWithRetry(line, retries = 2) {
    for (let attempt = 0; attempt < retries; attempt++) {
      if (attempt > 0) {
        await new Promise(r => setTimeout(r, 500 * attempt));
      }
      const [owner, name] = this.repo.split("/");
      const repoPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/contents/GitHubSocial.md`;
      try {
        const data = await ghFetch(repoPath);
        if (!data?.sha) throw new Error("missing sha in retry");
        const currentContent = base64ToUtf8(data.content);
        const newContent = `${currentContent.trimEnd()}\n${line}\n`;
        const entryParts = line.split(" ");
        const res = await fetch(`${API_BASE}${repoPath}`, {
          method: "PUT",
          headers: ghHeaders(),
          body: JSON.stringify({
            message: `journey: ${entryParts[2] || "update"} ${entryParts[3] || ""}`,
            content: utf8ToBase64(newContent),
            sha: data.sha,
          }),
        });
        if (res.ok) return res.json();
        // Only retry on 409; all other errors propagate.
        if (res.status !== 409) {
          const j = await res.json().catch(() => ({}));
          throw new GitHubError(res.status, j.message || `HTTP ${res.status}`, {});
        }
      } catch (e) {
        if (e instanceof GitHubError && e.status !== 409) throw e;
        if (attempt === retries - 1) throw e;
      }
    }
  }

  async flushPending() {
    const pending = this._loadPending();
    const remaining = [];
    for (const item of pending) {
      try {
        if (state.isTauri) {
          await tauriInvoke("append_journey_entry", { login: this.login, repo: this.repo, entry: item.line });
        } else {
          await this._restAppend(item.line);
        }
      } catch (e) {
        console.warn("[JourneyLog] flushPending retry failed:", e.message);
        remaining.push(item);
      }
    }
    this.pending = remaining;
    this._savePending();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Reactions module
// ─────────────────────────────────────────────────────────────────────────────

const Reactions = {
  REACTION_TYPES: ["heart", "thumbsup", "thumbsdown", "laugh", "confused", "rocket", "heart-eyes", "hooray"],

  async openReactionIssue(targetLogin, reactionType = "heart") {
    if (!state.token) return { ok: false, error: "No token — cannot create issue" };
    if (!this.REACTION_TYPES.includes(reactionType)) {
      return { ok: false, error: `Unknown reaction type: ${reactionType}` };
    }

    const ts = new Date().toISOString();
    const repo = `${targetLogin}/${targetLogin}`;
    const title = `reaction:${state.myLogin}:${reactionType}:${ts}`;

    const body = [
      `- from: ${state.myLogin}`,
      `- type: ${reactionType}`,
      `- timestamp: ${ts}`,
      `- approved: false`,
      "",
      "<!-- reaction-body -->",
      `Reacted with ${reactionType} from GitHub Social.`,
      "---",
      "*This issue was created by GitHub Social. Approve to confirm the reaction.*",
    ].join("\n");

    try {
      const issue = await ghFetch(`/repos/${encodeURIComponent(repo)}/issues`, {
        method: "POST",
        headers: { ...ghHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ title, body, labels: ["github-social", `reaction:${reactionType}`] }),
      });

      bumpStat("reactions_given");
      sessionStats.reactions++;
      renderSessionStats();

      if (window.ghsocial?._events?.reaction) {
        window.ghsocial._events.reaction.forEach(cb => cb({ targetLogin, reactionType, issueUrl: issue.html_url }));
      }

      return { ok: true, issue_url: issue.html_url };
    } catch (e) {
      if (e instanceof GitHubError && e.status === 404) {
        return { ok: false, error: `User ${targetLogin} has no profile repo` };
      }
      return { ok: false, error: e.message };
    }
  },

  async approveReactionIssue(issueUrl) {
    if (!state.token) return { ok: false, error: "No token" };

    const parts = issueUrl.replace("https://github.com/", "").split("/");
    const repo = `${parts[0]}/${parts[1]}`;
    const issueNumber = parts[3];

    try {
      const issue = await ghFetch(`/repos/${encodeURIComponent(repo)}/issues/${issueNumber}`);
      let body = issue.body || "";
      body = body.replace("- approved: false", "- approved: true");
      body += "\n\n*Reaction approved by profile owner.*";

      await ghFetch(`/repos/${encodeURIComponent(repo)}/issues/${issueNumber}`, {
        method: "PATCH",
        headers: { ...ghHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ body, state: "closed" }),
      });

      bumpStat("reactions_received");
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Invite module
// ─────────────────────────────────────────────────────────────────────────────

const Invite = {
  async detectNonUser(login) {
    try {
      const res = await fetch(
        `https://raw.githubusercontent.com/${encodeURIComponent(login)}/${encodeURIComponent(login)}/main/GitHubSocial.md`,
        { cache: "no-store" }
      );
      return { isUser: res.ok, hasProfile: res.ok };
    } catch {
      return { isUser: false, hasProfile: false };
    }
  },

  async openInviteIssue(targetLogin) {
    if (!state.token) return { ok: false, error: "No token — cannot create invite issue" };

    const repo = `${targetLogin}/${targetLogin}`;
    const ts = new Date().toISOString();
    const title = `invite:${state.myLogin}:${ts}`;

    const inviteTemplate = `Hey! I'm using GitHub Social — a decentralized social layer on top of GitHub.

Add a **GitHubSocial.md** file to your \`${targetLogin}/${targetLogin}\` repo to join.

## Quick Start

1. Copy this template: https://github.com/neohiro/github-social/blob/main/GitHubSocial.md
2. Rename it to \`GitHubSocial.md\` and place it in your profile repo
3. Edit the frontmatter with your preferences
4. Commit — you're in!

---

*Sent by ${state.myLogin} via GitHub Social v0.2.0*`;

    try {
      const issue = await ghFetch(`/repos/${encodeURIComponent(repo)}/issues`, {
        method: "POST",
        headers: { ...ghHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ title, body: inviteTemplate, labels: ["github-social", "invite"] }),
      });

      bumpStat("issues_opened");
      sessionStats.issues++;
      renderSessionStats();

      return { ok: true, issue_url: issue.html_url };
    } catch (e) {
      if (e instanceof GitHubError && e.status === 404) {
        return { ok: false, error: `User ${targetLogin} has no profile repo` };
      }
      return { ok: false, error: e.message };
    }
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// SpoofChecker class
// ─────────────────────────────────────────────────────────────────────────────

class SpoofChecker {
  constructor(login) {
    this.login = login;
    this.repo = `${login}/${login}`;
    this.lastCheck = null;
    this.anomalies = [];
  }

  async checkIntegrity() {
    this.anomalies = [];
    try {
      const [current, commits] = await Promise.all([
        this._fetchCurrent(),
        this._fetchCommitHistory(),
      ]);

      if (!current) {
        this.anomalies.push({ type: "no_profile", severity: "CRITICAL", detail: "No GitHubSocial.md found" });
        return this._buildResult();
      }

      this._checkCounterConsistency(current, commits);
      this._checkEditHistory(current, commits);
      this._checkTimestampOrder(current);
      this._checkRapidBumps(current, commits);

      this.lastCheck = new Date().toISOString();
      return this._buildResult();
    } catch (e) {
      this.anomalies.push({ type: "network", severity: "HIGH", detail: e.message });
      return this._buildResult();
    }
  }

  async _fetchCurrent() {
    try {
      const data = await ghFetch(`/repos/${encodeURIComponent(this.repo)}/contents/GitHubSocial.md`);
      const content = base64ToUtf8(data.content);
      return { content, sha: data.sha, fm: parseFrontmatter(content) };
    } catch (e) {
      return null;
    }
  }

  async _fetchCommitHistory() {
    try {
      const commits = await ghFetch(`/repos/${encodeURIComponent(this.repo)}/commits?path=GitHubSocial.md&per_page=100`);
      return commits;
    } catch (e) {
      return [];
    }
  }

  _checkCounterConsistency(current, commits) {
    const fm = current.fm;
    if (!fm?.counters || !fm?.history) return;

    const entryCounts = {};
    for (const line of fm.history || []) {
      const parts = line.trim().split(" ");
      if (parts.length >= 3) {
        const type = parts[2];
        entryCounts[type] = (entryCounts[type] || 0) + 1;
      }
    }

    const counterMap = {
      heart: "hearts_given",
      reaction: "reactions_given",
      comment: "comments_written",
      visit: "visited_counter",
      issue_open: "issues_opened",
    };

    for (const [entryType, counterKey] of Object.entries(counterMap)) {
      const expected = entryCounts[entryType] || 0;
      const actual = fm.counters[counterKey] || 0;
      if (Math.abs(actual - expected) > 5) {
        this.anomalies.push({
          type: "counter_mismatch",
          severity: "HIGH",
          detail: `counter ${counterKey}: frontmatter=${actual}, journey_sum=${expected}`,
        });
      }
    }
  }

  _checkEditHistory(current, commits) {
    const fm = current.fm;
    if (!fm?.edit_history?.length || !commits?.length) return;

    const commitTimestamps = commits.map(c => new Date(c.commit.author.date).getTime());
    const editTimestamps = fm.edit_history.map(e => new Date(e.timestamp).getTime()).sort((a, b) => a - b);

    for (let i = 1; i < editTimestamps.length; i++) {
      const gap = editTimestamps[i] - editTimestamps[i - 1];
      const dayInMs = 86400000;
      if (gap > 90 * dayInMs && editTimestamps[i] > commitTimestamps[0]) {
        this.anomalies.push({
          type: "edit_gap",
          severity: "MEDIUM",
          detail: `${Math.round(gap / dayInMs)} day gap between edits`,
        });
      }
    }
  }

  _checkTimestampOrder(current) {
    const fm = current.fm;
    if (!fm?.history?.length) return;

    const lines = fm.history;
    let prevTs = null;
    for (const line of lines) {
      const parts = line.trim().split(" ");
      if (parts.length < 2) continue;
      const ts = parts[0] + "T" + parts[1];
      const currTs = new Date(ts).getTime();
      if (prevTs !== null && currTs < prevTs) {
        this.anomalies.push({
          type: "timestamp_reorder",
          severity: "HIGH",
          detail: "Journey entry timestamp is earlier than previous entry",
        });
        break;
      }
      prevTs = currTs;
    }
  }

  _checkRapidBumps(current, commits) {
    const fm = current.fm;
    if (!fm?.history?.length) return;

    const oneHourMs = 3600000;
    const now = Date.now();
    const recentLines = fm.history.filter(line => {
      const parts = line.trim().split(" ");
      if (parts.length < 2) return false;
      const ts = new Date(parts[0] + "T" + parts[1]).getTime();
      return now - ts < oneHourMs;
    });

    if (recentLines.length > 100) {
      this.anomalies.push({
        type: "rapid_bumps",
        severity: "HIGH",
        detail: `${recentLines.length} entries in the last hour (threshold: 100)`,
      });
    }
  }

  _buildResult() {
    const critical = this.anomalies.filter(a => a.severity === "CRITICAL");
    const high = this.anomalies.filter(a => a.severity === "HIGH");
    const medium = this.anomalies.filter(a => a.severity === "MEDIUM");

    let status = "PASS";
    if (critical.length) status = "CRITICAL";
    else if (high.length) status = "FAIL";
    else if (medium.length) status = "WARN";

    return {
      status,
      login: this.login,
      checked_at: this.lastCheck || new Date().toISOString(),
      anomalies: this.anomalies,
      summary: {
        critical: critical.length,
        high: high.length,
        medium: medium.length,
      },
    };
  }

  getIntegrityBadge() {
    if (!this.lastCheck) return { icon: "❓", label: "Not checked", color: "var(--muted)" };
    const result = this._buildResult();
    const map = {
      PASS: { icon: "✓", label: "Verified", color: "var(--success)" },
      WARN: { icon: "⚠", label: "Minor issues", color: "var(--warn)" },
      FAIL: { icon: "✗", label: "Integrity issues", color: "var(--danger)" },
      CRITICAL: { icon: "🔒", label: "Locked", color: "var(--danger)" },
    };
    return map[result.status] || map.PASS;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MusicPlayer class
// ─────────────────────────────────────────────────────────────────────────────

class MusicPlayer {
  constructor() {
    this.audio = null;
    this.isPlaying = false;
    this.currentUrl = null;
    this.volume = 0.7;
    this._boundEnded = this._onEnded.bind(this);
  }

  load(url) {
    if (this.audio) {
      this.audio.pause();
      this.audio.removeEventListener("ended", this._boundEnded);
    }
    if (!url) return;
    this.audio = new Audio(url);
    this.audio.volume = this.volume;
    this.audio.addEventListener("ended", this._boundEnded);
    this.currentUrl = url;
  }

  async play() {
    if (!this.audio) return;
    try {
      await this.audio.play();
      this.isPlaying = true;
      if (state.myLogin && state.profileRepo) {
        const jl = new JourneyLog(state.myLogin, state.profileRepo);
        await jl.appendJourneyEntry(state.myLogin, "music_play", { track: this.currentUrl });
      }
      sessionStats.plays++;
      renderSessionStats();
    } catch (e) {
      console.warn("[MusicPlayer] Autoplay blocked:", e.message);
    }
  }

  pause() {
    if (!this.audio) return;
    this.audio.pause();
    this.isPlaying = false;
  }

  toggle() {
    if (this.isPlaying) this.pause();
    else this.play();
  }

  setVolume(v) {
    this.volume = Math.max(0, Math.min(1, v));
    if (this.audio) this.audio.volume = this.volume;
  }

  _onEnded() {
    this.isPlaying = false;
    if (window.ghsocial?._events?.music_end) {
      window.ghsocial._events.music_end.forEach(cb => cb({ url: this.currentUrl }));
    }
  }

  destroy() {
    if (this.audio) {
      this.audio.pause();
      this.audio.removeEventListener("ended", this._boundEnded);
      this.audio = null;
    }
    this.isPlaying = false;
    this.currentUrl = null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Session Stats Store
// ─────────────────────────────────────────────────────────────────────────────

const sessionStats = {
  visits: 0,
  hearts: 0,
  comments: 0,
  reactions: 0,
  plays: 0,
};

function renderSessionStats() {
  const ids = ["ss-visits", "ss-hearts", "ss-comments", "ss-reactions", "ss-plays"];
  const vals = [sessionStats.visits, sessionStats.hearts, sessionStats.comments, sessionStats.reactions, sessionStats.plays];
  ids.forEach((id, i) => {
    const el = document.getElementById(id);
    if (el) el.textContent = vals[i];
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// StatsPanel (floating panel for Tauri/PWA UI)
// ─────────────────────────────────────────────────────────────────────────────

function renderStatsPanel() {
  const panel = document.getElementById("session-stats-bar");
  if (!panel) return;
  const ids = ["ss-visits", "ss-hearts", "ss-comments", "ss-reactions", "ss-plays"];
  const vals = [sessionStats.visits, sessionStats.hearts, sessionStats.comments, sessionStats.reactions, sessionStats.plays];
  ids.forEach((id, i) => {
    const el = document.getElementById(id);
    if (el) el.textContent = vals[i];
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Extension Bridge — exposed on window.ghsocial for content script injection
// ─────────────────────────────────────────────────────────────────────────────

function initExtensionBridge() {
  if (typeof window === "undefined") return;

  window.ghsocial = window.ghsocial || {};
  window.ghsocial._events = { heart: [], reaction: [], comment: [], music_end: [], visit: [] };

  window.ghsocial.version = "0.2.0";
  window.ghsocial.state = state;
  window.ghsocial.session = sessionStats;
  window.ghsocial.bumpStat = bumpStat;
  window.ghsocial.setStatus = setStatus;

  window.ghsocial.heart = async (targetLogin) => {
    if (!state.myLogin || !state.profileRepo) return { ok: false, error: "Not configured" };
    const jl = new JourneyLog(state.myLogin, state.profileRepo);
    await jl.appendJourneyEntry(targetLogin, "heart", { repo: `${targetLogin}/${targetLogin}` });
    return Reactions.openReactionIssue(targetLogin, "heart");
  };

  window.ghsocial.react = async (targetLogin, emoji) => {
    if (!state.myLogin || !state.profileRepo) return { ok: false, error: "Not configured" };
    const jl = new JourneyLog(state.myLogin, state.profileRepo);
    await jl.appendJourneyEntry(targetLogin, "reaction", { emoji, repo: `${targetLogin}/${targetLogin}` });
    return Reactions.openReactionIssue(targetLogin, emoji);
  };

  window.ghsocial.comment = async (targetLogin, text) => {
    if (!state.myLogin || !state.profileRepo) return { ok: false, error: "Not configured" };
    const jl = new JourneyLog(state.myLogin, state.profileRepo);
    const result = await jl.appendJourneyEntry(targetLogin, "comment", { text: text.slice(0, 200) });
    if (result.ok) {
      sessionStats.comments++;
      renderSessionStats();
    }
    return result;
  };

  window.ghsocial.invite = (targetLogin) => Invite.openInviteIssue(targetLogin);

  const _musicPlayer = new MusicPlayer();
  window.ghsocial.playMusic = () => _musicPlayer.play();
  window.ghsocial.pauseMusic = () => _musicPlayer.pause();
  window.ghsocial.loadMusic = (url) => _musicPlayer.load(url);
  window.ghsocial.setMusicVolume = (v) => _musicPlayer.setVolume(v);

  window.ghsocial.checkIntegrity = async (login) => {
    const checker = new SpoofChecker(login || state.myLogin);
    return checker.checkIntegrity();
  };

  window.ghsocial.detectNonUser = (login) => Invite.detectNonUser(login);

  window.ghsocial.on = (event, cb) => {
    if (window.ghsocial._events[event]) {
      window.ghsocial._events[event].push(cb);
    }
  };

  window.ghsocial.off = (event, cb) => {
    if (window.ghsocial._events[event]) {
      window.ghsocial._events[event] = window.ghsocial._events[event].filter(f => f !== cb);
    }
  };

  window.ghsocial.JourneyLog = JourneyLog;
  window.ghsocial.Reactions = Reactions;
  window.ghsocial.Invite = Invite;
  window.ghsocial.SpoofChecker = SpoofChecker;
  window.ghsocial.MusicPlayer = MusicPlayer;
}

// Auto-init extension bridge in browser context
if (typeof window !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initExtensionBridge);
  } else {
    initExtensionBridge();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Auto-flush pending journey entries every 5 minutes
// ─────────────────────────────────────────────────────────────────────────────

if (typeof window !== "undefined") {
  setInterval(() => {
    if (state.myLogin && state.profileRepo) {
      const jl = new JourneyLog(state.myLogin, state.profileRepo);
      jl.flushPending();
    }
  }, 5 * 60 * 1000);
}

// ─────────────────────────────────────────────────────────────────────────────
// Exports (preserve existing exports, add new ones)
// ─────────────────────────────────────────────────────────────────────────────

export {
  JourneyLog,
  Reactions,
  Invite,
  SpoofChecker,
  MusicPlayer,
  sessionStats,
  renderSessionStats,
  renderStatsPanel,
  initExtensionBridge,
};
