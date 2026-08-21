/**
 * Git forge terminology.
 *
 * Ship Studio talks to GitHub and GitLab through the same Tauri commands — the
 * backend resolves which forge a project's remote points at and dispatches to
 * `gh` or `glab`. What can't be shared is the vocabulary: GitHub has pull
 * requests, GitLab has merge requests, and showing a GitLab user "Create Pull
 * Request" is wrong in the way that makes a tool feel foreign.
 *
 * Components read the `provider` on `ProjectGitHubStatus` and pass it here
 * rather than hard-coding either forge's words.
 *
 * @module lib/gitProvider
 */

/** Which forge a project's remote points at, as reported by the backend. */
export type GitProvider = 'github' | 'gitlab';

/** The words one forge uses for the things Ship Studio shows. */
export interface ProviderTerms {
  /** Product name: "GitHub" / "GitLab". */
  name: string;
  /** A proposed merge, lowercase mid-sentence: "pull request" / "merge request". */
  changeRequest: string;
  /**
   * Sentence case, for copy that opens a sentence: "Pull request created".
   * Distinct from `changeRequestTitle` — using Title Case mid-sentence reads
   * as a proper noun ("Pull Request created"), which is not how either forge
   * writes it.
   */
  changeRequestSentence: string;
  /** Title Case, for headings and buttons: "Pull Request" / "Merge Request". */
  changeRequestTitle: string;
  /** Plural, lowercase: "pull requests" / "merge requests". */
  changeRequestPlural: string;
  /** Plural in sentence case, for copy that opens with it: "Pull requests let you…". */
  changeRequestPluralSentence: string;
  /** The short form users actually say: "PR" / "MR". */
  abbrev: string;
}

const GITHUB_TERMS: ProviderTerms = {
  name: 'GitHub',
  changeRequest: 'pull request',
  changeRequestSentence: 'Pull request',
  changeRequestTitle: 'Pull Request',
  changeRequestPlural: 'pull requests',
  changeRequestPluralSentence: 'Pull requests',
  abbrev: 'PR',
};

const GITLAB_TERMS: ProviderTerms = {
  name: 'GitLab',
  changeRequest: 'merge request',
  changeRequestSentence: 'Merge request',
  changeRequestTitle: 'Merge Request',
  changeRequestPlural: 'merge requests',
  changeRequestPluralSentence: 'Merge requests',
  abbrev: 'MR',
};

/**
 * Terminology for a provider.
 *
 * Defaults to GitHub when the provider is unknown — a project with no remote
 * yet, or one whose forge the backend couldn't identify. That matches the
 * backend's own fallback, so the words on screen never contradict the CLI the
 * app is about to run.
 */
export function providerTerms(provider: GitProvider | null | undefined): ProviderTerms {
  return provider === 'gitlab' ? GITLAB_TERMS : GITHUB_TERMS;
}
