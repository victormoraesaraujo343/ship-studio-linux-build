//! # Git Remotes
//!
//! Which remote a project pushes to and fetches from.
//!
//! Every git operation in the app used to name `origin` literally. That holds
//! for the common case and breaks for a real one: a project mirrored to a
//! second forge, or a store whose base repo and demo repo are two remotes on
//! the same host. Such a project could only ever reach `origin` — the other
//! remote was invisible, with no way to select it.
//!
//! The choice is stored per project in `.shipstudio/project.json` and resolved
//! through [`active_remote`], which is deliberately forgiving: a stored name
//! that no longer exists (renamed, removed, or a fresh clone that never had it)
//! falls back rather than failing every git call with a dangling reference.

use crate::errors::CommandError;
use crate::types::ProjectMetadata;
use crate::utils::{create_command, validate_project_path};
use std::path::Path;

/// The remote used when a project has expressed no preference.
pub const DEFAULT_REMOTE: &str = "origin";

/// Remote names configured for the repository at `project`, in git's order.
///
/// An empty vector means no remotes (a repo that was never pushed) or that the
/// path isn't a git repository at all — both are "nothing to choose from", and
/// neither is an error worth surfacing.
pub fn list_remotes(project: &Path) -> Vec<String> {
    let mut cmd = create_command("git");
    cmd.args(["remote"]);
    cmd.current_dir(project);
    match cmd.output() {
        Ok(output) if output.status.success() => String::from_utf8_lossy(&output.stdout)
            .lines()
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .map(String::from)
            .collect(),
        _ => Vec::new(),
    }
}

/// The remote this project's git operations should target.
///
/// Resolution order:
/// 1. The stored choice, when it is still a real remote.
/// 2. `origin`, when it exists — what every project used before this setting.
/// 3. The only remote, when the repo has exactly one under a different name
///    (common after `git clone -o upstream`, and the unambiguous right answer).
/// 4. `origin` as a last resort, so callers always have a name to pass to git
///    and the resulting error is git's own, not a panic here.
pub fn active_remote(project: &Path) -> String {
    let remotes = list_remotes(project);
    let stored = read_stored_remote(project);

    if let Some(name) = stored {
        if remotes.iter().any(|r| *r == name) {
            return name;
        }
    }
    if remotes.iter().any(|r| r == DEFAULT_REMOTE) {
        return DEFAULT_REMOTE.to_string();
    }
    if remotes.len() == 1 {
        return remotes[0].clone();
    }
    DEFAULT_REMOTE.to_string()
}

/// The remote name recorded in `.shipstudio/project.json`, if any.
///
/// Reads the file directly rather than going through `read_project_metadata`:
/// that command migrates and rewrites the file on read, which is far too much
/// side effect for something called on the path of every git operation.
fn read_stored_remote(project: &Path) -> Option<String> {
    let path = project.join(".shipstudio").join("project.json");
    let contents = std::fs::read_to_string(path).ok()?;
    let metadata: ProjectMetadata = serde_json::from_str(&contents).ok()?;
    metadata.git_remote.filter(|name| !name.trim().is_empty())
}

// ============ Tauri Commands ============

/// Remote names available for this project, for the picker in the UI.
#[tauri::command]
#[tracing::instrument(fields(project = %project_path))]
pub async fn list_project_remotes(project_path: String) -> Result<Vec<String>, CommandError> {
    let project = validate_project_path(&project_path)?;
    Ok(list_remotes(&project))
}

/// The remote this project currently targets, already resolved through the
/// fallbacks — so the UI shows the name git will actually be given, not a
/// stored value that may no longer exist.
#[tauri::command]
#[tracing::instrument(fields(project = %project_path))]
pub async fn get_project_remote(project_path: String) -> Result<String, CommandError> {
    let project = validate_project_path(&project_path)?;
    Ok(active_remote(&project))
}

