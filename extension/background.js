// github-social/extension/background.js
// Service worker for the GitHub Social extension.
// Handles journey log writes, issue creation, and token management.

const API_BASE = "https://api.github.com";

chrome.runtime.onInstalled.addListener(() => {
  console.log("[ghsocial] extension installed");
});

// NOTE: chrome.action.onClicked is intentionally not registered here.
// manifest.json sets `action.default_popup` so Chrome opens popup.html on icon
// click — the click event never reaches the service worker. The previous
// implementation registered a listener that opened popup.html programmatically,
// which would have been dead code.

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleMessage(msg, sender)
    .then((resp) => sendResponse(resp))
    .catch((e) => sendResponse({ ok: false, error: e.message || String(e) }));
  return true;
});

async function handleMessage(msg, sender) {
  switch (msg.type) {
    case "open_reaction":
      return openReactionIssue(msg.targetLogin, msg.reactionType, msg.token);
    case "open_invite":
      return openInviteIssue(msg.targetLogin, msg.token);
    case "save_comment":
      return saveComment(msg.targetLogin, msg.text, msg.token);
    case "sync_journey":
      return syncJourneyToGitHub();
    case "update_stats":
      return updateStats(msg.key);
    case "fetch_profile":
      return fetchProfile(msg.login, msg.token);
    case "get_token":
      return { ok: true, token: await getStoredToken() };
    case "set_token":
      if (typeof msg.token !== "string" || !msg.token) {
        return { ok: false, error: "Token must be a non-empty string" };
      }
      await chrome.storage.local.set({ ghsocial_token: msg.token });
      return { ok: true };
    case "clear_token":
      await chrome.storage.local.remove(["ghsocial_token", "ghsocial_login"]);
      return { ok: true };
    case "clear_journey":
      await chrome.storage.local.remove("ghsocial_journey");
      return { ok: true };
    case "get_login":
      return { ok: true, login: await getStoredLogin() };
    case "set_login":
      if (typeof msg.login !== "string" || !msg.login) {
        return { ok: false, error: "Login must be a non-empty string" };
      }
      await chrome.storage.local.set({ ghsocial_login: msg.login });
      return { ok: true };
    case "get_journey":
      return { ok: true, journey: await getJourney() };
    default:
      return { ok: false, error: "Unknown message type: " + msg.type };
  }
}

// ── UTF-8 safe base64 helpers ─────────────────────────────────────────────────

function toBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function fromBase64(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

// ── Storage helpers ───────────────────────────────────────────────────────────

async function getStoredToken() {
  const r = await chrome.storage.local.get("ghsocial_token");
  return r.ghsocial_token || null;
}

async function getStoredLogin() {
  const r = await chrome.storage.local.get("ghsocial_login");
  return r.ghsocial_login || null;
}

async function getJourney() {
  const r = await chrome.storage.local.get("ghsocial_journey");
  return r.ghsocial_journey || [];
}

async function ghFetch(path, options = {}, token = null) {
  const t = token || (await getStoredToken());
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    ...(options.headers || {}),
  };
  if (t) headers.Authorization = `Bearer ${t}`;
  const res = await fetch(`${API_BASE}${path}`, { ...options, headers });
  if (!res.ok) {
    let body = "";
    try { body = (await res.clone().json()).message || ""; } catch { /* not JSON */ }
    throw new Error(`HTTP ${res.status}: ${body}`);
  }
  return res.json();
}

// ── Issue: reaction ──────────────────────────────────────────────────────────

async function openReactionIssue(targetLogin, reactionType, token) {
  if (!token) return { ok: false, error: "No token" };
  if (!targetLogin || typeof targetLogin !== "string" || !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(targetLogin)) {
    return { ok: false, error: "Invalid target login" };
  }
  const myLogin = await getStoredLogin();
  if (!myLogin) return { ok: false, error: "Not logged in (set your login in the extension popup)" };
  if (!reactionType || typeof reactionType !== "string") {
    return { ok: false, error: "Invalid reaction type" };
  }

  const repo = `${targetLogin}/${targetLogin}`;
  const ts = new Date().toISOString();
  const title = `reaction:${myLogin}:${reactionType}:${ts}`;

  const body = [
    `- from: ${myLogin}`,
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
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title,
        body,
        labels: ["github-social", `reaction:${reactionType}`],
      }),
    }, token);
    return { ok: true, issue_url: issue.html_url };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ── Issue: invite ────────────────────────────────────────────────────────────

