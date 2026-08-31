// github-social/extension/popup.js
// Popup UI logic — runs when the extension icon is clicked.

(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);

  // ── Load current state ────────────────────────────────────────────────────────
  async function loadState() {
    const [token, login, journey] = await Promise.all([
      chrome.runtime.sendMessage({ type: "get_token" }),
      chrome.runtime.sendMessage({ type: "get_login" }),
      chrome.runtime.sendMessage({ type: "get_journey" }),
    ]);

    $("my-login").textContent = login?.login || "Not set";
    $("token-input").value = token?.token ? "••••••••" + token.token.slice(-4) : "";

    // Today's journey
    const today = new Date().toISOString().slice(0, 10);
    const todayEntries = (journey?.journey || []).filter(e => {
      const ts = new Date(e.ts || 0).toISOString().slice(0, 10);
      return ts === today;
    });
    const counts = { visit: 0, heart: 0, reaction: 0, comment: 0 };
    todayEntries.forEach(e => {
      if (counts[e.type] !== undefined) counts[e.type]++;
    });
    $("stat-visits").textContent = counts.visit;
    $("stat-hearts").textContent = counts.heart;
    $("stat-reactions").textContent = counts.reaction;
    $("stat-comments").textContent = counts.comment;
  }

  // ── Save token ────────────────────────────────────────────────────────────────
  $("save-token-btn").addEventListener("click", async () => {
    const val = $("token-input").value.trim();
    const msg = $("token-msg");
    msg.className = "msg";
    msg.textContent = "";

    if (!val || val.startsWith("•")) {
      msg.className = "msg bad";
      msg.textContent = "Enter a real token";
      return;
    }

    // Validate token shape
    if (!/^(ghp|gho|ghu|ghs)_[A-Za-z0-9]{30,}$/.test(val)) {
      msg.className = "msg bad";
      msg.textContent = "Invalid token shape";
      return;
    }

    // Validate with GitHub BEFORE persisting. If GitHub rejects, we never
    // store the token — the previous code stored first, validated after, and
    // left a known-bad token in chrome.storage.local until the user clicked
    // "Clear".
    try {
      const r = await fetch("https://api.github.com/user", {
        headers: { Authorization: `Bearer ${val}`, Accept: "application/vnd.github+json" },
      });
      if (r.ok) {
        const u = await r.json();
        // GitHub's /user always returns a string `login`; defend against a
        // malformed 200 body (e.g., from a proxy misconfig).
        if (!u || typeof u.login !== "string" || !u.login) {
          msg.className = "msg bad";
          msg.textContent = "GitHub returned an unexpected response shape";
          return;
        }
        await chrome.runtime.sendMessage({ type: "set_token", token: val });
        await chrome.runtime.sendMessage({ type: "set_login", login: u.login });
        msg.className = "msg";
        msg.textContent = `✓ Saved (login: ${u.login})`;
        $("my-login").textContent = u.login;
        $("token-input").value = "••••••••" + val.slice(-4);
      } else {
        msg.className = "msg bad";
        msg.textContent = `GitHub rejected: HTTP ${r.status}`;
      }
    } catch (e) {
      msg.className = "msg bad";
      msg.textContent = `Network error: ${e.message}`;
    }
  });

  // ── Search ────────────────────────────────────────────────────────────────────
  $("search-btn").addEventListener("click", () => {
    let url = $("search-input").value.trim();
    if (!url) return;
    if (!url.startsWith("http")) {
      url = `https://github.com/${url.replace(/^@/, "")}`;
    }
    // Reject non-http(s) schemes (javascript:, data:, file:, chrome:, etc).
    // chrome.tabs.create() would block many of these at the API level, but
    // we reject explicitly so the user gets no surprise "This type of URL
    // is not allowed" dialog and we never expose a redirect surface.
    let parsed;
    try {
      parsed = new URL(url);
    } catch (_) {
      return; // malformed URL — silently drop.
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return;
    chrome.tabs.create({ url });
  });
  $("search-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") $("search-btn").click();
  });

  // ── Settings button ──────────────────────────────────────────────────────────
  $("settings-btn").addEventListener("click", () => {
    chrome.runtime.openOptionsPage ? chrome.runtime.openOptionsPage() :
      chrome.tabs.create({ url: "popup.html" });
  });

  // ── Logout button ────────────────────────────────────────────────────────────
  $("logout-btn").addEventListener("click", async () => {
    if (!confirm("Clear your token and stored login? Your settings and rate-cap counter will be kept.")) return;
    // Only clear credentials and journey log — NOT the whole store, which
    // would also wipe the user's settings page preferences (event toggles,
    // rate cap, journey repo).
    await chrome.runtime.sendMessage({ type: "clear_token" });
    await chrome.runtime.sendMessage({ type: "clear_journey" });
    $("my-login").textContent = "Not set";
    $("token-input").value = "";
    $("token-msg").className = "msg";
    $("token-msg").textContent = "Cleared";
  });

  // ── Init ──────────────────────────────────────────────────────────────────────
  loadState();
})();
