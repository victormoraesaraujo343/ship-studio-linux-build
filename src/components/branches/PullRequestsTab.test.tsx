/**
 * Provider vocabulary tests for the PR tab.
 *
 * Ship Studio talks to GitHub and GitLab through the same commands, so the same
 * component renders both. What must NOT be shared is the wording: a GitLab user
 * should never be shown "pull request". These pin the labels for both forges,
 * plus the GitHub default when the backend hasn't identified a provider.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { PullRequestsTab } from './PullRequestsTab';
import type { PullRequestInfo } from '../../lib/branches';

vi.mock('../../lib/branches', () => ({
  listPullRequests: vi.fn(),
  mergePullRequest: vi.fn(),
  checkoutPullRequest: vi.fn(),
  closePullRequest: vi.fn(),
  deleteBranch: vi.fn(),
  switchBranch: vi.fn(),
}));
vi.mock('../../lib/analytics', () => ({ trackEvent: vi.fn(), trackError: vi.fn() }));

import { listPullRequests } from '../../lib/branches';

const openPr: PullRequestInfo = {
  number: 7,
  title: 'Update pricing page',
  headRef: 'victor/pricing',
  baseRef: 'main',
  author: 'victor',
  state: 'OPEN',
  mergeable: true,
  isDraft: false,
  url: 'https://gitlab.com/acme/site/-/merge_requests/7',
  createdAt: new Date().toISOString(),
};

function makeProps(overrides?: Partial<Parameters<typeof PullRequestsTab>[0]>) {
  return {
    projectPath: '/path/to/project',
    githubUsername: 'victor',
    onRefresh: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listPullRequests).mockResolvedValue([]);
});

describe('PullRequestsTab — provider vocabulary', () => {
  it('says "merge requests" on GitLab', async () => {
    render(<PullRequestsTab {...makeProps({ provider: 'gitlab' })} />);

    expect(await screen.findByText('No open merge requests')).toBeInTheDocument();
    expect(screen.getByText(/^Merge requests let you propose changes/)).toBeInTheDocument();
    expect(screen.queryByText(/pull request/i)).not.toBeInTheDocument();
  });

  it('says "pull requests" on GitHub', async () => {
    render(<PullRequestsTab {...makeProps({ provider: 'github' })} />);

    expect(await screen.findByText('No open pull requests')).toBeInTheDocument();
    expect(screen.queryByText(/merge request/i)).not.toBeInTheDocument();
  });

  it('falls back to GitHub wording when the provider is unknown', async () => {
    // No `provider` prop at all — a project whose remote the backend couldn't
    // identify. The words must match the CLI the app would actually run.
    render(<PullRequestsTab {...makeProps()} />);

    expect(await screen.findByText('No open pull requests')).toBeInTheDocument();
    expect(screen.queryByText(/merge request/i)).not.toBeInTheDocument();
  });

  it('titles the close confirmation with the forge’s term', async () => {
    vi.mocked(listPullRequests).mockResolvedValue([openPr]);
    render(<PullRequestsTab {...makeProps({ provider: 'gitlab' })} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Close' }));

    expect(screen.getByText('Close Merge Request?')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close MR' })).toBeInTheDocument();
    expect(screen.getByText(/reopen this MR later from GitLab/)).toBeInTheDocument();
  });

  it('points the card link at the right forge by name', async () => {
    vi.mocked(listPullRequests).mockResolvedValue([openPr]);
    render(<PullRequestsTab {...makeProps({ provider: 'gitlab' })} />);

    expect(await screen.findByTitle('View on GitLab')).toBeInTheDocument();
  });
});