async function openInviteIssue(targetLogin, token) {
  if (!token) return { ok: false, error: "No token" };
  if (!targetLogin || typeof targetLogin !== "string" || !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(targetLogin)) {
    return { ok: false, error: "Invalid target login" };
  }
  const myLogin = await getStoredLogin();
  if (!myLogin) return { ok: false, error: "Not logged in (set your login in the extension popup)" };
  const repo = `${targetLogin}/${targetLogin}`;
  const ts = new Date().toISOString();
  const title = `invite:${myLogin}:${ts}`;

  const body = [
    `Hey! I'm using GitHub Social — a decentralized social layer on top of GitHub.`,
    "",
    `Add a **GitHubSocial.md** file to your \`${targetLogin}/${targetLogin}\` repo to join.`,
    "",
    "## Quick Start",
    "",
    "1. Copy this template: https://github.com/neohiro/github-social/blob/main/GitHubSocial.md",
    "2. Rename it to \`GitHubSocial.md\` and place it in your profile repo",
    "3. Edit the frontmatter with your preferences",
    "4. Commit — you're in!",
    "",
    "---",
    `*Sent by ${myLogin} via GitHub Social v0.2.0*`,
  ].join("\n");

  try {
    const issue = await ghFetch(`/repos/${encodeURIComponent(repo)}/issues`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title,
        body,
        labels: ["github-social", "invite"],
      }),
    }, token);
    return { ok: true, issue_url: issue.html_url };
  } catch (e) {
    if (e.message.includes("404")) {
      return { ok: false, error: `User ${targetLogin} has no profile repo` };
    }
    return { ok: false, error: e.message };
  }
}

// ── Comment ──────────────────────────────────────────────────────────────────

