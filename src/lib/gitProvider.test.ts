/**
 * Forge terminology and the optional GitLab setup path.
 *
 * Two things are being protected here. That GitLab users see GitLab's
 * vocabulary — showing "Create Pull Request" on a GitLab project is the kind of
 * wrongness that makes a tool feel like it wasn't built for you. And that
 * GitLab stays genuinely optional: someone who only uses GitHub must never be
 * held at the Git & GitHub step waiting on a CLI they will never install.
 */

import { describe, expect, it } from 'vitest';

import { providerTerms } from './gitProvider';
import {
  isWizardStepComplete,
  OPTIONAL_ITEMS,
  SETUP_DEPENDENCIES,
  SetupItem,
  STEP_OPTIONAL_ITEM_IDS,
  TERMINAL_COMMANDS,
  USES_TERMINAL,
  WIZARD_STEPS,
} from './setup';

describe('providerTerms', () => {
  it('gives GitLab its own vocabulary', () => {
    const terms = providerTerms('gitlab');
    expect(terms.name).toBe('GitLab');
    expect(terms.changeRequest).toBe('merge request');
    expect(terms.changeRequestTitle).toBe('Merge Request');
    expect(terms.changeRequestPlural).toBe('merge requests');
    expect(terms.abbrev).toBe('MR');
  });

  it('gives GitHub its own vocabulary', () => {
    const terms = providerTerms('github');
    expect(terms.changeRequestTitle).toBe('Pull Request');
    expect(terms.abbrev).toBe('PR');
  });

  /// The backend falls back to GitHub for an unidentified remote; the words on
  /// screen must not contradict the CLI the app is about to run.
  it('falls back to GitHub wording when the provider is unknown', () => {
    for (const unknown of [null, undefined] as const) {
      expect(providerTerms(unknown).changeRequestTitle).toBe('Pull Request');
      expect(providerTerms(unknown).name).toBe('GitHub');
    }
  });
});

describe('GitLab setup items', () => {
  /** A status list where every id given is ready. */
  const ready = (ids: string[]): SetupItem[] =>
    ids.map((id) => ({ id, friendlyName: id, status: 'ready' as const }));

  /** A status list where the named ids are missing and the rest are ready. */
  const withMissing = (all: string[], missing: string[]): SetupItem[] =>
    all.map((id) => ({
      id,
      friendlyName: id,
      status: missing.includes(id) ? ('not_installed' as const) : ('ready' as const),
    }));

  it('treats glab and its login as optional', () => {
    expect(OPTIONAL_ITEMS.has('glab')).toBe(true);
    expect(OPTIONAL_ITEMS.has('glab_auth')).toBe(true);
  });

  it('makes the login depend on the CLI', () => {
    expect(SETUP_DEPENDENCIES.glab).toEqual([]);
    expect(SETUP_DEPENDENCIES.glab_auth).toEqual(['glab']);
  });

  it('offers glab on the Git & GitHub step', () => {
    const step = WIZARD_STEPS.find((s) => s.id === 'git-github');
    expect(step?.itemIds).toContain('glab');
    expect(step?.itemIds).toContain('glab_auth');
  });

  /// The point of the whole optional treatment.
  it('completes the step without glab installed', () => {
    const items = withMissing(['git', 'gh', 'gh_auth', 'glab', 'glab_auth'], ['glab', 'glab_auth']);
    expect(isWizardStepComplete('git-github', items)).toBe(true);
  });

  /// gh_auth is also in OPTIONAL_ITEMS but genuinely does gate this step —
  /// which is why STEP_OPTIONAL_ITEM_IDS is a separate, narrower set.
  it('still requires the GitHub items', () => {
    for (const missing of ['git', 'gh', 'gh_auth']) {
      const items = withMissing(['git', 'gh', 'gh_auth', 'glab', 'glab_auth'], [missing]);
      expect(isWizardStepComplete('git-github', items)).toBe(false);
    }
  });

  it('completes when everything including glab is ready', () => {
    const items = ready(['git', 'gh', 'gh_auth', 'glab', 'glab_auth']);
    expect(isWizardStepComplete('git-github', items)).toBe(true);
  });

  it('scopes the step-optional exemption to the GitLab items only', () => {
    expect([...STEP_OPTIONAL_ITEM_IDS].sort()).toEqual(['glab', 'glab_auth']);
  });

  it('runs both glab steps in a terminal', () => {
    // Installing can need sudo, and `glab auth login` prompts for the instance
    // and sign-in method — neither works from a silent subprocess.
    expect(USES_TERMINAL.has('glab')).toBe(true);
    expect(USES_TERMINAL.has('glab_auth')).toBe(true);
  });

  it('signs in with glab auth login', () => {
    expect(TERMINAL_COMMANDS.glab_auth).toEqual({ command: 'glab', args: ['auth', 'login'] });
  });

  /// A wrong package name fails with "no match for argument", which reads like
  /// an app bug — so unsupported systems get the official instructions instead.
  it('points at the official docs rather than guessing a package name', () => {
    const script = TERMINAL_COMMANDS.glab.args[1];
    expect(script).toContain('brew install glab');
    expect(script).toContain('gitlab-org/cli');
  });
});
