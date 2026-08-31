# GitHub Social v0.2.0 — Specification Addendum

> **Spec version:** 2.0  
> **Date:** 2026-08-30  
> **Status:** Production  

---

## 1. Overview

GitHub Social v0.2.0 extends the v0.1.x foundation with a full journey-tracking
system, PR-based reactions, integrity checking, music autoplay, and three delivery
surfaces: Tauri desktop app, PWA mirror, and browser extension.

---

## 2. GitHubSocial.md Schema

Every profile is anchored by a `GitHubSocial.md` file in the user's primary
profile repo. The file has three sections:

### 2.1 YAML Frontmatter (`---…---`)

```yaml
---
login: <string>                        # GitHub login (must match repo owner)
activated: <ISO-8601 date>            # First activation timestamp
schema: 2                              # Schema version; bump on breaking changes
version: "0.2.0"                       # github-social client that last wrote

# --- Appearance ---
theme: dark | light                    # UI theme hint
accent: "#<hex>"                       # Accent color (6-digit hex)
motd: "<string>"                      # Message of the day / bio extension
music_url: "<URL>"                     # Audio stream or MP3 URL for autoplay
banner_url: "<URL>"                   # Optional banner image URL

# --- Visibility toggles ---
show_counters: true | false           # Show counter overlay on profile
show_history: true | false            # Show journey log viewer
show_integrity: true | false          # Show spoof-check badge
show_invite: true | false             # Show "Invite this user" button

# --- Counters (all integers, bumped atomically by journey log append) ---
counters:
  visitor_counter: 0                  # Times YOUR profile was visited by others
  visited_counter: 0                   # Times YOU visited other profiles
  hearts_given: 0                      # Hearts you gave
  hearts_received: 0                   # Hearts you received
  comments_written: 0                 # Comments/replies written
  reactions_given: 0                  # Non-heart reactions you gave
  reactions_received: 0                # Reactions you received
  issues_opened: 0                    # Issues you opened on others' repos
  prs_approved: 0                     # PRs you approved (via review events)
  commits_approved: 0                  # Commits in approved PRs
  music_plays: 0                       # Times your music was played
  unique_visitors: 0                  # Distinct visitors (approx via last-write)
  repeat_visitors: 0                  # Visitors who visited more than once
  active_days: 0                       # Days with at least one interaction

# --- Integrity / anti-spoof ---
integrity:
  spoof_count: 0                       # Number of anomalies detected
  last_checked: "<ISO-8601>"           # Last integrity-check timestamp
  last_alert: ""                       # Last alert message (if any)
  anomaly_log: []                      # List of {timestamp, type, detail}

# --- Buttons config (injected by extension) ---
buttons:
  - id: heart
    label: "♥ Heart"
    emoji: "heart"
    color: "#d23"
    action: openReactionIssue
  - id: comment
    label: "💬 Comment"
    emoji: "speech_balloon"
    color: "#58a6ff"
    action: openCommentIssue
  - id: music
    label: "♪ Play"
    emoji: "music"
    color: "#3fb950"
    action: playMusic

# --- Invite template ---
invite_template: |
  Hey! I'm using GitHub Social — a decentralized social layer on GitHub.
  Add a GitHubSocial.md to your profile repo to join.

# --- Edit history (append-only, last 50 entries) ---
edit_history:
  - timestamp: "<ISO-8601>"
    actor: "<login or 'self'>"
    field: "<field name>"
    old: "<old value>"
    new: "<new value>"
---
```

### 2.2 README Section (lines after frontmatter, human-editable)

```markdown
# GitHub Social — <login>

This file is the source of truth for GitHub Social on this profile.
Edit the frontmatter above to change your preferences. The journey log
below is auto-appended by the browser extension and Tauri GUI app.
```

### 2.3 Journey Log (auto-appended section)

Each interaction appends a line in this format:

```
<ISO-8601 timestamp> <actor-login> <entry_type> <target-login> [<metadata JSON>]
```

**Entry types:**

| Type | Metadata | Meaning |
|------|----------|---------|
| `visit` | `{}` | Visited target's profile |
| `heart` | `{"repo":"owner/repo"}` | Sent a heart reaction |
| `reaction` | `{"emoji":"+1","repo":"…"}` | Sent a non-heart reaction |
| `comment` | `{"issue_url":"…"}` | Wrote a comment |
| `issue_open` | `{"issue_url":"…"}` | Opened an issue |
| `pr_approve` | `{"pr_url":"…"}` | Approved a PR |
| `commit_approve` | `{"pr_url":"…"}` | Commits in approved PR |
| `music_play` | `{"track":"…"}` | Played music |
| `invite_sent` | `{"target":"…"}` | Sent an invite |

