/**
 * Tests for PublishBranchDropdown.
 *
 * The core contract: the trigger button says "Push" at ALL times (or
 * "Pushing..." while in flight) — never "Sync", "Publish", "Synced", or
 * "Go Live". That label churn was a real UX complaint; these tests pin it.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { PublishBranchDropdown } from './PublishBranchDropdown';
import type { ProjectGitHubStatus } from '../../lib/github';
import { listProjectRemotes, getProjectRemote, setProjectRemote } from '../../lib/git';

vi.mock('../../lib/branches', () => ({
  publishBranch: vi.fn().mockResolvedValue({ state: 'PUSHED', url: null }),
}));

// The panel reads the project's remotes when it opens. A single remote is the
// shape these tests describe — the picker only appears when there's a choice,
// so mocking one keeps it hidden and leaves this file about push terminology.
vi.mock('../../lib/git', () => ({
  listProjectRemotes: vi.fn().mockResolvedValue(['origin']),
  getProjectRemote: vi.fn().mockResolvedValue('origin'),
  setProjectRemote: vi.fn().mockResolvedValue(undefined),
}));

const connectedStatus = {
  status: 'connected',
  github_repo: 'user/repo',
} as unknown as ProjectGitHubStatus;

function makeProps(overrides?: Partial<Parameters<typeof PublishBranchDropdown>[0]>) {
  return {
    currentBranch: 'main',
    projectGithubStatus: connectedStatus,
    projectPath: '/test/path',
    hasChangesToSync: true,
    onStatusChange: vi.fn(),
    isPublishing: false,
    setIsPublishing: vi.fn(),
    ...overrides,
  };
}

const BANNED_LABELS = ['Sync', 'Synced', 'Syncing...', 'Publish', 'Publishing...', 'Go Live'];

function expectNoBannedLabels() {
  for (const label of BANNED_LABELS) {
    expect(screen.queryByText(label)).not.toBeInTheDocument();
  }
}

describe('PublishBranchDropdown trigger label', () => {
  it('says "Push" on the main branch', () => {
    render(<PublishBranchDropdown {...makeProps({ currentBranch: 'main' })} />);

    expect(screen.getByText('Push')).toBeInTheDocument();
    expectNoBannedLabels();
  });

  it('says "Push" on a feature branch', () => {
    render(<PublishBranchDropdown {...makeProps({ currentBranch: 'feature/thing' })} />);

    expect(screen.getByText('Push')).toBeInTheDocument();
    expectNoBannedLabels();
  });

  it('says "Push" even when there is nothing to push', () => {
    render(<PublishBranchDropdown {...makeProps({ hasChangesToSync: false })} />);

    expect(screen.getByText('Push')).toBeInTheDocument();
    expectNoBannedLabels();
  });

  it('says "Pushing..." while a push is in flight', () => {
    render(<PublishBranchDropdown {...makeProps({ isPublishing: true })} />);

    expect(screen.getByText('Pushing...')).toBeInTheDocument();
    expectNoBannedLabels();
  });

  it('says "Push" (disabled) when no GitHub repo exists yet', () => {
    render(
      <PublishBranchDropdown
        {...makeProps({
          projectGithubStatus: { status: 'no_repo' } as unknown as ProjectGitHubStatus,
        })}
      />
    );

    const button = screen.getByText('Push').closest('button');
    expect(button).toBeDisabled();
    expectNoBannedLabels();
  });
});

describe('PublishBranchDropdown open panel', () => {
  it('uses push terminology throughout the idle panel (feature branch)', () => {
    render(<PublishBranchDropdown {...makeProps({ currentBranch: 'feature/thing' })} />);

    fireEvent.click(screen.getByText('Push'));

    expect(screen.getByText('Push to GitHub')).toBeInTheDocument();
    // Trigger + primary action both say Push
    expect(screen.getAllByText('Push').length).toBeGreaterThanOrEqual(2);
    expectNoBannedLabels();
  });

  it('keeps the live-site warning when pushing to main', () => {
    render(<PublishBranchDropdown {...makeProps({ currentBranch: 'main' })} />);

    fireEvent.click(screen.getByText('Push'));

    expect(screen.getByText(/update your live site/i)).toBeInTheDocument();
    expectNoBannedLabels();
  });

  it('says there is nothing to push when GitHub is up to date', () => {
    render(<PublishBranchDropdown {...makeProps({ hasChangesToSync: false })} />);

    fireEvent.click(screen.getByText('Push'));

    expect(screen.getByText(/Nothing to push/i)).toBeInTheDocument();
    expectNoBannedLabels();
  });
});

describe('PublishBranchDropdown remote picker', () => {
  beforeEach(() => {
    vi.mocked(listProjectRemotes).mockResolvedValue(['origin']);
    vi.mocked(getProjectRemote).mockResolvedValue('origin');
    vi.mocked(setProjectRemote).mockClear();
  });

  // One remote is not a choice — offering a single-option dropdown would imply
  // a decision the user does not have.
  it('stays hidden when the project has a single remote', async () => {
    render(<PublishBranchDropdown {...makeProps()} />);
    fireEvent.click(screen.getByText('Push'));

    await waitFor(() => expect(listProjectRemotes).toHaveBeenCalledWith('/test/path'));
    expect(screen.queryByLabelText('Push to')).not.toBeInTheDocument();
  });

  it('offers every remote once there is more than one', async () => {
    vi.mocked(listProjectRemotes).mockResolvedValue(['origin', 'demo']);
    render(<PublishBranchDropdown {...makeProps()} />);
    fireEvent.click(screen.getByText('Push'));

    const select = await screen.findByLabelText<HTMLSelectElement>('Push to');
    expect(select.value).toBe('origin');
    expect(Array.from(select.options).map((o) => o.value)).toEqual(['origin', 'demo']);
  });

  it('records the chosen remote', async () => {
    vi.mocked(listProjectRemotes).mockResolvedValue(['origin', 'demo']);
    render(<PublishBranchDropdown {...makeProps()} />);
    fireEvent.click(screen.getByText('Push'));

    const select = await screen.findByLabelText('Push to');
    fireEvent.change(select, { target: { value: 'demo' } });

    await waitFor(() => expect(setProjectRemote).toHaveBeenCalledWith('/test/path', 'demo'));
  });

  // A rejected write must not leave the UI claiming a remote the backend
  // refused — the picker showing 'demo' while pushes still go to origin is
  // exactly the silent lie this whole change set exists to remove.
  it('reverts the selection when the backend rejects it', async () => {
    vi.mocked(listProjectRemotes).mockResolvedValue(['origin', 'demo']);
    vi.mocked(setProjectRemote).mockRejectedValue(new Error('not a remote'));
    render(<PublishBranchDropdown {...makeProps()} />);
    fireEvent.click(screen.getByText('Push'));

    const select = await screen.findByLabelText<HTMLSelectElement>('Push to');
    fireEvent.change(select, { target: { value: 'demo' } });

    await waitFor(() => expect(select.value).toBe('origin'));
  });
});
