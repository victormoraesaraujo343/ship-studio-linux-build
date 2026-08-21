/**
 * Linux setup-path tests.
 *
 * The suite pins a macOS userAgent in src/test/setup.ts, so every other test
 * file exercises the macOS branch of lib/setup. These tests re-import the
 * module graph under a Linux userAgent to cover the branches that only Linux
 * reaches — where installs go through the terminal instead of a silent backend
 * command, and where `/bin/zsh` can't be assumed to exist.
 *
 * `vi.resetModules()` before each import is load-bearing: `platform()` caches
 * its userAgent read at first call, and TERMINAL_COMMANDS / USES_TERMINAL are
 * module-level consts evaluated at import time.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const LINUX_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) jsdom';

let originalUserAgent: string;

/** Import a module fresh, with the platform resolving to Linux. */
async function importAsLinux<T>(path: string): Promise<T> {
  vi.resetModules();
  Object.defineProperty(globalThis.navigator, 'userAgent', {
    value: LINUX_UA,
    configurable: true,
  });
  return (await import(path)) as T;
}

beforeEach(() => {
  originalUserAgent = navigator.userAgent;
});

afterEach(() => {
  Object.defineProperty(globalThis.navigator, 'userAgent', {
    value: originalUserAgent,
    configurable: true,
  });
  vi.resetModules();
});

type SetupModule = typeof import('./setup');
type AgentModule = typeof import('./agent');
type OnboardingModule = typeof import('./agentOnboarding');

describe('platform detection on Linux', () => {
  it('reports linux and not macOS or Windows', async () => {
    const { isLinux, isMac, isWindows } = await importAsLinux<SetupModule>('./setup');
    expect(isLinux()).toBe(true);
    expect(isMac()).toBe(false);
    expect(isWindows()).toBe(false);
  });
});

describe('install routing on Linux', () => {
  it('routes node, git and gh through the terminal', async () => {
    // They need `sudo`, and a silent backend subprocess has nowhere to put a
    // password prompt — so unlike macOS/Windows these are terminal steps.
    const { USES_TERMINAL } = await importAsLinux<SetupModule>('./setup');
    expect(USES_TERMINAL.has('node')).toBe(true);
    expect(USES_TERMINAL.has('git')).toBe(true);
    expect(USES_TERMINAL.has('gh')).toBe(true);
  });

  it('leaves no items for the silent package-manager install path', async () => {
    const { PKG_MGR_PACKAGES } = await importAsLinux<SetupModule>('./setup');
    expect(PKG_MGR_PACKAGES.size).toBe(0);
  });

  it('keeps the shared interactive items', async () => {
    const { USES_TERMINAL } = await importAsLinux<SetupModule>('./setup');
    for (const id of ['gh_auth', 'claude', 'claude_auth', 'vercel', 'vercel_auth']) {
      expect(USES_TERMINAL.has(id)).toBe(true);
    }
  });
});

describe('Linux terminal commands', () => {
  it('provides install commands for node, git and gh', async () => {
    const { TERMINAL_COMMANDS } = await importAsLinux<SetupModule>('./setup');
    for (const id of ['node', 'git', 'gh']) {
      expect(TERMINAL_COMMANDS[id]).toBeDefined();
      expect(TERMINAL_COMMANDS[id].command).toBe('/bin/bash');
    }
  });

  it('detects the package manager at run time rather than assuming one', async () => {
    const { TERMINAL_COMMANDS } = await importAsLinux<SetupModule>('./setup');
    const script = TERMINAL_COMMANDS.git.args[1];
    for (const mgr of ['brew', 'apt-get', 'dnf', 'pacman', 'zypper', 'apk']) {
      expect(script).toContain(mgr);
    }
  });

  it('emits output before any slow step so the zero-output watchdog holds', async () => {
    // The onboarding terminal kills a PTY that stays silent for 10s (#245).
    const { TERMINAL_COMMANDS } = await importAsLinux<SetupModule>('./setup');
    for (const id of ['node', 'git', 'gh', 'homebrew']) {
      expect(TERMINAL_COMMANDS[id].args[1].startsWith('echo ')).toBe(true);
    }
  });

  it('adds GitHub’s apt repository, since gh is not in Debian/Ubuntu', async () => {
    const { TERMINAL_COMMANDS } = await importAsLinux<SetupModule>('./setup');
    const script = TERMINAL_COMMANDS.gh.args[1];
    expect(script).toContain('cli.github.com/packages');
    expect(script).toContain('githubcli-archive-keyring.gpg');
  });

  it('uses NodeSource on apt, where the distro Node is too old', async () => {
    const { TERMINAL_COMMANDS } = await importAsLinux<SetupModule>('./setup');
    expect(TERMINAL_COMMANDS.node.args[1]).toContain('deb.nodesource.com');
  });

  it('treats the package-manager step as informational, not an install', async () => {
    const { TERMINAL_COMMANDS } = await importAsLinux<SetupModule>('./setup');
    const script = TERMINAL_COMMANDS.homebrew.args[1];
    expect(script).not.toContain('raw.githubusercontent.com/Homebrew');
    // macOS gates this step on `dseditgroup`, which does not exist on Linux.
    expect(script).not.toContain('dseditgroup');
  });

  it('keeps the shared Unix commands for the agent CLIs', async () => {
    const { TERMINAL_COMMANDS } = await importAsLinux<SetupModule>('./setup');
    expect(TERMINAL_COMMANDS.claude_auth).toEqual({ command: 'claude', args: ['auth', 'login'] });
    expect(TERMINAL_COMMANDS.gh_auth.command).toBe('gh');
  });
});

describe('shell defaults on Linux', () => {
  it('falls back to bash rather than zsh, which Linux often lacks', async () => {
    const { TERMINAL } = await importAsLinux<AgentModule>('./agent');
    expect(TERMINAL.binaryName).toBe('/bin/bash');
    expect(TERMINAL.processName).toBe('bash');
  });

  it('spawns bash for the bring-your-own-agent path', async () => {
    const { otherAgentShellSpawn } = await importAsLinux<OnboardingModule>('./agentOnboarding');
    expect(otherAgentShellSpawn()).toEqual({ command: '/bin/bash', args: ['-il'] });
  });
});

describe('agent-led onboarding prompt on Linux', () => {
  /** Build the guided prompt with everything reported missing. */
  async function linuxPrompt(): Promise<string> {
    const { buildGuidedSetupPrompt } = await importAsLinux<OnboardingModule>('./agentOnboarding');
    const missing = ['homebrew', 'node', 'git', 'gh', 'gh_auth'].map((id) => ({
      id,
      friendlyName: id,
      status: 'not_installed' as const,
    }));
    return buildGuidedSetupPrompt(missing);
  }

  it('tells the agent to detect the package manager instead of naming Homebrew', async () => {
    const prompt = await linuxPrompt();
    expect(prompt).toContain('apt-get');
    expect(prompt).toContain('dnf');
    expect(prompt).toContain('pacman');
    // The macOS-only Homebrew installer must not be prescribed on Linux.
    expect(prompt).not.toContain('raw.githubusercontent.com/Homebrew');
  });

  it('warns about the sudo password prompt', async () => {
    expect(await linuxPrompt()).toContain('sudo');
  });

  it('does not send the user to the Microsoft Store', async () => {
    expect(await linuxPrompt()).not.toContain('Microsoft Store');
  });
});