---

## 3. Counter Types

All counters live in the `counters:` YAML block.

| Counter | Direction | Bumped by |
|---------|-----------|-----------|
| `visitor_counter` | My profile, visits by others | Extension (on other's view of me) |
| `visited_counter` | My visits to others | Extension (my visits) |
| `hearts_given` | I gave hearts | Journey entry `heart` |
| `hearts_received` | I received hearts | Journey entry `heart` (target) |
| `comments_written` | I wrote comments | Journey entry `comment` |
| `reactions_given` | I gave non-heart reactions | Journey entry `reaction` |
| `reactions_received` | I received reactions | Journey entry `reaction` (target) |
| `issues_opened` | Issues I opened on others' repos | Journey entry `issue_open` |
| `prs_approved` | PRs I reviewed/approved | Journey entry `pr_approve` |
| `commits_approved` | Commits in approved PRs | Journey entry `commit_approve` |
| `music_plays` | Times my music was played | Journey entry `music_play` |
| `unique_visitors` | Approx distinct visitors | Rollup from `visit` entries |
| `repeat_visitors` | Visitors with 2+ visits | Rollup from `visit` entries |
| `active_days` | Days with interactions | Rollup from all entries |

---

## 4. PR-Based Reaction Model

Reactions are stored as GitHub Issues on the target user's profile repo:

**Issue title format:** `reaction:<login>:<type>:<timestamp>`

**Issue body:**
```markdown
- from: <actor-login>
- type: <heart|thumbsup|thumbsdown|laugh|confused|rocket|heart-eyes|hooray>
- timestamp: <ISO-8601>
- approved: false   # user must explicitly approve

<!-- reaction-body -->
Optional message from actor.
```

**Approval flow:**
1. User visits target profile → extension fires `openReactionIssue`
2. Issue created with `approved: false`
3. Target receives notification → opens issue → clicks "Approve"
4. On approval, `hearts_received` / `reactions_received` are bumped
5. Issue closed

**ToS compliance:** No automated reactions. All reactions require explicit user
action (click a button) to fire. Background sync is opt-in with clear notice.

---

## 5. Spoof / Integrity Checker

### 5.1 Diff Edit History vs. Current

The `SpoofChecker` fetches:
1. Current `GitHubSocial.md` (HEAD)
2. Commit history via `gh api repos/{owner}/{repo}/commits?path=GitHubSocial.md`
3. Reconstructs expected history from commit diffs

### 5.2 Anomaly Detection Rules

| Anomaly | Rule | Severity |
|---------|------|----------|
| Counter mismatch | HEAD counter ≠ sum of journey entries | HIGH |
| Edit gap | Large gap in `edit_history` with no commits | MEDIUM |
| Timestamp reorder | Journey entry timestamp < previous entry | HIGH |
| Unexpected edit | Edit to locked field (login, activated) | CRITICAL |
| Rapid bumps | >100 counter bumps in 1 hour | HIGH |
| Missing journey | Counters bumped but no journey entries | HIGH |
| Duplicate SHA | Same SHA in two different commits | CRITICAL |

### 5.3 Integrity Badge

Shows in extension overlay:
- ✓ GREEN: All checks passed
- ⚠ YELLOW: Minor anomalies (logged, not blocking)
- ✗ RED: Critical anomaly (counter locked, alert sent)

---

## 6. Invitation Flow

1. Extension detects profile with no `GitHubSocial.md` (404 on raw.githubusercontent.com)
2. Shows "Invite to GitHub Social" button (styled identically to GitHub's green buttons)
3. On click → `openInviteIssue(targetLogin)`
4. Opens issue on `targetLogin/targetLogin` with `invite_template` content
5. Target accepts → bootstraps their `GitHubSocial.md` → journey entry logged

---

## 7. Music Autoplay

- Source: `music_url` field in frontmatter (MP3, OGG, or stream URL)
- Gate: Requires user interaction (click to play) — no autoplay without gesture
- Counter: Each play bumps `music_plays`
- Controls: Play/pause, volume slider, progress bar (injected panel)
- Fallback: If `music_url` empty or fails, panel shows "No music configured"

---

## 8. CSS GitHub-Mimicry Spec

The extension and PWA must exactly match github.com's visual language:

### 8.1 CSS Variables (read from `document.body` or injected)

```css
--fgColor: #c9d1d9;           /* primary text */
--bgColor: #0d1117;           /* page background */
--bgColor-secondary: #161b22; /* card/surface background */
--borderColor: #30363d;       /* borders */
--borderColor-muted: #21262d; /* subtle borders */
--accent-fg: #58a6ff;         /* links and accent text */
--accent-emphasis: #1f6feb;  /* primary buttons */
--accent-danger: #f85149;     /* destructive actions */
--success-fg: #3fb950;        /* success states */
--danger-fg: #f85149;        /* error states */
--attention-fg: #d29922;       /* warnings */
--secondarySubheadline: #8b949e; /* muted text */
```

### 8.2 Typography

```css
font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
font-size: 14px;
line-height: 1.5;
```

### 8.3 Button Shapes

```css
/* Primary button (GitHub blue) */
background: #1f6feb;
color: #ffffff;
border: 1px solid rgba(240,246,252,0.1);
border-radius: 6px;
padding: 5px 16px;
font-size: 14px;
font-weight: 500;
line-height: 20px;

/* Secondary button */
background: #21262d;
color: #c9d1d9;
border: 1px solid #30363d;
border-radius: 6px;

/* Danger button */
background: #f85149;
color: #ffffff;
border-radius: 6px;
```

### 8.4 Counter / Badge Styles

```css
.counter-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background: rgba(177,186,196,0.12);
  border: 1px solid rgba(177,186,196,0.2);
  border-radius: 50px;
  padding: 2px 10px;
  font-size: 12px;
  font-weight: 500;
  color: #c9d1d9;
}
```

---

## 9. Extension Content-Script Injection Rules

### 9.1 Injection Points

| Element | Injection | Condition |
|---------|-----------|-----------|
| Profile bio area | `page-pixel` div | `user.*` URL pattern |
| Profile action bar | Extra buttons (Follow/Sponsor) | Same |
| Below bio | Counter overlay | `show_counters: true` |
| Below bio | Journey viewer | `show_history: true` |
| Bottom-right corner | Floating stats panel | Always |
| Below bio | Music player | `music_url` non-empty |
| Below bio | Integrity badge | `show_integrity: true` |

### 9.2 URL Matching

- Profile pages: `https://github.com/{login}` (no `/` after)
- NOT: `https://github.com/{login}/*` (these are repo pages, not profiles)

Regex: `^https://github\\.com/[^/]+/?$`

### 9.3 CSS Injection

Injected `<style>` tag with `id="ghsocial-styles"` to avoid duplicates.
Must use `!important` overrides carefully — prefer adding classes rather than
overriding existing GitHub styles.

---

## 10. PWA Mirror Spec

The PWA at `frenzypenguin-media.github.io/github-social/` is a functional
equivalent of the Tauri app. Differences:

| Feature | Tauri | PWA |
|---------|-------|-----|
| gh CLI | ✓ (native) | ✗ (REST only) |
| Token storage | OS keychain | chrome.storage.local |
| Journey writes | gh CLI | REST API (requires token) |
| Offline | ✗ | ✓ (cache-first) |

PWA manifest: `pwa/manifest.json` with `start_url`, `display: standalone`,
`background_color: #0d1117`, `theme_color: #0d1117`.

---

## 11. Journey Log Append Protocol

Atomic bump (read → parse → modify → write):

```
Tauri:  gh api → decode → append line → write to tmp → gh api PUT
PWA:    GET contents → decode → append line → PUT contents
```

Error handling:
- If PUT fails with 409 (conflict), re-fetch SHA and retry once
- After 3 retries, queue locally in `ghsocial_pending_journey` localStorage key
- Sync worker retries pending entries every 5 minutes

---

## 12. Cheat Detection Rules

| Cheat | Detection | Response |
|-------|-----------|----------|
| Manual counter edit | Diff frontmatter vs journey sum | Lock counters, flag `spoof_count++` |
| Fake journey entries | Check actor login matches gh API user | Reject entry, alert |
| Token reuse | Rate-limit on per-user basis | Backoff + warning |
| Self-visits | Deduplicate same-login visits | Ignore, log `self_visit` |
| Mass reactions | >50 reactions in 1 hour | Cap at 50, show warning |

---

## 12.5 Drop-in Embed (gh-social-tab)

A zero-dependency, ~25 KB embed that any third-party site can use to render a
GitHub Social profile. Three modes, all driven by a single script:

```html
<!-- 1. Web Component -->
<script src="https://frenzypenguin-media.github.io/embed.js"></script>
<gh-social-tab login="octocat" mode="tab"></gh-social-tab>

<!-- 2. data-attribute (auto-mounted by the script) -->
<div data-gh-social="octocat" data-mode="embed"></div>
<div data-gh-social="octocat" data-mode="graph"></div>

<!-- 3. Programmatic -->
<script type="module">
  import { GHSocialWidget } from "https://frenzypenguin-media.github.io/embed.js";
  const w = GHSocialWidget.mount(el, "octocat", { mode: "tab", token: "ghp_..." });
</script>
```

Modes:

| Mode | Use case | What it renders |
|------|----------|-----------------|
| `tab` | Profile pages, dashboards | Counters, action buttons (heart/react/comment), music player, journey log, activity graph |
| `embed` | Sidebars, blog footers | Single-line pill: ♥ N  👍 N  👁 N |
| `graph` | Statistics dashboards | 30-day bar chart of journey activity (SVG) |

Security:
- The widget reads `GitHubSocial.md` from `raw.githubusercontent.com` (public, no auth).
- Buttons that write (heart/react/invite) require an explicit `token` attribute.
  Without a token, buttons show a toast asking the user to configure one.
- The widget never persists the token; it is held in memory only for the lifetime
  of the page. Users who want persistence should set the token via the Tauri
  desktop app or the browser extension, not the embed.
- All user-controlled values are escaped via the `safeHtml` tagged template.
  Vite injects DOMPurify in production builds as a defense-in-depth layer.
- The widget adds a `<style>` tag with an instance-scoped ID so multiple widgets
  on the same page never collide.

The build command `npm run build:embed` produces two bundles: `embed.js`
(ES module for `<script type="module">` and `import` statements) and `embed.iife.js`
(IIFE for `<script src>` use). The deploy workflow `pwa-deploy.yml`
runs `build:embed` after `build:pwa` and copies both bundles to the site
root: `https://frenzypenguin-media.github.io/embed.js` and
`https://frenzypenguin-media.github.io/embed.iife.js`.

---

## 13. Extension Bridge API (window.ghsocial.*)

When content script runs, it exposes:

```javascript
window.ghsocial = {
  // Core
  version: "0.2.0",
  login: "<current profile login>",
  isGitHubSocialUser: true|false,
  prefs: { theme, accent, show_counters, ... },

  // Actions
  heart: (targetLogin) => Promise<void>,
  react: (targetLogin, emoji) => Promise<void>,
  comment: (targetLogin, text) => Promise<void>,
  invite: (targetLogin) => Promise<void>,
  playMusic: () => void,
  pauseMusic: () => void,

  // Stats (session)
  session: { visits, hearts, comments, reactions, plays },

  // Events
  on: (event, cb) => void,
  off: (event, cb) => void,
};
```

---

## 14. File Tree

```
github-social/
├── .github/
│   ├── workflows/
│   │   ├── weekly-metrics.yml     # Weekly SVG graph generation
│   │   ├── journey-sync.yml      # Hourly journey aggregation
│   │   └── render_svg.py         # Pure-stdlib SVG renderer
│   ├── ISSUE_TEMPLATE/
│   │   └── anonymous-metrics.md  # Structured metrics submission
│   ├── dependabot.yml             # npm + cargo + github-actions
│   └── FUNDING.yml               # GitHub Sponsors link
├── extension/
│   ├── manifest.json             # WebExtension manifest v3
│   ├── content.js                # Content script (injected)
│   ├── background.js             # Service worker
│   ├── popup.html                # Extension popup
│   ├── popup.js                  # Popup logic
│   ├── styles.css                # GitHub-mimicry CSS
│   ├── _locales/
│   │   └── en/
│   │       └── messages.json     # i18n strings
│   └── icons/                    # PNG icons (16/32/48/128)
├── src/
│   ├── app.js                   # Shared app logic + v0.2.0 modules
│   └── index.html                # Tauri/PWA HTML shell
├── src-tauri/
│   ├── Cargo.toml                # Rust dependencies (+ base64)
│   ├── src/
│   │   └── lib.rs                # Tauri commands (base64 crate)
│   └── tauri.conf.json           # Tauri config
├── KB/
│   └── README.md                 # Knowledge base index
├── GitHubSocial.md               # User template
├── SPEC_ADDENDUM.md              # This file
├── README.md                     # Project README
├── .gitignore
└── package.json
```

---

## 15. Privacy

- **No PII collected.** Journey entries contain only public GitHub logins.
- **Token never transmitted** beyond `api.github.com`.
- **Session stats** stored locally only.
- **Counter data** is public on GitHub (readable by anyone).
- **Anonymous metrics** in `.github/ISSUE_TEMPLATE/anonymous-metrics.md` are
  voluntarily submitted and contain no private data.