async function saveComment(targetLogin, text, token) {
  if (!token) token = await getStoredToken();
  if (!token) return { ok: false, error: "No token" };
  if (!targetLogin || typeof targetLogin !== "string" || !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(targetLogin)) {
    return { ok: false, error: "Invalid target login" };
  }
  if (!text || typeof text !== "string") {
    return { ok: false, error: "Comment text is required" };
  }

  const repo = `${targetLogin}/${targetLogin}`;
  const ts = new Date().toISOString();
  const myLogin = await getStoredLogin();
  if (!myLogin) return { ok: false, error: "Not logged in" };
  const line = `${ts} ${myLogin} comment ${targetLogin} {"text":${JSON.stringify(text.slice(0, 200))}}`;

  try {
    const filePath = "GitHubSocial.md";
    let sha = null;
    let currentContent = "";
    try {
      const data = await ghFetch(`/repos/${encodeURIComponent(repo)}/contents/${filePath}`, {}, token);
      sha = data.sha;
      currentContent = fromBase64(data.content.replace(/\n/g, ""));
    } catch (e) {
      return { ok: false, error: `Cannot read ${repo}/GitHubSocial.md: ${e.message}` };
    }

    const newContent = `${currentContent.trimEnd()}\n${line}\n`;
    const body = {
      message: `journey: comment from ${myLogin}`,
      content: toBase64(newContent),
      sha,
    };

    await ghFetch(`/repos/${encodeURIComponent(repo)}/contents/${filePath}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }, token);

    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ── Profile fetch ────────────────────────────────────────────────────────────

async function fetchProfile(login, token) {
  if (!token) token = await getStoredToken();
  try {
    const [user, social] = await Promise.all([
      ghFetch(`/users/${encodeURIComponent(login)}`, {}, token),
      fetch(
        `https://raw.githubusercontent.com/${encodeURIComponent(login)}/${encodeURIComponent(login)}/main/GitHubSocial.md`,
        { cache: "no-store" }
      ).catch(() => null),
    ]);

    let prefs = null;
    // fetch() returns a Response object, not {ok: bool}
    if (social && social.ok) {
      const md = await social.text().catch(() => "");
      const m = md.match(/^---\n([\s\S]*?)\n---/);
      if (m) {
        prefs = {};
        for (const line of m[1].split("\n")) {
          const idx = line.indexOf(":");
          if (idx < 0) continue;
          prefs[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
        }
      }
    }

    return { ok: true, user, prefs, isGitHubSocialUser: !!prefs };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ── Stats sync (background tally from content script) ────────────────────────

async function updateStats(key) {
  try {
    const r = await chrome.storage.local.get("ghsocial_session_stats");
    const stats = r.ghsocial_session_stats || {};
    stats[key] = (stats[key] || 0) + 1;
    await chrome.storage.local.set({ ghsocial_session_stats: stats });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ── Journey sync ──────────────────────────────────────────────────────────────
async function syncJourneyToGitHub() {
  const MAX_SYNC_ATTEMPTS = 3;
  let attempt = 0;
  let lastErr = null;

  while (attempt < MAX_SYNC_ATTEMPTS) {
    attempt++;
    try {
      const r = await _syncJourneyOnce();
      if (r.ok) return r;
      lastErr = r.error;
      // Non-retryable error: bail.
      if (!r.retryable) return r;
    } catch (e) {
      lastErr = e.message;
    }
    // Small backoff before retry to let other writers finish.
    await new Promise(r => setTimeout(r, 200 * attempt));
  }
  return { ok: false, error: `sync failed after ${MAX_SYNC_ATTEMPTS} attempts: ${lastErr}` };
}

// Inner: single attempt. Returns {ok, error, retryable, synced, repo}.
async function _syncJourneyOnce() {
  const token = await getStoredToken();
  if (!token) return { ok: false, error: "No token", retryable: false };

  const myLogin = await getStoredLogin();
  if (!myLogin) return { ok: false, error: "No login", retryable: false };

  // Resolve the journey repo: explicit user setting takes priority over the
  // default `<myLogin>/<myLogin>` convention.  The setting is optional; when
  // empty or unparsable we fall back to the convention silently.
  const settings = await new Promise((r) =>
    chrome.storage.local.get(["ghsocial_settings"], (i) => r(i.ghsocial_settings || {}))
  );
  const configuredRepo = (settings.journeyRepo || "").trim();
  const repo = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(configuredRepo)
    ? configuredRepo
    : `${myLogin}/${myLogin}`;

  const journey = await getJourney();
  if (journey.length === 0) return { ok: true, synced: 0, repo };

  const filePath = "GitHubSocial.md";

  let sha = null;
  let currentContent = "";
  try {
    const data = await ghFetch(`/repos/${encodeURIComponent(repo)}/contents/${filePath}`, {}, token);
    sha = data.sha;
    currentContent = fromBase64(data.content.replace(/\n/g, ""));
  } catch (e) {
    if (e.message.includes("404")) {
      // File doesn't exist; bootstrap a skeleton with journey entries.
      currentContent = [
        "---",
        `login: ${myLogin}`,
        `activated: ${new Date().toISOString()}`,
        "schema: 2",
        "---",
        "",
        `# GitHub Social — ${myLogin}`,
        "",
        "## Journey Log",
      ].join("\n");
    } else {
      return { ok: false, error: `read: ${e.message}`, retryable: true };
    }
  }

  // Deduplicate by (actor + ts + type) tuple. localStorage accumulates every
  // visit/heart since the last successful sync; on resync we only need entries
  // that are not already in the remote file.
  //
  // The previous implementation filtered on `currentContent.includes(type)`
  // which matched anywhere in the file (including historical entries) and
  // produced false negatives, causing some entries to be silently dropped.
  //
  // Build a Set of already-synced tuple keys for O(1) membership checks.
  const synced = new Set();
  const tupleRe = /^(\S+) (\S+) (\S+) (\S+)/gm;
  let m;
  while ((m = tupleRe.exec(currentContent)) !== null) {
    synced.add(`${m[1]}|${m[2]}|${m[3]}`);
  }

  const newLines = journey
    .filter(e => {
      const tsIso = e.ts ? new Date(e.ts).toISOString() : new Date().toISOString();
      const key = `${tsIso}|${e.actor || myLogin}|${e.type}`;
      return !synced.has(key);
    })
    .map(e => {
      const ts = e.ts ? new Date(e.ts).toISOString() : new Date().toISOString();
      const meta = JSON.stringify({ ...e, ts: undefined });
      return `${ts} ${e.actor || myLogin} ${e.type} ${e.login} ${meta}`;
    });

  if (newLines.length === 0) return { ok: true, synced: 0, repo };

  const newContent = `${currentContent.trimEnd()}\n${newLines.join("\n")}\n`;

  const body = {
    message: `journey: sync ${newLines.length} entries`,
    content: toBase64(newContent),
  };
  if (sha) body.sha = sha;

  try {
    await ghFetch(`/repos/${encodeURIComponent(repo)}/contents/${filePath}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }, token);
  } catch (e) {
    // 409 = stale SHA from a concurrent writer. Retryable.
    // 422 = file validation failed (e.g. path changed). Not retryable.
    // Other = network/transient. Retryable.
    const retryable = e.message.includes("409");
    return { ok: false, error: `write: ${e.message}`, retryable };
  }

  // Clear synced entries from local storage.
  // Build a Set of (ts, actor, type) keys we just synced, then filter journey entries.
  const syncedKeys = new Set(
    newLines.map(line => {
      const parts = line.split(" ");
      // Format: "ISO_timestamp actor type target_login {...}"
      return `${parts[0]}|${parts[1]}|${parts[2]}`;
    })
  );
  const remaining = journey.filter(e => {
    const tsIso = e.ts ? new Date(e.ts).toISOString() : new Date().toISOString();
    const key = `${tsIso}|${e.actor || myLogin}|${e.type}`;
    return !syncedKeys.has(key);
  });
  await chrome.storage.local.set({ ghsocial_journey: remaining });
  return { ok: true, synced: newLines.length, repo };
}

// ── Periodic sync ─────────────────────────────────────────────────────────────

chrome.alarms.create("sync_journey", { periodInMinutes: 15 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "sync_journey") {
    syncJourneyToGitHub().catch((e) => console.error("[ghsocial] sync failed:", e.message));
  }
});

// ── Sync on startup ──────────────────────────────────────────────────────────

chrome.runtime.onStartup.addListener(() => {
  syncJourneyToGitHub().catch((e) => console.error("[ghsocial] startup sync failed:", e.message));
});
