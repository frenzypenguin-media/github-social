/**
 * github-social/src/social-widget.js
 *
 * Core widget engine. Renders a GitHub Social profile as:
 *   - "tab"      full interactive overlay with buttons, counters, journey, music, graph
 *   - "embed"   compact (~120px), read-only counters, no buttons
 *   - "graph"   bar chart of counter history over the last 30 days (SVG)
 *
 * API (attached to window.GHSocialWidget):
 *   GHSocialWidget.mount(containerEl, login, options?)
 *   GHSocialWidget.mountAll(selector?, options?)
 *
 * Options:
 *   mode: "tab" | "embed" | "graph"   (default "tab")
 *   theme: "dark" | "light" | "auto"    (default "auto" → reads GitHub vars)
 *   accent: "#hex"                       override accent colour
 *   token: "ghp_..."                    write-capable token (enables buttons)
 *   onReaction: (type) => void
 *   onInvite:   (login) => void
 *   onComment:  (text) => void
 *
 * No external dependencies. Pure ES2022, no build required.
 * DOMPurify is applied in production builds (vite.ext.config.ts injects it).
 */

const API_BASE = "https://api.github.com";
const MAX_QUERY = 256;
const BRANCHES = ["main", "master"];

// ── GitHub CSS vars (fallback if page vars unavailable) ─────────────────────────
const DEFAULTS = {
  fgColor: "#c9d1d9",
  bgColor: "#0d1117",
  bgColorSecondary: "#161b22",
  borderColor: "#30363d",
  borderColorMuted: "#21262d",
  accentFg: "#58a6ff",
  accentEmphasis: "#1f6feb",
  accentDanger: "#f85149",
  accentSuccess: "#3fb950",
  accentWarning: "#d29922",
  secondarySubheadline: "#8b949e",
};

