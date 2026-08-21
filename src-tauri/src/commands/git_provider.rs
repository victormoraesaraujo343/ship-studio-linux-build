//! # Git Forge Provider
//!
//! Ship Studio drives GitHub through the `gh` CLI. GitLab is the same shape of
//! integration through `glab`, so rather than duplicating every command this
//! module works out *which* forge a project's remote points at and the rest of
//! the backend dispatches on that.
//!
//! Detection is a cascade, because a hostname alone is not always enough:
//!
//! 1. `github.com` / `gitlab.com` and their subdomains — unambiguous.
//! 2. A self-hosted host with the product name in it (`gitlab.acme.com`).
//! 3. A self-hosted host on a company domain that names neither
//!    (`git.acme.com`, `code.acme.com`) — resolved by asking each CLI which
//!    hosts it is actually logged in to. This is the common enterprise case and
//!    the reason detection is async and cached rather than a pure function.
//!
//! Nothing here assumes a provider is installed: an absent CLI simply
//! contributes no hosts, and an unresolvable host falls back to GitHub, which
//! is the behaviour every existing project already had.

use crate::cache::TtlCache;
use crate::errors::CommandError;
use crate::external_command::run_with_timeout;
use crate::utils::{create_command, find_executable, get_extended_path, validate_project_path};
use serde::{Deserialize, Serialize};
use std::process::Command;
use std::sync::LazyLock;
use std::time::Duration;

/// How long a host→provider resolution stays cached.
///
/// Long, because the answer only changes when someone authenticates a CLI
/// against a new host — and both auth flows invalidate this cache explicitly.
const PROVIDER_CACHE_TTL_SECS: u64 = 900;

/// Bound on `gh auth status` / `glab auth status`. These are local config
/// reads, but `gh` can touch the network validating a token.
const AUTH_PROBE_TIMEOUT_SECS: u64 = 10;

/// Resolved host → provider. Keyed by lowercase hostname.
static PROVIDER_BY_HOST: LazyLock<TtlCache<String, GitProvider>> =
    LazyLock::new(|| TtlCache::new(Duration::from_secs(PROVIDER_CACHE_TTL_SECS)));

/// Which forge a remote points at.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GitProvider {
    GitHub,
    GitLab,
}

impl GitProvider {
    /// The CLI binary that drives this forge.
    pub fn cli(self) -> &'static str {
        match self {
            Self::GitHub => "gh",
            Self::GitLab => "glab",
        }
    }

    /// Product name, for user-facing copy.
    pub fn display_name(self) -> &'static str {
        match self {
            Self::GitHub => "GitHub",
            Self::GitLab => "GitLab",
        }
    }

    /// What this forge calls a proposed merge. GitHub says "pull request",
    /// GitLab says "merge request" — the UI follows this rather than calling
    /// everything a PR.
    pub fn change_request_name(self) -> &'static str {
        match self {
            Self::GitHub => "pull request",
            Self::GitLab => "merge request",
        }
    }

    /// The CLI subcommand for change requests: `gh pr …` vs `glab mr …`.
    pub fn change_request_subcommand(self) -> &'static str {
        match self {
            Self::GitHub => "pr",
            Self::GitLab => "mr",
        }
    }
}

/// A git remote URL broken into the parts we actually need.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteUrl {
    /// Lowercase hostname, without port or credentials.
    pub host: String,
    /// Repository path without a leading slash or a `.git` suffix. On GitLab
    /// this can be nested several levels deep (`group/subgroup/project`).
    pub path: String,
}

impl RemoteUrl {
    /// The last path segment — the repository's own name.
    pub fn repo_name(&self) -> &str {
        self.path.rsplit('/').next().unwrap_or(&self.path)
    }
}

/// Parse a git remote URL into host and repository path.
///
/// Handles every form git accepts: `https://`, `http://`, `ssh://`, `git://`,
/// and the scp-like `git@host:path`. Strips embedded credentials, ports and
/// the `.git` suffix.
///
/// This replaces a substring search for `"github.com/"`, which could not see a
/// self-hosted host at all and would happily match the literal anywhere in the
/// string.
pub fn parse_remote_url(url: &str) -> Option<RemoteUrl> {
    let url = url.trim();
    if url.is_empty() {
        return None;
    }

    // Split off the scheme, or recognise the scp-like `[user@]host:path` form.
    // The scp form is distinguished by a colon that comes before any slash —
    // in `git@host:owner/repo` the colon separates host from path, whereas in
    // `https://host:443/owner/repo` it introduces a port.
    let rest = if let Some(idx) = url.find("://") {
        &url[idx + 3..]
    } else {
        let colon = url.find(':')?;
        let slash = url.find('/').unwrap_or(usize::MAX);
        if colon > slash {
            return None; // no scheme and no scp-style separator
        }
        // Normalize the scp form to `host/path` so one code path handles both.
        return split_host_path(&format!("{}/{}", &url[..colon], &url[colon + 1..]));
    };

    split_host_path(rest)
}

