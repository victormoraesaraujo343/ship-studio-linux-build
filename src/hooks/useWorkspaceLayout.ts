/**
 * Hook for workspace layout state management.
 *
 * Manages: log panel visibility, preview visibility, and the workspace tab
 * selector (preview/code/branches/prs, plus any plugin that renders its own
 * pane). The narrow-window compact layout is a
 * separate tree driven by `useIsCompact`; its state lives in CompactWorkspace,
 * not here.
 */

import { useState, useCallback, useEffect } from 'react';
import { trackEvent, trackPageview } from '../lib/analytics';

interface UseWorkspaceLayoutParams {
  /** Whether GitHub is connected for the current project */
  isGitHubConnected: boolean;
}

type BuiltInTab = 'preview' | 'code' | 'branches' | 'prs';

/**
 * A workspace tab is one of the built-in panes, or a plugin that renders a whole
 * pane of its own. Plugin tabs are addressed by manifest id rather than by an
 * index so the selection survives a plugin being enabled, disabled, or reordered
 * beside it.
 */
export type WorkspaceTab = BuiltInTab | `plugin:${string}`;

const TAB_SCREEN: Record<BuiltInTab, string> = {
  preview: 'Workspace - Preview',
  code: 'Workspace - Code',
  branches: 'Workspace - Branches',
  prs: 'Workspace - Pull Requests',
};

/** Analytics screen name. Plugin panes are named by id, so one plugin's usage
 *  doesn't read as another's. */
function screenName(tab: WorkspaceTab): string {
  return tab.startsWith('plugin:')
    ? `Workspace - Plugin - ${tab.slice('plugin:'.length)}`
    : TAB_SCREEN[tab as BuiltInTab];
}

export function useWorkspaceLayout({ isGitHubConnected }: UseWorkspaceLayoutParams) {
  // Health-logs panel visibility (takes over the terminal pane when the user
  // opens the code-health log feed).
  const [showHealthLogs, setShowHealthLogs] = useState(false);

  // Preview panel visibility
  const [isPreviewHidden, setIsPreviewHidden] = useState(false);

  // Workspace tab state (preview/code/branches/prs). The raw value is what the
  // user selected; `workspaceTab` below projects it through the GitHub-connected
  // gate so branches/prs fall back to preview when GitHub isn't available. We
  // keep the raw value so the user's last selection comes back on reconnect.
  const [workspaceTabRaw, setWorkspaceTabRaw] = useState<WorkspaceTab>('preview');

  // Wrap the raw setter with `workspace_tab_switched` so click tracking is
  // automatic. Capture `workspaceTabRaw` from the closure rather than from
  // a functional updater — functional updaters fire twice under React 18
  // StrictMode and would double-count clicks in dev/tests. The closure is
  // refreshed on every state change anyway.
  //
  // Tag the click with the *destination* screen so this event and the
  // `$pageview` that follows agree on what screen the user is on. Without
  // the explicit override, enrichProperties would attach the active screen
  // (the *origin* tab), which makes "modal_opened on Workspace - Preview"
  // look adjacent to "Pageview /workspace-code" in the timeline and
  // confuses everyone reading the dashboard.
  const setWorkspaceTab = useCallback(
    (tab: WorkspaceTab) => {
      if (workspaceTabRaw !== tab) {
        void trackEvent('workspace_tab_switched', {
          from_tab: workspaceTabRaw,
          to_tab: tab,
          $screen_name: screenName(tab),
        });
      }
      setWorkspaceTabRaw(tab);
    },
    [workspaceTabRaw]
  );

  const workspaceTab: WorkspaceTab =
    !isGitHubConnected && (workspaceTabRaw === 'branches' || workspaceTabRaw === 'prs')
      ? 'preview'
      : workspaceTabRaw;

  // Pageview tracks the *projected* tab (after the GitHub-connected gate),
  // so a forced fallback when GitHub disconnects is recorded as a screen
  // change. Also fires once on mount with the initial resolved tab — replaces
  // the seed previously fired from useProjectLifecycle.
  useEffect(() => {
    trackPageview(screenName(workspaceTab));
  }, [workspaceTab]);

  // Reset layout state (when going back to projects)
  const resetLayout = useCallback(() => {
    setShowHealthLogs(false);
  }, []);

  return {
    // Log panel
    showHealthLogs,
    setShowHealthLogs,

    // Preview
    isPreviewHidden,
    setIsPreviewHidden,

    // Tabs
    workspaceTab,
    setWorkspaceTab,

    // Reset
    resetLayout,
  };
}
