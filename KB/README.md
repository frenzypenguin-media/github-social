# GitHub Social — Knowledge Base

> **Version:** 0.2.0 | **Status:** Production | **Last updated:** 2026-08-30

---

## Quick Links

| Section | Description |
|---------|-------------|
| [Installation](#installation) | How to install (Tauri, PWA, Extension) |
| [File Tree](#file-tree) | Complete repository structure |
| [Features](#features) | What's new in v0.2.0 |
| [API Reference](#api-reference) | `window.ghsocial` API |
| [Troubleshooting](#troubleshooting) | Common issues and fixes |
| [Contributing](#contributing) | How to contribute |

---

## Overview

GitHub Social v0.2.0 adds a full **journey-tracking system** on top of GitHub
profiles. Think of it as a decentralized social layer where every interaction
is recorded as an append-only journal entry in your `GitHubSocial.md` file.

### What's New in v0.2.0

- **Journey Log** — Record every profile visit, heart, reaction, and comment
- **PR-Based Reactions** — Heart/reactions stored as Issues on target's repo
- **Integrity Checker** — Detect and flag counter spoofing
- **Music Autoplay** — Stream audio from your profile via `music_url`
- **Spoof Detection** — Diff edit history vs. current state, flag anomalies
- **Stats Panel** — Floating session stats in all three delivery surfaces
- **Browser Extension** — Content-script injection with perfect GitHub mimicry
- **Extension Bridge API** — `window.ghsocial.*` for injection scripts

---

## File Tree

```
github-social/
│
├── .github/
│   ├── workflows/
│   │   ├── weekly-metrics.yml      🔄 Weekly SVG graph generation
│   │   ├── journey-sync.yml        🔄 Hourly journey aggregation
│   │   └── render_svg.py          📊 Pure-stdlib SVG renderer
│   ├── ISSUE_TEMPLATE/
│   │   └── anonymous-metrics.md   📋 Metrics submission template
│   ├── dependabot.yml              🔧 Dependabot config (npm + cargo + actions)
│   └── FUNDING.yml                💝 GitHub Sponsors link
│
├── extension/
│   ├── manifest.json               📋 WebExtension manifest v3
│   ├── content.js                  🖱️ Content script (injected on github.com)
│   ├── background.js               🔄 Service worker
│   ├── popup.html                  🪟 Extension popup UI
│   ├── popup.js                    ⚙️ Popup logic
│   ├── styles.css                  🎨 GitHub-mimicry CSS
│   └── _locales/
│       └── en/
│           └── messages.json       🌍 i18n strings
│
├── src/
│   ├── app.js                      ⚙️ Shared application logic (v0.2.0)
│   └── index.html                  🌐 Tauri/PWA HTML shell
│
├── src-tauri/
│   ├── Cargo.toml                  🦀 Rust dependencies
│   ├── tauri.conf.json             ⚙️ Tauri configuration
│   └── src/
│       └── lib.rs                  🦀 Tauri Rust commands
│
├── KB/
│   └── README.md                   📚 This file
│
├── SPEC_ADDENDUM.md                📖 Full v0.2.0 specification
├── GitHubSocial.md                 📝 User profile template
├── README.md                       📄 Project README
└── package.json                    📦 Node.js package manifest
```

---

## Installation

### Option 1: Browser Extension (Recommended)

Works on Chrome, Firefox, Edge, and Opera.

1. Clone the repo: `git clone https://github.com/neohiro/github-social`
2. Open `extension/manifest.json` in your browser's extension manager
   - **Chrome/Edge:** `chrome://extensions` → "Load unpacked" → select `extension/`
   - **Firefox:** `about:debugging#/runtime/this-firefox` → "Load Temporary Add-on"
   - **Opera:** `extensions` → "Developer mode" → "Load unpacked extension"
3. Navigate to any GitHub profile page to see the overlay

### Option 2: Tauri Desktop App

Native desktop app for macOS, Windows, and Linux.

```bash
# Prerequisites: Node.js 18+, Rust 1.70+, gh CLI
npm install
npm run tauri dev    # Development
npm run tauri build  # Production build
```

### Option 3: PWA (Web)

No installation required. Works in any modern browser.

```bash
npm install
npm run pwa          # Serve from pwa/ directory
```

Or visit the live instance at:
**https://frenzypenguin-media.github.io/github-social/**

---

## Features

### Journey Log

Every interaction you make is recorded in your `GitHubSocial.md` as an
append-only journal entry:

```
2026-08-30T12:00:00Z alice visit bob {}
2026-08-30T12:05:00Z alice heart bob {"repo":"bob/bob"}
```

Supported entry types: `visit`, `heart`, `reaction`, `comment`, `issue_open`,
`pr_approve`, `commit_approve`, `music_play`, `invite_sent`

### PR-Based Reactions

Reactions are stored as Issues on the target's profile repo. This means:
- No server needed — GitHub IS the social graph
- All reactions are public and auditable
- Users must explicitly approve reactions (ToS compliant)

### Integrity Checker

Detects counter spoofing by diffing:
- Edit history in commit log
- Current frontmatter state
- Journey log consistency

### Music Autoplay

Set `music_url` in your frontmatter with an MP3/stream URL. The extension
shows a player in your profile overlay. Requires user interaction to play.

---

## API Reference

### Extension Bridge (`window.ghsocial`)

```javascript
// Check if current profile is a GitHub Social user
window.ghsocial.isGitHubSocialUser  // boolean

// Current profile login
window.ghsocial.login               // string

// Profile preferences (from frontmatter)
window.ghsocial.prefs = {
  theme: "dark",
  accent: "#58a6ff",
  show_counters: true,
  show_history: true,
  music_url: "",
  // ...
}

// Actions
await window.ghsocial.heart("target_login")    // Send a heart
await window.ghsocial.react("target", "+1")    // Send a reaction
await window.ghsocial.invite("stranger")       // Invite non-user
window.ghsocial.playMusic()                    // Start music playback
window.ghsocial.pauseMusic()                   // Pause music

// Session stats
window.ghsocial.session = {
  visits: 0,
  hearts: 0,
  comments: 0,
  reactions: 0,
  plays: 0,
}

// Event system
window.ghsocial.on("heart", (data) => { ... })
window.ghsocial.off("heart", handler)
```

### Tauri Commands

```rust
// Append a journey entry (Rust/Tauri side)
tauri::invoke("append_journey_entry", {
  "login": "alice",
  "repo": "alice/alice",
  "entry": "2026-08-30T12:00:00Z alice visit bob {}"
})

// Bootstrap GitHubSocial.md
tauri::invoke("bootstrap_social_md", {
  "login": "alice",
  "repo": "alice/alice",
  "content": "..."
})
```

---

## Troubleshooting

### "No GitHub Social profile detected"

The user hasn't created a `GitHubSocial.md` file yet. Use the **Invite**
button to send them an invitation issue.

### "Rate limited"

Add a GitHub Personal Access Token in Settings. The extension and PWA
support token-based authentication for higher rate limits.

### "Music won't play"

Ensure `music_url` is a direct link to an audio file (MP3, OGG) or a
valid stream URL. Music autoplay requires user interaction — it won't
start automatically.

### "Counters not updating"

Counters are updated by appending journey entries. If counters seem stale:
1. Check your GitHubSocial.md commit history
2. Verify the `counters:` block is being updated
3. Run the integrity checker to detect spoofing

### "Extension not showing on profile page"

The extension only injects on GitHub profile pages (not repo pages).
Make sure you're at `https://github.com/username` (no trailing path).

---

## Contributing

1. Read [SPEC_ADDENDUM.md](./SPEC_ADDENDUM.md) for the full specification
2. Fork the repo and create a feature branch
3. Run tests: `npm test` (Tauri), `npm run test:ext` (Extension)
4. Submit a PR with tests and documentation updates

---

## License

MIT License — see [LICENSE](./LICENSE) file.

---

**Questions?** Open an issue at https://github.com/neohiro/github-social/issues
