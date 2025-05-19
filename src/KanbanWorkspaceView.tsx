import {
  Heading as MdastHeading,
  List as MdastList,
  ListItem as MdastListItem,
  Root as MdastRoot,
} from 'mdast';
import { ItemView, TFile, TFolder, WorkspaceLeaf } from 'obsidian';
import { render, unmountComponentAtNode } from 'preact/compat';
import { useCallback, useEffect, useMemo, useState } from 'preact/hooks';

import { DEFAULT_SETTINGS, KanbanSettings, SavedWorkspaceView } from './Settings';
import { StateManager } from './StateManager';
import { getTagColorFn, getTagSymbolFn } from './components/helpers';
import { ItemData, TagColor, TagSymbolSetting } from './components/types';
import { hasFrontmatterKey } from './helpers';
import KanbanPlugin from './main';
import { listItemToItemData } from './parsers/formats/list';
import { parseMarkdown } from './parsers/parseMarkdown';

// New interface for the cards displayed in the workspace view
interface WorkspaceCard {
  id: string;
  title: string;
  tags: string[];
  sourceBoardName: string;
  sourceBoardPath: string;
  laneTitle: string;
  blockId?: string;
}

export const KANBAN_WORKSPACE_VIEW_TYPE = 'kanban-workspace';
export const KANBAN_WORKSPACE_ICON = 'lucide-filter';

// Helper function to recursively get all markdown files in a folder
async function recursivelyGetAllMdFilesInFolder(folder: TFolder): Promise<TFile[]> {
  const mdFiles: TFile[] = [];
  for (const child of folder.children) {
    if (child instanceof TFile && child.extension === 'md') {
      mdFiles.push(child);
    } else if (child instanceof TFolder) {
      mdFiles.push(...(await recursivelyGetAllMdFilesInFolder(child)));
    }
  }
  return mdFiles;
}

// Helper to get text content from a heading node
function getHeadingText(node: MdastHeading): string {
  return node.children.map((child) => ('value' in child ? child.value : '')).join('');
}

