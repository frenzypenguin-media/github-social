# GitHub Social — My Profile

<!--
  ╔═══════════════════════════════════════════════════════════════╗
  ║  GitHub Social v0.2.0 — Personal Profile Template            ║
  ║  Customize the YAML below to configure your social presence  ║
  ╚═══════════════════════════════════════════════════════════════╝
-->

---

<!-- ═══════════════════════════════════════════════════════════════
     FRONTMATTER — All settings live here. Edit carefully.
     ═══════════════════════════════════════════════════════════════ -->

---

login: YOUR_GITHUB_USERNAME
activated: "2026-01-01T00:00:00Z"
schema: 2
version: "0.2.0"

# ── Appearance ─────────────────────────────────────────────────────
# Pick a theme: "dark" (default) or "light"
theme: dark

# Accent color for your profile (6-digit hex, GitHub-style)
accent: "#58a6ff"

# A short message shown on your profile card
motd: "Welcome to my GitHub Social profile!"

# Link to an audio file or stream (MP3, OGG, etc.)
# Leave empty to disable music.
music_url: ""

# Optional banner image URL (800×200 recommended)
banner_url: ""

# ── Visibility toggles ──────────────────────────────────────────────
# Set to "true" or "false" to control what visitors see
show_counters: true
show_history: true
show_integrity: true
show_invite: true

# ── Counters ───────────────────────────────────────────────────────
# These are auto-bumped by the GitHub Social extension/app.
# You can reset them here if needed (they'll sync back on next write).
counters:
  visitor_counter: 0
  visited_counter: 0
  hearts_given: 0
  hearts_received: 0
  comments_written: 0
  reactions_given: 0
  reactions_received: 0
  issues_opened: 0
  prs_approved: 0
  commits_approved: 0
  music_plays: 0
  unique_visitors: 0
  repeat_visitors: 0
  active_days: 0

# ── Integrity ──────────────────────────────────────────────────────
integrity:
  spoof_count: 0
  last_checked: ""
  last_alert: ""
  anomaly_log: []

# ── Custom buttons ─────────────────────────────────────────────────
# Add up to 5 custom action buttons to your profile overlay.
# Each button appears next to GitHub's native Follow/Sponsor buttons.
buttons:
  - id: heart
    label: "♥ Heart"
    emoji: heart
    color: "#d23"
    action: openReactionIssue
  - id: comment
    label: "💬 Comment"
    emoji: speech_balloon
    color: "#58a6ff"
    action: openCommentIssue

# ── Invite template ────────────────────────────────────────────────
# This message is sent when you invite a non-user to join GitHub Social.
invite_template: |
  Hey! I'm using GitHub Social — a decentralized social layer on GitHub.
  Add a GitHubSocial.md to your profile repo to join.

# ── Edit history (append-only, last 50 entries) ───────────────────
edit_history: []

---

<!-- ═══════════════════════════════════════════════════════════════
     README — This section is for human readers and is freely editable.
     The GitHub Social extension reads the frontmatter above, not this section.
     ═══════════════════════════════════════════════════════════════ -->

# GitHub Social — YOUR_GITHUB_USERNAME

<!-- Customize your profile README below. This is your public face on GitHub Social. -->

## About Me

Replace this section with your own bio, interests, projects, or anything you'd like.

## Projects

- **My Awesome Project** — Description of your project
  ![Project Status](https://img.shields.io/badge/status-active-brightgreen)

## Stats

<!-- You can embed your GitHub Social stats here using shields.io or similar: -->
<!-- ![Visitors](https://img.shields.io/endpoint?url=https://your-stats-api.com/visitors/YOUR_LOGIN) -->

## Journey Log

The auto-generated journey log is appended below this section by the GitHub Social
extension and Tauri/PWA app. It records your social interactions on GitHub.

---

<!--
  ╔═══════════════════════════════════════════════════════════════╗
  ║  INSTRUCTIONS                                                ║
  ╠═══════════════════════════════════════════════════════════════╣
  ║  1. Copy this file to YOUR_USERNAME/YOUR_USERNAME/GitHubSocial.md  ║
  ║  2. Replace "YOUR_GITHUB_USERNAME" with your actual GitHub login    ║
  ║  3. Update the frontmatter fields above                         ║
  ║  4. Edit the README section with your own content               ║
  ║  5. Commit and push to activate your GitHub Social profile      ║
  ║                                                              ║
  ║  For full documentation, see:                                  ║
  ║  https://github.com/neohiro/github-social#readme                 ║
  ╚═══════════════════════════════════════════════════════════════╝
-->
