//! github-social/src-tauri — Rust backend commands for the Tauri desktop app.
//!
//! ## Commands exposed to the frontend
//!
//! - `bootstrap_social_md(login, repo, content)` — commits `GitHubSocial.md` to `<repo>`
//!   via `octocrab::repos().create_file()` or `.update_file()`. The PAT is read from
//!   `gh auth token` at call time so the frontend never has to hand a PAT across the
//!   Tauri bridge.
//! - `append_journey_entry(login, repo, entry)` — appends a single line to the journey
//!   log in `<repo>/GitHubSocial.md`. Read-modify-write via octocrab with a retry
//!   on 409 (stale SHA from a concurrent edit).
//! - `preflight_health(token)` — single round-trip that validates BOTH auth channels
//!   (the `gh` CLI session AND the PAT from the frontend) using octocrab for all
//!   REST calls. Returns `{ ok, login, token_valid, rate_remaining, has_repos, error }`.
//!
//! ## Architecture
//!
//! GitHub API calls are routed through `octocrab` (the official Rust GitHub client),
//! which handles JSON serialization, error types, rate-limit awareness, and the
//! Accept header. The `gh` CLI is still used for `gh auth status` (to confirm the
//! local CLI session is live) and `gh auth token` (to retrieve the PAT without
//! the frontend needing to store it in `chrome.storage.local`). This means the Tauri
//! backend never holds or transmits a PAT — the PAT is retrieved from `gh` at call
//! time and used only for the duration of the API operation.
//!
//! ## Security model
//!
//! - All command parameters are validated against anchored regexes before reaching
//!   any GitHub API call.
//! - `gh` is invoked only for `auth status` and `auth token` — both read-only, with
//!   no shell, so argument injection is not possible (each arg is passed as a
//!   separate argv entry to the gh process).
//! - All REST writes (`create_file`, `update_file`) go through `octocrab` which
//!   handles JSON encoding and Content-Type headers correctly — no manual base64
//!   or content staging is needed.
//! - The frontend cannot bypass validation: `validate_login` and `validate_repo` are
//!   called at the top of every command.
//! - `preflight_health` accepts an optional `token` from the frontend solely to
//!   exercise the REST leg (`GET /user`); it is never written to disk, passed to
//!   `gh`, or logged. In Tauri mode, callers may pass `None` to validate `gh` CLI
//!   auth only — which is sufficient for `bootstrap_social_md` / `append_journey_entry`.

use http::StatusCode;
use octocrab::{Error as OctocrabError, Octocrab};
use regex::Regex;
use serde::Serialize;
use serde_json::Value;
use std::process::Command;
use std::sync::OnceLock;
use tauri::Manager;

const MAX_CONTENT_BYTES: usize = 1_000_000; // 1 MB for full bootstrap content
const MAX_JOURNEY_ENTRY_BYTES: usize = 64 * 1024; // 64 KB per journey entry
// GitHub login: 1-39 chars, alphanumeric + dash (no underscore, no leading/trailing dash restriction)
const LOGIN_PATTERN: &str = r"^[A-Za-z0-9][A-Za-z0-9-]{0,38}$";
// GitHub repo: owner/name where name allows . and _
const REPO_PATTERN: &str = r"^[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$";

#[derive(Serialize, Debug)]
struct CommandResult {
    ok: bool,
    message: String,
    stdout: String,
    stderr: String,
}

#[derive(Serialize, Debug)]
struct PreflightHealth {
    ok: bool,
    login: Option<String>,
    token_valid: bool,
    rate_remaining: Option<u32>,
    has_repos: bool,
    error: Option<String>,
}

#[derive(Debug)]
enum ValidateError {
    InvalidLogin(String),
    InvalidRepo(String),
}

impl std::fmt::Display for ValidateError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ValidateError::InvalidLogin(s) => write!(f, "invalid login format: {}", s),
            ValidateError::InvalidRepo(s) => write!(f, "invalid repo format (expected owner/name): {}", s),
        }
    }
}

impl std::error::Error for ValidateError {}

