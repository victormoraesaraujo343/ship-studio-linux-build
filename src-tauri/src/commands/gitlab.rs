//! # GitLab Integration
//!
//! The `glab` half of the forge integration. Every function here mirrors a
//! `gh`-backed operation in [`crate::commands::pull_requests`] and returns the
//! same types, so the dispatch in that module is the only place that has to
//! know which forge a project uses — and the frontend keeps one set of Tauri
//! commands regardless.
//!
//! GitLab calls them merge requests and numbers them per project (`iid`), not
//! per account. The `iid` is what users see and what `glab` accepts, so it maps
//! onto `PullRequestInfo::number` directly.
//!
//! Known limitation: unlike `gh`, `glab` is not isolated per workspace. The
//! account system redirects `GH_CONFIG_DIR` for non-default workspaces, but
//! `glab` reads `~/.config/glab-cli`, which is never redirected — so every
//! workspace shares one GitLab login.

use crate::commands::git_provider::{cli_command, GitProvider};
use crate::errors::CommandError;
use crate::external_command::{run_with_timeout, truncate_output};
use crate::types::PullRequestInfo;
use std::path::Path;

/// Bound on `glab` calls that hit the GitLab API. Matches the `gh` path.
const NETWORK_TIMEOUT_SECS: u64 = 60;

/// A `glab` command scoped to a project directory.
///
/// `glab` resolves the target project from the git remote in its working
/// directory, so `current_dir` is what points it at the right repository —
/// there is no `--repo` guessing here.
pub fn glab_command_for_project(project_path: &Path) -> std::process::Command {
    let mut cmd = cli_command(GitProvider::GitLab);
    cmd.current_dir(project_path);
    cmd
}

/// Run a `glab` command bounded by the network timeout.
async fn run_net(
    cmd: std::process::Command,
    label: &str,
) -> Result<std::process::Output, CommandError> {
    run_with_timeout(
        tokio::process::Command::from(cmd),
        label,
        NETWORK_TIMEOUT_SECS,
    )
    .await
}

/// Classify a `glab` failure that means "not signed in".
///
/// GitLab returns a bare 401 for an expired or absent token, and `glab` also
/// has its own no-token message. Both must map to `NotAuthenticated` so the UI
/// offers a sign-in instead of showing a raw API error.
pub(crate) fn glab_auth_error(stderr: &str) -> Option<CommandError> {
    let lower = stderr.to_lowercase();
    if lower.contains("401 unauthorized")
        || lower.contains("no token found")
        || lower.contains("authentication required")
        || lower.contains("glab auth login")
        || lower.contains("invalid token")
    {
        return Some(CommandError::NotAuthenticated {
            service: "gitlab".to_string(),
        });
    }
    None
}

/// Classify the `glab` failures that aren't the app's fault — network, TLS and
/// server-side problems — so they surface as guidance rather than telemetry.
pub(crate) fn glab_common_error(stderr: &str) -> Option<CommandError> {
    let lower = stderr.to_lowercase();

    if lower.contains("x509") || lower.contains("certificate") {
        return Some(CommandError::expected(
            "Could not verify the GitLab server's certificate. If this is a self-hosted \
             instance with a private certificate authority, your system needs to trust it.",
        ));
    }
    if lower.contains("no such host")
        || lower.contains("could not resolve host")
        || lower.contains("connection refused")
        || lower.contains("network is unreachable")
        || lower.contains("i/o timeout")
        || lower.contains("dial tcp")
    {
        return Some(CommandError::expected(
            "Could not reach GitLab. Check your internet connection — and if this is a \
             self-hosted instance, that you can reach it from this network (VPN included).",
        ));
    }
    if lower.contains("502 bad gateway")
        || lower.contains("503 service unavailable")
        || lower.contains("504 gateway")
        || lower.contains("500 internal server error")
    {
        return Some(CommandError::expected(
            "GitLab returned a server error. This is usually temporary — try again shortly.",
        ));
    }
    if lower.contains("404 not found") {
        return Some(CommandError::expected(
            "GitLab could not find this project. Check that the remote points at a project \
             you have access to.",
        ));
    }
    None
}

