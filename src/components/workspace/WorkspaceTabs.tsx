/**
 * The workspace tab strip: Preview, Focus, Code, the GitHub pair, and a tab for
 * every plugin that renders a pane of its own.
 *
 * Extracted from WorkspaceView not for reuse -- nothing else renders this -- but
 * because the strip is a self-contained piece of that file and the file is at
 * its line budget. Which tab is active stays WorkspaceView's state; this only
 * draws it and reports clicks back.
 */

import { EyeIcon, EyeOffIcon, CodeIcon, BranchIcon, PullRequestIcon, PuzzleIcon } from '../icons';
import { providerTerms } from '../../lib/gitProvider';
import type { IntegrationState } from '../../hooks/useIntegrationStatus';
import type { LoadedPlugin } from '../../hooks/usePlugins';
import type { WorkspaceTab } from '../../hooks/useWorkspaceLayout';

export interface WorkspaceTabsProps {
  /** Whether the project has a preview surface at all. */
  hasPreview: boolean;
  workspaceTab: WorkspaceTab;
  setWorkspaceTab: (tab: WorkspaceTab) => void;
  isPreviewHidden: boolean;
  setIsPreviewHidden: (hidden: boolean) => void;
  integrations: IntegrationState;
  /** Plugins filling the `panel` slot, one tab each. */
  panelPlugins: LoadedPlugin[];
}

export function WorkspaceTabs({
  hasPreview,
  workspaceTab,
  setWorkspaceTab,
  isPreviewHidden,
  setIsPreviewHidden,
  integrations,
  panelPlugins,
}: WorkspaceTabsProps) {
  return (
    <div className="workspace-tabs">
      {hasPreview && (
        <button
          className={`workspace-tab ${workspaceTab === 'preview' && !isPreviewHidden ? 'active' : ''}`}
          onClick={() => {
            setIsPreviewHidden(false);
            setWorkspaceTab('preview');
          }}
          title="Preview"
        >
          <EyeIcon size={14} />
          <span>Preview</span>
        </button>
      )}
      {/* Focus mode — collapses the preview pane so the agent terminal takes the
          full workspace. Active whenever the preview is hidden. */}
      <button
        className={`workspace-tab ${isPreviewHidden ? 'active' : ''}`}
        onClick={() => setIsPreviewHidden(!isPreviewHidden)}
        title={isPreviewHidden ? 'Exit focus mode' : 'Hide preview — agent only'}
      >
        <EyeOffIcon size={14} />
        <span>Focus</span>
      </button>
      <button
        className={`workspace-tab ${workspaceTab === 'code' && !isPreviewHidden ? 'active' : ''}`}
        onClick={() => {
          setIsPreviewHidden(false);
          setWorkspaceTab('code');
        }}
        title="Code"
      >
        <CodeIcon size={14} />
        <span>Code</span>
      </button>
      {integrations.projectGithub?.status === 'connected' && (
        <>
          <button
            className={`workspace-tab ${workspaceTab === 'branches' && !isPreviewHidden ? 'active' : ''}`}
            onClick={() => {
              setIsPreviewHidden(false);
              setWorkspaceTab('branches');
            }}
            title="Branches"
            data-education-id="branches-tab"
          >
            <BranchIcon size={14} />
            <span>Branches</span>
          </button>
          <button
            className={`workspace-tab ${workspaceTab === 'prs' && !isPreviewHidden ? 'active' : ''}`}
            onClick={() => {
              setIsPreviewHidden(false);
              setWorkspaceTab('prs');
            }}
            title={providerTerms(integrations.projectGithub?.provider).changeRequestPluralSentence}
            data-education-id="prs-tab"
          >
            <PullRequestIcon size={14} />
            <span>{`${providerTerms(integrations.projectGithub?.provider).abbrev}s`}</span>
          </button>
        </>
      )}
      {panelPlugins.map((plugin) => {
        const tab: WorkspaceTab = `plugin:${plugin.info.manifest.id}`;
        return (
          <button
            key={plugin.info.manifest.id}
            className={`workspace-tab ${workspaceTab === tab && !isPreviewHidden ? 'active' : ''}`}
            onClick={() => {
              setIsPreviewHidden(false);
              setWorkspaceTab(tab);
            }}
            title={plugin.info.manifest.description || plugin.info.manifest.name}
          >
            <PuzzleIcon size={14} />
            <span>{plugin.info.manifest.name}</span>
          </button>
        );
      })}
    </div>
  );
}
