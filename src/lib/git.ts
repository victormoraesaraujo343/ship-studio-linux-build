/**
 * Git operations wrapper for Tauri backend.
 *
 * Provides TypeScript types and functions for interacting with
 * git status and change detection.
 *
 * @module lib/git
 */

import { invoke } from '@tauri-apps/api/core';

/** Status type for a changed file */
export type ChangeStatus = 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked';

/** A file with uncommitted changes */
export interface ChangedFile {
  /** Relative file path from project root */
  path: string;
  /** Change type */
  status: ChangeStatus;
}

/** Diff information for a single file */
export interface FileDiff {
  /** Relative file path from project root */
  filePath: string;
  /** True if this is a newly added/untracked file */
  isNewFile: boolean;
  /** True if the file was deleted */
  isDeleted: boolean;
  /** True if this is a binary file */
  isBinary: boolean;
  /** The raw diff content (or full file content for new files) */
  content: string;
  /** Number of lines added */
  additions: number;
  /** Number of lines deleted */
  deletions: number;
}

/**
 * Gets list of files with uncommitted changes in a project.
 *
 * Uses `git status --porcelain -uno` to get changed tracked files.
 *
 * @param projectPath - Absolute path to the project
 * @returns Array of changed files with their status
 */
export async function getChangedFiles(projectPath: string): Promise<ChangedFile[]> {
  return invoke<ChangedFile[]>('get_changed_files', { projectPath });
}

/**
 * Gets the diff for a single uncommitted file.
 *
 * @param projectPath - Absolute path to the project
 * @param filePath - Relative path to the file from project root
 * @returns Diff information including raw diff content
 */
export async function getFileDiff(projectPath: string, filePath: string): Promise<FileDiff> {
  return invoke<FileDiff>('get_file_diff', { projectPath, filePath });
}

/**
 * Pull latest changes from remote.
 *
 * @param projectPath - Absolute path to the project
 */
export async function gitPull(projectPath: string): Promise<void> {
  return invoke<void>('git_pull', { projectPath });
}

/**
 * Stage all changes and create a commit.
 *
 * @param projectPath - Absolute path to the project
 * @param message - Commit message
 * @returns true if a commit was made, false if nothing to commit
 */
export async function commitChanges(projectPath: string, message: string): Promise<boolean> {
  return invoke<boolean>('commit_changes', { projectPath, message });
}

/**
 * Stash all current changes (tracked + untracked) so the working tree is clean.
 * A plain `git stash` set aside for manual restore (`git stash pop`) — not the
 * metadata-tracked auto-stash that branch switching uses.
 *
 * @param projectPath - Absolute path to the project
 * @returns true if something was stashed, false if the tree was already clean
 */
export async function stashChanges(projectPath: string): Promise<boolean> {
  return invoke<boolean>('stash_changes', { projectPath });
}

// ============ Remotes ============

/**
 * Remote names configured for this project, in git's own order.
 *
 * Empty when the repo has no remotes or the path isn't a repository — both mean
 * "nothing to choose from", so callers should hide the picker rather than show
 * an empty one.
 */
export async function listProjectRemotes(projectPath: string): Promise<string[]> {
  return invoke<string[]>('list_project_remotes', { projectPath });
}

/**
 * The remote this project's pushes and fetches actually target.
 *
 * Already resolved through the backend's fallbacks, so this is the name git
 * will be given — not a stored preference that may point at a remote the repo
 * no longer has.
 */
export async function getProjectRemote(projectPath: string): Promise<string> {
  return invoke<string>('get_project_remote', { projectPath });
}

/**
 * Choose which remote this project uses. Rejected by the backend if the name
 * isn't one of the repo's remotes.
 */
export async function setProjectRemote(projectPath: string, remote: string): Promise<void> {
  return invoke<void>('set_project_remote', { projectPath, remote });
}