/// Extract the signed-in username from a `glab auth status` report.
///
/// `None` means "not signed in". Parsed rather than read from the exit code
/// because `glab` exits non-zero when *any* configured instance has a bad
/// token — including when the one the user actually works on is fine, which
/// would otherwise report a working setup as broken. This mirrors the reasoning
/// in `accounts::parse_gh_auth_status`.
pub(crate) fn parse_glab_auth_status(stdout: &str, stderr: &str) -> Option<String> {
    let combined = format!("{stdout}\n{stderr}");
    for line in combined.lines() {
        let lower = line.to_lowercase();
        let idx = match lower.find("logged in to ") {
            Some(idx) => idx,
            None => continue,
        };
        // "✓ Logged in to gitlab.acme.com as jdoe (~/.config/glab-cli/config.yml)"
        let rest = &line[idx + "logged in to ".len()..];
        let mut words = rest.split_whitespace();
        let _host = words.next()?;
        if words.next()? != "as" {
            continue;
        }
        let user = words
            .next()?
            .trim_matches(|c: char| !c.is_alphanumeric() && c != '-' && c != '_' && c != '.');
        if !user.is_empty() {
            return Some(user.to_string());
        }
    }
    None
}

/// Map a GitLab merge-request state onto the vocabulary the UI already speaks.
///
/// The frontend filters on GitHub's uppercase `OPEN`/`MERGED`/`CLOSED`
/// (PullRequestsTab), so translating here keeps one rendering path for both
/// forges. `locked` is a still-open request with discussion locked.
fn normalize_state(state: &str) -> String {
    match state.to_lowercase().as_str() {
        "opened" | "locked" => "OPEN",
        "merged" => "MERGED",
        "closed" => "CLOSED",
        other => return other.to_uppercase(),
    }
    .to_string()
}

/// Whether GitLab considers the request cleanly mergeable.
///
/// `None` means "not known yet" — GitLab computes mergeability asynchronously
/// and reports `unchecked`/`checking` until it settles. Reporting that as
/// `false` would show a conflict warning on a perfectly healthy request.
fn parse_mergeable(mr: &serde_json::Value) -> Option<bool> {
    // `detailed_merge_status` supersedes `merge_status` in newer GitLab; try it
    // first and fall back so both server versions work.
    if let Some(detailed) = mr.get("detailed_merge_status").and_then(|v| v.as_str()) {
        return match detailed {
            "mergeable" => Some(true),
            "checking" | "unchecked" => None,
            _ => Some(false),
        };
    }
    match mr.get("merge_status").and_then(|v| v.as_str())? {
        "can_be_merged" => Some(true),
        "cannot_be_merged" => Some(false),
        _ => None,
    }
}