// ── XSS helpers (same as app.js) ────────────────────────────────────────────────
function escapeHtml(s) {
  if (s == null) return "";
  const MAP = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  return String(s).replace(/[&<>"']/g, function (c) { return MAP[c]; });
}

function escapeUrlAttr(s) {
  if (s == null) return "";
  const MAP = { "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  return String(s).replace(/[<>"']/g, function (c) { return MAP[c]; });
}

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

// ── GitHub vars reader ───────────────────────────────────────────────────────────
function readGitHubVars() {
  const s = getComputedStyle(document.documentElement);
  const v = {};
  for (const [k, cssVar] of [
    ["fgColor", "--color-fg-default"],
    ["bgColor", "--color-canvas-default"],
    ["bgColorSecondary", "--color-canvas-subtle"],
    ["borderColor", "--color-border-default"],
    ["borderColorMuted", "--color-border-muted"],
    ["accentFg", "--color-accent-fg"],
    ["accentEmphasis", "--color-accent-emphasis"],
    ["accentDanger", "--color-danger-emphasis"],
    ["accentSuccess", "--color-success-emphasis"],
    ["accentWarning", "--color-attention-emphasis"],
    ["secondarySubheadline", "--color-fg-muted"],
  ]) {
    v[k] = s.getPropertyValue(cssVar).trim() || DEFAULTS[k];
  }
  return v;
}

// ── State ──────────────────────────────────────────────────────────────────────
let _instanceCount = 0;
function uid() { return `ghsw-${++_instanceCount}`; }

class SocialWidget {
  constructor(container, login, options = {}) {
    this.container = typeof container === "string"
      ? document.querySelector(container)
      : container;
    this.login = login;
    this.options = {
      mode: "tab",
      theme: "auto",
      token: "",
      onReaction: null,
      onInvite: null,
      onComment: null,
      ...options,
    };
    this.prefs = null;
    this.isGitHubSocialUser = false;
    this.musicPlayer = null;
    this.active = false;
    this._toasts = [];
    this.id = uid();
  }

  // ── Fetch ─────────────────────────────────────────────────────────────────────
  async _fetch() {
    for (const branch of BRANCHES) {
      const url = `https://raw.githubusercontent.com/${encodeURIComponent(this.login)}/${encodeURIComponent(this.login)}/${encodeURIComponent(branch)}/GitHubSocial.md`;
      try {
        const res = await fetch(url, { cache: "no-store" });
        if (res.ok) return { text: await res.text(), branch };
        if (res.status !== 404) return null;
      } catch { /* network */ }
    }
    return null;
  }

  _parseFrontmatter(md) {
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

  _parseJourneyLog(md) {
    const marker = "## Journey Log";
    const idx = md.indexOf(marker);
    if (idx < 0) return [];
    const logSection = md.slice(idx + marker.length).trim();
    return logSection.split("\n")
      .filter(l => /^\d{4}-\d{2}-\d{2}T/.test(l.trim()))
      .slice(0, 100);
  }

  // ── Toast ─────────────────────────────────────────────────────────────────────
  _toast(msg, duration = 2500) {
    const existing = this.container?.querySelector(`.${this.id}-toast`);
    if (existing) existing.remove();
    const el = document.createElement("div");
    el.className = `${this.id}-toast ${this.id}-toast`;
    el.textContent = msg;
    el.style.cssText = [
      "position:fixed",
      "bottom:100px","right:24px",
      "background:var(--ghs-bg-sec,#161b22)",
      "border:1px solid var(--ghs-border,#30363d)",
      "border-radius:6px","padding:10px 16px",
      "font-size:13px","color:var(--ghs-fg,#c9d1d9)",
      "box-shadow:0 4px 16px rgba(0,0,0,0.3)",
      "z-index:10000",
      "animation:ghs-fadein 0.2s ease-out",
      "max-width:300px",
    ].join(";");
    document.body.appendChild(el);
    setTimeout(() => el.remove(), duration);
  }

  // ── SVG graph ─────────────────────────────────────────────────────────────────
  _renderGraph(journey) {
    // Aggregate counts by day for the last 30 days
    const days = [];
    const now = Date.now();
    const dayMs = 86400000;
    for (let i = 29; i >= 0; i--) {
      const d = new Date(now - i * dayMs);
      days.push({ date: d.toISOString().slice(0, 10), count: 0 });
    }
    for (const entry of journey) {
      const parts = entry.trim().split(" ");
      if (parts.length < 2) continue;
      const date = parts[0];
      const slot = days.find(d => d.date === date);
      if (slot) slot.count++;
    }
    const max = Math.max(...days.map(d => d.count), 1);
    const w = 600, h = 120, barW = Math.floor(w / days.length), pad = 4;
    const bars = days.map((d, i) => {
      const bh = Math.round((d.count / max) * (h - 30));
      const x = i * barW;
      return `<rect x="${x + pad}" y="${h - 20 - bh}" width="${Math.max(barW - pad * 2, 1)}" height="${bh}" rx="2" fill="var(--ghs-accent,#58a6ff)" opacity="${d.count > 0 ? 1 : 0.2}"><title>${d.date}: ${d.count} interaction${d.count !== 1 ? "s" : ""}</title></rect>`;
    }).join("");
    return `<svg viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg" style="width:100%;display:block;font-family:inherit;" aria-label="GitHub Social activity graph">
      <style>@keyframes ghs-fadein{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}</style>
      ${bars}
      <line x1="0" y1="${h - 20}" x2="${w}" y2="${h - 20}" stroke="var(--ghs-border-muted,#21262d)" stroke-width="1"/>
    </svg>`;
  }

  // ── Buttons ───────────────────────────────────────────────────────────────────
  async _sendReaction(type) {
    if (!this.options.token) {
      this._toast("Set a GitHub token to enable reactions");
      return;
    }
    try {
      const repo = `${this.login}/${this.login}`;
      const ts = new Date().toISOString();
      const myLogin = this._myLogin || this.login;
      const title = `reaction:${myLogin}:${type}:${ts}`;
      const body = [
        `- from: ${myLogin}`,
        `- type: ${type}`,
        `- timestamp: ${ts}`,
        `- approved: false`,
        "",
        "<!-- reaction-body -->",
        `Reacted with ${type} from GitHub Social.`,
        "---",
        "*This issue was created by GitHub Social.*",
      ].join("\n");
      const res = await fetch(`${API_BASE}/repos/${encodeURIComponent(repo)}/issues`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.options.token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ title, body, labels: ["github-social", `reaction:${type}`] }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        this._toast(`Failed: ${j.message || res.status}`);
        return;
      }
      this._toast(`${type === "heart" ? "♥" : type} sent!`);
      this.options.onReaction?.(type);
    } catch (e) {
      this._toast(`Error: ${e.message}`);
    }
  }

  async _sendInvite() {
    if (!this.options.token) {
      this._toast("Set a GitHub token to send invites");
      return;
    }
    try {
      const repo = `${this.login}/${this.login}`;
      const ts = new Date().toISOString();
      const myLogin = this._myLogin || this.login;
      const body = [
        `Hey! I'm using GitHub Social — a decentralized social layer on top of GitHub.`,
        "",
        `Add a **GitHubSocial.md** file to your \`${this.login}/${this.login}\` repo to join.`,
        "",
        "---",
        `*Sent by ${myLogin} via GitHub Social*`,
      ].join("\n");
      const res = await fetch(`${API_BASE}/repos/${encodeURIComponent(repo)}/issues`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.options.token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          title: `invite:${myLogin}:${ts}`,
          body,
          labels: ["github-social", "invite"],
        }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        this._toast(`Failed: ${j.message || res.status}`);
        return;
      }
      this._toast(`Invite sent to ${this.login}!`);
      this.options.onInvite?.(this.login);
    } catch (e) {
      this._toast(`Error: ${e.message}`);
    }
  }

  // ── Music ────────────────────────────────────────────────────────────────────
  _toggleMusic() {
    if (!this.musicPlayer) return;
    if (this.musicPlayer.paused) {
      this.musicPlayer.play().catch(() => this._toast("Playback blocked — click to try again"));
    } else {
      this.musicPlayer.pause();
    }
  }

  _loadMusic(url) {
    if (this.musicPlayer) { this.musicPlayer.pause(); this.musicPlayer.src = ""; }
    this.musicPlayer = new Audio(url);
    this.musicPlayer.volume = 0.7;
    this.musicPlayer.addEventListener("play", () => this._updateMusicBtn(true));
    this.musicPlayer.addEventListener("pause", () => this._updateMusicBtn(false));
  }

  _updateMusicBtn(playing) {
    this.container?.querySelector(`.${this.id}-music-btn`)?.setAttribute("data-playing", playing);
  }

  // ── Render: tab mode ───────────────────────────────────────────────────────────
  _renderTab(vars) {
    const c = this.prefs || {};
    const counters = c.counters || {};
    const journey = this._journey || [];
    const hasMusic = !!c.music_url;

    const counterBadges = [
      { emoji: "♥", key: "hearts_received" },
      { emoji: "👍", key: "reactions_received" },
      { emoji: "👁", key: "visitor_counter" },
      { emoji: "♪", key: "music_plays" },
      { emoji: "💬", key: "comments_written" },
    ].map(({ emoji, key }) => safeHtml`
      <span class="${this.id}-counter">
        ${emoji} <span class="${this.id}-val">${Number(counters[key]) || 0}</span>
      </span>`).join("");

    const graphHtml = journey.length > 5 ? this._renderGraph(journey) : "";
    const musicHtml = hasMusic ? safeHtml`
      <div class="${this.id}-music">
        <button class="${this.id}-music-btn ${this.id}-btn-icon" data-playing="false" title="Play music">▶</button>
        <input type="range" class="${this.id}-vol" min="0" max="1" step="0.05" value="0.7" title="Volume" />
        <span class="${this.id}-muted">♪ Music</span>
      </div>` : "";

    const journeyHtml = journey.length > 0 ? journey.slice(-10).reverse().map(e => {
      const parts = e.trim().split(" ");
      const actor = escapeHtml(parts[1] || "?");
      const type = escapeHtml(parts[2] || "?");
      const date = escapeHtml(parts[0] || "");
      return safeHtml`<div class="${this.id}-journey-entry">
        <span class="${this.id}-actor">${actor}</span>
        <span class="${this.id}-type">${type}</span>
        <span class="${this.id}-ts">${date}</span>
      </div>`;
    }).join("") : safeHtml`<div class="${this.id}-muted" style="padding:8px;font-size:11px;">No interactions yet</div>`;

    return safeHtml`
<div class="${this.id}-tab" style="
  background:var(--ghs-bg-sec,${vars.bgColorSecondary});
  border:1px solid var(--ghs-border,${vars.borderColor});
  border-radius:8px;
  overflow:hidden;
  font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;
  font-size:14px;
  color:var(--ghs-fg,${vars.fgColor});
  max-width:680px;
">
  ${this.isGitHubSocialUser ? raw("") : safeHtml`
  <div class="${this.id}-invite-banner" style="
    display:flex;align-items:center;gap:8px;padding:10px 14px;
    background:linear-gradient(135deg,rgba(31,111,235,.12),rgba(210,57,34,.12));
    border-bottom:1px solid var(--ghs-border,${vars.borderColor});
    font-size:12px;
  ">
    <span style="color:var(--ghs-muted,${vars.secondarySubheadline})">Not on GitHub Social yet.</span>
    <button class="${this.id}-invite-btn" style="
      background:#238636;color:#fff;border:none;border-radius:6px;
      padding:4px 12px;font-size:12px;cursor:pointer;font-weight:500;
    ">Send Invite</button>
  </div>`}

  <div style="padding:12px;">
    ${counterBadges ? safeHtml`<div class="${this.id}-counter-row" style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px;">${raw(counterBadges)}</div>` : ""}

    <div class="${this.id}-actions" style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px;">
      <button class="${this.id}-heart-btn ${this.id}-btn" data-type="heart" style="
        background:#d23;color:#fff;border:none;border-radius:6px;
        padding:5px 12px;font-size:12px;font-weight:500;cursor:pointer;
      ">♥ Heart</button>
      <button class="${this.id}-react-btn ${this.id}-btn" data-type="thumbsup" style="
        background:var(--ghs-accent-emp,${vars.accentEmphasis});color:#fff;border:none;border-radius:6px;
        padding:5px 12px;font-size:12px;font-weight:500;cursor:pointer;
      ">👍 React</button>
      <button class="${this.id}-comment-btn ${this.id}-btn" style="
        background:var(--ghs-bg,${vars.bgColor});color:var(--ghs-fg,${vars.fgColor});
        border:1px solid var(--ghs-border,${vars.borderColor});border-radius:6px;
        padding:5px 12px;font-size:12px;cursor:pointer;
      ">💬 Comment</button>
    </div>

    ${hasMusic ? raw(musicHtml) : ""}

    ${graphHtml ? safeHtml`<div style="margin-bottom:12px;">${raw(graphHtml)}</div>` : ""}

    <div class="${this.id}-journey" style="
      background:var(--ghs-bg,${vars.bgColor});
      border:1px solid var(--ghs-border-muted,${vars.borderColorMuted});
      border-radius:6px;padding:8px;max-height:180px;overflow-y:auto;
    ">
      <div style="font-size:11px;color:var(--ghs-muted,${vars.secondarySubheadline});margin-bottom:6px;">Recent Journey</div>
      ${raw(journeyHtml)}
    </div>
  </div>
</div>`;
  }

  // ── Render: embed mode ────────────────────────────────────────────────────────
  _renderEmbed(vars) {
    const counters = this.prefs?.counters || {};
    return safeHtml`
<div class="${this.id}-embed" style="
  display:inline-flex;align-items:center;gap:8px;
  background:var(--ghs-bg-sec,${vars.bgColorSecondary});
  border:1px solid var(--ghs-border,${vars.borderColor});
  border-radius:50px;padding:4px 14px;
  font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;
  font-size:12px;color:var(--ghs-fg,${vars.fgColor});
">
  <span style="font-size:11px;font-weight:600;color:var(--ghs-accent,${vars.accentFg})">GitHub Social</span>
  ${["hearts_received","reactions_received","visitor_counter"].map(key =>
    safeHtml`<span class="${this.id}-mini-badge" style="
      background:rgba(177,186,196,.12);border:1px solid rgba(177,186,196,.2);
      border-radius:50px;padding:1px 8px;font-size:11px;
    ">${key === "hearts_received" ? "♥" : key === "reactions_received" ? "👍" : "👁"}
      <span class="${this.id}-val" style="color:var(--ghs-accent,${vars.accentFg});font-weight:600">${Number(counters[key]) || 0}</span>
    </span>`
  ).join("")}
</div>`;
  }

  // ── Mount ─────────────────────────────────────────────────────────────────────
  async mount() {
    if (!this.container) return;
    const vars = readGitHubVars();

    try {
      const result = await this._fetch();
      if (result) {
        this.prefs = this._parseFrontmatter(result.text);
        this._journey = this._parseJourneyLog(result.text);
        this.isGitHubSocialUser = true;
      }
    } catch { /* non-user */ }

    const mode = this.options.mode;
    this.container.innerHTML = mode === "embed"
      ? this._renderEmbed(vars)
      : this._renderTab(vars);

    this._wire(vars);
    this.active = true;
  }

  _wire(vars) {
    const c = this.container;

    c.querySelector(`.${this.id}-heart-btn`)?.addEventListener("click", () => this._sendReaction("heart"));
    c.querySelector(`.${this.id}-react-btn`)?.addEventListener("click", () => this._sendReaction("thumbsup"));
    c.querySelector(`.${this.id}-comment-btn`)?.addEventListener("click", () => {
      const text = prompt("Your comment:");
      if (text) {
        this.options.onComment?.(text);
        this._toast("Comment saved locally");
      }
    });
    c.querySelector(`.${this.id}-invite-btn`)?.addEventListener("click", () => this._sendInvite());

    const musicBtn = c.querySelector(`.${this.id}-music-btn`);
    if (musicBtn) {
      musicBtn.addEventListener("click", () => this._toggleMusic());
      if (this.prefs?.music_url) this._loadMusic(this.prefs.music_url);
    }
    c.querySelector(`.${this.id}-vol`)?.addEventListener("input", e => {
      if (this.musicPlayer) this.musicPlayer.volume = parseFloat(e.target.value);
    });

    // Style injection
    if (!document.getElementById(`${this.id}-styles`)) {
      const style = document.createElement("style");
      style.id = `${this.id}-styles`;
      style.textContent = `
        @keyframes ghs-fadein{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}
        .${this.id}-counter{background:rgba(177,186,196,.12);border:1px solid rgba(177,186,196,.2);border-radius:50px;padding:2px 10px;font-size:11px;font-weight:500}
        .${this.id}-val{color:var(--ghs-accent,${vars.accentFg});font-weight:600}
        .${this.id}-muted{color:var(--ghs-muted,${vars.secondarySubheadline})}
        .${this.id}-actor{color:var(--ghs-accent,${vars.accentFg});font-weight:500;min-width:60px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
        .${this.id}-type{color:var(--ghs-success,${vars.accentSuccess})}
        .${this.id}-ts{color:var(--ghs-border-muted,${vars.borderColorMuted});margin-left:auto;font-size:10px}
        .${this.id}-journey-entry{display:flex;gap:6px;padding:3px 0;border-bottom:1px solid var(--ghs-border-muted,${vars.borderColorMuted});font-size:11px}
        .${this.id}-journey-entry:last-child{border-bottom:none}
      `;
      document.head.appendChild(style);
    }
  }

  destroy() {
    if (this.musicPlayer) { this.musicPlayer.pause(); this.musicPlayer = null; }
    this.container.innerHTML = "";
    this.active = false;
  }
}

// ── Public API ───────────────────────────────────────────────────────────────────
const GHSocialWidget = {
  mount(container, login, options) {
    const w = new SocialWidget(container, login, options);
    w.mount();
    return w;
  },
  mountAll(selector = "[data-gh-social]", options) {
    const els = document.querySelectorAll(selector);
    return Array.from(els).map(el => {
      const login = el.dataset.ghSocial || el.dataset.login || el.dataset.user;
      if (!login) return null;
      const opts = { ...options, ...el.dataset };
      delete opts.ghSocial; delete opts.login; delete opts.user;
      const w = new SocialWidget(el, login, opts);
      w.mount();
      return w;
    }).filter(Boolean);
  },
  SocialWidget,
};

window.GHSocialWidget = GHSocialWidget;
export { GHSocialWidget, SocialWidget };
