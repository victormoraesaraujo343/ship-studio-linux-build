/**
 * Submit for Review modal.
 *
 * Creates a change request from the current branch — a pull request on GitHub,
 * a merge request on GitLab; the flow is the same and only the wording differs
 * (see `providerTerms`).
 * Supports AI-generated PR titles and descriptions via Claude CLI.
 *
 * @module components/SubmitReviewModal
 */

import { useState, useEffect } from 'react';
import { openUrl } from '@tauri-apps/plugin-opener';
import {
  createPullRequest,
  mergePullRequest,
  switchBranch,
  deleteBranch,
  getDefaultBaseBranch,
} from '../../lib/branches';
import { generatePRDescription } from '../../lib/ai';
import { commitChanges } from '../../lib/git';
import { trackEvent, trackError } from '../../lib/analytics';
import {
  asCommandError,
  formatCommandError,
  humanizeGitError,
  isMergeConflictError,
  isRecognizedGitFailure,
} from '../../lib/errors';
import { logger } from '../../lib/logger';
import { providerTerms, type GitProvider, type ProviderTerms } from '../../lib/gitProvider';
import { ModalFrame } from '../primitives/ModalFrame';
import { Button } from '../primitives/Button';
import { Spinner } from '../primitives/Spinner';
import { ForgeIcon, WarningIcon } from '../icons';
import { useOptionalToast } from '../../contexts/ToastContext';

interface SubmitReviewModalProps {
  /** Project path for PR operations */
  projectPath: string;
  /** Branch to create PR from */
  branchName: string;
  /** Available base branches */
  baseBranches: string[];
  /** Whether the AI agent CLI is available for AI generation */
  aiAvailable: boolean;
  /** Callback when PR is created */
  onSuccess: (prUrl: string) => void;
  /** Callback when the local branch was switched (e.g. after merge cleanup) */
  onBranchSwitch?: (branchName: string) => void;
  /** Paste a prompt into the active agent terminal (e.g. to ask Claude to fix conflicts) */
  onSendToAgent?: (prompt: string) => void;
  /** Open the in-app conflict resolution UI for a head/base branch pair */
  onResolveConflicts?: (headBranch: string, baseBranch: string) => void;
  /** Callback to close modal */
  onClose: () => void;
  /**
   * Forge the project's remote points at. Only affects wording — GitLab calls
   * these merge requests. Omitted/null falls back to GitHub's vocabulary.
   */
  provider?: GitProvider | null;
}

type Phase = 'edit' | 'created' | 'conflict' | 'merged';

/**
 * The request's number, read back from the URL the forge returned.
 *
 * Each forge shapes it differently — GitHub `/pull/<n>`, GitLab
 * `/-/merge_requests/<n>` — and the number is what the follow-up merge call
 * needs. Recognizing only GitHub's meant a GitLab user got their merge request
 * created and then the flow silently gave up on offering to merge it.
 */
function parsePrNumberFromUrl(url: string): number | null {
  const match = url.match(/\/(?:pull|merge_requests)\/(\d+)/);
  return match ? Number(match[1]) : null;
}

/** Git branch names are constrained to a safe charset, but be defensive — the
 *  branch is interpolated into a prompt sent to an LLM agent so we don't want
 *  shell-style chars sneaking through and confusing the model. */