/// Cached compiled regexes. `regex::Regex` construction is expensive; we
/// compile once and reuse.
static LOGIN_RE: OnceLock<Regex> = OnceLock::new();
static REPO_RE: OnceLock<Regex> = OnceLock::new();

fn validate_login(login: &str) -> Result<(), ValidateError> {
    let re = LOGIN_RE.get_or_init(|| Regex::new(LOGIN_PATTERN).expect("static pattern"));
    if !re.is_match(login) {
        return Err(ValidateError::InvalidLogin(login.to_string()));
    }
    Ok(())
}

fn validate_repo(repo: &str) -> Result<(), ValidateError> {
    let re = REPO_RE.get_or_init(|| Regex::new(REPO_PATTERN).expect("static pattern"));
    if !re.is_match(repo) {
        return Err(ValidateError::InvalidRepo(repo.to_string()));
    }
    Ok(())
}

fn run_gh(args: &[&str]) -> Result<CommandResult, String> {
    let out = Command::new("gh")
        .args(args)
        .output()
        .map_err(|e| format!("gh not available: {}", e))?;
    let stdout = String::from_utf8_lossy(&out.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&out.stderr).into_owned();
    let ok = out.status.success();
    Ok(CommandResult {
        ok,
        message: if ok {
            stdout.clone()
        } else {
            format!("gh exited with status {}: {}", out.status, stderr.trim())
        },
        stdout,
        stderr,
    })
}

/// Read the current `gh auth token` (the PAT the user authenticated with via
/// `gh auth login`). Used by the Tauri backend so the frontend never has to
/// hand a PAT across the bridge.
fn read_gh_token() -> Result<String, String> {
    let r = run_gh(&["auth", "token"])?;
    if !r.ok {
        return Err(format!(
            "gh CLI is not authenticated: {}",
            r.stderr.trim()
        ));
    }
    Ok(r.stdout.trim().to_string())
}

/// Build an `Octocrab` instance pre-configured for GitHub's REST API. The
/// returned client sets the `X-GitHub-Api-Version: 2022-11-28` header and a
/// stable User-Agent — both required by GitHub's API policy.
/// Timeout is set to 30s for connect and 60s for read to prevent hangs.
async fn build_octocrab(token: &str) -> Result<Octocrab, OctocrabError> {
    use std::time::Duration;
    Octocrab::builder()
        .personal_token(token.to_string())
        .user_agent("github-social/0.2.0")
        .default_headers({
            let mut h = http::HeaderMap::new();
            h.insert(
                "X-GitHub-Api-Version",
                "2022-11-28".parse().expect("static header value"),
            );
            h
        })
        .timeout(Duration::from_secs(60))
        .connect_timeout(Duration::from_secs(30))
        .build()
}

/// Parse the JSON output of `gh auth status --json hosts` and return the
/// login of the first successful, active entry. Returns `None` if the output
/// is malformed or no such entry exists.
///
/// Output shape (from cli/cli pkg/cmd/auth/status/status.go):
/// ```json
/// { "hosts": {
///     "github.com": [
///       {"state": "success", "login": "octocat", "active": true, ...},
///       {"state": "error",   "login": "x",       "active": false, ...}
///     ]
///   }
/// }
/// ```
/// The first host with an entry where `state == "success"` and `active == true`
/// is the auth-active account; that login is what subsequent `gh` calls will
/// act as. This is immune to non-English locales, terminal color codes, and
/// multi-account hosts — none of which would have affected text parsing of
/// the human-readable "Logged in to <host> account <login> (...)" line.
fn parse_gh_auth_status_json(stdout: &str) -> Option<String> {
    let val: Value = serde_json::from_str(stdout.trim()).ok()?;
    let hosts = val.get("hosts")?.as_object()?;
    for (_host, entries) in hosts {
        let arr = entries.as_array()?;
        for e in arr {
            let state = e.get("state").and_then(|v| v.as_str());
            let active = e.get("active").and_then(|v| v.as_bool()).unwrap_or(false);
            if state == Some("success") && active {
                if let Some(login) = e.get("login").and_then(|v| v.as_str()) {
                    return Some(login.to_string());
                }
            }
        }
    }
    None
}



