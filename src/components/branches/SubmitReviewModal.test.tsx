/**
 * Regression test for the "Submit for Review" PR-create error display.
 *
 * Tauri command rejections arrive as a structured `CommandError` *object*, not
 * a JS `Error`. The submit handler used to render `String(e)` on failure, which
 * stringified that object to a literal "[object Object]" in the modal. It must
 * route the error through `formatCommandError(asCommandError(e))` so users see
 * the real reason a PR couldn't be created.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { SubmitReviewModal } from './SubmitReviewModal';
import { ToastContext } from '../../contexts/ToastContext';

vi.mock('../../lib/branches', () => ({
  createPullRequest: vi.fn(),
  mergePullRequest: vi.fn(),
  switchBranch: vi.fn(),
  deleteBranch: vi.fn(),
  getDefaultBaseBranch: vi.fn().mockResolvedValue(null),
}));
vi.mock('../../lib/ai', () => ({ generatePRDescription: vi.fn() }));
vi.mock('../../lib/git', () => ({ commitChanges: vi.fn() }));
vi.mock('../../lib/analytics', () => ({ trackEvent: vi.fn(), trackError: vi.fn() }));
vi.mock('../../lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { createPullRequest, getDefaultBaseBranch } from '../../lib/branches';
import { logger } from '../../lib/logger';

type Fn = ReturnType<typeof vi.fn>;

/** Render with a toast spy so the tests can assert toast type routing. */
function renderWithToasts(ui: ReactNode) {
  const showToast = vi.fn();
  render(
    <ToastContext.Provider value={{ toasts: [], showToast, dismissToast: vi.fn() }}>
      {ui}
    </ToastContext.Provider>
  );
  return { showToast };
}

describe('SubmitReviewModal — PR create error display', () => {
  const props = {
    projectPath: '/path/to/project',
    branchName: 'ptymoshenko/sanity',
    baseBranches: ['main'],
    aiAvailable: false,
    onSuccess: vi.fn(),
    onClose: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    // Default-base lookup runs on mount; keep it resolved so the effect no-ops.
    vi.mocked(getDefaultBaseBranch).mockResolvedValue(null);
  });

  it('renders a formatted CommandError, never "[object Object]"', async () => {
    // Tauri rejects with a tagged CommandError object (NOT a JS Error) — the
    // shape that used to stringify to "[object Object]".
    vi.mocked(createPullRequest).mockRejectedValue({
      type: 'Process',
      cmd: 'gh pr create',
      exit_code: 1,
      stderr: 'a pull request for branch "ptymoshenko/sanity" already exists',
    });

    render(<SubmitReviewModal {...props} />);
    fireEvent.click(screen.getByRole('button', { name: /create pull request/i }));

    // A readable, humanized message is surfaced (existing PR case)...
    expect(await screen.findByText(/already an open pull request/i)).toBeInTheDocument();
    // ...and the old broken output is gone.
    expect(screen.queryByText(/\[object Object\]/)).not.toBeInTheDocument();
  });

  it('handles a bare string rejection too (legacy commands)', async () => {
    vi.mocked(createPullRequest).mockRejectedValue('gh: not authenticated');

    render(<SubmitReviewModal {...props} />);
    fireEvent.click(screen.getByRole('button', { name: /create pull request/i }));

    // Humanized auth message, never "[object Object]".
    expect(await screen.findByText(/didn't accept the connection/i)).toBeInTheDocument();
    expect(screen.queryByText(/\[object Object\]/)).not.toBeInTheDocument();
  });
});

describe('SubmitReviewModal — expected-refusal toast routing (#538)', () => {
  const props = {
    projectPath: '/path/to/project',
    branchName: 'ptymoshenko/sanity',
    baseBranches: ['main'],
    aiAvailable: false,
    onSuccess: vi.fn(),
    onClose: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getDefaultBaseBranch).mockResolvedValue(null);
  });

  it('toasts a recognized refusal as info (no generic error toast, warn log)', async () => {
    // "PR already exists" — backend classifies this Expected and skips its own
    // report; the frontend toast must not become the fallback reporter.
    vi.mocked(createPullRequest).mockRejectedValue({
      type: 'Process',
      cmd: 'gh pr create',
      exit_code: 1,
      stderr: 'GraphQL: A pull request already exists for julian:ptymoshenko/sanity.',
    });

    const { showToast } = renderWithToasts(<SubmitReviewModal {...props} />);
    fireEvent.click(screen.getByRole('button', { name: /create pull request/i }));

    await waitFor(() => expect(showToast).toHaveBeenCalled());
    expect(showToast).toHaveBeenCalledWith(
      expect.stringMatching(/already an open pull request/i),
      'info'
    );
    expect(showToast).not.toHaveBeenCalledWith('Failed to create pull request', 'error');
    // eslint-disable-next-line @typescript-eslint/unbound-method -- inspecting the logger mock's calls, not invoking it bound
    expect(logger.warn as Fn).toHaveBeenCalled();
    // eslint-disable-next-line @typescript-eslint/unbound-method -- inspecting the logger mock's calls, not invoking it bound
    expect(logger.error as Fn).not.toHaveBeenCalled();
  });

  it('keeps the generic error toast for genuinely unrecognized failures', async () => {
    vi.mocked(createPullRequest).mockRejectedValue({
      type: 'Other',
      message: 'some completely novel gh failure',
    });

    const { showToast } = renderWithToasts(<SubmitReviewModal {...props} />);
    fireEvent.click(screen.getByRole('button', { name: /create pull request/i }));

    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith('Failed to create pull request', 'error')
    );
    // The inline modal error still carries the real detail.
    expect(await screen.findByText(/some completely novel gh failure/)).toBeInTheDocument();
  });
});

