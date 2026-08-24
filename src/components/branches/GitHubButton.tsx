/**
 * GitHubButton component for GitHub repository management.
 *
 * Provides a dropdown button that allows users to:
 * - Create a new GitHub repository for the project
 * - Push changes to an existing repository
 * - View repository status (remote URL, pending changes)
 * - Auto-connect to Vercel after repo creation
 *
 * Uses the GitHub CLI (gh) for all operations via Tauri backend.
 *
 * @module components/GitHubButton
 */

import { useState, useEffect, useRef } from 'react';
import { GitHubState } from '../../hooks/useIntegrationStatus';
import {
  ProjectGitHubStatus,
  pushToGitHub,
  getGitHubOrgs,
  getGitHubUsername,
} from '../../lib/github';
import { openUrl } from '@tauri-apps/plugin-opener';
import { Button } from '../primitives/Button';
import { ModalFrame } from '../primitives/ModalFrame';
import { useOptionalToast } from '../../contexts/ToastContext';
import {
  asCommandError,
  formatCommandError,
  humanizeGitError,
  isRecognizedGitFailure,
} from '../../lib/errors';
import { logger } from '../../lib/logger';
import { providerTerms } from '../../lib/gitProvider';
import { ForgeIcon } from '../icons/brand';

/** Props for the GitHubButton component */
interface GitHubButtonProps {
  /** Global GitHub authentication state */
  githubState: GitHubState;
  /** Current project's GitHub status (remote, branch, pending changes) */
  projectStatus: ProjectGitHubStatus | null;
  /** Absolute path to the project directory */
  projectPath: string;
  /** Project name (used as default repo name) */
  projectName: string;
  /** Callback to refresh project status after changes */
  onStatusChange: () => Promise<void> | void;
  /** Callback to initiate GitHub CLI authentication */
  onGitHubConnect: () => void;
  /** Optional callback when modal is closed */
  onModalClose?: () => void;
}

