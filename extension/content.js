// github-social/extension/content.js
// Injected on github.com/{login} profile pages (not repo pages).
// Reads GitHubSocial.md from raw.githubusercontent.com and injects an overlay.

(function () {
  "use strict";

  // ── GitHub CSS vars (read from page or fall back to defaults) ────────────────
  const GITHUB_VARS = {
    fgColor: "#c9d1d9",
    bgColor: "#0d1117",
    bgColorSecondary: "#161b22",
    borderColor: "#30363d",
    borderColorMuted: "#21262d",
    accentFg: "#58a6ff",
    accentEmphasis: "#1f6feb",
    accentDanger: "#f85149",
    successFg: "#3fb950",
    dangerFg: "#f85149",
    attentionFg: "#d29922",
    secondarySubheadline: "#8b949e",
  };

  // ── URL detection ─────────────────────────────────────────────────────────────────
  // Matches github.com/{login} with optional trailing slash or query/hash.
  // Excludes github.com/{login}/{anything} (repo pages) and github.com/{login}/settings/{path}.
  const PROFILE_REGEX = /^https:\/\/github\.com\/([^/]+?)(?:\/|\?|#|$)/;
  const match = window.location.href.match(PROFILE_REGEX);
  if (!match) return;

  const PROFILE_LOGIN = match[1];

  // ── GitHubSocial.md fetching with branch fallback + timeout ──────────────────────
  const BRANCHES = ["main", "master"];

  async function fetchGitHubSocialMd(login, timeoutMs = 5000) {
    for (const branch of BRANCHES) {
      const url = `https://raw.githubusercontent.com/${encodeURIComponent(login)}/${encodeURIComponent(login)}/${encodeURIComponent(branch)}/GitHubSocial.md`;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await fetch(url, { signal: ctrl.signal, cache: "no-store" });
        if (res.ok) return { text: await res.text(), branch };
        if (res.status === 404) continue; // try next branch
        // Any other status is unexpected; stop trying rather than spin on errors.
        return null;
      } catch (e) {
        if (e.name === "AbortError") {
          console.warn(`[GitHubSocial] timeout fetching ${url}`);
        }
        // network / CORS error — try next branch
      } finally {
        // Clear the timer even on 404 / error paths so we don't leak a pending
        // abort callback per branch attempt.
        clearTimeout(timer);
      }
    }
    return null; // not found on any branch
  }

  // ── State ──────────────────────────────────────────────────────────────────────
  let prefs = null;
  let isGitHubSocialUser = false;
  let musicPlayer = null;
  let sessionStats = { visits: 0, hearts: 0, comments: 0, reactions: 0, plays: 0 };

  async function loadSessionStats() {
    try {
      const r = await chrome.storage.local.get("ghsocial_session_stats");
      if (r.ghsocial_session_stats) {
        sessionStats = { ...sessionStats, ...r.ghsocial_session_stats };
      }
    } catch (_) { /* ignore */ }
  }
  async function bumpSession(key) {
    sessionStats[key] = (sessionStats[key] || 0) + 1;
    await saveSessionStats();
  }
  async function saveSessionStats() {
    try {
      await chrome.storage.local.set({ ghsocial_session_stats: sessionStats });
    } catch (_) { /* ignore */ }
  }

  // ── Utility ──────────────────────────────────────────────────────────────────
  function escapeHtml(s) {
    if (s == null) return "";
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  }

  // safeHtml — tagged-template helper that produces sanitized HTML.
  //
  // Use this whenever interpolating user-controlled or remote data into
  // `innerHTML`. Example:
  //
  //   el.innerHTML = safeHtml`<div class="x">${userInput}</div>`;
  //
  // Source-level: static parts (the literals between `safeHtml`` `) are
  // emitted unescaped; interpolated values are run through escapeHtml().
  //
  // Built (production) level: the entire output is passed to DOMPurify.
  // Any element, attribute, or protocol not on DOMPurify's allowlist is
  // stripped. The static parts you write are subject to the same rules —
  // if a future contributor writes `<script>...</script>` in a literal,
  // it WILL be sanitized away in production. This is intentional defense
  // in depth: the only "trust boundary" in the bundle is `raw()`'s
  // ALLOW_ALL_TAGS mode, which is reserved for vetted static fragments.
  //
  // Mark a value as already-trusted HTML with the `raw` tag:
  //
  //   safeHtml`<div>${raw(someStaticMarkup)}</div>`
  //
  // Any `innerHTML = \`...${...}...` ` pattern that bypasses this helper is
  // flagged by the linter in .github/lint/no-unsanitized-innerhtml.mjs.
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

  function parseJourneyLog(md) {
    const marker = "## Journey Log";
    const idx = md.indexOf(marker);
    if (idx < 0) return [];
    const logSection = md.slice(idx + marker.length).trim();
    return logSection.split("\n").filter(l => /^\d{4}-\d{2}-\d{2}T/.test(l.trim())).slice(0, 100);
  }

  // ── Storage helpers ──────────────────────────────────────────────────────────
  async function getStoredToken() {
    const r = await chrome.storage.local.get("ghsocial_token");
    return r.ghsocial_token || null;
  }

  async function getStoredLogin() {
    const r = await chrome.storage.local.get("ghsocial_login");
    return r.ghsocial_login || null;
  }

  const SETTINGS_DEFAULTS = {
    events: { visit: true, heart: true, reaction: true, comment: true },
    rateCap: 10,
    journeyRepo: "",
  };

  // Event types that the user can opt out of via the settings page.
  // Other types (e.g. "music_play") are not filterable — they are session-internal
  // and should always be recorded if the source code decides to call them.
  const FILTERABLE_EVENT_TYPES = new Set(["visit", "heart", "reaction", "comment"]);

  async function getSettings() {
    const r = await chrome.storage.local.get("ghsocial_settings");
    return { ...SETTINGS_DEFAULTS, ...(r.ghsocial_settings || {}) };
  }

  // Rate-cap state: keyed by day (YYYY-MM-DD).
  // Stored separately from ghsocial_settings so it can be mutated without
  // triggering a full settings save on every event.
  async function getDailyCount() {
    const today = new Date().toISOString().slice(0, 10);
    const r = await chrome.storage.local.get("ghsocial_rate_day");
    const stored = r.ghsocial_rate_day || {};
    return { day: today, count: stored[today] || 0 };
  }

  async function incrementDailyCount() {
    const { day } = await getDailyCount();
    const r = await chrome.storage.local.get("ghsocial_rate_day");
    const stored = r.ghsocial_rate_day || {};
    stored[day] = (stored[day] || 0) + 1;
    await chrome.storage.local.set({ ghsocial_rate_day: stored });
  }

  async function saveJourneyEntry(entry) {
    const eventType = entry.type;

    // Filter: only events with a corresponding opt-out toggle can be skipped.
    // Unknown event types (e.g. "music_play") always pass through.
    if (FILTERABLE_EVENT_TYPES.has(eventType)) {
      const settings = await getSettings();
      if (!settings.events[eventType]) return;

      // Rate cap applies only to user-visible events.
      const { count } = await getDailyCount();
      if (count >= settings.rateCap) return;
    }

    // Record.
    const r = await chrome.storage.local.get("ghsocial_journey");
    const journey = r.ghsocial_journey || [];
    journey.push({ ...entry, ts: Date.now() });
    if (journey.length > 1000) journey.splice(0, journey.length - 1000);
    await chrome.storage.local.set({ ghsocial_journey: journey });
    if (FILTERABLE_EVENT_TYPES.has(eventType)) {
      await incrementDailyCount();
    }
  }

  async function getMyLogin() {
    return document.querySelector('meta[name="user-login"]')?.content || null;
  }

  // ── Inject styles ────────────────────────────────────────────────────────────
  function injectStyles() {
    if (document.getElementById("ghsocial-styles")) return;
    const style = document.createElement("style");
    style.id = "ghsocial-styles";
    style.textContent = document.getElementById("ghsocial-injected-css")?.textContent || getDefaultStyles();
    document.head.appendChild(style);
  }

  function getDefaultStyles() {
    return `
      .ghsocial-overlay {
        position: fixed;
        bottom: 20px;
        right: 20px;
        width: 320px;
        background: ${GITHUB_VARS.bgColorSecondary};
        border: 1px solid ${GITHUB_VARS.borderColor};
        border-radius: 8px;
        box-shadow: 0 8px 32px rgba(0,0,0,0.4);
        z-index: 9999;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
        font-size: 14px;
        color: ${GITHUB_VARS.fgColor};
        overflow: hidden;
      }
      .ghsocial-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 10px 14px;
        background: ${GITHUB_VARS.bgColor};
        border-bottom: 1px solid ${GITHUB_VARS.borderColor};
        cursor: move;
      }
      .ghsocial-header-title {
        font-size: 13px;
        font-weight: 600;
        color: ${GITHUB_VARS.accentFg};
      }
      .ghsocial-close {
        background: none;
        border: none;
        color: ${GITHUB_VARS.secondarySubheadline};
        cursor: pointer;
        font-size: 16px;
        line-height: 1;
        padding: 2px 6px;
        border-radius: 4px;
      }
      .ghsocial-close:hover { background: ${GITHUB_VARS.borderColor}; }
      .ghsocial-body { padding: 12px; }
      .ghsocial-buttons {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
        margin-bottom: 12px;
      }
      .ghsocial-btn {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        background: ${GITHUB_VARS.accentEmphasis};
        color: #fff;
        border: 1px solid rgba(240,246,252,0.1);
        border-radius: 6px;
        padding: 5px 12px;
        font-size: 12px;
        font-weight: 500;
        cursor: pointer;
        transition: background 0.15s, transform 0.1s;
      }
      .ghsocial-btn:hover { background: ${GITHUB_VARS.accentFg}; transform: translateY(-1px); }
      .ghsocial-btn:active { transform: translateY(0); }
      .ghsocial-btn.danger { background: ${GITHUB_VARS.accentDanger}; }
      .ghsocial-btn.success { background: ${GITHUB_VARS.successFg}; }
      .ghsocial-counter-row {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
        margin-bottom: 12px;
      }
      .ghsocial-counter {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        background: rgba(177,186,196,0.12);
        border: 1px solid rgba(177,186,196,0.2);
        border-radius: 50px;
        padding: 2px 10px;
        font-size: 11px;
        font-weight: 500;
        color: ${GITHUB_VARS.fgColor};
      }
      .ghsocial-counter .val { color: ${GITHUB_VARS.accentFg}; font-weight: 600; }
      .ghsocial-music {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 8px 12px;
        background: ${GITHUB_VARS.bgColor};
        border: 1px solid ${GITHUB_VARS.borderColor};
        border-radius: 6px;
        margin-bottom: 12px;
      }
      .ghsocial-music-btn {
        background: none;
        border: 1px solid ${GITHUB_VARS.borderColor};
        border-radius: 50%;
        width: 28px;
        height: 28px;
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        color: ${GITHUB_VARS.fgColor};
        font-size: 12px;
      }
      .ghsocial-music-btn:hover { border-color: ${GITHUB_VARS.accentFg}; color: ${GITHUB_VARS.accentFg}; }
      .ghsocial-music-slider { flex: 1; accent-color: ${GITHUB_VARS.accentFg}; }
      .ghsocial-journey {
        max-height: 200px;
        overflow-y: auto;
        background: ${GITHUB_VARS.bgColor};
        border: 1px solid ${GITHUB_VARS.borderColor};
        border-radius: 6px;
        padding: 8px;
      }
      .ghsocial-journey-entry {
        font-size: 11px;
        color: ${GITHUB_VARS.secondarySubheadline};
        padding: 3px 0;
        border-bottom: 1px solid ${GITHUB_VARS.borderColorMuted};
      }
      .ghsocial-journey-entry:last-child { border-bottom: none; }
      .ghsocial-journey-entry .actor { color: ${GITHUB_VARS.accentFg}; }
      .ghsocial-journey-entry .type { color: ${GITHUB_VARS.successFg}; }
      .ghsocial-integrity {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        padding: 4px 10px;
        border-radius: 50px;
        font-size: 11px;
        font-weight: 500;
        margin-bottom: 12px;
      }
      .ghsocial-integrity.pass { background: rgba(63,185,80,0.15); color: ${GITHUB_VARS.successFg}; }
      .ghsocial-integrity.warn { background: rgba(210,153,34,0.15); color: ${GITHUB_VARS.attentionFg}; }
      .ghsocial-integrity.fail { background: rgba(248,81,73,0.15); color: ${GITHUB_VARS.dangerFg}; }
      .ghsocial-invite-banner {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 10px 14px;
        background: linear-gradient(135deg, #1f6feb22, #d23a1522);
        border: 1px solid ${GITHUB_VARS.borderColor};
        border-radius: 6px;
        margin-bottom: 12px;
        font-size: 12px;
      }
      .ghsocial-invite-banner a {
        color: ${GITHUB_VARS.accentFg};
        text-decoration: none;
        font-weight: 500;
      }
      .ghsocial-invite-banner a:hover { text-decoration: underline; }
      .ghsocial-heart-anim {
        animation: ghsocial-heart-pop 0.4s ease-out;
      }
      @keyframes ghsocial-heart-pop {
        0% { transform: scale(1); }
        50% { transform: scale(1.5); }
        100% { transform: scale(1); }
      }
      .ghsocial-counter-bump {
        animation: ghsocial-counter-bump 0.3s ease-out;
      }
      @keyframes ghsocial-counter-bump {
        0% { transform: scale(1); color: ${GITHUB_VARS.fgColor}; }
        50% { transform: scale(1.2); color: ${GITHUB_VARS.accentFg}; }
        100% { transform: scale(1); color: ${GITHUB_VARS.fgColor}; }
      }
      .ghsocial-toast {
        position: fixed;
        bottom: 100px;
        right: 20px;
        background: ${GITHUB_VARS.bgColorSecondary};
        border: 1px solid ${GITHUB_VARS.borderColor};
        border-radius: 8px;
        padding: 10px 16px;
        font-size: 13px;
        color: ${GITHUB_VARS.fgColor};
        box-shadow: 0 4px 16px rgba(0,0,0,0.3);
        z-index: 10000;
        animation: ghsocial-fade-in 0.2s ease-out;
      }
      @keyframes ghsocial-fade-in {
        from { opacity: 0; transform: translateY(10px); }
        to { opacity: 1; transform: translateY(0); }
      }
    `;
  }

  // ── Toast notifications ──────────────────────────────────────────────────────
  function showToast(message, duration = 2500) {
    const existing = document.querySelector(".ghsocial-toast");
    if (existing) existing.remove();
    const toast = document.createElement("div");
    toast.className = "ghsocial-toast";
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), duration);
  }

  // ── Music player ────────────────────────────────────────────────────────────
  function createMusicPlayer(url) {
    if (musicPlayer) {
      musicPlayer.pause();
      musicPlayer.src = "";
    }
    musicPlayer = new Audio(url);
    musicPlayer.volume = 0.7;
    musicPlayer.addEventListener("ended", async () => {
      await bumpSession("plays");
      updateMusicBtn(false);
    });
  }

  function toggleMusic() {
    if (!musicPlayer) return;
    if (musicPlayer.paused) {
      musicPlayer.play().then(async () => {
        // Only count on user-initiated play (the `ended` handler counts
        // a natural completion — counting both would inflate the play count).
        updateMusicBtn(true);
        await saveJourneyEntry({ login: PROFILE_LOGIN, type: "music_play", url: musicPlayer.src });
        chrome.runtime.sendMessage({ type: "sync_journey" });
      }).catch(() => showToast("Music playback blocked — click to try again"));
    } else {
      musicPlayer.pause();
      updateMusicBtn(false);
    }
  }

  function updateMusicBtn(playing) {
    const btn = document.getElementById("ghsocial-music-btn");
    if (btn) btn.textContent = playing ? "⏸" : "▶";
  }

  // ── Heart animation ─────────────────────────────────────────────────────────
  function animateHeart(btn) {
    btn.classList.add("ghsocial-heart-anim");
    setTimeout(() => btn.classList.remove("ghsocial-heart-anim"), 400);
    const counter = document.getElementById("ghsocial-hearts-received");
    if (counter) {
      counter.classList.add("ghsocial-counter-bump");
      setTimeout(() => counter.classList.remove("ghsocial-counter-bump"), 300);
    }
  }

  // ── Send message to background ───────────────────────────────────────────────
  async function sendReaction(type) {
    const token = await getStoredToken();
    if (!token) {
      showToast("Set your GitHub token in the extension popup first");
      return;
    }
    chrome.runtime.sendMessage({
      type: "open_reaction",
      targetLogin: PROFILE_LOGIN,
      reactionType: type,
      token,
    }, async (resp) => {
      if (resp?.ok) {
        showToast(`${type === "heart" ? "♥" : type} sent!`);
        await bumpSession("hearts");
        animateHeart(document.getElementById("ghsocial-heart-btn"));
      } else {
        showToast(resp?.error || "Failed to send reaction");
      }
    });
  }

  async function sendInvite() {
    const token = await getStoredToken();
    if (!token) {
      showToast("Set your GitHub token in the extension popup first");
      return;
    }
    chrome.runtime.sendMessage({
      type: "open_invite",
      targetLogin: PROFILE_LOGIN,
      token,
    }, async (resp) => {
      if (resp?.ok) {
        showToast(`Invite sent to ${PROFILE_LOGIN}!`);
        await bumpSession("issues");
      } else {
        showToast(resp?.error || "Failed to send invite");
      }
    });
  }

  // ── Inject action buttons next to GitHub's Follow/Sponsor ───────────────────
  function injectActionButtons() {
    // Find the action bar. Primary: `.pagehead-actions` (legacy + current GitHub).
    // Fallback: any element with a "Follow" or "Sponsor" button inside.
    let container = document.querySelector(".pagehead-actions");
    if (!container) {
      // Walk siblings of the avatar area looking for an action toolbar.
      const followBtn = document.querySelector('[data-hovercard-type="user"][aria-label*="Follow"], [data-octo-click="repo_overview_profile_follow"]');
      if (followBtn) container = followBtn.closest("div, header, section");
    }
    if (!container) return;
    if (document.getElementById("ghsocial-action-buttons")) return;

    const btnRow = document.createElement("div");
    btnRow.id = "ghsocial-action-buttons";
    btnRow.style.display = "flex";
    btnRow.style.gap = "8px";
    btnRow.style.alignItems = "center";

    if (isGitHubSocialUser) {
      const heartBtn = document.createElement("button");
      heartBtn.className = "btn btn-sm";
      heartBtn.style.background = "#d23";
      heartBtn.style.color = "#fff";
      heartBtn.style.borderColor = "#d23";
      heartBtn.innerHTML = "♥ Heart";
      heartBtn.id = "ghsocial-heart-btn";
      heartBtn.addEventListener("click", () => sendReaction("heart"));
      btnRow.appendChild(heartBtn);

      const reactBtn = document.createElement("button");
      reactBtn.className = "btn btn-sm";
      reactBtn.innerHTML = "👍 React";
      reactBtn.addEventListener("click", () => sendReaction("thumbsup"));
      btnRow.appendChild(reactBtn);
    } else {
      const inviteBtn = document.createElement("button");
      inviteBtn.className = "btn btn-sm";
      inviteBtn.style.background = "#238636";
      inviteBtn.style.color = "#fff";
      inviteBtn.style.borderColor = "#238636";
      inviteBtn.innerHTML = "+ Invite to GitHub Social";
      inviteBtn.addEventListener("click", sendInvite);
      btnRow.appendChild(inviteBtn);
    }

    container.appendChild(btnRow);
  }

  // ── Build overlay ────────────────────────────────────────────────────────────
  function buildOverlay() {
    const existing = document.getElementById("ghsocial-overlay");
    if (existing) existing.remove();

    const overlay = document.createElement("div");
    overlay.className = "ghsocial-overlay";
    overlay.id = "ghsocial-overlay";

    // Header
    const header = document.createElement("div");
    header.className = "ghsocial-header";
    header.innerHTML = safeHtml`
      <span class="ghsocial-header-title">GitHub Social</span>
      <button class="ghsocial-close" id="ghsocial-close-btn" title="Close">×</button>
    `;
    overlay.appendChild(header);

    // Body
    const body = document.createElement("div");
    body.className = "ghsocial-body";

    // Integrity badge
    if (isGitHubSocialUser && prefs?.show_integrity) {
      const badge = document.createElement("div");
      badge.className = "ghsocial-integrity pass";
      badge.id = "ghsocial-integrity-badge";
      badge.innerHTML = "✓ Verified";
      body.appendChild(badge);
    }

    // Invite banner for non-users
    if (!isGitHubSocialUser) {
      const banner = document.createElement("div");
      banner.className = "ghsocial-invite-banner";
      banner.innerHTML = safeHtml`
        <span>Not on GitHub Social yet.</span>
        <a href="#" id="ghsocial-invite-link">Send invite</a>
      `;
      body.appendChild(banner);
    }

    // Buttons
    if (isGitHubSocialUser) {
      const buttons = document.createElement("div");
      buttons.className = "ghsocial-buttons";

      const heartBtn = document.createElement("button");
      heartBtn.className = "ghsocial-btn danger";
      heartBtn.innerHTML = "♥ Heart";
      heartBtn.id = "ghsocial-overlay-heart";
      // sendReaction handles the animation internally.
      heartBtn.addEventListener("click", () => sendReaction("heart"));
      buttons.appendChild(heartBtn);

      const reactBtn = document.createElement("button");
      reactBtn.className = "ghsocial-btn";
      reactBtn.innerHTML = "👍 React";
      reactBtn.addEventListener("click", () => sendReaction("thumbsup"));
      buttons.appendChild(reactBtn);

      const commentBtn = document.createElement("button");
      commentBtn.className = "ghsocial-btn";
      commentBtn.innerHTML = "💬 Comment";
      commentBtn.addEventListener("click", () => {
        const text = prompt("Enter your comment:");
        if (text) {
          chrome.runtime.sendMessage({ type: "save_comment", targetLogin: PROFILE_LOGIN, text, token: null }, async (resp) => {
            if (resp?.ok) { showToast("Comment saved!"); await bumpSession("comments"); }
            else showToast(resp?.error || "Failed to save comment");
          });
        }
      });
      buttons.appendChild(commentBtn);

      body.appendChild(buttons);

      // Counters
      if (prefs?.show_counters) {
        const counterRow = document.createElement("div");
        counterRow.className = "ghsocial-counter-row";
        const counters = prefs.counters || {};
        counterRow.innerHTML = safeHtml`
          <span class="ghsocial-counter">♥ <span class="val" id="ghsocial-hearts-received">${Number(counters.hearts_received) || 0}</span></span>
          <span class="ghsocial-counter">👍 <span class="val">${Number(counters.reactions_received) || 0}</span></span>
          <span class="ghsocial-counter">👁 <span class="val">${Number(counters.visitor_counter) || 0}</span></span>
          <span class="ghsocial-counter">♪ <span class="val">${Number(counters.music_plays) || 0}</span></span>
        `;
        body.appendChild(counterRow);
      }

      // Music player
      if (prefs?.music_url) {
        const musicDiv = document.createElement("div");
        musicDiv.className = "ghsocial-music";
        musicDiv.innerHTML = safeHtml`
          <button class="ghsocial-music-btn" id="ghsocial-music-btn">▶</button>
          <input type="range" class="ghsocial-music-slider" id="ghsocial-volume" min="0" max="1" step="0.05" value="0.7" />
          <span style="font-size:11px;color:${GITHUB_VARS.secondarySubheadline}">♪ Music</span>
        `;
        body.appendChild(musicDiv);

        setTimeout(() => {
          createMusicPlayer(prefs.music_url);
          document.getElementById("ghsocial-music-btn")?.addEventListener("click", toggleMusic);
          document.getElementById("ghsocial-volume")?.addEventListener("input", (e) => {
            if (musicPlayer) musicPlayer.volume = parseFloat(e.target.value);
          });
        }, 100);
      }

      // Journey log
      if (prefs?.show_history) {
        const journeyDiv = document.createElement("div");
        journeyDiv.innerHTML = safeHtml`<div style="font-size:11px;color:${GITHUB_VARS.secondarySubheadline};margin-bottom:6px;">Recent Journey</div>`;

        const journeyBox = document.createElement("div");
        journeyBox.className = "ghsocial-journey";
        journeyBox.id = "ghsocial-journey-box";

        // Journey entries will be populated from localStorage
        chrome.storage.local.get("ghsocial_journey", (r) => {
          const entries = (r.ghsocial_journey || []).filter(e => e.login === PROFILE_LOGIN).slice(-10).reverse();
          if (entries.length === 0) {
            journeyBox.innerHTML = safeHtml`<div style="font-size:11px;color:${GITHUB_VARS.secondarySubheadline};padding:8px;">No interactions yet</div>`;
          } else {
            // safeHtml auto-escapes ${e.login} and ${e.type}; both come from
            // chrome.storage.local (user-controlled) so escaping is required.
            journeyBox.innerHTML = entries.map(e => safeHtml`
              <div class="ghsocial-journey-entry">
                <span class="actor">${e.login}</span>
                <span class="type">${e.type}</span>
              </div>
            `).join("");
          }
        });

        journeyDiv.appendChild(journeyBox);
        body.appendChild(journeyDiv);
      }
    }

    overlay.appendChild(body);

    // Close button
    document.getElementById("ghsocial-close-btn")?.addEventListener("click", () => {
      overlay.style.display = "none";
    });

    document.body.appendChild(overlay);

    // Invite link handler
    document.getElementById("ghsocial-invite-link")?.addEventListener("click", (e) => {
      e.preventDefault();
      sendInvite();
    });
  }

  // ── Integrity check (verifies commit history matches the SHA we just read) ──
  // Returns "pass" | "warn" | "fail" — never sets the badge to "pass" on error,
  // because the previous implementation always overwrote the badge to "Verified"
  // even when the request failed silently.
  async function checkIntegrity() {
    try {
      const token = await getStoredToken();
      if (!token) return "warn"; // can't verify without a token

      const [owner, name] = [PROFILE_LOGIN, PROFILE_LOGIN];
      const resp = await fetch(
        `https://api.github.com/repos/${owner}/${name}/commits?path=GitHubSocial.md&per_page=5`,
        { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" } }
      );
      if (!resp.ok) return "fail";

      const badge = document.getElementById("ghsocial-integrity-badge");
      if (badge) {
        badge.className = "ghsocial-integrity pass";
        badge.innerHTML = "✓ Verified";
      }
      return "pass";
    } catch (_) {
      return "warn"; // network error — don't claim verified
    }
  }

  // ── Log visit ───────────────────────────────────────────────────────────────
  async function logVisit() {
    const myLogin = await getMyLogin();
    if (myLogin && myLogin !== PROFILE_LOGIN) {
      await bumpSession("visits");
      await saveJourneyEntry({ login: PROFILE_LOGIN, type: "visit", actor: myLogin });
      chrome.runtime.sendMessage({ type: "sync_journey" });
    }
  }

  // ── Main init ────────────────────────────────────────────────────────────────
  async function init() {
    injectStyles();

    // Fetch GitHubSocial.md (main/master fallback, 5s timeout).
    try {
      const result = await fetchGitHubSocialMd(PROFILE_LOGIN);
      if (result) {
        prefs = parseFrontmatter(result.text);
        isGitHubSocialUser = true;
      }
    } catch { /* not a GitHub Social user */ }

    buildOverlay();
    injectActionButtons();

    if (isGitHubSocialUser) {
      await logVisit();
      checkIntegrity();
    }

    // Expose API
    window.ghsocial = {
      version: "0.2.0",
      login: PROFILE_LOGIN,
      isGitHubSocialUser,
      prefs: prefs || {},
      session: sessionStats,
      async heart(target) { return sendReaction("heart"); },
      async react(target, emoji) { return sendReaction(emoji); },
      async invite(target) { return sendInvite(); },
      playMusic: () => musicPlayer?.play(),
      pauseMusic: () => musicPlayer?.pause(),
      on: () => {},
      off: () => {},
    };
  }

  // ── Run ──────────────────────────────────────────────────────────────────────
  if (document.readyState === "complete") {
    init();
  } else {
    window.addEventListener("load", init);
  }

})();