describe('SubmitReviewModal — provider vocabulary', () => {
  const props = {
    projectPath: '/path/to/project',
    branchName: 'victor/pricing',
    baseBranches: ['main'],
    aiAvailable: false,
    onSuccess: vi.fn(),
    onClose: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getDefaultBaseBranch).mockResolvedValue(null);
  });

  it('calls it a merge request on GitLab', () => {
    render(<SubmitReviewModal {...props} provider="gitlab" />);

    expect(screen.getByRole('button', { name: 'Create Merge Request' })).toBeInTheDocument();
    expect(screen.getByText(/opens a merge request into/)).toBeInTheDocument();
    expect(screen.queryByText(/pull request/i)).not.toBeInTheDocument();
  });

  it('calls it a pull request on GitHub', () => {
    render(<SubmitReviewModal {...props} provider="github" />);

    expect(screen.getByRole('button', { name: 'Create Pull Request' })).toBeInTheDocument();
    expect(screen.getByText(/opens a pull request into/)).toBeInTheDocument();
    expect(screen.queryByText(/merge request/i)).not.toBeInTheDocument();
  });

  it('falls back to GitHub wording when the provider is unknown', () => {
    // Provider omitted (still loading / no remote to identify) and explicitly
    // null must both read as GitHub — the app's own fallback forge.
    const { unmount } = render(<SubmitReviewModal {...props} />);
    expect(screen.getByRole('button', { name: 'Create Pull Request' })).toBeInTheDocument();
    unmount();

    render(<SubmitReviewModal {...props} provider={null} />);
    expect(screen.getByRole('button', { name: 'Create Pull Request' })).toBeInTheDocument();
  });

  it('uses the forge’s term in the failure toast too', async () => {
    vi.mocked(createPullRequest).mockRejectedValue({
      type: 'Other',
      message: 'some completely novel glab failure',
    });

    const { showToast } = renderWithToasts(<SubmitReviewModal {...props} provider="gitlab" />);
    fireEvent.click(screen.getByRole('button', { name: 'Create Merge Request' }));

    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith('Failed to create merge request', 'error')
    );
  });
});

describe('SubmitReviewModal — reading the number back from the created URL', () => {
  const props = {
    projectPath: '/path/to/project',
    branchName: 'victor/pricing',
    baseBranches: ['main'],
    aiAvailable: false,
    onSuccess: vi.fn(),
    onClose: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getDefaultBaseBranch).mockResolvedValue(null);
  });

  /**
   * The number drives the follow-up merge offer. GitLab shapes its URL as
   * `/-/merge_requests/<n>`, and only GitHub's `/pull/<n>` used to be
   * recognized — so a GitLab user's merge request was created and then the
   * flow quietly gave up on offering to merge it.
   */
  it('offers the merge step for a GitLab merge request URL', async () => {
    vi.mocked(createPullRequest).mockResolvedValue(
      'https://gitlab.acme.com/group/sub/proj/-/merge_requests/42'
    );

    render(<SubmitReviewModal {...props} provider="gitlab" />);
    fireEvent.click(screen.getByRole('button', { name: 'Create Merge Request' }));

    expect(await screen.findByText('Merge request created')).toBeInTheDocument();
  });

  it('still offers it for a GitHub pull request URL', async () => {
    vi.mocked(createPullRequest).mockResolvedValue('https://github.com/owner/repo/pull/7');

    render(<SubmitReviewModal {...props} provider="github" />);
    fireEvent.click(screen.getByRole('button', { name: 'Create Pull Request' }));

    expect(await screen.findByText('Pull request created')).toBeInTheDocument();
  });

  /// A URL with no number must still degrade gracefully rather than throw.
  it('falls back to a toast when the URL carries no number', async () => {
    vi.mocked(createPullRequest).mockResolvedValue('https://gitlab.acme.com/group/proj');

    const { showToast } = renderWithToasts(<SubmitReviewModal {...props} provider="gitlab" />);
    fireEvent.click(screen.getByRole('button', { name: 'Create Merge Request' }));

    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith(
        expect.stringContaining('Merge request created'),
        'success'
      )
    );
  });
});