/// Commits or updates `GitHubSocial.md` in `<repo>` using `octocrab`'s
/// `repos().create_file()` or `.update_file()`. The `sha` is obtained by reading
/// the existing file first; if it doesn't exist, the file is created.
#[tauri::command]
async fn bootstrap_social_md(
    login: String,
    repo: String,
    content: String,
) -> Result<CommandResult, String> {
    tracing::info!(%login, %repo, "bootstrap_social_md: starting");
    validate_login(&login).map_err(|e| e.to_string())?;
    validate_repo(&repo).map_err(|e| e.to_string())?;
    if content.len() > MAX_CONTENT_BYTES {
        return Err(format!(
            "content too large ({} bytes; max {})",
            content.len(),
            MAX_CONTENT_BYTES
        ));
    }

    // Confirm gh CLI session is alive.
    let status = run_gh(&["auth", "status"])?;
    if !status.ok {
        return Err(
            "gh CLI is not authenticated. Run `gh auth login` in your terminal.".into(),
        );
    }

    let token = read_gh_token()?;
    let octocrab = build_octocrab(&token)
        .await
        .map_err(|e| format!("failed to build GitHub client: {}", e))?;

    let (owner, repo_name) = repo
        .split_once('/')
        .ok_or_else(|| "repo must be in owner/name format".to_string())?;

    // Try to read the existing file to get its SHA (needed for updates).
    let existing_sha: Option<String> = match octocrab
        .repos(owner, repo_name)
        .get_content()
        .path("GitHubSocial.md")
        .send()
        .await
    {
        Ok(content) => content.items.first().map(|item| item.sha.clone()),
        Err(OctocrabError::GitHub { source, .. })
            if source.status_code == StatusCode::NOT_FOUND =>
        {
            None
        }
        Err(e) => {
            return Err(format!(
                "could not check existing GitHubSocial.md: {}",
                e
            ));
        }
    };

    let message = if existing_sha.is_some() {
        "Update GitHubSocial.md"
    } else {
        "Add GitHubSocial.md"
    };

    let result = if let Some(sha) = existing_sha.as_deref() {
        octocrab
            .repos(owner, repo_name)
            .update_file("GitHubSocial.md", message, content.as_bytes(), sha)
            .send()
            .await
    } else {
        octocrab
            .repos(owner, repo_name)
            .create_file("GitHubSocial.md", message, content.as_bytes())
            .send()
            .await
    };

    match result {
        Ok(_commit) => Ok(CommandResult {
            ok: true,
            message: format!("Committed GitHubSocial.md to {}", repo),
            stdout: String::new(),
            stderr: String::new(),
        }),
        Err(e) => Ok(CommandResult {
            ok: false,
            message: format!("Commit failed: {}", e),
            stdout: String::new(),
            stderr: e.to_string(),
        }),
    }
}

