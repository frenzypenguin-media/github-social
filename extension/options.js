// github-social/extension/options.js
// Settings page logic — runs on chrome://extensions → "Options" link.
// Stores user preferences in chrome.storage.local under the `ghsocial_settings`
// key. All other extension components (content.js, background.js) read from
// this key to respect the user's preferences without coupling to the UI.

(function () {
  "use strict";

  const DEFAULTS = {
    events: { visit: true, heart: true, reaction: true, comment: true },
    rateCap: 10,
    journeyRepo: "",
  };

  const $ = (id) => document.getElementById(id);

  function getSettings() {
    return new Promise((resolve) => {
      chrome.storage.local.get(["ghsocial_settings"], (items) => {
        const stored = items.ghsocial_settings || {};
        resolve({ ...DEFAULTS, ...stored });
      });
    });
  }

  function saveSettings(settings) {
    return new Promise((resolve) => {
      chrome.storage.local.set({ ghsocial_settings: settings }, resolve);
    });
  }

  async function loadUI() {
    const s = await getSettings();

    $("ev-visit").checked = s.events.visit;
    $("ev-heart").checked = s.events.heart;
    $("ev-reaction").checked = s.events.reaction;
    $("ev-comment").checked = s.events.comment;
    $("rate-cap").value = s.rateCap;
    $("journey-repo").value = s.journeyRepo;

    await loadTokenDisplay();
    await loadStorageInfo();
  }

  async function loadTokenDisplay() {
    const [token, login] = await Promise.all([
      new Promise((r) => chrome.storage.local.get(["ghsocial_token"], (i) => r(i.ghsocial_token))),
      new Promise((r) => chrome.storage.local.get(["ghsocial_login"], (i) => r(i.ghsocial_login))),
    ]);
    const el = $("token-value");
    if (token) {
      el.textContent = `••••••••${token.slice(-4)} — ${login || "unknown"}`;
      el.style.color = "#3fb950";
    } else {
      el.textContent = "Not configured";
      el.style.color = "#8b949e";
    }
  }

  async function loadStorageInfo() {
    const items = await new Promise((r) => chrome.storage.local.get(["ghsocial_journey"], r));
    const journey = items.ghsocial_journey || [];
    const count = journey.length;
    $("journey-count").textContent = count;

    if (count > 0) {
      const oldest = journey.reduce((a, b) => (a.ts < b.ts ? a : b));
      const d = new Date(oldest.ts);
      $("journey-oldest").textContent = d.toLocaleDateString();
    } else {
      $("journey-oldest").textContent = "—";
    }
  }

  function showMsg(id, text, isError) {
    const el = $(id);
    el.textContent = text;
    el.className = "msg" + (isError ? " bad" : "");
    if (text) setTimeout(() => { el.textContent = ""; el.className = "msg"; }, 4000);
  }

  // ── Event: settings fields change → save ────────────────────────────────────
  async function saveAll() {
    const settings = {
      events: {
        visit: $("ev-visit").checked,
        heart: $("ev-heart").checked,
        reaction: $("ev-reaction").checked,
        comment: $("ev-comment").checked,
      },
      rateCap: Math.max(1, Math.min(100, parseInt($("rate-cap").value, 10) || 10)),
      journeyRepo: $("journey-repo").value.trim(),
    };
    await saveSettings(settings);
  }

  $("ev-visit").addEventListener("change", saveAll);
  $("ev-heart").addEventListener("change", saveAll);
  $("ev-reaction").addEventListener("change", saveAll);
  $("ev-comment").addEventListener("change", saveAll);
  $("rate-cap").addEventListener("change", saveAll);
  $("journey-repo").addEventListener("change", saveAll);

  // ── Test token ───────────────────────────────────────────────────────────────
  $("test-token-btn").addEventListener("click", async () => {
    const token = await new Promise((r) => chrome.storage.local.get(["ghsocial_token"], r)).then((i) => i.ghsocial_token);
    if (!token) {
      showMsg("token-msg", "No token configured", true);
      return;
    }
    try {
      const r = await fetch("https://api.github.com/user", {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
        },
      });
      if (r.ok) {
        const u = await r.json();
        if (!u || typeof u.login !== "string" || !u.login) {
          showMsg("token-msg", "GitHub returned an unexpected response shape", true);
          return;
        }
        showMsg("token-msg", `✓ Token valid — logged in as ${u.login}`);
      } else {
        showMsg("token-msg", `✗ GitHub rejected token (HTTP ${r.status})`, true);
      }
    } catch (e) {
      showMsg("token-msg", `✗ Network error: ${e.message}`, true);
    }
  });

  // ── Clear token ─────────────────────────────────────────────────────────────
  $("clear-token-btn").addEventListener("click", async () => {
    if (!confirm("Clear your GitHub token? You will need to re-authenticate.")) return;
    await new Promise((r) => chrome.storage.local.remove(["ghsocial_token", "ghsocial_login"], r));
    await loadTokenDisplay();
    showMsg("token-msg", "Token cleared");
  });

  // ── Clear journey ────────────────────────────────────────────────────────────
  $("clear-journey-btn").addEventListener("click", async () => {
    if (!confirm("Clear all journey log entries? This cannot be undone.")) return;
    await new Promise((r) => chrome.storage.local.remove(["ghsocial_journey"], r));
    await loadStorageInfo();
    showMsg("token-msg", "Journey log cleared");
  });

  // ── Init ────────────────────────────────────────────────────────────────────
  loadUI();
})();