/// Split an already-scheme-stripped `[user[:pass]@]host[:port]/path` string.
fn split_host_path(rest: &str) -> Option<RemoteUrl> {
    // Drop credentials. Use the LAST '@' before the path so a password
    // containing '@' can't truncate the host.
    let path_start = rest.find('/').unwrap_or(rest.len());
    let authority = &rest[..path_start];
    let path = rest.get(path_start..).unwrap_or("");

    let host_part = match authority.rfind('@') {
        Some(at) => &authority[at + 1..],
        None => authority,
    };

    // Drop the port. Guard against IPv6 literals, where colons are part of
    // the host and the port would follow a closing bracket.
    let host = if let Some(stripped) = host_part.strip_prefix('[') {
        match stripped.find(']') {
            Some(end) => &stripped[..end],
            None => return None,
        }
    } else {
        match host_part.find(':') {
            Some(colon) => &host_part[..colon],
            None => host_part,
        }
    };

    if host.is_empty() {
        return None;
    }

    let path = path
        .trim_start_matches('/')
        .trim_end_matches('/')
        .strip_suffix(".git")
        .map(str::to_string)
        .unwrap_or_else(|| {
            path.trim_start_matches('/')
                .trim_end_matches('/')
                .to_string()
        });

    if path.is_empty() {
        return None;
    }

    Some(RemoteUrl {
        host: host.to_ascii_lowercase(),
        path,
    })
}

/// Identify a provider from the hostname alone.
///
/// Returns `None` for a self-hosted host that names neither product — those
/// need [`detect_provider_for_host`], which asks the CLIs.
pub fn provider_from_host(host: &str) -> Option<GitProvider> {
    let host = host.to_ascii_lowercase();

    if host == "github.com" || host.ends_with(".github.com") {
        return Some(GitProvider::GitHub);
    }
    if host == "gitlab.com" || host.ends_with(".gitlab.com") {
        return Some(GitProvider::GitLab);
    }

    // Self-hosted instances very often put the product in the domain
    // (gitlab.acme.com, github.acme.com). Match whole labels only, so
    // "mygitlabclone.com" doesn't get claimed.
    let labels: Vec<&str> = host.split('.').collect();
    if labels.contains(&"gitlab") {
        return Some(GitProvider::GitLab);
    }
    if labels.contains(&"github") {
        return Some(GitProvider::GitHub);
    }

    None
}

/// Build a `Command` for a forge CLI, resolved and configured the same way
/// `get_gh_command` does it: extended PATH, workspace account env, and no
/// stdin — a GUI-spawned CLI has no tty, so a prompt must fail fast rather
/// than block until the network timeout kills it.
pub fn cli_command(provider: GitProvider) -> Command {
    let binary = provider.cli();
    let mut cmd = match find_executable(binary) {
        Some(path) => create_command(path),
        None => create_command(binary),
    };
    cmd.env("PATH", get_extended_path());
    cmd.envs(crate::commands::accounts::get_env_vars_for_active_account());
    cmd.stdin(std::process::Stdio::null());
    cmd
}

