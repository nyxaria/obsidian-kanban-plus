import {
  Heading as MdastHeading,
  List as MdastList,
  ListItem as MdastListItem,
  Root as MdastRoot,
} from 'mdast';
import { FileView, ItemView, TFile, TFolder, WorkspaceLeaf, normalizePath } from 'obsidian';
import { render, unmountComponentAtNode } from 'preact/compat';
import { useCallback, useEffect, useMemo, useState } from 'preact/hooks';

import { KanbanView } from './KanbanView';
import { DEFAULT_SETTINGS, KanbanSettings, SavedWorkspaceView } from './Settings';
import { StateManager } from './StateManager';
import { getTagColorFn, getTagSymbolFn } from './components/helpers';
import { ItemData, TagColor, TagSymbolSetting, TeamMemberColorConfig } from './components/types';
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
  assignedMembers?: string[];
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
  const [selectedMemberForFilter, setSelectedMemberForFilter] = useState('');
  const [activeFilterMembers, setActiveFilterMembers] = useState<string[]>([]);
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
        setActiveFilterMembers(viewToLoad.members ? [...viewToLoad.members] : []);
        setSelectedViewId(viewToLoad.id);
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

  const hideHashForTagsWithoutSymbols =
    props.plugin.settings.hideHashForTagsWithoutSymbols ??
    DEFAULT_SETTINGS.hideHashForTagsWithoutSymbols;

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

  // New handlers for member filters
  const handleAddMemberFilter = useCallback(() => {
    const newMember = selectedMemberForFilter;
    if (newMember && !activeFilterMembers.includes(newMember)) {
      setActiveFilterMembers((prevMembers) => [...prevMembers, newMember]);
    }
    setSelectedMemberForFilter('');
  }, [selectedMemberForFilter, activeFilterMembers]);

  const handleRemoveMemberFilter = useCallback((memberToRemove: string) => {
    setActiveFilterMembers((prevMembers) =>
      prevMembers.filter((member) => member !== memberToRemove)
    );
  }, []);

  const handleScanDirectory = useCallback(
    async (tagsToFilterBy: string[], membersToFilterBy: string[]) => {
      setIsLoading(true);
      setError(null);
      setFilteredCards([]);
      const app = props.plugin.app;

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
                { file: mdFile } as any,
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
                  const rawLaneTitle = getHeadingText(astNode as MdastHeading) || 'Unnamed Lane';
                  currentLaneTitle = rawLaneTitle.replace(/\s*\(\d+\)$/, '').trim();
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
                      const hasAllRequiredTags =
                        tagsToFilterBy.length === 0 ||
                        tagsToFilterBy.every((reqTag) => cardTags.includes(reqTag));

                      // Member filtering logic - case-sensitive
                      const cardAssignedMembers = itemData.assignedMembers || []; // Already string[] from parser
                      const hasAllRequiredMembers =
                        membersToFilterBy.length === 0 ||
                        membersToFilterBy.every((reqMember) =>
                          cardAssignedMembers.includes(reqMember)
                        );

                      if (hasAllRequiredTags && hasAllRequiredMembers) {
                        allCards.push({
                          id:
                            itemData.blockId ||
                            `${mdFile.path}-${currentLaneTitle}-${itemData.titleRaw.slice(0, 10)}-${Math.random()}`,
                          title: itemData.title,
                          tags: (itemData.metadata?.tags || []).map((t) =>
                            t.startsWith('#') ? t : `#${t}`
                          ),
                          assignedMembers: itemData.assignedMembers || [],
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
    [props.plugin, setIsLoading, setError, setFilteredCards]
  );

  useEffect(() => {
    handleScanDirectory(activeFilterTags, activeFilterMembers);
  }, [activeFilterTags, activeFilterMembers, handleScanDirectory]);

  const handleRowClick = useCallback(
    async (card: WorkspaceCard) => {
      const { app } = props.plugin;
      const targetPath = card.sourceBoardPath;
      console.log(`[WorkspaceView] handleRowClick: Target path from card: '${targetPath}'`);
      let existingLeaf: WorkspaceLeaf | null = null;

      // Normalize targetPath. It should be normalized already as it comes from TFile.path,
      // but this ensures consistency.
      const normalizedTargetPath = normalizePath(targetPath);
      console.log(
        `[WorkspaceView] Normalized target path for comparison: '${normalizedTargetPath}'`
      );

      // const leaves = app.workspace.getLeavesOfType('markdown'); // Previous approach
      // console.log(`[WorkspaceView] Found ${leaves.length} markdown leaves to check.`);

      const allLeaves: WorkspaceLeaf[] = [];
      app.workspace.iterateAllLeaves((leaf) => {
        allLeaves.push(leaf);
      });
      console.log(`[WorkspaceView] Found ${allLeaves.length} total leaves to check.`);

      for (const leaf of allLeaves) {
        // Iterate over all leaves
        let currentLeafPath: string | undefined = undefined;
        const view = leaf.view;

        if (view instanceof KanbanView) {
          // For KanbanView, get the file path from the view's file property
          if (view.file) {
            currentLeafPath = view.file.path;
            console.log(
              `[WorkspaceView] Leaf (type: kanban) is KanbanView. Path from .file.path: '${currentLeafPath}'`
            );
          }
        } else if (view instanceof FileView) {
          // For other FileViews (like markdown editor), get path from .file.path
          if ((view as FileView).file) {
            currentLeafPath = (view as FileView).file.path;
            console.log(
              `[WorkspaceView] Leaf (type: ${view.getViewType()}) is FileView. Path from .file.path: '${currentLeafPath}'`
            );
          }
        }

        // Fallback or alternative: check getViewState if path not found yet
        if (!currentLeafPath) {
          const leafState = leaf.getViewState();
          const fileFromState = leafState.state?.file;
          if (typeof fileFromState === 'string') {
            currentLeafPath = fileFromState;
            console.log(
              `[WorkspaceView] Leaf (type: ${view.getViewType()}) path from .getViewState().state.file: '${currentLeafPath}'`
            );
          } else {
            console.log(
              `[WorkspaceView] Leaf (type: ${view.getViewType()}) path from .getViewState().state.file is not a string or is undefined. Value:`,
              fileFromState
            );
          }
        }

        if (currentLeafPath) {
          const normalizedLeafPath = normalizePath(currentLeafPath);
          console.log(
            `[WorkspaceView] Checking leaf: Type: ${view.getViewType()}, ` +
              `Orig Path: '${currentLeafPath}', Norm Path: '${normalizedLeafPath}'`
          );

          if (normalizedLeafPath === normalizedTargetPath) {
            console.log('[WorkspaceView] Found existing leaf for path:', normalizedTargetPath);
            existingLeaf = leaf;
            break; // Exit loop as we found a matching leaf
          }
        } else {
          console.log(
            `[WorkspaceView] Checking leaf: Type: ${view.getViewType()}, Path: undefined (cannot compare)`
          );
        }
      }

      console.log(
        '[WorkspaceView] Existing leaf found?',
        existingLeaf ? `${existingLeaf.view.getViewType()} was found` : 'No'
      );

      const navigationState = {
        // Ensure the file path is part of the state for existing views
        file: card.sourceBoardPath,
        eState: {
          filePath: card.sourceBoardPath, // Use original path for state consistency
          blockId: card.blockId,
          cardTitle: !card.blockId ? card.title : undefined,
          listName: !card.blockId ? card.laneTitle : undefined,
        },
      };

      if (existingLeaf) {
        console.log(
          `[WorkspaceView] Activating existing leaf. View type: ${existingLeaf.view.getViewType()}`
        );
        app.workspace.setActiveLeaf(existingLeaf, { focus: true });

        // Check if the view in the existing leaf is a KanbanView
        if (existingLeaf.view instanceof KanbanView) {
          console.log('[WorkspaceView] Existing leaf is KanbanView instance. Calling setState.');
          // *** MODIFICATION HERE ***
          const stateForExistingLeaf = {
            file: card.sourceBoardPath, // Keep passing the file
            eState: {
              filePath: card.sourceBoardPath,
              blockId: card.blockId,
              cardTitle: !card.blockId ? card.title : undefined,
              listName: !card.blockId ? card.laneTitle : undefined,
              preventSetViewData: true, // Add this line
            },
          };
          (existingLeaf.view as KanbanView).setState(stateForExistingLeaf, { history: false });
          console.log('[WorkspaceView] setState called on existing KanbanView instance.');
        } else if (existingLeaf.view.getViewType() === 'kanban') {
          // ... (similar modification for the fallback cast) ...
          const stateForExistingLeafFallback = {
            file: card.sourceBoardPath,
            eState: {
              filePath: card.sourceBoardPath,
              blockId: card.blockId,
              cardTitle: !card.blockId ? card.title : undefined,
              listName: !card.blockId ? card.laneTitle : undefined,
              preventSetViewData: true, // Add this line
            },
          };
          (existingLeaf.view as unknown as KanbanView).setState(stateForExistingLeafFallback, {
            history: false,
          });
          // ...
        } else {
          // ...
        }
      } else {
        // When opening in a NEW leaf, preventSetViewData should be false or absent
        const navigationStateForNewLeaf = {
          file: card.sourceBoardPath, // Still needed by KanbanView's setState
          eState: {
            filePath: card.sourceBoardPath,
            blockId: card.blockId,
            cardTitle: !card.blockId ? card.title : undefined,
            listName: !card.blockId ? card.laneTitle : undefined,
            // No preventSetViewData: true here
          },
        };
        console.log('[WorkspaceView] No existing leaf found. Opening new link.');
        let linkPath = card.sourceBoardPath;
        if (card.blockId) {
          linkPath = `${card.sourceBoardPath}#^${card.blockId}`;
        }
        console.log(
          `[WorkspaceView] Opening link: '${linkPath}' with state:`,
          navigationStateForNewLeaf
        );
        await app.workspace.openLinkText(linkPath, card.sourceBoardPath, false, {
          state: navigationStateForNewLeaf, // Pass the state for new leaf
        });
      }
    },
    [props.plugin]
  );

  const handleSaveView = useCallback(async () => {
    if (!newViewName.trim()) {
      console.warn('[WorkspaceView] Cannot save view: name is empty.');
      return;
    }
    const newId = Date.now().toString();
    const newSavedView: SavedWorkspaceView = {
      id: newId,
      name: newViewName.trim(),
      tags: [...activeFilterTags],
      members: [...activeFilterMembers], // Save active member filters
    };

    const currentSavedViews = props.plugin.settings.savedWorkspaceViews || [];
    const updatedViews = [...currentSavedViews, newSavedView];

    props.plugin.settings.savedWorkspaceViews = updatedViews;
    props.plugin.settings.lastSelectedWorkspaceViewId = newSavedView.id;
    await props.plugin.saveSettings();

    setSavedViews(updatedViews);
    setSelectedViewId(newSavedView.id);
    // No need to set activeFilterTags/Members here, as useEffect on selectedViewId or handleScanDirectory will react
    setNewViewName('');
  }, [
    newViewName,
    activeFilterTags,
    activeFilterMembers,
    props.plugin,
    setSavedViews,
    setSelectedViewId,
    setNewViewName,
  ]); // Added activeFilterMembers and setters to deps

  const handleDeleteView = useCallback(async () => {
    if (!selectedViewId) {
      console.warn('[WorkspaceView] Cannot delete view: no view selected.');
      return;
    }
    const viewToDelete = savedViews.find((v) => v.id === selectedViewId);
    if (!viewToDelete) {
      console.warn('[WorkspaceView] Cannot delete view: selected view not found.');
      return;
    }
    if (!confirm(`Are you sure you want to delete the view "${viewToDelete.name}"?`)) {
      return;
    }

    const updatedViews = savedViews.filter((v) => v.id !== selectedViewId);
    props.plugin.settings.savedWorkspaceViews = updatedViews;

    if (props.plugin.settings.lastSelectedWorkspaceViewId === selectedViewId) {
      props.plugin.settings.lastSelectedWorkspaceViewId = undefined;
      // Clear filters if the deleted view was the last selected active one
      setActiveFilterTags([]);
      setActiveFilterMembers([]);
    }

    await props.plugin.saveSettings();
    setSavedViews(updatedViews);
    setSelectedViewId(null);
    // If another view becomes selected (e.g., first in list), its filters would be loaded by dropdown onChange or useEffect.
    // If no view is selected, filters are already cleared (or should be if last selected was deleted).
  }, [
    selectedViewId,
    savedViews,
    props.plugin,
    setActiveFilterTags,
    setActiveFilterMembers,
    setSavedViews,
    setSelectedViewId,
  ]); // Added setters to deps

  const availableTeamMembers = useMemo(() => {
    return props.plugin.settings.teamMembers || [];
  }, [props.plugin.settings.teamMembers]);

  return (
    <div style={{ padding: '10px' }}>
      <h2>Kanban Workspace - Filters</h2>

      {/* Combined Save/Load Section - MOVED HERE */}
      <div
        style={{
          marginTop: '10px',
          marginBottom: '20px',
          padding: '10px',
          border: '1px solid var(--background-modifier-border-hover)',
          borderRadius: '4px',
          maxWidth: '320px',
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
            disabled={!newViewName.trim()}
            style={{ minWidth: '65px' }}
          >
            Save
          </button>
        </div>

        {/* Load View Controls - only render if there are saved views */}
        {savedViews.length > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <select
              value={selectedViewId || ''}
              onChange={async (e) => {
                // Make onChange async
                const newId = (e.target as HTMLSelectElement).value;
                setSelectedViewId(newId);
                if (newId) {
                  const viewToLoad = savedViews.find((v) => v.id === newId);
                  if (viewToLoad) {
                    setActiveFilterTags([...viewToLoad.tags]);
                    setActiveFilterMembers(viewToLoad.members ? [...viewToLoad.members] : []);
                    props.plugin.settings.lastSelectedWorkspaceViewId = viewToLoad.id;
                    await props.plugin.saveSettings();
                  }
                }
              }}
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
              onClick={handleDeleteView}
              disabled={!selectedViewId}
              style={{
                minWidth: '65px',
                backgroundColor: 'var(--background-modifier-error)',
                color: 'var(--text-on-accent)',
              }} // Adjusted width and added styling
              title="Delete selected view"
            >
              Delete
            </button>
          </div>
        )}
      </div>

      {/* Combined Filter Input Sections */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '20px',
          marginTop: '20px',
          marginBottom: '10px',
        }}
      >
        {/* Add Tag Section */}
        <div style={{ display: 'flex', alignItems: 'center' }}>
          <label htmlFor="workspace-tag-input" style={{ marginRight: '5px' }}>
            Filter by Tag:{' '}
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
            style={{ marginRight: '0px' }}
            placeholder="e.g. mechanics"
          />
          <button onClick={handleAddTag} disabled={!currentTagInput.trim()}>
            +
          </button>
        </div>

        {/* Add Member Filter Section */}
        <div style={{ display: 'flex', alignItems: 'center' }}>
          <label htmlFor="workspace-member-select" style={{ marginRight: '5px' }}>
            Filter by Member:{' '}
          </label>
          <select
            id="workspace-member-select"
            value={selectedMemberForFilter}
            onChange={(e) => setSelectedMemberForFilter((e.target as HTMLSelectElement).value)}
            style={{ marginRight: '0px', minWidth: '150px', padding: '5px' }}
          >
            <option value="">Select a member...</option>
            {availableTeamMembers.map((member) => (
              <option key={member} value={member}>
                {member}
              </option>
            ))}
          </select>
          <button onClick={handleAddMemberFilter} disabled={!selectedMemberForFilter.trim()}>
            +
          </button>
        </div>
      </div>

      {/* Active tags display - REMAINS BELOW ADD TAG */}
      {/* {activeFilterTags.length > 0 && (
        <div style={{ marginBottom: '10px', display: 'flex', flexWrap: 'wrap', gap: '5px' }}>
          {activeFilterTags.map((tag) => {
            const tagWithHashForLookup = `#${tag}`;
            const colorSetting = getTagColor(tagWithHashForLookup);
            const symbolInfo = getTagEmoji(tagWithHashForLookup);
            const colorValue = colorSetting ? colorSetting.color : undefined;
            const bgColor = colorSetting ? colorSetting.backgroundColor : undefined;

            let displayContent = null;
            if (symbolInfo) {
              displayContent = (
                <>
                  {symbolInfo.symbol}
                  {!symbolInfo.hideTag && <span style={{ marginLeft: '4px' }}>{tag}</span>}
                </>
              );
            } else {
              if (hideHashForTagsWithoutSymbols) {
                displayContent = tag;
              } else {
                displayContent = `#${tag}`;
              }
            }

            return (
              <span
                key={tag}
                style={{
                  color: colorValue,
                  backgroundColor: bgColor,
                  padding: '0px 6px',
                  borderRadius: '4px',
                  marginRight: '5px',
                  display: 'inline-flex',
                  alignItems: 'center',
                  fontSize: '0.9em',
                  border: bgColor ? 'none' : '1px solid var(--background-modifier-border)',
                }}
              >
                {displayContent}
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
      )} */}

      {/* Active Member Filters Display */}
      {(activeFilterTags.length > 0 || activeFilterMembers.length > 0) && (
        <div
          style={{
            marginBottom: '20px',
            display: 'flex',
            flexWrap: 'wrap',
            gap: '8px', // Increased gap for better separation
            padding: '8px',
            borderRadius: '4px',
          }}
        >
          {/* Display Active Member Filters First */}
          {activeFilterMembers.map((member) => {
            const memberConfig = props.plugin.settings.teamMemberColors?.[member] as
              | TeamMemberColorConfig
              | undefined;
            const backgroundColor = memberConfig?.background || 'var(--background-modifier-hover)';
            const textColor =
              memberConfig?.text ||
              (memberConfig?.background ? 'var(--text-on-accent)' : 'var(--text-normal)');
            return (
              <span
                key={`member-filter-${member}`}
                style={{
                  backgroundColor: backgroundColor,
                  color: textColor,
                  padding: '0px 9px',
                  borderRadius: '4px',
                  display: 'inline-flex',
                  alignItems: 'center',
                  fontSize: '0.9em',
                  fontWeight: '500',
                }}
              >
                {member}
                <button
                  onClick={() => handleRemoveMemberFilter(member)}
                  style={{
                    marginLeft: '6px',
                    background: 'transparent',
                    border: 'none',
                    color: 'var(--text-muted)',
                    cursor: 'pointer',
                    padding: '0 3px',
                    fontSize: '1.1em',
                    lineHeight: '1',
                    opacity: 0.7,
                  }}
                  title={`Remove member filter: ${member}`}
                  onMouseEnter={(e) => (e.currentTarget.style.opacity = '1')}
                  onMouseLeave={(e) => (e.currentTarget.style.opacity = '0.7')}
                >
                  &times;
                </button>
              </span>
            );
          })}
          {/* Display Active Tag Filters */}
          {activeFilterTags.map((tag) => {
            const tagWithHashForLookup = `#${tag}`;
            const colorSetting = getTagColor(tagWithHashForLookup);
            const symbolInfo = getTagEmoji(tagWithHashForLookup);
            const colorValue = colorSetting ? colorSetting.color : undefined;
            const bgColor = colorSetting ? colorSetting.backgroundColor : undefined;

            let displayContent = null;
            if (symbolInfo) {
              displayContent = (
                <>
                  {symbolInfo.symbol}
                  {!symbolInfo.hideTag && <span style={{ marginLeft: '4px' }}>{tag}</span>}
                </>
              );
            } else {
              if (hideHashForTagsWithoutSymbols) {
                displayContent = tag;
              } else {
                displayContent = `#${tag}`;
              }
            }

            return (
              <span
                key={`tag-filter-${tag}`}
                style={{
                  color: colorValue,
                  backgroundColor: bgColor,
                  padding: '2px 8px',
                  borderRadius: '4px',
                  display: 'inline-flex',
                  alignItems: 'center',
                  fontSize: '0.9em',
                  border: bgColor ? 'none' : '1px solid var(--background-modifier-border)',
                }}
              >
                {displayContent}
                <button
                  onClick={() => handleRemoveTag(tag)}
                  style={{
                    marginLeft: '6px',
                    background: 'transparent',
                    border: 'none',
                    color: colorValue || 'var(--text-muted)',
                    cursor: 'pointer',
                    padding: '0 3px',
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
            <i> Loading cards...</i>
          </p>
        )}
        {!isLoading && filteredCards.length === 0 && !error && activeFilterTags.length > 0 && (
          <p>
            <i> No cards found matching the selected tags in this directory.</i>
          </p>
        )}
        {!isLoading && filteredCards.length === 0 && !error && activeFilterTags.length === 0 && (
          <p>
            <i> No cards found in the current scan scope.</i>
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
                      display: 'flex',
                      flexWrap: 'wrap',
                      gap: '4px',
                      justifyContent: 'center',
                    }}
                  >
                    {card.assignedMembers &&
                      card.assignedMembers.length > 0 &&
                      card.assignedMembers.map((member) => {
                        const memberConfig = props.plugin.settings.teamMemberColors?.[member] as
                          | TeamMemberColorConfig
                          | undefined;
                        const backgroundColor =
                          memberConfig?.background || 'var(--background-modifier-accent-hover)';
                        const textColor =
                          memberConfig?.text ||
                          (memberConfig?.background
                            ? 'var(--text-on-accent)'
                            : 'var(--text-normal)');
                        return (
                          <span
                            key={`${card.id}-member-${member}`}
                            style={{
                              backgroundColor: backgroundColor,
                              color: textColor,
                              padding: '2px 6px',
                              borderRadius: '3px',
                              fontSize: '0.85em',
                              display: 'inline-flex',
                              alignItems: 'center',
                            }}
                            title={`Assigned: ${member}`}
                          >
                            {member}
                          </span>
                        );
                      })}
                    {card.tags.map((tagWithHash) => {
                      const colorSetting = getTagColor(tagWithHash);
                      const symbolInfo = getTagEmoji(tagWithHash);
                      const colorValue = colorSetting ? colorSetting.color : undefined;
                      const bgColor = colorSetting ? colorSetting.backgroundColor : undefined;
                      const tagNameForDisplay = tagWithHash.substring(1);

                      let displayContent = null;
                      if (symbolInfo) {
                        displayContent = (
                          <>
                            {symbolInfo.symbol}
                            {!symbolInfo.hideTag && (
                              <span style={{ marginLeft: '4px' }}>{tagNameForDisplay}</span>
                            )}
                          </>
                        );
                      } else {
                        if (hideHashForTagsWithoutSymbols) {
                          displayContent = tagNameForDisplay;
                        } else {
                          displayContent = tagWithHash;
                        }
                      }

                      return (
                        <span
                          key={tagWithHash}
                          style={{
                            color: colorValue,
                            backgroundColor: bgColor,
                            padding: '2px 4px',
                            borderRadius: '3px',
                            display: 'inline-flex',
                            alignItems: 'center',
                          }}
                        >
                          {displayContent}
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