function sanitizeBranchName(name: string): string {
  return name.replace(/[`"'\\\n\r]/g, '');
}

/** The forge's own words go into the prompt too: the agent decides which CLI to
 *  reach for from what the user says, and "merge request" points it at GitLab. */
function buildConflictPrompt(headBranch: string, baseBranch: string, terms: ProviderTerms): string {
  const head = sanitizeBranchName(headBranch);
  const base = sanitizeBranchName(baseBranch);
  return `My ${terms.changeRequest} from "${head}" into "${base}" has merge conflicts. Please help me:
1. Check out "${head}" and pull the latest "${base}"
2. Identify which files have conflicts
3. Resolve the conflicts, prioritising the changes from "${head}" unless context suggests otherwise
4. Commit the resolution and push so the ${terms.abbrev} can be merged`;
}

export function SubmitReviewModal({
  projectPath,
  branchName,
  baseBranches,
  aiAvailable,
  onSuccess,
  onBranchSwitch,
  onSendToAgent,
  onResolveConflicts,
  onClose,
  provider,
}: SubmitReviewModalProps) {
  const terms = providerTerms(provider);
  /** Submit button's resting label, and what the progress label resets to. */
  const createLabel = `Create ${terms.changeRequestTitle}`;
  const { showToast } = useOptionalToast();
  const onToast = (message: string, type?: 'success' | 'error' | 'info') =>
    showToast(message, type);
  const [baseBranch, setBaseBranch] = useState(baseBranches[0] || 'main');

  // Default the merge target to the project's configured default base branch
  // (e.g. "develop") when it's an available target, so teams merging into
  // develop rather than main don't have to re-pick every time.
  useEffect(() => {
    void getDefaultBaseBranch(projectPath)
      .then((configured) => {
        if (configured && baseBranches.includes(configured)) {
          setBaseBranch(configured);
        }
      })
      .catch(() => {}); // Ignore; falls back to baseBranches[0]
    // Only re-run when the target list identity changes for this project.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectPath, baseBranches.join(',')]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  // Progress label shown on the submit button as it works through its steps.
  const [progressLabel, setProgressLabel] = useState(createLabel);
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>('edit');
  const [createdPr, setCreatedPr] = useState<{ url: string; number: number } | null>(null);
  const [isMerging, setIsMerging] = useState(false);
  const [isCleaningUp, setIsCleaningUp] = useState(false);

  // Track modal open
  useEffect(() => {
    // Branch name omitted on purpose — see PublishBranchDropdown for rationale.
    void trackEvent('submit_review_opened', { $screen_name: 'Workspace' });
  }, [branchName]);

  const handleSubmit = async () => {
    setIsSubmitting(true);
    setError(null);

    let usedAi = false;
    let prTitle = formatBranchAsTitle(branchName);
    let prDescription = '';

    try {
      // 1. Commit any pending changes so they land in the PR (a clean tree
      //    just returns false). A FAILED commit must stop the flow: continuing
      //    would open a PR that silently lacks the user's latest changes while
      //    the UI reports success — the worst failure mode for this audience.
      setProgressLabel('Saving your changes...');
      try {
        await commitChanges(projectPath, 'Updates from Ship Studio');
      } catch (e) {
        trackError('submit_review_autocommit', e, 'Submit Review');
        setError(humanizeGitError(e, { branch: branchName, base: baseBranch }));
        onToast?.(
          `Couldn't save your latest changes — the ${terms.changeRequest} wasn't created`,
          'error'
        );
        return;
      }

      // 2. Read the diff and write a title + summary. Falls back to a
      //    branch-name title if AI isn't available or fails; never blocks the PR.
      if (aiAvailable) {
        setProgressLabel('Writing a summary of your changes...');
        try {
          const result = await generatePRDescription(projectPath, baseBranch);
          if (result.title?.trim()) prTitle = result.title.trim();
          prDescription = result.description ?? '';
          usedAi = true;
        } catch (e) {
          logger.warn('[SubmitReview] AI summary failed; using branch-name title', { error: e });
        }
      }

      // 3. Open the change request.
      setProgressLabel(`Opening ${terms.changeRequest}...`);
      const prUrl = await createPullRequest(
        projectPath,
        prTitle,
        prDescription || null,
        baseBranch
      );
      void trackEvent('pr_created', {
        base_branch: baseBranch,
        used_ai: usedAi,
        title_length: prTitle.length,
        description_length: prDescription.length,
        $screen_name: 'Workspace',
      });
      onSuccess(prUrl);
      const prNumber = parsePrNumberFromUrl(prUrl);
      if (prNumber !== null) {
        setCreatedPr({ url: prUrl, number: prNumber });
        setPhase('created');
      } else {
        logger.warn(
          '[SubmitReview] Created request URL carried no recognizable number; skipping merge prompt',
          {
            url: prUrl,
          }
        );
        onToast?.(
          `${terms.changeRequestSentence} created (could not parse number for merge prompt)`,
          'success'
        );
        onClose();
      }
    } catch (e) {
      trackError('pr_create', e, 'Submit Review');
      const humanized = humanizeGitError(e, { branch: branchName, base: baseBranch });
      setError(humanized);
      if (isRecognizedGitFailure(e)) {
        // A known, by-design refusal (nothing to review, PR already exists,
        // auth, network, …) — the backend already classified these Expected
        // and skipped its report; an unconditional 'error' toast here would
        // re-report the same incident through the toast telemetry pipeline
        // (issue #538). Surface the humanized cause as info + warn log.
        logger.warn('[SubmitReview] PR creation refused for a recognized reason', {
          error: formatCommandError(asCommandError(e)),
        });
        onToast?.(humanized, 'info');
      } else {
        onToast?.(`Failed to create ${terms.changeRequest}`, 'error');
      }
    } finally {
      setIsSubmitting(false);
      setProgressLabel(createLabel);
    }
  };

  const handleMerge = async () => {
    if (!createdPr) return;
    setIsMerging(true);
    setError(null);
    try {
      await mergePullRequest(projectPath, createdPr.number);
      void trackEvent('pr_merged', {
        head_ref: branchName,
        base_ref: baseBranch,
        from_submit_modal: true,
        $screen_name: 'Submit Review',
      });
      onToast?.(`${terms.changeRequestSentence} merged`, 'success');
      setPhase('merged');
    } catch (e) {
      trackError('pr_merge', e, 'Submit Review');
      if (isMergeConflictError(e)) {
        setPhase('conflict');
        setError(null);
      } else {
        const message = humanizeGitError(e, { branch: branchName, base: baseBranch });
        setError(message);
        onToast?.(message, 'error');
      }
    } finally {
      setIsMerging(false);
    }
  };

  const handleAskAgentToResolve = () => {
    if (!onSendToAgent) return;
    onSendToAgent(buildConflictPrompt(branchName, baseBranch, terms));
    void trackEvent('pr_conflict_sent_to_agent', {
      head_ref: branchName,
      base_ref: baseBranch,
      $screen_name: 'Submit Review',
    });
    onToast?.('Asked the agent to resolve conflicts', 'success');
    onClose();
  };

  const handleResolveMyself = () => {
    if (!onResolveConflicts) return;
    onResolveConflicts(branchName, baseBranch);
    void trackEvent('pr_conflict_resolve_in_app', {
      head_ref: branchName,
      base_ref: baseBranch,
      $screen_name: 'Submit Review',
    });
    onClose();
  };

  const handlePostMergeCleanup = async () => {
    setIsCleaningUp(true);
    setError(null);
    try {
      const result = await switchBranch(projectPath, baseBranch, true);
      if (!result.success) {
        const msg = result.error || 'Failed to switch branch';
        setError(msg);
        onToast?.(msg, 'error');
        return;
      }
      onBranchSwitch?.(baseBranch);
      await deleteBranch(projectPath, branchName, true);
      void trackEvent('post_merge_cleanup', {
        deleted_branch: branchName,
        $screen_name: 'Submit Review',
      });
      onToast?.(`Switched to ${baseBranch} and deleted ${branchName}`, 'success');
      onClose();
    } catch (e) {
      const message = formatCommandError(asCommandError(e));
      trackError('pr_post_merge_cleanup', e, 'Submit Review');
      setError(message);
      onToast?.(`Cleanup failed: ${message}`, 'error');
    } finally {
      setIsCleaningUp(false);
    }
  };

  const isBusy = isSubmitting || isMerging || isCleaningUp;

  if (phase === 'created' && createdPr) {
    return (
      <ModalFrame
        isOpen
        onClose={onClose}
        dismissable={!isBusy}
        title={`${terms.changeRequestSentence} created`}
        className="post-merge-content"
      >
        <div className="post-merge-body">
          <p>
            Your {terms.changeRequest} was created. Want to merge <strong>{branchName}</strong> into{' '}
            <strong>{baseBranch}</strong> now?
          </p>
          <button
            type="button"
            className="post-merge-link"
            onClick={() => void openUrl(createdPr.url)}
          >
            <ForgeIcon provider={provider} size={14} />
            View on {terms.name}
          </button>
          {error && <div className="submit-review-error">{error}</div>}
        </div>
        <div className="post-merge-footer">
          <Button variant="secondary" onClick={onClose} disabled={isBusy}>
            Done
          </Button>
          <Button variant="primary" onClick={() => void handleMerge()} disabled={isBusy}>
            {isMerging ? 'Merging...' : `Merge into ${baseBranch}`}
          </Button>
        </div>
      </ModalFrame>
    );
  }

  if (phase === 'conflict') {
    const canAskAgent = !!onSendToAgent && aiAvailable;
    const canResolveInApp = !!onResolveConflicts;
    return (
      <ModalFrame
        isOpen
        onClose={onClose}
        dismissable={!isBusy}
        title={
          <div className="submit-review-title-row">
            <WarningIcon size={16} />
            <span>Merge conflicts</span>
          </div>
        }
        className="post-merge-content"
      >
        <div className="post-merge-body">
          <p>
            <strong>{branchName}</strong> can't be cleanly merged into <strong>{baseBranch}</strong>
            . The base branch has changes that conflict with yours.
          </p>
          <p className="submit-review-conflict-question">
            {canAskAgent
              ? 'Want the agent to fix it, or would you rather resolve it yourself?'
              : 'You can resolve the conflicts in the visual editor.'}
          </p>
        </div>
        <div className="post-merge-footer">
          {canResolveInApp && (
            <Button variant="secondary" onClick={handleResolveMyself} disabled={isBusy}>
              Resolve myself
            </Button>
          )}
          {canAskAgent ? (
            <Button variant="primary" onClick={handleAskAgentToResolve} disabled={isBusy}>
              Ask agent to fix
            </Button>
          ) : (
            <Button variant="primary" onClick={onClose} disabled={isBusy}>
              Done
            </Button>
          )}
        </div>
      </ModalFrame>
    );
  }

  if (phase === 'merged') {
    return (
      <ModalFrame
        isOpen
        onClose={onClose}
        dismissable={!isBusy}
        title="Branch merged!"
        className="post-merge-content"
      >
        <div className="post-merge-body">
          <p>
            Would you like to switch to <strong>{baseBranch}</strong> and delete the{' '}
            <strong>{branchName}</strong> branch?
          </p>
          {error && <div className="submit-review-error">{error}</div>}
        </div>
        <div className="post-merge-footer">
          <Button variant="secondary" onClick={onClose} disabled={isBusy}>
            No, thanks
          </Button>
          <Button variant="primary" onClick={() => void handlePostMergeCleanup()} disabled={isBusy}>
            {isCleaningUp ? 'Cleaning up...' : 'Yes, clean up'}
          </Button>
        </div>
      </ModalFrame>
    );
  }

  return (
    <ModalFrame
      isOpen
      onClose={onClose}
      dismissable={!isBusy}
      className="submit-review-content"
      title="Submit for Review"
    >
      <>
        <div className="submit-review-body">
          <div className="submit-review-field">
            <label className="submit-review-label">Branch</label>
            <div className="publish-branch-info">
              <span className="publish-branch-name">{branchName}</span>
            </div>
          </div>

          <div className="submit-review-field">
            <label className="submit-review-label">Merging into</label>
            <select
              className="submit-review-input"
              value={baseBranch}
              onChange={(e) => setBaseBranch(e.target.value)}
              disabled={isBusy}
            >
              {baseBranches.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </select>
          </div>

          {error ? (
            <div className="submit-review-error">{error}</div>
          ) : (
            <p className="submit-review-explainer">
              When you create this, Ship Studio saves your changes, writes a short summary of them,
              and opens a {terms.changeRequest} into <strong>{baseBranch}</strong> for your team to
              review and merge.
            </p>
          )}
        </div>

        <div className="submit-review-footer">
          <Button variant="secondary" onClick={onClose} disabled={isBusy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void handleSubmit()} disabled={isBusy}>
            {isSubmitting ? (
              <>
                <Spinner size="sm" />
                {progressLabel}
              </>
            ) : (
              createLabel
            )}
          </Button>
        </div>
      </>
    </ModalFrame>
  );
}

/**
 * Convert a branch name to a human-readable title.
 * e.g., "user/update-pricing-page" -> "Update pricing page"
 */
function formatBranchAsTitle(branchName: string): string {
  // Remove username prefix if present
  let name = branchName;
  if (name.includes('/')) {
    name = name.split('/').slice(1).join('/');
  }

  // Replace dashes/underscores with spaces and capitalize
  return name.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