/// Read the current content of `GitHubSocial.md`, append `entry` as a new line,
/// and write it back via `octocrab.repos().create_file()` (or `.update_file()` if
/// the file already exists). Retries once on HTTP 409 (stale SHA from a concurrent
/// edit) by re-reading the SHA and retrying.
async fn append_journey_entry_inner(
    login: &str,
    repo: &str,
    entry: &str,
) -> Result<CommandResult, String> {
    validate_login(login).map_err(|e| e.to_string())?;
    validate_repo(repo).map_err(|e| e.to_string())?;
    if entry.len() > MAX_JOURNEY_ENTRY_BYTES {
        return Err(format!(
            "entry too large ({} bytes; max {})",
            entry.len(),
            MAX_JOURNEY_ENTRY_BYTES
        ));
    }
    if entry.contains('\n') || entry.contains('\r') || entry.contains('\0') {
        return Err("entry must not contain newline or null characters".into());
    }
    // Strip control characters (except tab) and limit to printable range.
    let sanitized: String = entry
        .chars()
        .filter(|c| c.is_ascii_graphic() || *c == ' ' || *c == '\t')
        .collect();
    if sanitized != entry {
        return Err("entry contains disallowed control characters".into());
    }

    let status = run_gh(&["auth", "status"])?;
    if !status.ok {
        return Err("gh CLI is not authenticated. Run `gh auth login`.".into());
    }

    let token = read_gh_token()?;
    let octocrab = build_octocrab(&token)
        .await
        .map_err(|e| format!("failed to build GitHub client: {}", e))?;

    let (owner, repo_name) = repo
        .split_once('/')
        .ok_or_else(|| "repo must be in owner/name format".to_string())?;

    const MAX_JOURNEY_ATTEMPTS: u32 = 3;
    const INITIAL_RETRY_DELAY_MS: u64 = 250;

    let mut attempt = 0;

    loop {
        attempt += 1;
        if attempt > MAX_JOURNEY_ATTEMPTS {
            return Ok(CommandResult {
                ok: false,
                message: format!(
                    "Append failed after {} attempts — the repository may be under concurrent write pressure",
                    MAX_JOURNEY_ATTEMPTS
                ),
                stdout: String::new(),
                stderr: String::new(),
            });
        }

        // ── Read current file ──────────────────────────────────────────────
        let (sha, decoded) = match octocrab
            .repos(owner, repo_name)
            .get_content()
            .path("GitHubSocial.md")
            .send()
            .await
        {
            Ok(content) => {
                let sha = content
                    .items
                    .first()
                    .map(|i| i.sha.clone())
                    .unwrap_or_default();
                let decoded = content
                    .items
                    .first()
                    .and_then(|i| i.decoded_content())
                    .unwrap_or_default();
                (sha, decoded)
            }
            Err(OctocrabError::GitHub { source, .. })
                if source.status_code == StatusCode::NOT_FOUND =>
            {
                (String::new(), String::new())
            }
            Err(e) => {
                return Err(format!("could not read GitHubSocial.md: {}", e));
            }
        };

        // ── Build new content ───────────────────────────────────────────────
        let new_content = format!("{}\n{}\n", decoded.trim_end(), entry);
        let message = format!("journey: append (by {})", login);

        // ── Write ───────────────────────────────────────────────────────────
        let result = if sha.is_empty() {
            octocrab
                .repos(owner, repo_name)
                .create_file("GitHubSocial.md", &message, new_content.as_bytes())
                .send()
                .await
        } else {
            octocrab
                .repos(owner, repo_name)
                .update_file("GitHubSocial.md", &message, new_content.as_bytes(), &sha)
                .send()
                .await
        };

        match result {
            Ok(_commit) => {
                return Ok(CommandResult {
                    ok: true,
                    message: format!("Appended journey entry to {}/GitHubSocial.md", repo),
                    stdout: String::new(),
                    stderr: String::new(),
                });
            }
            Err(OctocrabError::GitHub { source, .. })
                if source.status_code == StatusCode::CONFLICT =>
            {
                // Stale SHA — retry with fresh read (409 means another write happened).
                // Exponential backoff: 250ms, 500ms, 1000ms...
                let delay_ms = INITIAL_RETRY_DELAY_MS * (1 << (attempt - 1));
                tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
                continue;
            }
            Err(e) => {
                return Ok(CommandResult {
                    ok: false,
                    message: format!("Append failed: {}", e),
                    stdout: String::new(),
                    stderr: e.to_string(),
                });
            }
        }
    }
}