/// Hosts a forge CLI is configured for.
///
/// Used as evidence of *which product* runs at a host: a company host only
/// appears in `glab`'s config because someone pointed glab at their GitLab.
/// Configured — not necessarily signed in — is the right bar here, since the
/// remote's product doesn't change while a token is expired.
///
/// A missing CLI or a failed probe yields an empty list, so detection falls
/// through instead of failing.
async fn known_hosts(provider: GitProvider) -> Vec<String> {
    if find_executable(provider.cli()).is_none() {
        return Vec::new();
    }

    let mut cmd = cli_command(provider);
    match provider {
        // Without -a, glab reports only the default instance — which is
        // exactly the self-hosted case we need this probe for.
        GitProvider::GitLab => cmd.args(["auth", "status", "-a"]),
        GitProvider::GitHub => cmd.args(["auth", "status"]),
    };

    let label = format!("{} auth status", provider.cli());
    let output = match run_with_timeout(
        tokio::process::Command::from(cmd),
        &label,
        AUTH_PROBE_TIMEOUT_SECS,
    )
    .await
    {
        Ok(output) => output,
        Err(err) => {
            tracing::debug!("{label} failed while resolving provider: {err}");
            return Vec::new();
        }
    };

    // Both CLIs write the status report to stderr, but check stdout too —
    // `gh` has moved this between streams across versions.
    let combined = format!(
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    parse_known_hosts(&combined)
}

/// Pull hostnames out of a `gh`/`glab auth status` report.
///
/// Two shapes, because the CLIs don't agree and neither is stable across
/// versions: an un-indented hostname section header (both emit one per
/// configured host), and an indented "Logged in to <host> …" line. Reading
/// both means a phrasing change in either tool degrades to the other signal
/// rather than silently detecting nothing.
fn parse_known_hosts(text: &str) -> Vec<String> {
    let mut hosts = Vec::new();
    let mut push = |host: &str| {
        let host = host
            .trim()
            .trim_end_matches(&[',', ':', '.'][..])
            .to_ascii_lowercase();
        // A hostname here always has a dot; requiring one rejects prose lines
        // and bare labels that would otherwise look like headers.
        if host.contains('.') && !host.contains(' ') && !hosts.contains(&host) {
            hosts.push(host);
        }
    };

    for line in text.lines() {
        if let Some(idx) = line.to_ascii_lowercase().find("logged in to ") {
            if let Some(host) = line[idx + "logged in to ".len()..]
                .split_whitespace()
                .next()
            {
                push(host);
            }
            continue;
        }
        // Section header: un-indented, a bare hostname on its own line.
        let trimmed = line.trim_end();
        if !trimmed.is_empty()
            && !trimmed.starts_with(char::is_whitespace)
            && trimmed.split_whitespace().count() == 1
        {
            push(trimmed);
        }
    }
    hosts
}

/// Resolve which forge runs at `host`.
///
/// Hostname first (cheap, exact), then the authenticated-hosts probe for
/// self-hosted domains that name neither product. Results are cached because
/// the probe spawns subprocesses and this sits behind per-project status polls.
///
/// Falls back to GitHub when nothing resolves — the behaviour every project had
/// before GitLab support existed.
pub async fn detect_provider_for_host(host: &str) -> GitProvider {
    let host = host.to_ascii_lowercase();

    if let Some(provider) = provider_from_host(&host) {
        return provider;
    }
    if let Some(cached) = PROVIDER_BY_HOST.get(&host) {
        return cached;
    }

    // Ask GitLab first: a company running self-hosted GitLab on a neutral
    // domain is precisely the case the hostname check cannot see, whereas
    // self-hosted GitHub Enterprise on a neutral domain is rarer.
    let mut resolved = None;
    for provider in [GitProvider::GitLab, GitProvider::GitHub] {
        if known_hosts(provider).await.contains(&host) {
            resolved = Some(provider);
            break;
        }
    }

    let provider = resolved.unwrap_or(GitProvider::GitHub);
    // Only cache a positive identification. Caching the GitHub fallback would
    // pin the wrong answer for 15 minutes if the user is mid-way through
    // authenticating glab against their company host.
    if resolved.is_some() {
        PROVIDER_BY_HOST.insert(host, provider);
    }
    provider
}

/// Forget cached host→provider resolutions. Called after an auth flow, where a
/// newly authenticated host can change the answer.
pub fn invalidate_provider_cache() {
    PROVIDER_BY_HOST.clear();
}

/// The origin remote of an already-validated directory.
///
/// `None` covers "not a git repo" and "no origin remote" alike — both mean
/// there is no forge to talk to.
pub async fn remote_for_dir(dir: &std::path::Path) -> Result<Option<RemoteUrl>, CommandError> {
    if !dir.join(".git").exists() {
        return Ok(None);
    }

    let mut cmd = crate::utils::git_command_in(dir)?;
    cmd.args(["remote", "get-url", "origin"]);

    let output = run_with_timeout(
        tokio::process::Command::from(cmd),
        "git remote get-url origin",
        AUTH_PROBE_TIMEOUT_SECS,
    )
    .await?;

    if !output.status.success() {
        return Ok(None);
    }

    Ok(parse_remote_url(
        String::from_utf8_lossy(&output.stdout).trim(),
    ))
}

/// The remote of a project identified by a user-supplied path.
pub async fn project_remote(project_path: &str) -> Result<Option<RemoteUrl>, CommandError> {
    let project = validate_project_path(project_path)?;
    remote_for_dir(&project).await
}

/// The provider an already-validated directory's remote points at.
pub async fn provider_for_dir(dir: &std::path::Path) -> Result<Option<GitProvider>, CommandError> {
    match remote_for_dir(dir).await? {
        Some(remote) => Ok(Some(detect_provider_for_host(&remote.host).await)),
        None => Ok(None),
    }
}

/// The provider a project's remote points at, or `None` when it has no remote.
pub async fn project_provider(project_path: &str) -> Result<Option<GitProvider>, CommandError> {
    let project = validate_project_path(project_path)?;
    provider_for_dir(&project).await
}

#[cfg(test)]
mod tests {
    use super::*;

    mod parse_remote_url_tests {
        use super::*;

        #[test]
        fn https_url() {
            let r = parse_remote_url("https://github.com/owner/repo.git").unwrap();
            assert_eq!(r.host, "github.com");
            assert_eq!(r.path, "owner/repo");
            assert_eq!(r.repo_name(), "repo");
        }

        #[test]
        fn https_url_without_git_suffix() {
            let r = parse_remote_url("https://github.com/owner/repo").unwrap();
            assert_eq!(r.path, "owner/repo");
        }

        #[test]
        fn scp_style_ssh() {
            let r = parse_remote_url("git@github.com:owner/repo.git").unwrap();
            assert_eq!(r.host, "github.com");
            assert_eq!(r.path, "owner/repo");
        }

        #[test]
        fn ssh_scheme_with_port() {
            let r = parse_remote_url("ssh://git@gitlab.acme.com:2222/group/repo.git").unwrap();
            assert_eq!(r.host, "gitlab.acme.com");
            assert_eq!(r.path, "group/repo");
        }

        /// GitLab groups nest arbitrarily deep — the whole path is the project.
        #[test]
        fn nested_gitlab_groups_are_preserved() {
            let r = parse_remote_url("https://gitlab.com/group/subgroup/team/repo.git").unwrap();
            assert_eq!(r.path, "group/subgroup/team/repo");
            assert_eq!(r.repo_name(), "repo");
        }

        #[test]
        fn credentials_are_stripped() {
            let r = parse_remote_url("https://user:token@gitlab.acme.com/group/repo.git").unwrap();
            assert_eq!(r.host, "gitlab.acme.com");
            assert_eq!(r.path, "group/repo");
        }

        /// A token containing '@' must not truncate the host.
        #[test]
        fn password_containing_at_sign() {
            let r = parse_remote_url("https://user:p@ss@git.acme.com/group/repo.git").unwrap();
            assert_eq!(r.host, "git.acme.com");
        }

        #[test]
        fn host_is_lowercased() {
            let r = parse_remote_url("https://GitHub.COM/Owner/Repo.git").unwrap();
            assert_eq!(r.host, "github.com");
            // Only the host is case-normalized; repo paths are case-sensitive.
            assert_eq!(r.path, "Owner/Repo");
        }

        #[test]
        fn git_protocol() {
            let r = parse_remote_url("git://git.acme.com/group/repo.git").unwrap();
            assert_eq!(r.host, "git.acme.com");
            assert_eq!(r.path, "group/repo");
        }

        #[test]
        fn ipv6_literal_host() {
            let r = parse_remote_url("ssh://git@[2001:db8::1]:22/group/repo.git").unwrap();
            assert_eq!(r.host, "2001:db8::1");
            assert_eq!(r.path, "group/repo");
        }

        #[test]
        fn rejects_junk() {
            assert!(parse_remote_url("").is_none());
            assert!(parse_remote_url("   ").is_none());
            assert!(parse_remote_url("not a url").is_none());
            // Host but no repository path.
            assert!(parse_remote_url("https://github.com/").is_none());
        }

        /// The old substring check matched "github.com/" anywhere in the
        /// string; real parsing must key on the actual host.
        #[test]
        fn does_not_match_host_appearing_inside_the_path() {
            let r =
                parse_remote_url("https://git.acme.com/mirrors/github.com/owner/repo.git").unwrap();
            assert_eq!(r.host, "git.acme.com");
        }
    }

    mod provider_from_host_tests {
        use super::*;

        #[test]
        fn canonical_hosts() {
            assert_eq!(provider_from_host("github.com"), Some(GitProvider::GitHub));
            assert_eq!(provider_from_host("gitlab.com"), Some(GitProvider::GitLab));
        }

        #[test]
        fn subdomains_of_canonical_hosts() {
            assert_eq!(
                provider_from_host("salesforce.gitlab.com"),
                Some(GitProvider::GitLab)
            );
        }

        #[test]
        fn self_hosted_naming_the_product() {
            assert_eq!(
                provider_from_host("gitlab.acme.com"),
                Some(GitProvider::GitLab)
            );
            assert_eq!(
                provider_from_host("github.acme.com"),
                Some(GitProvider::GitHub)
            );
        }

        /// A neutral company domain is exactly the case that needs the CLI
        /// probe — claiming it from the hostname would be a guess.
        #[test]
        fn neutral_company_domain_is_unresolved() {
            assert_eq!(provider_from_host("git.acme.com"), None);
            assert_eq!(provider_from_host("code.acme.com"), None);
            assert_eq!(provider_from_host("source.acme.internal"), None);
        }

        /// Whole labels only — a domain that merely contains the product name
        /// as a substring is not that product.
        #[test]
        fn substring_matches_are_not_claimed() {
            assert_eq!(provider_from_host("mygitlabclone.com"), None);
            assert_eq!(provider_from_host("notgithub.example.com"), None);
        }

        #[test]
        fn is_case_insensitive() {
            assert_eq!(provider_from_host("GitLab.COM"), Some(GitProvider::GitLab));
        }
    }

    mod known_hosts_tests {
        use super::*;

        /// Verbatim `gh auth status` output from a signed-in machine.
        #[test]
        fn parses_real_gh_status_report() {
            let out = "github.com\n  \
                       ✓ Logged in to github.com account octocat (keyring)\n  \
                       - Active account: true\n  \
                       - Git operations protocol: https\n  \
                       - Token: gho_************************************\n  \
                       - Token scopes: 'gist', 'read:org', 'repo'";
            assert_eq!(parse_known_hosts(out), vec!["github.com"]);
        }

        /// Verbatim `glab auth status` output. Note it reports the host even
        /// while signed out — which is the point: the product running at a
        /// host doesn't change because a token expired.
        #[test]
        fn parses_real_glab_status_report_while_signed_out() {
            let out = "gitlab.acme.com\n  \
                       x gitlab.acme.com: API call failed: GET https://gitlab.acme.com/api/v4/user: 401\n  \
                       ✓ Git operations for gitlab.acme.com configured to use ssh protocol.\n  \
                       ✓ REST API Endpoint: https://gitlab.acme.com/api/v4/\n  \
                       ! No token found (checked config file, keyring, and environment variables).";
            assert_eq!(parse_known_hosts(out), vec!["gitlab.acme.com"]);
        }

        /// The company host is the one detection actually needs to find.
        #[test]
        fn finds_a_self_hosted_instance_alongside_the_default() {
            let out = "gitlab.com\n  ✓ Logged in to gitlab.com as a\n\
                       git.acme.com\n  ✓ Logged in to git.acme.com as b";
            assert_eq!(parse_known_hosts(out), vec!["gitlab.com", "git.acme.com"]);
        }

        #[test]
        fn deduplicates_hosts_seen_in_both_shapes() {
            let out = "gitlab.com\n  ✓ Logged in to gitlab.com as a";
            assert_eq!(parse_known_hosts(out), vec!["gitlab.com"]);
        }

        #[test]
        fn ignores_prose_and_empty_reports() {
            assert!(parse_known_hosts("You are not logged into any hosts.").is_empty());
            assert!(parse_known_hosts("").is_empty());
            // Indented detail lines are never headers.
            assert!(parse_known_hosts("  some.detail.line").is_empty());
            // A bare word without a dot is not a hostname.
            assert!(parse_known_hosts("localhost").is_empty());
        }
    }

    mod provider_naming_tests {
        use super::*;

        /// The UI reads these — GitLab users must not be shown "pull request".
        #[test]
        fn change_request_terminology_matches_the_forge() {
            assert_eq!(GitProvider::GitHub.change_request_name(), "pull request");
            assert_eq!(GitProvider::GitLab.change_request_name(), "merge request");
            assert_eq!(GitProvider::GitHub.change_request_subcommand(), "pr");
            assert_eq!(GitProvider::GitLab.change_request_subcommand(), "mr");
        }

        #[test]
        fn cli_binaries() {
            assert_eq!(GitProvider::GitHub.cli(), "gh");
            assert_eq!(GitProvider::GitLab.cli(), "glab");
        }

        /// The frontend switches on this, so the wire format must stay stable.
        #[test]
        fn serializes_lowercase() {
            assert_eq!(
                serde_json::to_string(&GitProvider::GitLab).unwrap(),
                "\"gitlab\""
            );
            assert_eq!(
                serde_json::to_string(&GitProvider::GitHub).unwrap(),
                "\"github\""
            );
        }
    }
}
