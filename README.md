<div align="center">

# GitHub Social

### v0.2.0 — The decentralized, immersive GitHub social layer

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](license.md)
[![Platforms: Windows, macOS, Linux](https://img.shields.io/badge/Platforms-Windows%20%7C%20macOS%20%7C%20Linux-purple)]()
[![Auto-update: Tauri Updater](https://img.shields.io/badge/Auto--update-Tauri%20Updater-green)]()
[![v0.2.0](https://img.shields.io/badge/v0.2.0-2026-orange)]()

&nbsp;

> **GitHub Social** is a free, decentralized social network built on top of GitHub's public topology.
> No server. No tracking. Just GitHub.
> Activate your profile by adding `GitHubSocial.md` to your profile repo — the GUI, PWA, and
> browser extension all do this for you automatically.

</div>

---

## What's new in v0.2.0

| Feature | Description |
|---------|-------------|
| **Immersive overlays** | GitHub Social buttons and counters that look and feel native to github.com |
| **GitHubSocial.md** | Your profile's social configuration — counters, music, theme, motd, buttons |
| **Journey log** | Every visit, heart, and reaction is recorded in your own GitHubSocial.md |
| **Browser extension** | Chrome, Firefox, Edge, Opera — GitHub Social overlays on every profile |
| **PWA mirror** | No install needed — `frenzypenguin-media.github.io/github-social` |
| **Spoof detection** | Integrity checker flags tampered or fake GitHubSocial.md profiles |
| **Anonymous metrics** | Weekly SVG dashboards show platform trends — no private data collected |
| **Music autoplay** | Set a `music_url` in your GitHubSocial.md and visitors hear it on arrival |

---

## Activate GitHub Social (30 seconds)

### Option 1 — Automatic (recommended)

Use the Tauri app, PWA, or browser extension. Open **Settings → Bootstrap my GitHubSocial.md**.
It creates the file in your profile repo automatically.

### Option 2 — Manual

Add to your GitHub profile repository root as `GitHubSocial.md`:

```bash
curl -fsSL https://raw.githubusercontent.com/frenzypenguin-media/github-social/v0.2.0/GitHubSocial.md
# Edit the frontmatter, commit to your profile repo
```

---

## Three ways to use GitHub Social

### 1. Desktop app (Tauri)

Download from [Releases](https://github.com/frenzypenguin-media/github-social/releases).
Windows `.exe`, macOS `.dmg`, Linux `.AppImage` — all auto-update.

```bash
# Build from source
git clone https://github.com/frenzypenguin-media/github-social
cd github-social && npm install && npm run tauri build
```

### 2. PWA (browser, no install)

Visit **[frenzypenguin-media.github.io/github-social](https://frenzypenguin-media.github.io/github-social)**.
Add to home screen for an app-like experience. Fully functional without any installation.

### 3. Browser extension

**[Chrome](https://chrome.google.com/webstore)** · **[Firefox](https://addons.mozilla.org)** · **[Edge](https://microsoftedge.microsoft.com/addons)** · **[Opera](https://addons.opera.com)**

The extension shows GitHub Social overlays directly on github.com profile pages:
extra counter buttons, visit notifications, heart reactions, and comment threads.

---

## What gets injected into your GitHub profile

The extension and PWA read your `GitHubSocial.md` frontmatter and inject:

| Element | Description |
|---------|-------------|
| **Counter buttons** | Visits, hearts, reactions — styled to match GitHub's own buttons |
| **Visitor log** | List of recent profile visitors (their GitHub Social stats) |
| **MOTD banner** | Your `motd` text shown at the top of your profile |
| **Music player** | Autoplay from your `music_url` (requires user interaction to start) |
| **Theme accent** | Your `accent` color applied to buttons and highlights |
| **Comment thread** | Visitors can leave GitHub Social-only comment threads |

---

## How the social layer works

```
You visit @octocat's profile
    │
    ├─► Browser extension / PWA reads octocat/GitHubSocial.md
    │       (via raw.githubusercontent.com — no auth needed)
    │
    ├─► Counters displayed: visitors, hearts, reactions
    │       (spoof-checker verifies integrity)
    │
    ├─► You click ♥ Heart
    │       │
    │       └─► GitHub issue opened on octocat's profile repo
    │               (within GitHub's ToS — it's a public issue)
    │
    └─► Your journey logged to YOUR GitHubSocial.md
            (via gh CLI or REST — your own repo, your own write)
```

**No one can write to your GitHubSocial.md but you.** Visitors record their actions
in their own file. Your profile reflects a summary derived from reading others'
files — completely decentralized.

---

## GitHubSocial.md schema

```yaml
---
login: your-github-username
activated: 2026-08-30
schema: 2

# Visual preferences
theme: dark              # dark | light
accent: "#58a6ff"       # hex color for your GitHub Social UI
motd: "Welcome to my profile!"

# Music (any direct audio URL — no tracking)
music_url: "https://soundcloud.com/..."

# What to show on your profile overlay
show_counters: true
show_history: true
show_comments: true
show_music: true

# Buttons to display
buttons:
  - heart
  - reaction
  - comment

# All counters (auto-updated by extension/GUI)
counters:
  visitor_counter: 0
  visited_counter: 0
  hearts_given: 0
  hearts_received: 0
  reactions_given: 0
  reactions_received: 0
  comments_written: 0
  comments_received: 0
  issues_opened: 0
  prs_approved: 0
  music_plays: 0

# Integrity (auto-managed)
integrity:
  spoof_count: 0
  last_checked: ""
  last_alert: ""

# Social links (shown on your profile)
links:
  twitter: ""
  mastodon: ""
  bluesky: ""
  website: ""

history: []
---
```

---

## Sponsor

GitHub Social is 100% free and open source. If it brings value to your workflow,
consider supporting the maintainers:

[![Sponsor](https://img.shields.io/badge/Sponsor-♥-ea4aaa)](https://github.com/sponsors/neohiro)

---

## Architecture

```
github-social/
├── src/                    # Shared SPA logic (vanilla JS)
│   ├── index.html         # Tauri desktop entry
│   └── app.js            # All shared modules
├── extension/              # Browser extension (MV3)
│   ├── manifest.json
│   ├── content.js        # Injects GitHub Social overlays
│   ├── background.js     # Service worker + gh API bridge
│   ├── popup.html/js     # Extension popup UI
│   └── styles.css        # GitHub-native CSS mimicry
├── src-tauri/            # Tauri (Rust) backend
│   └── src/lib.rs       # gh CLI commands (bootstrap, journey)
├── .github/
│   ├── workflows/
│   │   ├── release.yml         # Build + publish on tag
│   │   ├── updater.yml         # Auto-tag on version bump
│   │   ├── weekly-metrics.yml # Anonymous SVG dashboard
│   │   └── journey-sync.yml   # Hourly journey aggregation
│   ├── ISSUE_TEMPLATE/
│   │   └── anonymous-metrics.md # Weekly metrics submission
│   ├── dependabot.yml   # npm + cargo + actions
│   └── FUNDING.yml
├── GitHubSocial.md       # Template users can copy
├── SPEC_ADDENDUM.md      # Full v0.2.0 protocol spec
├── KB/                   # Knowledge base
│   └── README.md
└── profile-activator.html  # Legacy HTML activator (v0.1.0)
```

---

## License

MIT — see [license.md](license.md)

---

## Credit

Every API call, every user record, every avatar — all flows through GitHub's
infrastructure within their free tier. GitHub Actions builds and publishes the
binaries. GitHub Releases distributes them. GitHub is the backbone.

Thank you, GitHub. Every day, a little more.

[![Visitors](https://api.visitorbadge.io/api/visitors?path=github.com/frenzypenguin-media/github-social&label=Visitors&countColor=%23263759)](https://visitorbadge.io/status?path=github.com/frenzypenguin-media/github-social)