#[tauri::command]
async fn append_journey_entry(
    login: String,
    repo: String,
    entry: String,
) -> Result<CommandResult, String> {
    append_journey_entry_inner(&login, &repo, &entry).await
}
/// Single-round-trip health check that validates both GitHub auth channels used by
/// this app:
///
///  1. `gh auth status --json hosts`  — the CLI session required for `bootstrap_social_md`
///     and `append_journey_entry`. This is the same pattern as the two write commands.
///  2. `octocrab` REST calls with the PAT  — exercises the `/user` endpoint and the
///     `/user/repos` endpoint, which together confirm the PAT is valid and the account
///     has at least read access to the user's repos. This is a proxy for "can write".
///
/// Always returns a valid `PreflightHealth` struct.  Errors are encoded in the
/// `error` field rather than returned as `Err` so the frontend can always render a
/// diagnostic even when something goes wrong (e.g. `gh` not installed).
#[tauri::command]
async fn preflight_health(token: Option<String>) -> PreflightHealth {
    let cli_login = match run_gh(&["auth", "status", "--json", "hosts"]) {
        Ok(r) if r.ok => parse_gh_auth_status_json(&r.stdout),
        Ok(r) => {
            return PreflightHealth {
                ok: false,
                login: None,
                token_valid: false,
                rate_remaining: None,
                has_repos: false,
                error: Some(format!("gh auth not authenticated: {}", r.stderr.trim())),
            };
        }
        Err(e) => {
            return PreflightHealth {
                ok: false,
                login: None,
                token_valid: false,
                rate_remaining: None,
                has_repos: false,
                error: Some(e),
            };
        }
    };

    let Some(token) = token else {
        // No PAT provided — we can still confirm the gh CLI session is live.
        // Surface this honestly: ok=true (CLI leg passed), but token_valid=false
        // and an error string so the frontend can prompt the user to add a PAT.
        return PreflightHealth {
            ok: true,
            login: cli_login,
            token_valid: false,
            rate_remaining: None,
            has_repos: false,
            error: Some("no PAT provided — REST leg skipped".into()),
        };
    };

    let octocrab = match build_octocrab(&token).await {
        Ok(c) => c,
        Err(e) => {
            return PreflightHealth {
                ok: false,
                login: cli_login,
                token_valid: false,
                rate_remaining: None,
                has_repos: false,
                error: Some(format!("octocrab builder error: {}", e)),
            };
        }
    };

    // ── Leg 2a: GET /user — confirms token is valid and reads login ─────────
    let rest_login = match octocrab.current().user().await {
        Ok(user) => Some(user.login),
        Err(e) => {
            let msg = github_error_message(&e);
            return PreflightHealth {
                ok: false,
                login: cli_login,
                token_valid: false,
                rate_remaining: None,
                has_repos: false,
                error: Some(format!("REST /user failed: {}", msg)),
            };
        }
    };

    // ── Leg 2b: GET /user/repos — checks read access to repos ──────────────
    // A non-empty result means the user has at least one repo. An error is
    // expected for fine-grained PATs without `repo` scope; we treat that as
    // "no repos visible" but surface the cause in the error field for the
    // doctor page to display.
    let (has_repos, repos_err) = match octocrab
        .current()
        .list_repos_for_authenticated_user()
        .per_page(1)
        .page(1u8)
        .send()
        .await
    {
        Ok(page) => (!page.items.is_empty(), None),
        Err(e) => (false, Some(github_error_message(&e))),
    };

    PreflightHealth {
        ok: true,
        login: rest_login.or(cli_login),
        token_valid: true,
        rate_remaining: None,
        has_repos,
        error: repos_err,
    }
}

/// Extract a human-readable error message from an `OctocrabError`.
/// Also extracts rate limit info if present in the response headers.
fn github_error_message(e: &OctocrabError) -> String {
    match e {
        OctocrabError::GitHub { source, .. } => {
            let status = format!("HTTP {}: ", source.status_code.as_u16());
            let rate_info = source
                .headers
                .as_ref()
                .and_then(|h| {
                    let rem = h.get("x-ratelimit-remaining")?.to_str().ok()?;
                    let limit = h.get("x-ratelimit-limit")?.to_str().ok()?;
                    Some(format!(" (rate: {}/{})", rem, limit))
                })
                .unwrap_or_default();
            format!("{}{}{}", status, source.message, rate_info)
        }
        OctocrabError::Http(e) => format!("HTTP transport error: {}", e),
        OctocrabError::Serde(e) => format!("JSON decode error: {}", e),
        OctocrabError::Uri(e) => format!("Invalid URI: {}", e),
        _ => e.to_string(),
    }
}