// Basic React component for the workspace view
function KanbanWorkspaceViewComponent(props: { plugin: KanbanPlugin }) {
  const [currentTagInput, setCurrentTagInput] = useState('');
  const [activeFilterTags, setActiveFilterTags] = useState<string[]>([]);
  const [filteredCards, setFilteredCards] = useState<WorkspaceCard[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // New state for saved views
  const [savedViews, setSavedViews] = useState<SavedWorkspaceView[]>([]);
  const [newViewName, setNewViewName] = useState('');
  const [selectedViewId, setSelectedViewId] = useState<string | null>(null);

  // Load saved views from settings
  useEffect(() => {
    const loadedSavedViews = props.plugin.settings.savedWorkspaceViews || [];
    setSavedViews(loadedSavedViews);

    // Attempt to load the last selected view on initial mount
    const lastViewId = props.plugin.settings.lastSelectedWorkspaceViewId;
    if (lastViewId) {
      const viewToLoad = loadedSavedViews.find((v) => v.id === lastViewId);
      if (viewToLoad) {
        setActiveFilterTags([...viewToLoad.tags]);
        setSelectedViewId(viewToLoad.id); // Update dropdown to reflect loaded view
      }
    }
  }, [
    props.plugin.settings.savedWorkspaceViews,
    props.plugin.settings.lastSelectedWorkspaceViewId,
  ]);

  // console.log('[WorkspaceView] Raw tag-colors setting:', JSON.stringify(props.plugin.settings['tag-colors'], null, 2));
  // console.log('[WorkspaceView] Raw tag-symbols setting:', JSON.stringify(props.plugin.settings['tag-symbols'], null, 2));

  const getTagColor = useMemo(() => {
    return getTagColorFn(props.plugin.settings['tag-colors'] || []);
  }, [props.plugin.settings]);

  const getTagEmoji = useMemo(() => {
    return getTagSymbolFn(props.plugin.settings['tag-symbols'] || []);
  }, [props.plugin.settings]);

  const handleAddTag = useCallback(() => {
    const newTag = currentTagInput.trim().toLowerCase().replace(/^#/, '');
    if (newTag && !activeFilterTags.includes(newTag)) {
      setActiveFilterTags((prevTags) => [...prevTags, newTag]);
    }
    setCurrentTagInput('');
  }, [currentTagInput, activeFilterTags]);

  const handleRemoveTag = useCallback((tagToRemove: string) => {
    setActiveFilterTags((prevTags) => prevTags.filter((tag) => tag !== tagToRemove));
  }, []);

  const handleScanDirectory = useCallback(
    async (tagsToFilterBy: string[]) => {
      // console.log('[WorkspaceView] handleScanDirectory called with tags:', tagsToFilterBy);
      setIsLoading(true);
      setError(null);
      setFilteredCards([]);
      const app = props.plugin.app;

      if (tagsToFilterBy.length === 0) {
        setError('Please add at least one tag to filter by.');
        setIsLoading(false);
        setFilteredCards([]);
        return;
      }

      const currentFile = app.workspace.getActiveFile();
      let targetFolder: TFolder | null = null;
      if (currentFile && currentFile.parent) {
        targetFolder = currentFile.parent;
      } else if (app.vault.getRoot().children.length > 0) {
        targetFolder = app.vault.getRoot();
      } else {
        // console.log('[WorkspaceView] No suitable target folder found initially.');
      }

      if (!targetFolder) {
        setError('Could not determine a directory to scan.');
        setIsLoading(false);
        return;
      }

      const allCards: WorkspaceCard[] = [];
      const getGlobalSettingsForStateManager = (): KanbanSettings => {
        return props.plugin.settings || DEFAULT_SETTINGS;
      };

      try {
        const allMdFiles = await recursivelyGetAllMdFilesInFolder(targetFolder);
        for (const mdFile of allMdFiles) {
          if (hasFrontmatterKey(mdFile)) {
            try {
              const fileContent = await props.plugin.app.vault.cachedRead(mdFile);
              const tempStateManager = new StateManager(
                props.plugin.app,
                {
                  app: props.plugin.app,
                  file: mdFile,
                  getWindow: () => window,
                  leaf: { view: {} },
                  requestSave: () => {},
                  onunload: () => {},
                  prerender: async () => {},
                  initHeaderButtons: () => {},
                  validatePreviewCache: () => {},
                  populateViewState: () => {},
                } as any,
                '',
                () => {},
                getGlobalSettingsForStateManager
              );

              const { ast } = parseMarkdown(tempStateManager, fileContent) as {
                ast: MdastRoot;
                settings: KanbanSettings;
              };

              let currentLaneTitle = 'Unknown Lane';
              for (const astNode of ast.children) {
                if (astNode.type === 'heading') {
                  currentLaneTitle = getHeadingText(astNode as MdastHeading) || 'Unnamed Lane';
                } else if (astNode.type === 'list') {
                  for (const listItemNode of (astNode as MdastList).children) {
                    if (listItemNode.type === 'listItem') {
                      const itemData: ItemData = listItemToItemData(
                        tempStateManager,
                        fileContent,
                        listItemNode as MdastListItem
                      );
                      const cardTags = (itemData.metadata?.tags || []).map((t) =>
                        t.replace(/^#/, '').toLowerCase()
                      );
                      const hasAllRequiredTags = tagsToFilterBy.every((reqTag) =>
                        cardTags.includes(reqTag)
                      );

                      if (hasAllRequiredTags) {
                        allCards.push({
                          id:
                            itemData.blockId ||
                            `${mdFile.path}-${currentLaneTitle}-${itemData.titleRaw.slice(0, 10)}-${Math.random()}`,
                          title: itemData.title,
                          tags: (itemData.metadata?.tags || []).map((t) =>
                            t.startsWith('#') ? t : `#${t}`
                          ),
                          sourceBoardName: mdFile.basename,
                          sourceBoardPath: mdFile.path,
                          laneTitle: currentLaneTitle,
                          blockId: itemData.blockId,
                        });
                      }
                    }
                  }
                }
              }
            } catch (parseError) {
              console.error(`[WorkspaceView] Error processing board ${mdFile.path}:`, parseError);
              setError(`Error processing ${mdFile.path}: ${parseError.message}`);
            }
          }
        }

        if (allCards.length > 0 && !(error && error.startsWith('Error processing'))) {
          setError(null);
        } else if (allCards.length === 0 && !error) {
          // UI will show "No cards found..." if filteredCards is empty and no error is set
        }
        setFilteredCards(allCards);
      } catch (e) {
        console.error('[WorkspaceView] Error scanning directory (outer catch):', e);
        setError(`Error scanning directory: ${e.message}`);
        setFilteredCards([]);
      }
      setIsLoading(false);
    },
    [props.plugin]
  );

  useEffect(() => {
    if (activeFilterTags.length > 0) {
      handleScanDirectory(activeFilterTags);
    } else {
      setFilteredCards([]);
      setError(null);
    }
  }, [activeFilterTags, handleScanDirectory]);

  const handleRowClick = useCallback(
    async (card: WorkspaceCard) => {
      const { app } = props.plugin;
      let linkPath = card.sourceBoardPath;
      let openState = {};

      if (card.blockId) {
        linkPath = `${card.sourceBoardPath}#^${card.blockId}`;
        // For blockId links, Obsidian usually handles scrolling and focusing.
        // We can still pass eState if we want our custom yellow border highlight.
        openState = {
          eState: {
            filePath: card.sourceBoardPath,
            blockId: card.blockId,
          },
        };
      } else {
        // Fallback if no blockId: try to highlight based on title and lane
        // This relies on KanbanView being able to process this eState for highlighting
        openState = {
          eState: {
            filePath: card.sourceBoardPath,
            cardTitle: card.title, // Need to ensure KanbanView can use this
            listName: card.laneTitle, // Need to ensure KanbanView can use this
          },
        };
      }

      // console.log(`[WorkspaceView] Opening link: ${linkPath} with state:`, openState);
      await app.workspace.openLinkText(linkPath, card.sourceBoardPath, false, { state: openState });
    },
    [props.plugin]
  );

  const handleSaveView = useCallback(async () => {
    if (!newViewName.trim() || activeFilterTags.length === 0) {
      // Optionally, show an error message to the user
      console.warn('[WorkspaceView] Cannot save view: name is empty or no active tags.');
      return;
    }
    const newId = Date.now().toString();
    const newSavedView: SavedWorkspaceView = {
      id: newId,
      name: newViewName.trim(),
      tags: [...activeFilterTags], // Save a copy of current tags
    };

    const currentSavedViews = props.plugin.settings.savedWorkspaceViews || [];
    const updatedViews = [...currentSavedViews, newSavedView];

    props.plugin.settings.savedWorkspaceViews = updatedViews;
    await props.plugin.saveSettings();
    // No need to call setSavedViews here as the useEffect listening to props.plugin.settings will update it.
    setNewViewName(''); // Clear input
    alert(`View "${newSavedView.name}" saved!`); // Simple feedback
  }, [newViewName, activeFilterTags, props.plugin]);

  const handleLoadView = useCallback(async () => {
    if (!selectedViewId) return;
    const viewToLoad = savedViews.find((v) => v.id === selectedViewId);
    if (viewToLoad) {
      setActiveFilterTags([...viewToLoad.tags]); // Set active tags, which will trigger re-scan
      // Save the loaded view ID as the last selected
      props.plugin.settings.lastSelectedWorkspaceViewId = viewToLoad.id;
      await props.plugin.saveSettings();
    }
  }, [selectedViewId, savedViews, props.plugin]);

  return (
    <div style={{ padding: '10px' }}>
      <h2>Kanban Workspace - Tag Filter</h2>

      {/* Combined Save/Load Section - MOVED HERE */}
      <div
        style={{
          marginTop: '10px',
          marginBottom: '20px',
          padding: '10px',
          border: '1px solid var(--background-modifier-border-hover)',
          borderRadius: '4px',
          maxWidth: '420px',
        }}
      >
        {/* Save View Controls */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
            marginBottom: savedViews.length > 0 ? '10px' : '0',
          }}
        >
          <input
            type="text"
            placeholder="Enter view name to save"
            value={newViewName}
            onInput={(e) => setNewViewName((e.target as HTMLInputElement).value)}
            style={{ flexGrow: 1, padding: '5px' }}
          />
          <button
            onClick={handleSaveView}
            disabled={!newViewName.trim() || activeFilterTags.length === 0}
            style={{ minWidth: '150px' }}
          >
            Save Current View
          </button>
        </div>

        {/* Load View Controls - only render if there are saved views */}
        {savedViews.length > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <select
              value={selectedViewId || ''}
              onChange={(e) => setSelectedViewId((e.target as HTMLSelectElement).value)}
              style={{ flexGrow: 1, padding: '5px' }}
            >
              <option value="" disabled>
                Select a view to load...
              </option>
              {savedViews.map((view) => (
                <option key={view.id} value={view.id}>
                  {view.name}
                </option>
              ))}
            </select>
            <button
              onClick={handleLoadView}
              disabled={!selectedViewId}
              style={{ minWidth: '150px' }}
            >
              Load Selected View
            </button>
          </div>
        )}
      </div>

      {/* Add Tag Section */}
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: '10px' }}>
        <label htmlFor="workspace-tag-input" style={{ marginRight: '5px' }}>
          Add Tag:{' '}
        </label>
        <input
          type="text"
          id="workspace-tag-input"
          value={currentTagInput}
          onInput={(e) => setCurrentTagInput((e.target as HTMLInputElement).value)}
          onKeyPress={(e) => {
            if (e.key === 'Enter') {
              handleAddTag();
              e.preventDefault();
            }
          }}
          style={{ marginRight: '5px' }}
          placeholder="e.g. mechanics"
        />
        <button onClick={handleAddTag} disabled={!currentTagInput.trim()}>
          +
        </button>
      </div>

      {/* Active tags display - REMAINS BELOW ADD TAG */}
      {activeFilterTags.length > 0 && (
        <div style={{ marginBottom: '10px', display: 'flex', flexWrap: 'wrap', gap: '5px' }}>
          {activeFilterTags.map((tag) => {
            const tagWithHashForLookup = `#${tag}`;
            const colorSetting = getTagColor(tagWithHashForLookup);
            const emoji = getTagEmoji(tagWithHashForLookup);
            const colorValue = colorSetting ? colorSetting.color : undefined;
            const bgColor = colorSetting ? colorSetting.backgroundColor : undefined;
            const displayTag = emoji ? `${emoji} ${tag}` : tag;

            return (
              <span
                key={tag}
                style={{
                  color: colorValue,
                  backgroundColor: bgColor,
                  padding: '3px 6px',
                  borderRadius: '4px',
                  marginRight: '5px',
                  display: 'inline-flex',
                  alignItems: 'center',
                  fontSize: '0.9em',
                  border: bgColor ? 'none' : '1px solid var(--background-modifier-border)',
                }}
              >
                {displayTag}
                <button
                  onClick={() => handleRemoveTag(tag)}
                  style={{
                    marginLeft: '5px',
                    background: 'transparent',
                    border: 'none',
                    color: colorValue || 'var(--text-muted)',
                    cursor: 'pointer',
                    padding: '0 2px',
                    fontSize: '1.1em',
                    lineHeight: '1',
                    opacity: 0.7,
                  }}
                  title={`Remove tag ${tag}`}
                  onMouseEnter={(e) => (e.currentTarget.style.opacity = '1')}
                  onMouseLeave={(e) => (e.currentTarget.style.opacity = '0.7')}
                >
                  &times;
                </button>
              </span>
            );
          })}
        </div>
      )}

      {/* Error and Table display - REMAINS AT THE BOTTOM */}
      {error && <div style={{ color: 'red', marginTop: '10px' }}>Error: {error}</div>}
      <div
        style={{
          marginTop: '20px',
          border: '1px solid var(--background-modifier-border)',
        }}
      >
        {isLoading && (
          <p>
            <i>Loading cards...</i>
          </p>
        )}
        {!isLoading && filteredCards.length === 0 && !error && activeFilterTags.length > 0 && (
          <p>
            <i>No cards found matching the selected tags in this directory.</i>
          </p>
        )}
        {!isLoading && filteredCards.length === 0 && !error && activeFilterTags.length === 0 && (
          <p>
            <i>Add one or more tags above to automatically find cards.</i>
          </p>
        )}
        {!isLoading && filteredCards.length > 0 && (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th
                  style={{
                    border: '1px solid var(--background-modifier-border)',
                    padding: '4px',
                    paddingLeft: '0px',
                  }}
                >
                  Ticket
                </th>
                <th
                  style={{
                    border: '1px solid var(--background-modifier-border)',
                    padding: '4px',
                    textAlign: 'center',
                  }}
                >
                  Category
                </th>
                <th
                  style={{
                    border: '1px solid var(--background-modifier-border)',
                    padding: '4px',
                    textAlign: 'center',
                  }}
                >
                  Board
                </th>
                <th
                  style={{
                    border: '1px solid var(--background-modifier-border)',
                    padding: '4px',
                    textAlign: 'center',
                  }}
                >
                  Tags
                </th>
              </tr>
            </thead>
            <tbody>
              {filteredCards.map((card) => (
                <tr
                  key={card.id}
                  onClick={() => handleRowClick(card)}
                  style={{ cursor: 'pointer' }}
                  onMouseEnter={(e) =>
                    (e.currentTarget.style.backgroundColor = 'var(--background-secondary-alt)')
                  }
                  onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
                >
                  <td
                    style={{
                      border: '1px solid var(--background-modifier-border)',
                      padding: '4px',
                      paddingLeft: '8px',
                    }}
                  >
                    {card.title}
                  </td>
                  <td
                    style={{
                      border: '1px solid var(--background-modifier-border)',
                      padding: '4px',
                      textAlign: 'center',
                    }}
                  >
                    {card.laneTitle}
                  </td>
                  <td
                    style={{
                      border: '1px solid var(--background-modifier-border)',
                      padding: '4px',
                      textAlign: 'center',
                    }}
                  >
                    {card.sourceBoardName}
                  </td>
                  <td
                    style={{
                      border: '1px solid var(--background-modifier-border)',
                      padding: '4px',
                      textAlign: 'center',
                    }}
                  >
                    {card.tags.map((tagWithHash) => {
                      const colorSetting = getTagColor(tagWithHash);
                      const emoji = getTagEmoji(tagWithHash);
                      const colorValue = colorSetting ? colorSetting.color : undefined;
                      const bgColor = colorSetting ? colorSetting.backgroundColor : undefined;
                      const tagNameForDisplay = tagWithHash.substring(1);
                      const displayTag = emoji
                        ? `${emoji} ${tagNameForDisplay}`
                        : tagNameForDisplay;

                      return (
                        <span
                          key={tagWithHash}
                          style={{
                            color: colorValue,
                            backgroundColor: bgColor,
                            marginRight: '6px',
                            padding: '2px 4px',
                            borderRadius: '3px',
                          }}
                        >
                          {displayTag}
                        </span>
                      );
                    })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

export class KanbanWorkspaceView extends ItemView {
  plugin: KanbanPlugin;

  constructor(leaf: WorkspaceLeaf, plugin: KanbanPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType() {
    return KANBAN_WORKSPACE_VIEW_TYPE;
  }

  getDisplayText() {
    return 'Kanban Workspace';
  }

  getIcon() {
    return KANBAN_WORKSPACE_ICON;
  }

  async onOpen() {
    render(<KanbanWorkspaceViewComponent plugin={this.plugin} />, this.contentEl);
  }

  async onClose() {
    unmountComponentAtNode(this.contentEl);
  }
}
