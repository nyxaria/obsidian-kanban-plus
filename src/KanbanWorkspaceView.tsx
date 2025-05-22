import {
  Heading as MdastHeading,
  List as MdastList,
  ListItem as MdastListItem,
  Root as MdastRoot,
} from 'mdast';
import moment from 'moment';
import {
  App,
  Events, // Import Events
  FileView,
  ItemView,
  Menu,
  MenuItem,
  Modal,
  Notice,
  Setting,
  TFile,
  TFolder,
  WorkspaceLeaf,
  normalizePath,
} from 'obsidian';
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
  date?: moment.Moment;
  sourceStartLine?: number;
  checked?: boolean;
  priority?: 'high' | 'medium' | 'low'; // <-- New property
}

// Define an internal type for pre-filtered cards
interface WorkspaceCardInternal {
  itemData: ItemData;
  currentLaneTitle: string;
  sourceBoardPath: string;
  sourceBoardName: string;
  sourceStartLine?: number;
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

// Utility to escape strings for regex
function escapeRegExp(string: string): string {
  return string.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&'); // $& means the whole matched string
}

// --- Simple Modal for Date Input ---
class DateInputModal extends Modal {
  currentDate: string; // YYYY-MM-DD format
  onSubmit: (newDate: string | null) => void;

  constructor(app: App, currentDate: string, onSubmit: (newDate: string | null) => void) {
    super(app);
    this.currentDate = currentDate;
    this.onSubmit = onSubmit;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h2', { text: 'Set/Change Due Date' });

    let dateStrFromPicker: string = this.currentDate; // Store date from picker

    new Setting(contentEl)
      .setName('Due Date')
      .setDesc('Select a date, or clear the input to remove the due date.')
      .addMomentFormat((momentFormat) => {
        // Configure the moment format component
        momentFormat
          .setPlaceholder('YYYY-MM-DD')
          .setValue(this.currentDate) // Expects YYYY-MM-DD for initial value if set
          .onChange((value: string) => {
            dateStrFromPicker = value; // Update on change
          });
      });

    new Setting(contentEl)
      .addButton((btn) =>
        btn
          .setButtonText('Save')
          .setCta()
          .onClick(() => {
            this.close();
            this.onSubmit(dateStrFromPicker);
          })
      )
      .addButton((btn) =>
        btn.setButtonText('Cancel').onClick(() => {
          this.close();
          this.onSubmit(null); // Indicate cancellation
        })
      );
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}
// --- End Date Input Modal ---

// Basic React component for the workspace view
function KanbanWorkspaceViewComponent(props: { plugin: KanbanPlugin; viewEvents: Events }) {
  const [currentTagInput, setCurrentTagInput] = useState('');
  const [activeFilterTags, setActiveFilterTags] = useState<string[]>([]);
  const [selectedMemberForFilter, setSelectedMemberForFilter] = useState('');
  const [activeFilterMembers, setActiveFilterMembers] = useState<string[]>([]);
  const [dueDateFilterValue, setDueDateFilterValue] = useState<number | ''>('');
  const [dueDateFilterUnit, setDueDateFilterUnit] = useState<'days' | 'weeks' | 'months'>('days');
  const [filteredCards, setFilteredCards] = useState<WorkspaceCard[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // New toggles for Archive and Done
  const [excludeArchive, setExcludeArchive] = useState(true);
  const [excludeDone, setExcludeDone] = useState(true);

  // New state for saved views
  const [savedViews, setSavedViews] = useState<SavedWorkspaceView[]>([]);
  const [newViewName, setNewViewName] = useState('');
  const [selectedViewId, setSelectedViewId] = useState<string | null>(null);

  // ADDED: New state for all available tags (stored WITHOUT #)
  const [allScannedTags, setAllScannedTags] = useState<string[]>([]);

  // Load saved views from settings
  useEffect(() => {
    const loadedSavedViews = props.plugin.settings.savedWorkspaceViews || [];
    setSavedViews(loadedSavedViews);

    // Attempt to load the last selected view on initial mount
    const lastViewId = props.plugin.settings.lastSelectedWorkspaceViewId;
    if (lastViewId) {
      const viewToLoad = loadedSavedViews.find((v) => v.id === lastViewId);
      if (viewToLoad) {
        // MODIFIED: Ensure tags loaded from saved view are stripped of leading '#'
        setActiveFilterTags(viewToLoad.tags.map((t) => t.replace(/^#/, '')));
        setActiveFilterMembers(viewToLoad.members ? [...viewToLoad.members] : []);
        if (viewToLoad.dueDateFilter) {
          setDueDateFilterValue(viewToLoad.dueDateFilter.value);
          setDueDateFilterUnit(viewToLoad.dueDateFilter.unit);
        } else {
          setDueDateFilterValue('');
          setDueDateFilterUnit('days');
        }
        // Load new toggles, defaulting to true if not present
        setExcludeArchive(viewToLoad.excludeArchive ?? true);
        setExcludeDone(viewToLoad.excludeDone ?? true);
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
    async (
      tagsToFilterBy: string[],
      membersToFilterBy: string[],
      currentDueDateValue: number | '', // ADDED PARAM
      currentDueDateUnit: 'days' | 'weeks' | 'months', // ADDED PARAM
      currentExcludeArchive: boolean, // ADDED PARAM
      currentExcludeDone: boolean // ADDED PARAM
    ) => {
      console.log(
        '[WorkspaceView] handleScanDirectory called with:',
        'Tags:',
        tagsToFilterBy,
        'Members:',
        membersToFilterBy,
        'Due Value:',
        currentDueDateValue, // USE PARAM
        'Due Unit:',
        currentDueDateUnit, // USE PARAM
        'Exclude Archive:',
        currentExcludeArchive, // USE PARAM
        'Exclude Done:',
        currentExcludeDone // USE PARAM
      );
      setIsLoading(true);
      setError(null);
      // setFilteredCards([]); // Keep existing cards while loading new ones, or clear if preferred
      const app = props.plugin.app;

      // Due Date Filter Logic - START
      let maxDueDate: moment.Moment | null = null;
      if (typeof currentDueDateValue === 'number' && currentDueDateValue > 0) {
        // USE PARAM
        maxDueDate = moment().add(currentDueDateValue, currentDueDateUnit).endOf('day'); // USE PARAMS
      }
      const today = moment().startOf('day');
      // Due Date Filter Logic - END

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
      const allCardsDataPreFilter: WorkspaceCardInternal[] = []; // This is correctly declared
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

                      // Manually hydrate the date field from dateStr (important for any subsequent logic)
                      if (itemData.metadata?.dateStr && !moment.isMoment(itemData.metadata.date)) {
                        itemData.metadata.date = moment(
                          itemData.metadata.dateStr,
                          tempStateManager.getSetting('date-format')
                        );
                      }

                      // CORRECTED: Populate allCardsDataPreFilter with all parsed items
                      allCardsDataPreFilter.push({
                        itemData,
                        currentLaneTitle,
                        sourceBoardPath: mdFile.path,
                        sourceBoardName: mdFile.basename,
                        sourceStartLine: listItemNode.position?.start.line,
                      });
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

        // MOVED AND CORRECTED: Populate allScannedTags from all cardsDataPreFilter (which now contains all items)
        const uniqueTagsFromAllPossibleCards = new Set<string>();
        allCardsDataPreFilter.forEach((internalCard) => {
          internalCard.itemData.metadata?.tags?.forEach((tag) => {
            if (tag && tag.trim() !== '') {
              uniqueTagsFromAllPossibleCards.add(tag.trim().replace(/^#/, '')); // Store without leading #
            }
          });
        });
        const sortedUniqueTags = Array.from(uniqueTagsFromAllPossibleCards).sort();
        setAllScannedTags(sortedUniqueTags);
        console.log('[WorkspaceView] All scanned tags (for dropdown):', sortedUniqueTags);

        // Now, filter from allCardsDataPreFilter to populate the final allCards array for display
        for (const internalCard of allCardsDataPreFilter) {
          const { itemData, currentLaneTitle, sourceBoardPath, sourceBoardName, sourceStartLine } =
            internalCard;

          // Filters are applied here, using parameters like tagsToFilterBy, membersToFilterBy, etc.
          const cardTags = (itemData.metadata?.tags || []).map((t) =>
            t.replace(/^#/, '').toLowerCase()
          );
          const hasAllRequiredTags =
            tagsToFilterBy.length === 0 ||
            tagsToFilterBy.every((reqTag) => cardTags.includes(reqTag));

          const cardAssignedMembers = itemData.assignedMembers || [];
          const hasAllRequiredMembers =
            membersToFilterBy.length === 0 ||
            membersToFilterBy.every((reqMember) => cardAssignedMembers.includes(reqMember));

          let passesDueDateFilter = true;
          if (maxDueDate && itemData.metadata?.date) {
            // maxDueDate and today are defined earlier using currentDueDateValue
            const cardDate = itemData.metadata.date.clone().startOf('day');
            const isValid = cardDate.isValid();
            const isAfterMax = cardDate.isAfter(maxDueDate);
            const isBeforeToday = cardDate.isBefore(today);
            if (!isValid || isAfterMax || isBeforeToday) {
              passesDueDateFilter = false;
            }
          } else if (maxDueDate && !itemData.metadata?.date) {
            passesDueDateFilter = false;
          }

          let passesArchiveFilter = true;
          if (currentExcludeArchive && currentLaneTitle.toLowerCase() === 'archive') {
            passesArchiveFilter = false;
          }

          let passesDoneFilter = true;
          if (currentExcludeDone && itemData.checked) {
            passesDoneFilter = false;
          }

          if (
            hasAllRequiredTags &&
            hasAllRequiredMembers &&
            passesDueDateFilter &&
            passesArchiveFilter &&
            passesDoneFilter
          ) {
            // console.log and allCards.push logic was here, it's correct
            // ... (The existing console.log('[WorkspaceView] PRE-PUSH...') and allCards.push({...}) logic remains here)
            console.log(
              '[WorkspaceView] PRE-PUSH. Card Title:',
              itemData.titleRaw.slice(0, 20),
              'itemData.metadata.date:',
              itemData.metadata?.date,
              'isMoment:',
              moment.isMoment(itemData.metadata?.date),
              'isValid:',
              itemData.metadata?.date?.isValid(),
              'dateStr:',
              itemData.metadata?.dateStr,
              'Board:',
              sourceBoardName // CORRECTED: Use sourceBoardName from internalCard scope
            );
            allCards.push({
              id:
                itemData.blockId ||
                `${sourceBoardPath}-${currentLaneTitle}-${itemData.titleRaw.slice(0, 10)}-${Math.random()}`,
              title: itemData.title,
              tags: (itemData.metadata?.tags || []).map((t) => (t.startsWith('#') ? t : `#${t}`)),
              assignedMembers: itemData.assignedMembers || [],
              sourceBoardName: sourceBoardName, // Use sourceBoardName from internalCard
              sourceBoardPath: sourceBoardPath, // Use sourceBoardPath from internalCard
              laneTitle: currentLaneTitle,
              blockId: itemData.blockId,
              date: itemData.metadata?.date,
              sourceStartLine: sourceStartLine, // Use sourceStartLine from internalCard
              checked: itemData.checked,
              priority: itemData.metadata?.priority, // <-- Add priority here
            });
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
    [
      props.plugin,
      setIsLoading,
      setError,
      setFilteredCards,
      // No longer need direct state dependencies for filter values here,
      // as they are passed as arguments.
      // dueDateFilterValue,
      // dueDateFilterUnit,
      // excludeArchive,
      // excludeDone,
      setAllScannedTags,
      // handleScanDirectory, // ADDED BACK
    ]
  );

  // Effect to re-scan when filters change
  useEffect(() => {
    console.log(
      '[EffectUpdate] Filters changed. activeFilterTags before calling handleScanDirectory:',
      JSON.stringify(activeFilterTags)
    ); // ADDED LOG
    handleScanDirectory(
      [...activeFilterTags],
      [...activeFilterMembers],
      dueDateFilterValue, // PASS STATE
      dueDateFilterUnit, // PASS STATE
      excludeArchive, // PASS STATE
      excludeDone // PASS STATE
    );
  }, [
    activeFilterTags,
    activeFilterMembers,
    dueDateFilterValue,
    dueDateFilterUnit,
    excludeArchive,
    excludeDone,
    handleScanDirectory, // ADD handleScanDirectory to this useEffect's dependency array
  ]);

  // Effect to listen for refresh events from the parent ItemView
  useEffect(() => {
    const refresher = () => {
      console.log(
        "[KanbanWorkspaceViewComponent] 'refresh-data' event received. Calling handleScanDirectory."
      );
      // Ensure we use the latest filter states when refreshing
      handleScanDirectory(
        [...activeFilterTags],
        [...activeFilterMembers],
        dueDateFilterValue, // PASS STATE
        dueDateFilterUnit, // PASS STATE
        excludeArchive, // PASS STATE
        excludeDone // PASS STATE
      );
    };

    if (props.viewEvents) {
      props.viewEvents.on('refresh-data', refresher);
    }

    return () => {
      if (props.viewEvents) {
        props.viewEvents.off('refresh-data', refresher);
      }
    };
  }, [props.viewEvents, handleScanDirectory, activeFilterTags, activeFilterMembers]);

  const handleToggleCardDoneStatus = useCallback(
    async (card: WorkspaceCard, newCheckedStatus: boolean) => {
      const originalCheckedStatus = card.checked || false;
      // 1. Optimistically update local state for immediate UI feedback
      setFilteredCards((prevCards) =>
        prevCards.map((c) => (c.id === card.id ? { ...c, checked: newCheckedStatus } : c))
      );

      // 2. Update source file
      const targetFile = props.plugin.app.vault.getAbstractFileByPath(
        card.sourceBoardPath
      ) as TFile;

      if (!targetFile || !(targetFile instanceof TFile)) {
        new Notice(
          `Error: Could not find file ${card.sourceBoardPath} or it is a folder to update done status.`
        );
        // Revert local state if file not found
        setFilteredCards((prevCards) =>
          prevCards.map((c) => (c.id === card.id ? { ...c, checked: originalCheckedStatus } : c))
        );
        return;
      }

      try {
        let fileContent = await props.plugin.app.vault.cachedRead(targetFile);
        const lines = fileContent.split('\n');
        let foundAndReplaced = false;
        const taskRegex = /^(\s*)- \[(\s*|x|X|-|\/|>)\](.*)/; // Matches task prefix

        const updateLineCheckedStatus = (line: string): string => {
          const match = line.match(taskRegex);
          if (match) {
            const prefix = match[1];
            const restOfLine = match[3];
            const newMarker = newCheckedStatus ? 'x' : ' ';
            return `${prefix}- [${newMarker}]${restOfLine.startsWith(' ') ? restOfLine : ` ${restOfLine.trimStart()}`}`.trimEnd();
          }
          return line;
        };

        if (card.blockId) {
          const blockIdSuffix = `^${card.blockId}`;
          for (let i = 0; i < lines.length; i++) {
            if (lines[i].endsWith(blockIdSuffix)) {
              if (taskRegex.test(lines[i])) {
                lines[i] = updateLineCheckedStatus(lines[i]);
                foundAndReplaced = true;
              } else {
                new Notice(
                  `Line with block ID ${card.blockId} is not a task. Cannot mark as done/undone.`
                );
              }
              break;
            }
          }
        } else if (card.sourceStartLine) {
          const targetLineIndex = card.sourceStartLine - 1;
          if (targetLineIndex >= 0 && targetLineIndex < lines.length) {
            const lineToUpdate = lines[targetLineIndex];
            const titleSnippet = card.title.length > 20 ? card.title.substring(0, 20) : card.title;
            if (lineToUpdate.toLowerCase().includes(titleSnippet.toLowerCase())) {
              if (taskRegex.test(lineToUpdate)) {
                lines[targetLineIndex] = updateLineCheckedStatus(lineToUpdate);
                foundAndReplaced = true;
              } else {
                new Notice(
                  `Line ${card.sourceStartLine} is not a task. Cannot mark as done/undone.`
                );
              }
            } else {
              new Notice(
                `Line content at ${card.sourceStartLine} seems to have changed for "${card.title}". Done status updated in view only (file not changed).`
              );
              // Do not revert local state here as the file wasn't touched, but also don't proceed to save.
              return; // Exit before attempting to save
            }
          }
        }

        if (foundAndReplaced) {
          fileContent = lines.join('\n');
          await props.plugin.app.vault.modify(targetFile, fileContent);
          new Notice(
            `"${card.title}" marked as ${newCheckedStatus ? 'Done' : 'Undone'} in ${targetFile.basename}.`
          );
          handleScanDirectory(
            [...activeFilterTags],
            [...activeFilterMembers],
            dueDateFilterValue, // PASS STATE
            dueDateFilterUnit, // PASS STATE
            excludeArchive, // PASS STATE
            excludeDone // PASS STATE
          ); // Refresh list
        } else if (!card.blockId && !card.sourceStartLine) {
          new Notice(
            `Cannot update done status for "${card.title}": No block ID or source line. Updated in view only (file not changed).`
          );
        } else if (card.blockId && !foundAndReplaced) {
          if (!lines.find((line) => line.endsWith(`^${card.blockId}`))) {
            new Notice(
              `Could not find block ID ${card.blockId} for "${card.title}" to update done status. Updated in view only (file not changed).`
            );
          }
        } else if (card.sourceStartLine && !foundAndReplaced) {
          if (
            !lines[card.sourceStartLine - 1]
              ?.toLowerCase()
              .includes(
                (card.title.length > 20 ? card.title.substring(0, 20) : card.title).toLowerCase()
              )
          ) {
            // Already handled by specific notice, file not changed
          } else if (!taskRegex.test(lines[card.sourceStartLine - 1])) {
            // Already handled by specific notice, file not changed
          }
        } else {
          new Notice(
            `Could not update done status for "${card.title}" in source file. Updated in view only (file not changed).`
          );
        }
      } catch (e) {
        console.error('Error updating card done status in source file:', e);
        new Notice('Error updating done status. See console.');
        // Revert local state on error
        setFilteredCards((prevCards) =>
          prevCards.map((c) => (c.id === card.id ? { ...c, checked: originalCheckedStatus } : c))
        );
      }
    },
    [
      props.plugin,
      setFilteredCards,
      activeFilterTags,
      activeFilterMembers,
      dueDateFilterValue, // ADD STATE DEPENDENCY
      dueDateFilterUnit, // ADD STATE DEPENDENCY
      excludeArchive, // ADD STATE DEPENDENCY
      excludeDone, // ADD STATE DEPENDENCY
      handleScanDirectory,
    ]
  );

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

  const handleRowContextMenu = useCallback(
    async (event: MouseEvent, card: WorkspaceCard) => {
      event.preventDefault();
      const menu = new Menu();

      menu.addItem((item) =>
        item
          .setTitle('Set/Change Due Date')
          .setIcon('calendar-clock')
          .onClick(() => {
            // Note: Removed async here as modal handles async part
            new DateInputModal(
              props.plugin.app,
              card.date ? card.date.format('DD-MM-YYYY') : moment().format('DD-MM-YYYY'),
              async (newDateStr) => {
                if (newDateStr === null) return; // User cancelled modal

                // The dateStrFromPicker (newDateStr) from MomentFormatComponent might be in display format.
                // We need to parse it back to YYYY-MM-DD for consistent internal handling and before re-saving.
                // However, for this iteration, we'll assume the settings for date-format will correctly parse it if it's a valid date string.
                // A more robust solution might involve knowing the display format used by MomentFormatComponent.

                let newMomentDate: moment.Moment | undefined = undefined;
                if (newDateStr.trim() !== '') {
                  // Try parsing with plugin's date-format first, then with YYYY-MM-DD as a fallback for direct input.
                  const pluginDateFormat = props.plugin.settings['date-format'] || 'DD-MM-YYYY';
                  let parsedDate = moment(newDateStr.trim(), pluginDateFormat, true); // Strict parsing
                  if (!parsedDate.isValid()) {
                    parsedDate = moment(newDateStr.trim(), 'DD-MM-YYYY', true); // Fallback for direct YYYY-MM-DD input
                  }

                  if (!parsedDate.isValid()) {
                    new Notice(
                      'Invalid date format. Please use a valid date recognized by your settings or DD-MM-YYYY.'
                    );
                    return;
                  }
                  newMomentDate = parsedDate;
                }

                // 1. Update local state for immediate feedback
                setFilteredCards((prevCards) =>
                  prevCards.map((c) => (c.id === card.id ? { ...c, date: newMomentDate } : c))
                );

                // 2. Propagate change to source file (logic remains the same)
                const targetFile = props.plugin.app.vault.getAbstractFileByPath(
                  card.sourceBoardPath
                ) as TFile;
                if (!targetFile || !(targetFile instanceof TFile)) {
                  new Notice(
                    `Error: Could not find file ${card.sourceBoardPath} or it is a folder.`
                  );
                  return;
                }

                try {
                  let fileContent = await props.plugin.app.vault.cachedRead(targetFile);
                  const dateFormat = props.plugin.settings['date-format'] || 'DD-MM-YYYY';
                  const dateTrigger = props.plugin.settings['date-trigger'] || '@';

                  const newDateStringForMd = newMomentDate
                    ? `${dateTrigger}{${newMomentDate.format(dateFormat)}}`
                    : '';

                  const pluginDatePattern = new RegExp(
                    `(?:^|\\s)${escapeRegExp(dateTrigger)}\\{[^}]+\\}(?:\\s|$)`,
                    'g'
                  );
                  const wikilinkDatePattern = /\s*\[\[\d{4}-\d{2}-\d{2}\]\]\s*/g;
                  const taskPluginDatePattern = /\s*📅\s*\d{4}-\d{2}-\d{2}\s*/g;

                  if (card.blockId) {
                    let foundAndReplaced = false;
                    const lines = fileContent.split('\n');
                    const blockIdSuffix = `^${card.blockId}`;

                    for (let i = 0; i < lines.length; i++) {
                      if (lines[i].includes(blockIdSuffix)) {
                        let line = lines[i];
                        line = line
                          .replace(pluginDatePattern, ' ')
                          .replace(wikilinkDatePattern, ' ')
                          .replace(taskPluginDatePattern, ' ');

                        const blockIdIndex = line.lastIndexOf(blockIdSuffix);
                        const mainContent = line.substring(0, blockIdIndex).trim();
                        const blockIdPart = line.substring(blockIdIndex);

                        if (newDateStringForMd) {
                          lines[i] = `${mainContent} ${newDateStringForMd} ${blockIdPart}`.trim();
                        } else {
                          lines[i] = `${mainContent} ${blockIdPart}`.trim();
                        }
                        lines[i] = lines[i].replace(/\s+/g, ' ').trim();
                        foundAndReplaced = true;
                        break;
                      }
                    }

                    if (foundAndReplaced) {
                      fileContent = lines.join('\n');
                      await props.plugin.app.vault.modify(targetFile, fileContent);
                      new Notice(`Due date for "${card.title}" updated in ${targetFile.basename}.`);
                      handleScanDirectory(
                        [...activeFilterTags],
                        [...activeFilterMembers],
                        dueDateFilterValue, // PASS STATE
                        dueDateFilterUnit, // PASS STATE
                        excludeArchive, // PASS STATE
                        excludeDone // PASS STATE
                      ); // Refresh list
                    } else {
                      new Notice(
                        `Could not find block ID ${card.blockId} to update date. Date updated in this view only.`
                      );
                    }
                  } else if (card.sourceStartLine !== undefined) {
                    // Fallback to line number if blockId is not available
                    new Notice(
                      'Attempting to update by line number (no block ID). This is less reliable.'
                    );
                    const lines = fileContent.split('\n');
                    const targetLineIndex = card.sourceStartLine - 1; // Adjust for 0-based array

                    if (targetLineIndex >= 0 && targetLineIndex < lines.length) {
                      let line = lines[targetLineIndex];

                      // Basic verification: check if the line still roughly contains the card title.
                      // This is a simple heuristic and might not be foolproof.
                      const titleSnippet =
                        card.title.length > 20 ? card.title.substring(0, 20) : card.title;
                      if (!line.toLowerCase().includes(titleSnippet.toLowerCase())) {
                        new Notice(
                          `Line content at ${card.sourceStartLine} seems to have changed. Date updated in this view only.`
                        );
                        // Optionally, clear newMomentDate here if we decide not to update local state on verification failure
                        // For now, local state is updated, but file isn't.
                        return; // Abort file modification
                      }

                      line = line
                        .replace(pluginDatePattern, ' ')
                        .replace(wikilinkDatePattern, ' ')
                        .replace(taskPluginDatePattern, ' ');

                      if (newDateStringForMd) {
                        lines[targetLineIndex] = `${line.trim()} ${newDateStringForMd}`.trim();
                      } else {
                        lines[targetLineIndex] = line.trim(); // Just the cleaned line if date is cleared
                      }
                      lines[targetLineIndex] = lines[targetLineIndex].replace(/\s+/g, ' ').trim();

                      fileContent = lines.join('\n');
                      await props.plugin.app.vault.modify(targetFile, fileContent);
                      new Notice(
                        `Due date for "${card.title}" updated by line number in ${targetFile.basename}.`
                      );
                      handleScanDirectory(
                        [...activeFilterTags],
                        [...activeFilterMembers],
                        dueDateFilterValue, // PASS STATE
                        dueDateFilterUnit, // PASS STATE
                        excludeArchive, // PASS STATE
                        excludeDone // PASS STATE
                      ); // Refresh list
                    } else {
                      new Notice(
                        `Invalid source line number (${card.sourceStartLine}). Date updated in this view only.`
                      );
                    }
                  } else {
                    new Notice(
                      'Date update in source file requires a block ID or a valid source line. Date updated in this view only.'
                    );
                  }
                } catch (e) {
                  console.error('Error updating card date in source file:', e);
                  new Notice('Error updating card date. See console.');
                }
              }
            ).open();
          })
      );

      // --- Assign Members ---
      const rawTeamMembers = props.plugin.settings.teamMembers || [];
      console.log('[WorkspaceView] rawTeamMembers', rawTeamMembers);
      // Filter for actual, non-empty string members
      const validTeamMembers = rawTeamMembers.filter(
        (member) => typeof member === 'string' && member.trim() !== ''
      );

      if (validTeamMembers.length > 0) {
        console.log('[WorkspaceView] validTeamMembers', validTeamMembers);
        menu.addItem((item) => {
          item.setTitle('Assign/Unassign Members').setIcon('users');

          const memberSubMenu = (item as any).setSubmenu(); // Use (item as any) to call setSubmenu and assign its result

          validTeamMembers.forEach((member) => {
            console.log('[WorkspaceView] member', member);
            memberSubMenu.addItem((subItem: MenuItem) => {
              // Add items to the menu returned by setSubmenu
              console.log(
                '[WorkspaceView] subItem',
                subItem,
                member,
                card.assignedMembers?.includes(member) || false
              );
              subItem
                .setTitle(member)
                .setChecked(card.assignedMembers?.includes(member) || false)
                .onClick(async () => {
                  const isAssigned = card.assignedMembers?.includes(member) || false;
                  let updatedMembers = card.assignedMembers ? [...card.assignedMembers] : [];

                  if (isAssigned) {
                    updatedMembers = updatedMembers.filter((m) => m !== member);
                    console.log('[WorkspaceView] updatedMembers isAssigned', updatedMembers);
                  } else {
                    updatedMembers.push(member);
                    console.log('[WorkspaceView] updatedMembers else', updatedMembers);
                  }

                  // 1. Update local state
                  setFilteredCards((prevCards) =>
                    prevCards.map((c) =>
                      c.id === card.id ? { ...c, assignedMembers: updatedMembers } : c
                    )
                  );

                  // 2. Update source file
                  const targetFile = props.plugin.app.vault.getAbstractFileByPath(
                    card.sourceBoardPath
                  ) as TFile;
                  if (!targetFile || !(targetFile instanceof TFile)) {
                    new Notice(
                      `Error: Could not find file ${card.sourceBoardPath} or it is a folder.`
                    );
                    return;
                  }

                  try {
                    let fileContent = await props.plugin.app.vault.cachedRead(targetFile);
                    const lines = fileContent.split('\n');
                    let foundAndReplaced = false;

                    const memberAssignmentPrefix =
                      props.plugin.settings.memberAssignmentPrefix || '@@';

                    const updateLineWithMembers = (
                      line: string,
                      currentBlockId?: string
                    ): string => {
                      // Remove all existing member tags (@@member)
                      let cleanedLine = line
                        .replace(
                          new RegExp(`${escapeRegExp(memberAssignmentPrefix)}[^\\s^]+`, 'g'),
                          ''
                        )
                        .trim();

                      // Remove block ID if present to re-append it later
                      if (currentBlockId) {
                        cleanedLine = cleanedLine
                          .replace(new RegExp(`\\s*^${escapeRegExp(currentBlockId)}$`), '')
                          .trim();
                      }

                      const membersString = updatedMembers
                        .map((m) => `${memberAssignmentPrefix}${m}`)
                        .join(' ');

                      if (currentBlockId) {
                        return `${cleanedLine} ${membersString} ^${currentBlockId}`
                          .replace(/\s+/g, ' ')
                          .trim();
                      } else {
                        return `${cleanedLine} ${membersString}`.replace(/\s+/g, ' ').trim();
                      }
                    };

                    if (card.blockId) {
                      const blockIdSuffix = `^${card.blockId}`;
                      for (let i = 0; i < lines.length; i++) {
                        if (lines[i].endsWith(blockIdSuffix)) {
                          lines[i] = updateLineWithMembers(lines[i], card.blockId);
                          foundAndReplaced = true;
                          break;
                        }
                      }
                    } else if (card.sourceStartLine) {
                      const targetLineIndex = card.sourceStartLine - 1;
                      if (targetLineIndex >= 0 && targetLineIndex < lines.length) {
                        const titleSnippet =
                          card.title.length > 20 ? card.title.substring(0, 20) : card.title;
                        if (
                          lines[targetLineIndex].toLowerCase().includes(titleSnippet.toLowerCase())
                        ) {
                          lines[targetLineIndex] = updateLineWithMembers(lines[targetLineIndex]);
                          foundAndReplaced = true;
                        } else {
                          new Notice(
                            `Line content at ${card.sourceStartLine} seems to have changed for "${card.title}". Members updated in this view only.`
                          );
                        }
                      }
                    }

                    if (foundAndReplaced) {
                      fileContent = lines.join('\n');
                      await props.plugin.app.vault.modify(targetFile, fileContent);
                      new Notice(`Members for "${card.title}" updated in ${targetFile.basename}.`);
                      handleScanDirectory(
                        [...activeFilterTags],
                        [...activeFilterMembers],
                        dueDateFilterValue, // PASS STATE
                        dueDateFilterUnit, // PASS STATE
                        excludeArchive, // PASS STATE
                        excludeDone // PASS STATE
                      ); // Refresh list
                    } else if (!card.blockId && !card.sourceStartLine) {
                      new Notice(
                        `Cannot update members for "${card.title}": No block ID or source line. Updated in view only.`
                      );
                    } else if (card.blockId && !foundAndReplaced) {
                      new Notice(
                        `Could not find block ID ${card.blockId} for "${card.title}" to update members. Updated in view only.`
                      );
                    } else if (
                      card.sourceStartLine &&
                      !foundAndReplaced &&
                      !lines[card.sourceStartLine - 1]
                        ?.toLowerCase()
                        .includes(
                          (card.title.length > 20
                            ? card.title.substring(0, 20)
                            : card.title
                          ).toLowerCase()
                        )
                    ) {
                      // Already handled by the specific notice inside the sourceStartLine block
                    } else {
                      new Notice(
                        `Could not update members for "${card.title}" in source file. Updated in view only.`
                      );
                    }
                  } catch (e) {
                    console.error('Error updating card members in source file:', e);
                    new Notice('Error updating members. See console.');
                  }
                });
            });
          });
          console.log('[WorkspaceView] memberSubMenu HERE', memberSubMenu);
        });
      }

      // --- End Assign Members ---

      // --- Mark as Done/Undone ---
      menu.addItem((item) => {
        const isDone = card.checked || false;
        item
          .setTitle(isDone ? 'Mark as Undone' : 'Mark as Done')
          .setIcon(isDone ? 'check-square' : 'square')
          .onClick(async () => {
            await handleToggleCardDoneStatus(card, !isDone); // Call the helper function
          });
      });
      // --- End Mark as Done/Undone ---

      menu.showAtMouseEvent(event);
    },
    [
      props.plugin,
      setFilteredCards,
      activeFilterTags,
      activeFilterMembers,
      dueDateFilterValue, // ADD STATE DEPENDENCY
      dueDateFilterUnit, // ADD STATE DEPENDENCY
      excludeArchive, // ADD STATE DEPENDENCY
      excludeDone, // ADD STATE DEPENDENCY
      handleScanDirectory,
      handleToggleCardDoneStatus,
    ] // Added handleToggleCardDoneStatus to dependencies
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
      dueDateFilter:
        dueDateFilterValue !== ''
          ? { value: dueDateFilterValue, unit: dueDateFilterUnit }
          : undefined,
      excludeArchive: excludeArchive, // Save new toggle
      excludeDone: excludeDone, // Save new toggle
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
    dueDateFilterValue,
    dueDateFilterUnit,
    excludeArchive, // Add to dependencies
    excludeDone, // Add to dependencies
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
      setDueDateFilterValue('');
      setDueDateFilterUnit('days');
      setExcludeArchive(true); // Reset new toggle
      setExcludeDone(true); // Reset new toggle
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
    setDueDateFilterValue,
    setDueDateFilterUnit,
    setExcludeArchive, // Add to dependencies
    setExcludeDone, // Add to dependencies
  ]); // Added setters to deps

  const availableTeamMembers = useMemo(() => {
    return props.plugin.settings.teamMembers || [];
  }, [props.plugin.settings.teamMembers]);

  const handleClearAllFilters = useCallback(() => {
    setActiveFilterTags([]);
    setActiveFilterMembers([]);
    setDueDateFilterValue('');
    setDueDateFilterUnit('days');
    setExcludeArchive(true); // Reset new toggle
    setExcludeDone(true); // Reset new toggle
  }, [
    setActiveFilterTags,
    setActiveFilterMembers,
    setDueDateFilterValue,
    setDueDateFilterUnit,
    setExcludeArchive, // Add to dependencies
    setExcludeDone, // Add to dependencies
  ]);

  // ADDED: Handler for the tag filter dropdown click
  const handleTagFilterDropdownClick = useCallback(
    (event: MouseEvent) => {
      // MODIFIED: Use DOM MouseEvent
      const menu = new Menu();
      if (allScannedTags.length === 0) {
        menu.addItem((item) => item.setTitle('No tags available').setDisabled(true));
      } else {
        allScannedTags.forEach((tag) => {
          // tag is without #
          menu.addItem((item) => {
            item
              .setTitle(tag) // Display WITHOUT # in menu
              .setChecked(activeFilterTags.includes(tag)) // activeFilterTags stores tags without #
              .onClick(() => {
                console.log(
                  '[TagDropdownClick] Before setActiveFilterTags. Current activeFilterTags:',
                  JSON.stringify(activeFilterTags),
                  'Tag to toggle:',
                  tag
                );
                setActiveFilterTags((prevSelectedTags) => {
                  const newSelectedTags = prevSelectedTags.includes(tag)
                    ? prevSelectedTags.filter((t) => t !== tag)
                    : [...prevSelectedTags, tag];
                  console.log(
                    '[TagDropdownClick] Inside setActiveFilterTags. New selected tags calculated:',
                    JSON.stringify(newSelectedTags)
                  );
                  return newSelectedTags;
                });
                // Note: Logging activeFilterTags immediately after a setState call might not show the updated value due to closure/batching.
                // The log inside the updater function (prevSelectedTags => ...) is more reliable for the calculated new state.
              });
          });
        });
      }
      // Ensure event is of the correct type for showAtMouseEvent
      // No longer needed to check instance if type is MouseEvent directly
      menu.showAtMouseEvent(event);
    },
    [allScannedTags, activeFilterTags, setActiveFilterTags]
  );
  // END ADDED SECTION

  // ADDED: Handler for the member filter dropdown click
  const handleMemberFilterDropdownClick = useCallback(
    (event: MouseEvent) => {
      const menu = new Menu();
      const availableMembers = props.plugin.settings.teamMembers || [];

      if (availableMembers.length === 0) {
        menu.addItem((item) =>
          item.setTitle('No members configured in settings').setDisabled(true)
        );
      } else {
        availableMembers.forEach((member) => {
          if (typeof member === 'string' && member.trim() !== '') {
            // Ensure member is a valid string
            menu.addItem((item) => {
              item
                .setTitle(member)
                .setChecked(activeFilterMembers.includes(member))
                .onClick(() => {
                  setActiveFilterMembers((prevSelectedMembers) =>
                    prevSelectedMembers.includes(member)
                      ? prevSelectedMembers.filter((m) => m !== member)
                      : [...prevSelectedMembers, member]
                  );
                });
            });
          }
        });
      }
      menu.showAtMouseEvent(event);
    },
    [props.plugin.settings.teamMembers, activeFilterMembers, setActiveFilterMembers]
  );
  // END ADDED SECTION

  // ADDED: Log activeFilterTags right before rendering the display
  console.log(
    '[KanbanWorkspaceViewComponent] Rendering activeFilterTags for display:',
    JSON.stringify(activeFilterTags)
  );

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
                    setActiveFilterTags(viewToLoad.tags.map((t) => t.replace(/^#/, ''))); // MODIFIED: Ensure tags are stripped of leading '#'
                    setActiveFilterMembers(viewToLoad.members ? [...viewToLoad.members] : []);
                    if (viewToLoad.dueDateFilter) {
                      setDueDateFilterValue(viewToLoad.dueDateFilter.value);
                      setDueDateFilterUnit(viewToLoad.dueDateFilter.unit);
                    } else {
                      setDueDateFilterValue('');
                      setDueDateFilterUnit('days');
                    }
                    // Load new toggles, defaulting to true
                    setExcludeArchive(viewToLoad.excludeArchive ?? true);
                    setExcludeDone(viewToLoad.excludeDone ?? true);
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
          gap: '15px', // Adjusted gap
          alignItems: 'flex-end', // Align items to the bottom for a cleaner inline look
          marginBottom: '20px',
          flexWrap: 'wrap', // Allow wrapping on smaller screens
        }}
      >
        {/* MODIFIED: Tag Filter Section */}
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: '5px' }}>
          <label style={{ marginBottom: '5px' }}>
            {' '}
            {/* MODIFIED: htmlFor removed */}
            Tag:
          </label>
          {/* REPLACED INPUT WITH DIV FOR DROPDOWN */}
          <div
            className="kanban-tag-filter-dropdown-trigger"
            onClick={handleTagFilterDropdownClick}
            style={{
              border: '1px solid var(--input-border, var(--background-modifier-border))',
              padding: 'var(--size-2-2, 5px) var(--size-2-3, 8px)',
              borderRadius: 'var(--radius-s, 4px)',
              cursor: 'pointer',
              minHeight: 'calc(var(--input-height) - 2px)',
              display: 'flex',
              alignItems: 'center',
              backgroundColor: 'var(--input-background, var(--background-primary))',
              flexGrow: 1,
              minWidth: '150px', // Ensure it has some width
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
            title={
              activeFilterTags.length > 0
                ? activeFilterTags.map((t) => t.replace(/^#/, '')).join(', ')
                : 'Select tags...'
            } // Tooltip shows selected tags (no #)
          >
            Select tags...
          </div>
          {/* Original Add Button can be removed or repurposed if tag selection is purely via dropdown */}
          {/* 
          <button
            onClick={handleAddTag} // This would now be redundant if using dropdown exclusively
            disabled={!currentTagInput.trim()}
            style={{ padding: '5px' }}
          >
            +
          </button> 
          */}
        </div>
        {/* END MODIFIED SECTION */}

        {/* Vertical Divider */}
        <div
          style={{
            borderLeft: '1px solid var(--background-modifier-border)',
            height: '30px',
            alignSelf: 'flex-end',
          }}
        ></div>

        {/* MODIFIED: Member Filter Section - Replaced with dropdown */}
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: '5px' }}>
          <label style={{ marginBottom: '5px' }}>Member:</label>
          <div
            className="kanban-member-filter-dropdown-trigger" // You might want to add specific CSS for this class
            onClick={handleMemberFilterDropdownClick} // Use the new handler
            style={{
              border: '1px solid var(--input-border, var(--background-modifier-border))',
              padding: 'var(--size-2-2, 5px) var(--size-2-3, 8px)',
              borderRadius: 'var(--radius-s, 4px)',
              cursor: 'pointer',
              minHeight: 'calc(var(--input-height) - 2px)',
              display: 'flex',
              alignItems: 'center',
              backgroundColor: 'var(--input-background, var(--background-primary))',
              flexGrow: 1,
              minWidth: '150px', // Ensure it has some width
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
            title={
              activeFilterMembers.length > 0 ? activeFilterMembers.join(', ') : 'Select members...'
            }
          >
            {activeFilterMembers.length > 0 ? activeFilterMembers.join(', ') : 'Select members...'}
          </div>
        </div>
        {/* END MODIFIED MEMBER FILTER SECTION */}

        {/* Vertical Divider */}
        <div
          style={{
            borderLeft: '1px solid var(--background-modifier-border)',
            height: '30px',
            alignSelf: 'flex-end',
          }}
        ></div>

        {/* Due Date, Archive, and Done Filter Section Group - CHANGED TO ROW LAYOUT */}
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: '10px' }}>
          {/* Due Date Filter Section (remains as a sub-group) */}
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: '5px' }}>
            <label
              htmlFor="due-date-filter-value"
              style={{ marginBottom: '5px', minWidth: '80px' }}
            >
              Due in next:
            </label>
            <input
              type="number"
              id="due-date-filter-value"
              value={dueDateFilterValue}
              onInput={(e) => {
                const val = (e.target as HTMLInputElement).value;
                setDueDateFilterValue(val === '' ? '' : parseInt(val, 10));
              }}
              placeholder="N"
              style={{ width: '60px', padding: '5px' }} // Standardized padding
              min="0"
            />
            <select
              id="due-date-filter-unit"
              value={dueDateFilterUnit}
              onChange={(e) =>
                setDueDateFilterUnit(
                  (e.target as HTMLSelectElement).value as 'days' | 'weeks' | 'months'
                )
              }
              style={{ padding: '5px' }} // Standardized padding
            >
              <option value="days">Days</option>
              <option value="weeks">Weeks</option>
              <option value="months">Months</option>
            </select>
          </div>

          {/* NEW Vertical Divider */}
          <div
            style={{
              borderLeft: '1px solid var(--background-modifier-border)',
              height: '30px',
              alignSelf: 'flex-end',
            }}
          ></div>

          {/* Exclude Archive Toggle */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '5px', marginBottom: '5px' }}>
            <label
              htmlFor="exclude-archive-toggle"
              style={
                {
                  /* minWidth removed for tighter packing, or keep if preferred */
                }
              }
            >
              Exclude Archive:
            </label>
            <input
              type="checkbox"
              id="exclude-archive-toggle"
              checked={excludeArchive}
              onChange={(e) => setExcludeArchive((e.target as HTMLInputElement).checked)}
              style={{ height: '16px', width: '16px' }}
            />
          </div>
          <div
            style={{
              borderLeft: '1px solid var(--background-modifier-border)',
              height: '30px',
              alignSelf: 'flex-end',
            }}
          ></div>
          {/* Exclude Done Toggle */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '5px', marginBottom: '5px' }}>
            <label
              htmlFor="exclude-done-toggle"
              style={
                {
                  /* minWidth removed for tighter packing, or keep if preferred */
                }
              }
            >
              Exclude Done:
            </label>
            <input
              type="checkbox"
              id="exclude-done-toggle"
              checked={excludeDone}
              onChange={(e) => setExcludeDone((e.target as HTMLInputElement).checked)}
              style={{ height: '16px', width: '16px' }}
            />
          </div>
        </div>
      </div>

      {/* Active Member Filters Display */}
      {(activeFilterTags.length > 0 ||
        activeFilterMembers.length > 0 ||
        (dueDateFilterValue !== '' && dueDateFilterValue > 0) ||
        !excludeArchive || // Display if excludeArchive is false (meaning archives are included)
        !excludeDone) && ( // Display if excludeDone is false (meaning done items are included)
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
          {/* Display Due Date Filter First */}
          {dueDateFilterValue !== '' && dueDateFilterValue > 0 && (
            <span
              key="due-date-filter"
              style={{
                backgroundColor: 'var(--interactive-accent)',
                color: 'var(--text-on-accent)',
                padding: '0px 9px',
                borderRadius: '4px',
                display: 'inline-flex',
                alignItems: 'center',
                fontSize: '0.9em',
                fontWeight: '500',
              }}
            >
              Due in {dueDateFilterValue} {dueDateFilterUnit}
              <button
                onClick={() => {
                  setDueDateFilterValue('');
                  setDueDateFilterUnit('days');
                }}
                style={{
                  marginLeft: '6px',
                  background: 'transparent',
                  border: 'none',
                  color: 'var(--text-on-accent)',
                  cursor: 'pointer',
                  padding: '0 3px',
                  fontSize: '1.1em',
                  lineHeight: '1',
                  opacity: 0.7,
                }}
                title="Remove due date filter"
                onMouseEnter={(e) => (e.currentTarget.style.opacity = '1')}
                onMouseLeave={(e) => (e.currentTarget.style.opacity = '0.7')}
              >
                &times;
              </button>
            </span>
          )}
          {/* Display Active Member Filters */}
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
          {/* Display Archive/Done Filter Status if they are set to "include" */}
          {!excludeArchive && (
            <span
              key="include-archive-filter-status"
              style={{
                backgroundColor: 'var(--background-modifier-hover)',
                color: 'var(--text-normal)',
                padding: '0px 9px',
                borderRadius: '4px',
                display: 'inline-flex',
                alignItems: 'center',
                fontSize: '0.9em',
                fontWeight: '500',
              }}
            >
              Archive
              <button
                onClick={() => setExcludeArchive(true)} // Click to re-exclude
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
                title="Click to Exclude Archive"
                onMouseEnter={(e) => (e.currentTarget.style.opacity = '1')}
                onMouseLeave={(e) => (e.currentTarget.style.opacity = '0.7')}
              >
                &times;
              </button>
            </span>
          )}
          {!excludeDone && (
            <span
              key="include-done-filter-status"
              style={{
                backgroundColor: 'var(--background-modifier-hover)',
                color: 'var(--text-normal)',
                padding: '0px 9px',
                borderRadius: '4px',
                display: 'inline-flex',
                alignItems: 'center',
                fontSize: '0.9em',
                fontWeight: '500',
              }}
            >
              Done
              <button
                onClick={() => setExcludeDone(true)} // Click to re-exclude
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
                title="Click to Exclude Done"
                onMouseEnter={(e) => (e.currentTarget.style.opacity = '1')}
                onMouseLeave={(e) => (e.currentTarget.style.opacity = '0.7')}
              >
                &times;
              </button>
            </span>
          )}
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
                <th /* Checkbox column header */
                  style={{
                    border: '1px solid var(--background-modifier-border)',
                    padding: '4px',
                    width: '40px', // Fixed width for checkbox column
                    textAlign: 'center',
                  }}
                >
                  {/* Optionally, an icon or empty for cleaner look */}
                </th>
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
                  Priority
                </th>
                <th
                  style={{
                    border: '1px solid var(--background-modifier-border)',
                    padding: '4px',
                    textAlign: 'center',
                  }}
                >
                  Members
                </th>
                <th
                  style={{
                    border: '1px solid var(--background-modifier-border)',
                    padding: '4px',
                    textAlign: 'center',
                  }}
                >
                  Card Tags
                </th>
                <th
                  style={{
                    border: '1px solid var(--background-modifier-border)',
                    padding: '4px',
                    textAlign: 'center',
                  }}
                >
                  Due in (days)
                </th>
              </tr>
            </thead>
            <tbody>
              {filteredCards.map((card) => {
                // Due date calculation for display
                let dueDateDisplay = '';
                const isCardDateMoment = moment.isMoment(card.date);
                console.log(
                  '[WorkspaceView] IN MAP. Card Title:',
                  card.title.slice(0, 20),
                  'card.date:',
                  card.date,
                  'isMoment:',
                  isCardDateMoment,
                  'isValid (if moment):',
                  isCardDateMoment ? card.date?.isValid() : 'N/A (not moment)',
                  'Source Board:',
                  card.sourceBoardName
                );
                // console.log('card:', card); // Reduced logging for clarity

                if (card.date) {
                  try {
                    const todayMoment = moment().startOf('day');
                    const cardDateMoment = moment.isMoment(card.date)
                      ? card.date.clone().startOf('day')
                      : moment(card.date).startOf('day');

                    // console.log('cardDateMoment:', cardDateMoment);
                    // console.log('todayMoment:', todayMoment);
                    if (cardDateMoment.isValid()) {
                      const diffDays = cardDateMoment.diff(todayMoment, 'days');
                      dueDateDisplay = diffDays === 0 ? 'Today' : `${diffDays}`;
                    }
                  } catch (error) {
                    console.error('Error calculating due date:', error, 'card:', card);
                  }
                }
                const priorityDisplay = card.priority
                  ? card.priority.charAt(0).toUpperCase() + card.priority.slice(1)
                  : '-';
                let priorityStyle = {};
                switch (card.priority) {
                  case 'high':
                    priorityStyle = { color: 'var(--color-red)', fontWeight: 'bold' };
                    break;
                  case 'medium':
                    priorityStyle = { color: 'var(--color-orange)' };
                    break;
                  case 'low':
                    priorityStyle = { color: 'var(--color-green)' };
                    break;
                }

                return (
                  <tr
                    key={card.id}
                    onClick={() => handleRowClick(card)}
                    onContextMenu={(e) => handleRowContextMenu(e, card)}
                    style={{ cursor: 'pointer' }}
                    onMouseEnter={(e) =>
                      (e.currentTarget.style.backgroundColor = 'var(--background-secondary-alt)')
                    }
                    onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
                  >
                    {/* Checkbox Cell */}
                    <td
                      style={{
                        border: '1px solid var(--background-modifier-border)',
                        padding: '4px',
                        textAlign: 'center',
                      }}
                      onClick={(e) => e.stopPropagation()} // Stop propagation here
                    >
                      <input
                        type="checkbox"
                        checked={card.checked || false}
                        onChange={async (e) => {
                          // e.stopPropagation(); // No longer strictly needed here if stopped on td, but doesn't hurt
                          await handleToggleCardDoneStatus(
                            card,
                            (e.target as HTMLInputElement).checked
                          );
                        }}
                        style={{ cursor: 'pointer' }} // Make it clear it's clickable
                      />
                    </td>
                    {/* Ticket Cell */}
                    <td
                      style={{
                        border: '1px solid var(--background-modifier-border)',
                        padding: '4px',
                        paddingLeft: '8px',
                      }}
                    >
                      {card.title}
                    </td>
                    {/* Category Cell */}
                    <td
                      style={{
                        border: '1px solid var(--background-modifier-border)',
                        padding: '4px',
                        textAlign: 'center',
                      }}
                    >
                      {card.laneTitle}
                    </td>
                    {/* Board Cell */}
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
                        ...priorityStyle,
                      }}
                    >
                      {priorityDisplay}
                    </td>
                    {/* Members Cell - RESTORED with inner flex div */}
                    <td
                      style={{
                        border: '1px solid var(--background-modifier-border)',
                        padding: '4px',
                        textAlign: 'center', // Keep textAlign for the cell itself if content might not fill
                      }}
                    >
                      <div
                        style={{
                          display: 'flex',
                          flexWrap: 'wrap',
                          gap: '4px',
                          justifyContent: 'center',
                        }}
                      >
                        {card.assignedMembers &&
                          card.assignedMembers.length > 0 &&
                          card.assignedMembers.map((member) => {
                            const memberConfig = props.plugin.settings.teamMemberColors?.[
                              member
                            ] as TeamMemberColorConfig | undefined;
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
                      </div>
                    </td>
                    {/* Card Tags Cell - RESTORED with inner flex div */}
                    <td
                      style={{
                        border: '1px solid var(--background-modifier-border)',
                        padding: '4px',
                        textAlign: 'center', // Keep textAlign for the cell itself
                      }}
                    >
                      <div
                        style={{
                          display: 'flex',
                          flexWrap: 'wrap',
                          gap: '4px',
                          justifyContent: 'center',
                        }}
                      >
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
                      </div>
                    </td>
                    {/* Due in (days) Cell */}
                    <td
                      style={{
                        border: '1px solid var(--background-modifier-border)',
                        padding: '4px',
                        textAlign: 'center',
                      }}
                    >
                      {dueDateDisplay}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

export class KanbanWorkspaceView extends ItemView {
  plugin: KanbanPlugin;
  private viewEvents = new Events();
  private boundHandleActiveLeafChange: (leaf: WorkspaceLeaf | null) => void;

  constructor(leaf: WorkspaceLeaf, plugin: KanbanPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.boundHandleActiveLeafChange = this.handleActiveLeafChange.bind(this);
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

  async onload() {
    super.onload();
    render(
      <KanbanWorkspaceViewComponent plugin={this.plugin} viewEvents={this.viewEvents} />,
      this.contentEl
    );
    this.app.workspace.on('active-leaf-change', this.boundHandleActiveLeafChange);

    // Initial refresh when view is first loaded.
    const timeoutDuration = 1000; // Centralized timeout duration
    setTimeout(() => {
      const currentActiveLeafPolled = this.app.workspace.activeLeaf;
      const isActiveLeafThisViewLeaf = currentActiveLeafPolled === this.leaf;
      const isObsidianReportingThisAsActiveView =
        this.app.workspace.getActiveViewOfType(KanbanWorkspaceView) === this;

      console.log(
        `[KanbanWorkspaceView] onload (setTimeout ${timeoutDuration}ms): Checking initial active state. Details:`,
        {
          currentActiveLeafPolled: currentActiveLeafPolled
            ? {
                id: (currentActiveLeafPolled as any).id ?? 'N/A',
                viewType: currentActiveLeafPolled.view?.getViewType(),
              }
            : null,
          thisLeaf: { id: (this.leaf as any).id ?? 'N/A', viewType: this.getViewType() },
          isActiveLeafThisViewLeaf: isActiveLeafThisViewLeaf,
          isObsidianReportingThisAsActiveView: isObsidianReportingThisAsActiveView,
          currentActiveLeafPolled_VIEW_INSTANCE_COMPARISON_this:
            currentActiveLeafPolled?.view === this,
        }
      );

      if (isActiveLeafThisViewLeaf || isObsidianReportingThisAsActiveView) {
        console.log(
          `[KanbanWorkspaceView] onload (setTimeout ${timeoutDuration}ms): View determined active on load. Triggering 'refresh-data'. Conditions: (polledActiveLeaf === this.leaf): ${isActiveLeafThisViewLeaf}, (getActiveViewOfType === this): ${isObsidianReportingThisAsActiveView}`
        );
        this.viewEvents.trigger('refresh-data');
      } else {
        console.log(
          `[KanbanWorkspaceView] onload (setTimeout ${timeoutDuration}ms): View is NOT determined active on load.`
        );
      }
    }, timeoutDuration);
  }

  handleActiveLeafChange(eventLeaf: WorkspaceLeaf | null) {
    const timeoutDuration = 1000; // Centralized timeout duration

    if (eventLeaf === this.leaf) {
      console.log(
        `[KanbanWorkspaceView] handleActiveLeafChange: Event is for this.leaf. Scheduling refresh check in ${timeoutDuration}ms.`,
        {
          eventLeafId: (eventLeaf as any)?.id ?? 'N/A',
          thisLeafId: (this.leaf as any)?.id ?? 'N/A',
          eventLeafViewType: eventLeaf?.view?.getViewType(),
          thisViewType: this.getViewType(),
        }
      );
      setTimeout(() => {
        const currentActiveLeafPolled = this.app.workspace.activeLeaf;
        const isThisLeafStillActiveViaPolled = currentActiveLeafPolled === this.leaf;
        const isThisViewStillActiveViaApi =
          this.app.workspace.getActiveViewOfType(KanbanWorkspaceView) === this;

        console.log(
          `[KanbanWorkspaceView] handleActiveLeafChange (setTimeout ${timeoutDuration}ms): Post-timeout check for this.leaf. Details:`,
          {
            eventLeafAtEventTime: eventLeaf
              ? { id: (eventLeaf as any)?.id ?? 'N/A', viewType: eventLeaf.view?.getViewType() }
              : null,
            thisLeafInstance: { id: (this.leaf as any).id ?? 'N/A', viewType: this.getViewType() },
            currentActiveLeafPolled: currentActiveLeafPolled
              ? {
                  id: (currentActiveLeafPolled as any).id ?? 'N/A',
                  viewType: currentActiveLeafPolled.view?.getViewType(),
                }
              : null,
            isThisLeafStillActive_polled: isThisLeafStillActiveViaPolled,
            isThisViewStillActive_api: isThisViewStillActiveViaApi,
            polledActiveLeaf_VIEW_INSTANCE_COMPARISON_this: currentActiveLeafPolled?.view === this,
          }
        );

        if (isThisLeafStillActiveViaPolled || isThisViewStillActiveViaApi) {
          console.log(
            `[KanbanWorkspaceView] handleActiveLeafChange (setTimeout ${timeoutDuration}ms): Confirmed active. Triggering 'refresh-data'. Conditions: (polledActiveLeaf === this.leaf): ${isThisLeafStillActiveViaPolled}, (getActiveViewOfType === this): ${isThisViewStillActiveViaApi}`
          );
          this.viewEvents.trigger('refresh-data');
        } else {
          console.log(
            `[KanbanWorkspaceView] handleActiveLeafChange (setTimeout ${timeoutDuration}ms): View no longer considered active post-timeout.`
          );
        }
      }, timeoutDuration);
    } else {
      console.log(
        `[KanbanWorkspaceView] handleActiveLeafChange: Event leaf (viewType: ${eventLeaf?.view?.getViewType()}, id: ${(eventLeaf as any)?.id ?? 'N/A'}) is not this.leaf (viewType: ${this.getViewType()}, id: ${(this.leaf as any)?.id ?? 'N/A'}). Ignoring.`,
        {
          eventLeafPassed: eventLeaf
            ? { id: (eventLeaf as any)?.id ?? 'N/A', viewType: eventLeaf.view?.getViewType() }
            : null,
          thisLeafInstance: { id: (this.leaf as any).id ?? 'N/A', viewType: this.getViewType() },
        }
      );
    }
  }

  async onunload() {
    this.app.workspace.off('active-leaf-change', this.boundHandleActiveLeafChange);
    if (this.contentEl) {
      unmountComponentAtNode(this.contentEl);
    }
    super.onunload();
  }
}