/// Record which remote this project should use.
///
/// Refuses a name the repository doesn't have: the alternative is a setting
/// that silently does nothing while every push reports a dangling remote.
#[tauri::command]
#[tracing::instrument(fields(project = %project_path, remote = %remote))]
pub async fn set_project_remote(project_path: String, remote: String) -> Result<(), CommandError> {
    let project = validate_project_path(&project_path)?;
    let remotes = list_remotes(&project);
    if !remotes.iter().any(|r| *r == remote) {
        return Err(CommandError::Validation {
            field: "remote".into(),
            reason: format!(
                "'{remote}' is not a remote of this project. Available: {}",
                if remotes.is_empty() {
                    "none".to_string()
                } else {
                    remotes.join(", ")
                }
            ),
        });
    }

    let metadata_path = project.join(".shipstudio").join("project.json");
    let mut metadata: ProjectMetadata = std::fs::read_to_string(&metadata_path)
        .ok()
        .and_then(|c| serde_json::from_str(&c).ok())
        .unwrap_or_default();
    metadata.git_remote = Some(remote);

    crate::commands::projects::save_project_metadata(&project, &metadata)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repo_with_remotes(names: &[&str]) -> tempfile::TempDir {
        let tmp = tempfile::TempDir::new().unwrap();
        assert!(std::process::Command::new("git")
            .args(["init", "-q"])
            .current_dir(tmp.path())
            .status()
            .expect("git init")
            .success());
        for name in names {
            assert!(std::process::Command::new("git")
                .args([
                    "remote",
                    "add",
                    name,
                    &format!("https://example.com/{name}.git")
                ])
                .current_dir(tmp.path())
                .status()
                .expect("git remote add")
                .success());
        }
        tmp
    }

    fn store_remote(dir: &Path, name: &str) {
        let ship = dir.join(".shipstudio");
        std::fs::create_dir_all(&ship).unwrap();
        let mut metadata = ProjectMetadata::default();
        metadata.git_remote = Some(name.to_string());
        std::fs::write(
            ship.join("project.json"),
            serde_json::to_string(&metadata).unwrap(),
        )
        .unwrap();
    }

    #[test]
    fn defaults_to_origin_when_nothing_is_stored() {
        let repo = repo_with_remotes(&["origin", "demo"]);
        assert_eq!(active_remote(repo.path()), "origin");
    }

    #[test]
    fn honors_a_stored_choice() {
        let repo = repo_with_remotes(&["origin", "demo"]);
        store_remote(repo.path(), "demo");
        assert_eq!(active_remote(repo.path()), "demo");
    }

    // The setting outliving the remote is the case that would otherwise wire
    // every git call to a name the repo doesn't have.
    #[test]
    fn falls_back_when_the_stored_remote_no_longer_exists() {
        let repo = repo_with_remotes(&["origin"]);
        store_remote(repo.path(), "demo");
        assert_eq!(active_remote(repo.path()), "origin");
    }

    // `git clone -o upstream` leaves a repo with one remote that isn't origin.
    // Picking it is unambiguous; defaulting to a nonexistent `origin` is not.
    #[test]
    fn uses_the_only_remote_when_it_is_not_named_origin() {
        let repo = repo_with_remotes(&["upstream"]);
        assert_eq!(active_remote(repo.path()), "upstream");
    }

    #[test]
    fn falls_back_to_origin_with_no_remotes_at_all() {
        let repo = repo_with_remotes(&[]);
        assert_eq!(active_remote(repo.path()), "origin");
        assert!(list_remotes(repo.path()).is_empty());
    }

    // Ambiguous: several remotes, none named origin, nothing stored. Returning
    // origin makes git produce its own clear error instead of this picking one
    // arbitrarily and pushing somewhere the user never chose.
    #[test]
    fn stays_on_origin_when_several_remotes_and_none_is_origin() {
        let repo = repo_with_remotes(&["alpha", "beta"]);
        assert_eq!(active_remote(repo.path()), "origin");
    }
}