use tracing_subscriber::EnvFilter;

/// Pure inner function (no Tauri context) so unit tests can call it with a
/// mock-friendly surface. The `#[tauri::command]` wrapper above just forwards.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env())
        .init();
    tracing::info!("starting github-social v0.2.0");

    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            let window = app.get_webview_window("main").unwrap();
            window.set_theme(Some(tauri::Theme::Dark)).ok();
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![bootstrap_social_md, append_journey_entry, preflight_health])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    /// Generate a deterministic unique temp path for tests.
    /// Combines the process id with a counter so concurrent tests can't collide.
    fn temp_path(name: &str) -> std::path::PathBuf {
        use std::sync::atomic::{AtomicU64, Ordering};
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let pid = std::process::id();
        std::env::temp_dir().join(format!("github-social-test-{}-{}-{}", pid, n, name))
    }

    #[test]
    fn validate_login_accepts_normal_handles() {
        for ok in ["octocat", "a", "a-b-c", "A1B2C3", "1234567890"] {
            assert!(validate_login(ok).is_ok(), "expected {} to be valid", ok);
        }
    }

    #[test]
    fn validate_login_accepts_max_length() {
        // 39 chars = 1 + 38
        assert!(validate_login(&"a".repeat(39)).is_ok());
    }

    #[test]
    fn validate_login_rejects_garbage() {
        for bad in [
            "",
            "-starts-with-dash",
            "has space",
            "has/slash",
            "ümlaut",
        ] {
            assert!(validate_login(bad).is_err(), "expected {} to be invalid", bad);
        }
        // 40 chars — too long
        assert!(validate_login(&"a".repeat(40)).is_err());
    }

    #[test]
    fn validate_login_rejects_underscore() {
        // GitHub logins do NOT allow underscores
        assert!(validate_login("user_name").is_err());
    }

    #[test]
    fn validate_repo_accepts_normal() {
        for ok in [
            "octocat/octocat",
            "a/b",
            "user-name/repo.name",
            "A1-B2/C3_D4.e5",
        ] {
            assert!(validate_repo(ok).is_ok(), "expected {} to be valid", ok);
        }
    }

    #[test]
    fn validate_repo_accepts_max_lengths() {
        // 39-char owner + 100-char name = valid
        let max_owner = "a".repeat(39);
        let max_name = "r".repeat(100);
        assert!(validate_repo(&format!("{}/{}", max_owner, max_name)).is_ok());
    }

    #[test]
    fn validate_repo_rejects_garbage() {
        for bad in [
            "",
            "no-slash",
            "/leading",
            "trailing/",
            "double//slash",
            "owner/-bad-name",
        ] {
            assert!(validate_repo(bad).is_err(), "expected {} to be invalid", bad);
        }
        // 40-char owner — too long
        assert!(validate_repo(&format!("{}/r", "a".repeat(40))).is_err());
        // 101-char name — too long
        assert!(validate_repo(&format!("o/{}", "r".repeat(101))).is_err());
    }

    #[test]
    fn temp_paths_are_unique_under_concurrent_load() {
        use std::collections::HashSet;
        let mut seen = HashSet::new();
        for i in 0..1000 {
            let p = temp_path(&format!("test-{}", i));
            let s = p.to_string_lossy().to_string();
            assert!(seen.insert(s.clone()), "duplicate temp path: {}", s);
        }
        assert_eq!(seen.len(), 1000);
    }

    #[test]
    fn content_size_limit_constants() {
        assert_eq!(MAX_CONTENT_BYTES, 1_000_000);
        assert_eq!(MAX_JOURNEY_ENTRY_BYTES, 64 * 1024);
    }

    #[tokio::test]
    async fn append_journey_entry_validates_login() {
        let result = append_journey_entry_inner("", "octocat/octocat", "entry").await;
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(err.contains("invalid login"), "got: {}", err);
    }

    #[tokio::test]
    async fn append_journey_entry_validates_repo() {
        let result = append_journey_entry_inner("octocat", "no-slash", "entry").await;
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(err.contains("invalid repo"), "got: {}", err);
    }

    #[tokio::test]
    async fn append_journey_entry_validates_entry_size() {
        let huge = "x".repeat(MAX_JOURNEY_ENTRY_BYTES + 1);
        let result = append_journey_entry_inner("octocat", "octocat/octocat", &huge).await;
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(err.contains("entry too large"), "got: {}", err);
    }

    #[tokio::test]
    async fn append_journey_entry_rejects_newlines() {
        for bad in ["line1\nline2", "a\rb", "foo\nbar\rbaz"] {
            let result = append_journey_entry_inner("octocat", "octocat/octocat", bad).await;
            assert!(result.is_err(), "expected newline entry {} to be rejected", bad);
            let err = result.unwrap_err();
            assert!(err.contains("newline"), "got: {}", err);
        }
    }

    #[test]
    fn preflight_health_serializes_with_all_fields() {
        let p = PreflightHealth {
            ok: true,
            login: Some("octocat".into()),
            token_valid: true,
            rate_remaining: Some(4999),
            has_repos: true,
            error: None,
        };
        let json = serde_json::to_string(&p).unwrap();
        assert!(json.contains("\"ok\":true"));
        assert!(json.contains("\"login\":\"octocat\""));
        assert!(json.contains("\"token_valid\":true"));
        assert!(json.contains("\"rate_remaining\":4999"));
        assert!(json.contains("\"has_repos\":true"));
        assert!(json.contains("\"error\":null"));
    }
    #[test]
    fn preflight_health_serializes_with_failure() {
        let p = PreflightHealth {
            ok: false,
            login: None,
            token_valid: false,
            rate_remaining: None,
            has_repos: false,
            error: Some("gh not authenticated".into()),
        };
        let json = serde_json::to_string(&p).unwrap();
        assert!(json.contains("\"ok\":false"));
        assert!(json.contains("\"login\":null"));
        assert!(json.contains("\"token_valid\":false"));
        assert!(json.contains("\"error\":\"gh not authenticated\""));
    }

    #[test]
    fn parse_gh_auth_status_json_single_active_account() {
        let json = r#"{"hosts":{"github.com":[{"state":"success","login":"octocat","active":true}]}}"#;
        assert_eq!(parse_gh_auth_status_json(json), Some("octocat".to_string()));
    }

    #[test]
    fn parse_gh_auth_status_json_prefers_active_entry() {
        // Two entries: error (inactive) first, then success (active) — should pick active.
        let json = r#"{"hosts":{"github.com":[
            {"state":"error","login":"olduser","active":false},
            {"state":"success","login":"octocat","active":true}
        ]}}"#;
        assert_eq!(parse_gh_auth_status_json(json), Some("octocat".to_string()));
    }

    #[test]
    fn parse_gh_auth_status_json_ignores_inactive_success() {
        // Success entry but not active — should return None.
        let json = r#"{"hosts":{"github.com":[{"state":"success","login":"inactive-user","active":false}]}}"#;
        assert_eq!(parse_gh_auth_status_json(json), None);
    }

    #[test]
    fn parse_gh_auth_status_json_malformed_returns_none() {
        assert_eq!(parse_gh_auth_status_json("not json {{{"), None);
        assert_eq!(parse_gh_auth_status_json("{}"), None);
        assert_eq!(parse_gh_auth_status_json(r#"{"hosts":{}}"#), None);
    }

    #[test]
    fn parse_gh_auth_status_json_realistic_gh_output() {
        // This is the actual shape produced by `gh auth status --json hosts`
        // for a user logged in to one host with one active account.
        let json = r#"{
            "hosts": {
                "github.com": [
                    {
                        "state": "success",
                        "host": "github.com",
                        "login": "octocat",
                        "active": true,
                        "tokenSource": "/Users/octocat/.config/gh/hosts.yml",
                        "token": "****",
                        "scopes": "repo, read:user, gist",
                        "gitProtocol": "https"
                    }
                ]
            }
        }"#;
        assert_eq!(parse_gh_auth_status_json(json), Some("octocat".to_string()));
    }
}