/// Convert one GitLab merge-request JSON object into the shared shape.
fn parse_merge_request(mr: &serde_json::Value) -> PullRequestInfo {
    PullRequestInfo {
        // `iid` is the per-project number users see; `id` is a global surrogate
        // that `glab` commands do not accept.
        number: mr.get("iid").and_then(|v| v.as_i64()).unwrap_or(0) as i32,
        title: mr
            .get("title")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        head_ref: mr
            .get("source_branch")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        base_ref: mr
            .get("target_branch")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        author: mr
            .get("author")
            .and_then(|a| a.get("username"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        state: normalize_state(mr.get("state").and_then(|v| v.as_str()).unwrap_or("")),
        mergeable: parse_mergeable(mr),
        // `draft` is current; `work_in_progress` is the pre-14.0 name.
        is_draft: mr
            .get("draft")
            .and_then(|v| v.as_bool())
            .or_else(|| mr.get("work_in_progress").and_then(|v| v.as_bool()))
            .unwrap_or(false),
        url: mr
            .get("web_url")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        created_at: mr
            .get("created_at")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
    }
}

/// The signed-in GitLab user's username.
///
/// The UI uses this to mark which requests are the user's own, so on a GitLab
/// project it has to be the GitLab identity — showing a GitHub username there
/// would highlight the wrong rows, or none.
///
/// `glab api` has no `--jq`, so the JSON is parsed here rather than filtered by
/// the CLI the way the `gh` path does it.
pub async fn get_gitlab_username(project: &Path) -> Result<String, CommandError> {
    let mut cmd = glab_command_for_project(project);
    cmd.args(["api", "user"]);

    let output = run_net(cmd, "glab api user").await?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        if let Some(err) = glab_auth_error(&stderr) {
            return Err(err);
        }
        if let Some(err) = glab_common_error(&stderr) {
            return Err(err);
        }
        return Err(CommandError::NotAuthenticated {
            service: "gitlab".to_string(),
        });
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    parse_username(&stdout).ok_or_else(|| {
        CommandError::from("GitLab did not report a username for the signed-in account")
    })
}

/// Pull `username` out of a GitLab user object.
fn parse_username(json: &str) -> Option<String> {
    serde_json::from_str::<serde_json::Value>(json)
        .ok()?
        .get("username")?
        .as_str()
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// List open merge requests for a project.
pub async fn list_merge_requests(project: &Path) -> Result<Vec<PullRequestInfo>, CommandError> {
    let mut cmd = glab_command_for_project(project);
    cmd.args(["mr", "list", "--output", "json", "--per-page", "20"]);

    let output = run_net(cmd, "glab mr list").await?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stdout).to_string()
            + &String::from_utf8_lossy(&output.stderr);
        // An empty project or one with no MRs is a normal state, not an error.
        if stderr.contains("404") && stderr.to_lowercase().contains("not found") {
            return Ok(Vec::new());
        }
        if let Some(err) = glab_auth_error(&stderr) {
            return Err(err);
        }
        if let Some(err) = glab_common_error(&stderr) {
            return Err(err);
        }
        return Err(truncate_output(&stderr).into());
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let trimmed = stdout.trim();
    if trimmed.is_empty() || trimmed == "null" {
        return Ok(Vec::new());
    }

    let parsed: Vec<serde_json::Value> = serde_json::from_str(trimmed)
        .map_err(|e| CommandError::from(format!("Could not read GitLab's response: {e}")))?;

    Ok(parsed.iter().map(parse_merge_request).collect())
}

/// Create a merge request from the current branch.
///
/// Returns the new merge request's URL.
pub async fn create_merge_request(
    project: &Path,
    title: &str,
    body: Option<&str>,
    base: &str,
) -> Result<String, CommandError> {
    let mut cmd = glab_command_for_project(project);
    cmd.args([
        "mr",
        "create",
        "--title",
        title,
        "--description",
        body.unwrap_or(""),
        "--target-branch",
        base,
        // Without --yes, glab opens an interactive confirmation the PTY-less
        // spawn here can never answer.
        "--yes",
    ]);

    let output = run_net(cmd, "glab mr create").await?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        if let Some(err) = glab_auth_error(&stderr) {
            return Err(err);
        }
        if let Some(err) = glab_common_error(&stderr) {
            return Err(err);
        }
        let lower = stderr.to_lowercase();
        if lower.contains("already exists") || lower.contains("open merge request") {
            return Err(CommandError::expected(truncate_output(&stderr)));
        }
        return Err(truncate_output(&stderr).into());
    }

    // glab prints the merge request URL; take the last URL it emitted rather
    // than constructing one, so the value is always something GitLab returned.
    let stdout = String::from_utf8_lossy(&output.stdout);
    let url = stdout
        .lines()
        .rev()
        .flat_map(|line| line.split_whitespace())
        .find(|word| word.starts_with("http://") || word.starts_with("https://"))
        .map(str::to_string);

    match url {
        Some(url) => Ok(url),
        // A successful create with no URL in the output is unexpected but not
        // a failure — say so rather than inventing a link.
        None => Err(CommandError::expected(
            "GitLab created the merge request but did not report its address. \
             Open the project in GitLab to find it.",
        )),
    }
}

/// Merge a merge request immediately.
pub async fn merge_merge_request(project: &Path, iid: i32) -> Result<(), CommandError> {
    let iid = iid.to_string();
    let mut cmd = glab_command_for_project(project);
    cmd.args([
        "mr",
        "merge",
        &iid,
        "--yes",
        // glab defaults --auto-merge to true, which on a project with
        // pipelines *schedules* the merge instead of performing it — the user
        // clicked Merge and would be told it succeeded while nothing merged.
        "--auto-merge=false",
    ]);

    let output = run_net(cmd, "glab mr merge").await?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        if is_gitlab_conflict(&stderr) {
            return Err(CommandError::MergeConflict {
                pr_number: iid.parse().unwrap_or(0),
                stderr: truncate_output(&stderr),
            });
        }
        if stderr.to_lowercase().contains("draft") {
            return Err(CommandError::expected(
                "This merge request is still a draft. Mark it ready in GitLab before merging.",
            ));
        }
        if let Some(err) = glab_auth_error(&stderr) {
            return Err(err);
        }
        if let Some(err) = glab_common_error(&stderr) {
            return Err(err);
        }
        return Err(truncate_output(&stderr).into());
    }

    Ok(())
}