export function GitHubButton({
  githubState,
  projectStatus,
  projectPath,
  projectName,
  onStatusChange,
  onGitHubConnect,
  onModalClose,
}: GitHubButtonProps) {
  const { showToast } = useOptionalToast();
  // Every label and mark below follows the forge this project's remote points
  // at. Unknown provider falls back to GitHub's words, matching the backend.
  const provider = projectStatus?.provider ?? null;
  const terms = providerTerms(provider);
  const onToast = (message: string, type?: 'success' | 'error' | 'info') =>
    showToast(message, type);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [repoName, setRepoName] = useState(projectName);
  const [isPrivate, setIsPrivate] = useState(true);
  const [isLoading, setIsLoading] = useState(false);
  const [isCreatingRepo, setIsCreatingRepo] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [orgs, setOrgs] = useState<string[]>([]);
  const [selectedOwner, setSelectedOwner] = useState<string | null>(null);
  // GitHub login for *this project's* workspace, which can differ from the
  // globally-active workspace login carried by `githubState.username`. The
  // repo is created under the project's workspace (push_to_github is
  // project-scoped), so the owner we show must come from the same place — else
  // the dropdown defaults to the active workspace's account (the wrong-owner bug).
  const [projectUsername, setProjectUsername] = useState<string | null>(null);
  const createRepoTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { cliStatus, username: activeUsername } = githubState;
  // Prefer the project-scoped login; fall back to the active one until it loads.
  const username = projectUsername ?? activeUsername;

  const closeCreateModal = () => {
    setShowCreateModal(false);
    onModalClose?.();
  };

  // Clear fallback timeout on unmount
  useEffect(() => {
    return () => {
      if (createRepoTimeoutRef.current) {
        clearTimeout(createRepoTimeoutRef.current);
      }
    };
  }, []);

  // Fetch the owner (this project's workspace login) and its orgs when the
  // modal opens. Both are scoped to `projectPath` so they match the account the
  // repo will be created under, not whichever workspace is globally active.
  useEffect(() => {
    if (!showCreateModal || !cliStatus.authenticated) return;
    let cancelled = false;
    void getGitHubUsername(projectPath)
      .then((name) => {
        if (cancelled) return;
        setProjectUsername(name);
        // Default the dropdown to the project's account unless the user already
        // picked an owner this session.
        setSelectedOwner((prev) => prev ?? name);
      })
      .catch(() => {
        /* fall back to the active-workspace username already in state */
      });
    void getGitHubOrgs(projectPath)
      .then((list) => {
        if (!cancelled) setOrgs(list);
      })
      .catch(() => {
        if (!cancelled) setOrgs([]);
      });
    return () => {
      cancelled = true;
    };
  }, [showCreateModal, cliStatus.authenticated, projectPath]);

  // Clear isCreatingRepo when status becomes connected
  // This synchronizes local loading state with external status - a valid pattern
  useEffect(() => {
    if (projectStatus?.status === 'connected') {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setIsCreatingRepo(false);
    }
  }, [projectStatus?.status]);

  // If gh CLI not installed, show install prompt
  if (!cliStatus.installed) {
    return (
      <button
        className="github-button github-install"
        onClick={() =>
          void openUrl(
            provider === 'gitlab'
              ? 'https://gitlab.com/gitlab-org/cli#installation'
              : 'https://cli.github.com/'
          )
        }
        title={`Install ${terms.name} CLI`}
      >
        <ForgeIcon provider={provider} size={12} />
        Install CLI
      </button>
    );
  }

  // If not authenticated, show connect button
  if (!cliStatus.authenticated) {
    return (
      <button
        className="github-button github-connect"
        onClick={onGitHubConnect}
        title={`Connect your ${terms.name} account`}
      >
        <ForgeIcon provider={provider} size={12} />
        Connect
      </button>
    );
  }

  // If project has a GitHub repo, show icon link to repo
  if (projectStatus?.status === 'connected' && projectStatus?.github_url) {
    return (
      <button
        className="github-button github-link"
        onClick={() => void openUrl(projectStatus.github_url!)}
        title={`Open on ${terms.name}`}
      >
        <ForgeIcon provider={provider} size={12} />
      </button>
    );
  }

  // Show loading state while creating repo (even after modal closes)
  if (isCreatingRepo) {
    return (
      <button className="github-button github-creating" disabled title="Setting up...">
        <ForgeIcon provider={provider} size={12} />
        Setting up...
      </button>
    );
  }

  // Still checking GitHub status - show loading state
  if (projectStatus === null) {
    return (
      <button
        className="github-button github-checking"
        disabled
        title={`Checking ${terms.name} status...`}
      >
        <ForgeIcon provider={provider} size={12} />
        Checking...
      </button>
    );
  }

  // Project not connected - show Create Repo button
  return (
    <>
      <button
        className="github-button github-create"
        onClick={() => {
          setRepoName(projectName);
          // Clear so the modal's effect can default the owner to this project's
          // workspace login once it resolves (see the fetch effect above).
          setSelectedOwner(null);
          setShowCreateModal(true);
          setError(null);
        }}
        title={`Create ${terms.name} repository`}
      >
        <ForgeIcon provider={provider} size={12} />
        <span style={{ whiteSpace: 'nowrap' }}>Create Repo</span>
      </button>

      {/* Create Repo Modal */}
      <ModalFrame
        isOpen={showCreateModal}
        onClose={closeCreateModal}
        title={`Create ${terms.name} Repository`}
        className="github-modal"
        dismissable={!isLoading}
      >
        <p>Create a new {terms.name} repository for this project.</p>

        <div className="github-form">
          <label>
            Owner
            <select
              className="owner-select"
              value={selectedOwner || username || ''}
              onChange={(e) => setSelectedOwner(e.target.value)}
            >
              {username && <option value={username}>{username}</option>}
              {orgs.map((org) => (
                <option key={org} value={org}>
                  {org}
                </option>
              ))}
            </select>
          </label>

          <label>
            Repository name
            <div className="repo-name-input">
              <span className="repo-prefix">{selectedOwner || username}/</span>
              <input
                type="text"
                value={repoName}
                onChange={(e) => setRepoName(e.target.value.replace(/[^a-zA-Z0-9-_]/g, '-'))}
                placeholder="my-project"
                autoFocus
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
              />
            </div>
          </label>

          <label className="visibility-option">
            <input
              type="radio"
              name="visibility"
              checked={isPrivate}
              onChange={() => setIsPrivate(true)}
            />
            <div>
              <strong>Private</strong>
              <span>Only you can see this repository</span>
            </div>
          </label>

          <label className="visibility-option">
            <input
              type="radio"
              name="visibility"
              checked={!isPrivate}
              onChange={() => setIsPrivate(false)}
            />
            <div>
              <strong>Public</strong>
              <span>Anyone can see this repository</span>
            </div>
          </label>

          {error && <p className="github-error">{error}</p>}
        </div>

        <div className="modal-actions">
          <Button variant="secondary" onClick={closeCreateModal} disabled={isLoading}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              if (!repoName.trim()) return;

              const handleCreate = async () => {
                setIsLoading(true);
                setIsCreatingRepo(true);
                setError(null);
                try {
                  const owner = selectedOwner || username;
                  const fullRepoName = `${owner}/${repoName}`;
                  await pushToGitHub({
                    projectPath,
                    repoName: fullRepoName,
                    isPrivate,
                  });

                  // Close modal immediately after GitHub repo is created
                  setShowCreateModal(false);
                  setIsLoading(false);
                  onModalClose?.();

                  // Refresh status - this will clear isCreatingRepo when status updates
                  await onStatusChange();
                  onToast?.('Repository created!', 'success');

                  // Fallback: clear isCreatingRepo after a delay if status doesn't update
                  createRepoTimeoutRef.current = setTimeout(() => {
                    setIsCreatingRepo(false);
                  }, 3000);
                } catch (e) {
                  // Include the humanized cause in the toast: a static string
                  // collapses every failure mode (auth, name collision,
                  // network…) into one undiagnosable telemetry fingerprint
                  // (issue #511).
                  const detail = humanizeGitError(e);
                  setError(detail);
                  if (isRecognizedGitFailure(e)) {
                    // A known, by-design refusal (name collision, auth,
                    // network, …) — the backend already classified these
                    // Expected and skipped its report; an unconditional
                    // 'error' toast would re-report the same incident through
                    // the toast telemetry pipeline (issues #666/#667, same
                    // pattern as SubmitReviewModal / issue #538).
                    logger.warn('[GitHubButton] Repo creation refused for a recognized reason', {
                      error: formatCommandError(asCommandError(e)),
                    });
                    onToast?.(`Failed to create repository: ${detail}`, 'info');
                  } else {
                    onToast?.(`Failed to create repository: ${detail}`, 'error');
                  }
                  setIsLoading(false);
                  setIsCreatingRepo(false);
                }
              };

              void handleCreate();
            }}
            disabled={isLoading || !repoName.trim()}
          >
            {isLoading ? 'Creating...' : 'Create Repository'}
          </Button>
        </div>
      </ModalFrame>
    </>
  );
}