/// Whether a failed merge was refused because the branches conflict.
pub(crate) fn is_gitlab_conflict(stderr: &str) -> bool {
    let lower = stderr.to_lowercase();
    lower.contains("cannot be merged")
        || lower.contains("merge conflict")
        || lower.contains("conflicts")
        || lower.contains("not mergeable")
}

/// Check out a merge request's branch locally. Returns the branch name.
pub async fn checkout_merge_request(project: &Path, iid: i32) -> Result<String, CommandError> {
    let iid_str = iid.to_string();
    let mut cmd = glab_command_for_project(project);
    cmd.args(["mr", "checkout", &iid_str]);

    let output = run_net(cmd, "glab mr checkout").await?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        if let Some(err) = glab_auth_error(&stderr) {
            return Err(err);
        }
        if let Some(err) = glab_common_error(&stderr) {
            return Err(err);
        }
        if crate::commands::git::is_overwrite_refusal(&stderr) {
            return Err(CommandError::expected(
                "You have unsaved changes that would be overwritten. Commit or stash them, \
                 then try again.",
            ));
        }
        return Err(format!("Failed to check out merge request: {stderr}").into());
    }

    // Ask git which branch we landed on rather than parsing glab's output.
    let mut branch_cmd = crate::utils::git_command_in(project)?;
    branch_cmd.args(["rev-parse", "--abbrev-ref", "HEAD"]);
    let branch_out = run_net(branch_cmd, "git rev-parse --abbrev-ref HEAD").await?;

    Ok(String::from_utf8_lossy(&branch_out.stdout)
        .trim()
        .to_string())
}

/// Close a merge request without merging it.
pub async fn close_merge_request(project: &Path, iid: i32) -> Result<(), CommandError> {
    let iid = iid.to_string();
    let mut cmd = glab_command_for_project(project);
    cmd.args(["mr", "close", &iid]);

    let output = run_net(cmd, "glab mr close").await?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        if let Some(err) = glab_auth_error(&stderr) {
            return Err(err);
        }
        if let Some(err) = glab_common_error(&stderr) {
            return Err(err);
        }
        return Err(format!("Failed to close merge request: {stderr}").into());
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    mod state_tests {
        use super::*;

        /// The UI filters on GitHub's vocabulary; GitLab's must be translated
        /// or every merge request renders as neither open nor merged.
        #[test]
        fn gitlab_states_map_onto_the_shared_vocabulary() {
            assert_eq!(normalize_state("opened"), "OPEN");
            assert_eq!(normalize_state("merged"), "MERGED");
            assert_eq!(normalize_state("closed"), "CLOSED");
        }

        /// A locked request is still open — just not accepting discussion.
        #[test]
        fn locked_is_still_open() {
            assert_eq!(normalize_state("locked"), "OPEN");
        }

        #[test]
        fn unknown_states_pass_through_uppercased() {
            assert_eq!(normalize_state("something_new"), "SOMETHING_NEW");
        }
    }

    mod mergeable_tests {
        use super::*;

        #[test]
        fn detailed_status_wins_when_present() {
            let mr = serde_json::json!({
                "detailed_merge_status": "mergeable",
                "merge_status": "cannot_be_merged"
            });
            assert_eq!(parse_mergeable(&mr), Some(true));
        }

        #[test]
        fn falls_back_to_legacy_merge_status() {
            let mr = serde_json::json!({ "merge_status": "can_be_merged" });
            assert_eq!(parse_mergeable(&mr), Some(true));
            let mr = serde_json::json!({ "merge_status": "cannot_be_merged" });
            assert_eq!(parse_mergeable(&mr), Some(false));
        }

        /// GitLab computes mergeability asynchronously. Reporting "not yet
        /// known" as `false` would show a conflict warning on a healthy
        /// request — the UI treats `mergeable === false` as conflicted.
        #[test]
        fn pending_mergeability_is_unknown_not_false() {
            for status in ["unchecked", "checking"] {
                let mr = serde_json::json!({ "detailed_merge_status": status });
                assert_eq!(parse_mergeable(&mr), None, "status: {status}");
            }
            let mr = serde_json::json!({ "merge_status": "unchecked" });
            assert_eq!(parse_mergeable(&mr), None);
        }

        #[test]
        fn absent_status_is_unknown() {
            assert_eq!(parse_mergeable(&serde_json::json!({})), None);
        }

        /// Any other detailed status (blocked, ci_still_running, discussions
        /// unresolved…) means it can't be merged right now.
        #[test]
        fn blocking_statuses_are_not_mergeable() {
            let mr = serde_json::json!({ "detailed_merge_status": "discussions_not_resolved" });
            assert_eq!(parse_mergeable(&mr), Some(false));
        }
    }

    mod parse_merge_request_tests {
        use super::*;

        /// Shaped after a real `glab mr list --output json` element.
        fn sample() -> serde_json::Value {
            serde_json::json!({
                "id": 90210,
                "iid": 42,
                "title": "Add the thing",
                "source_branch": "feature/thing",
                "target_branch": "main",
                "state": "opened",
                "draft": false,
                "web_url": "https://gitlab.acme.com/group/sub/proj/-/merge_requests/42",
                "created_at": "2026-08-21T10:00:00.000Z",
                "detailed_merge_status": "mergeable",
                "author": { "username": "jdoe", "name": "J Doe" }
            })
        }

        /// `iid` is the number users see and the only one glab accepts —
        /// taking `id` would make every merge/close hit the wrong request.
        #[test]
        fn uses_the_project_scoped_iid_not_the_global_id() {
            assert_eq!(parse_merge_request(&sample()).number, 42);
        }

        #[test]
        fn maps_every_field_onto_the_shared_shape() {
            let pr = parse_merge_request(&sample());
            assert_eq!(pr.title, "Add the thing");
            assert_eq!(pr.head_ref, "feature/thing");
            assert_eq!(pr.base_ref, "main");
            assert_eq!(pr.author, "jdoe");
            assert_eq!(pr.state, "OPEN");
            assert_eq!(pr.mergeable, Some(true));
            assert!(!pr.is_draft);
            assert!(pr.url.contains("/merge_requests/42"));
            assert_eq!(pr.created_at, "2026-08-21T10:00:00.000Z");
        }

        /// Pre-14.0 GitLab called it work_in_progress.
        #[test]
        fn accepts_the_legacy_draft_field() {
            let mr = serde_json::json!({ "iid": 1, "work_in_progress": true });
            assert!(parse_merge_request(&mr).is_draft);
        }

        /// A sparse object must not panic — GitLab omits fields the token
        /// can't see.
        #[test]
        fn tolerates_missing_fields() {
            let pr = parse_merge_request(&serde_json::json!({ "iid": 7 }));
            assert_eq!(pr.number, 7);
            assert_eq!(pr.author, "");
            assert_eq!(pr.mergeable, None);
            assert!(!pr.is_draft);
        }
    }

    mod auth_status_tests {
        use super::*;

        #[test]
        fn extracts_username_from_a_signed_in_report() {
            let out =
                "gitlab.com\n  ✓ Logged in to gitlab.com as jdoe (~/.config/glab-cli/config.yml)";
            assert_eq!(parse_glab_auth_status(out, ""), Some("jdoe".to_string()));
        }

        #[test]
        fn reads_a_self_hosted_instance() {
            let out = "gitlab.acme.com\n  ✓ Logged in to gitlab.acme.com as v.moraes (keyring)";
            assert_eq!(
                parse_glab_auth_status("", out),
                Some("v.moraes".to_string())
            );
        }

        /// Verbatim signed-out output — must not be read as a username.
        #[test]
        fn signed_out_report_yields_none() {
            let out = "gitlab.com\n  \
                       x gitlab.com: API call failed: GET https://gitlab.com/api/v4/user: 401\n  \
                       ! No token found (checked config file, keyring, and environment variables).";
            assert_eq!(parse_glab_auth_status(out, ""), None);
            assert_eq!(parse_glab_auth_status("", ""), None);
        }

        /// glab exits non-zero when any configured instance has a bad token.
        /// A working instance in the same report still counts as signed in.
        #[test]
        fn finds_a_good_login_despite_a_broken_second_instance() {
            let out = "gitlab.com\n  x gitlab.com: API call failed: 401\n\
                       gitlab.acme.com\n  ✓ Logged in to gitlab.acme.com as jdoe (keyring)";
            assert_eq!(parse_glab_auth_status(out, ""), Some("jdoe".to_string()));
        }
    }

    mod username_tests {
        use super::*;

        #[test]
        fn reads_username_from_a_gitlab_user_object() {
            let json = r#"{"id":7,"username":"jdoe","name":"J Doe","state":"active"}"#;
            assert_eq!(parse_username(json), Some("jdoe".to_string()));
        }

        /// GitLab's field is `username`; GitHub's is `login`. Reading the wrong
        /// one would silently return nobody.
        #[test]
        fn does_not_read_githubs_login_field() {
            assert_eq!(parse_username(r#"{"login":"octocat"}"#), None);
        }

        #[test]
        fn rejects_empty_and_malformed_responses() {
            assert_eq!(parse_username(r#"{"username":""}"#), None);
            assert_eq!(parse_username("not json"), None);
            assert_eq!(parse_username("{}"), None);
        }
    }

    mod error_classification_tests {
        use super::*;

        #[test]
        fn unauthorized_becomes_not_authenticated() {
            let err = glab_auth_error("GET https://gitlab.com/api/v4/user: 401 Unauthorized");
            assert!(matches!(
                err,
                Some(CommandError::NotAuthenticated { ref service }) if service == "gitlab"
            ));
        }

        #[test]
        fn missing_token_becomes_not_authenticated() {
            assert!(glab_auth_error("! No token found (checked config file)").is_some());
        }

        #[test]
        fn unrelated_stderr_is_not_an_auth_error() {
            assert!(glab_auth_error("something else went wrong").is_none());
        }

        /// Self-hosted GitLab behind a private CA is common enough that the
        /// certificate failure needs its own explanation.
        #[test]
        fn certificate_failure_is_expected_with_guidance() {
            let err = glab_common_error("x509: certificate signed by unknown authority").unwrap();
            assert!(matches!(err, CommandError::Expected { .. }));
            assert!(err.to_string().contains("certificate authority"));
        }

        #[test]
        fn unreachable_host_mentions_vpn() {
            let err = glab_common_error("dial tcp: lookup gitlab.acme.com: no such host").unwrap();
            assert!(err.to_string().contains("VPN"));
        }

        #[test]
        fn server_errors_are_expected() {
            assert!(matches!(
                glab_common_error("503 Service Unavailable"),
                Some(CommandError::Expected { .. })
            ));
        }

        #[test]
        fn healthy_stderr_classifies_as_nothing() {
            assert!(glab_common_error("warning: something harmless").is_none());
        }

        #[test]
        fn conflict_detection_matches_gitlab_phrasing() {
            assert!(is_gitlab_conflict("Branch cannot be merged"));
            assert!(is_gitlab_conflict("merge conflict detected"));
            assert!(!is_gitlab_conflict("pipeline still running"));
        }
    }
}
