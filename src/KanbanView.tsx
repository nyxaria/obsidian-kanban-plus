import EventEmitter from 'eventemitter3';
import update from 'immutability-helper';
import {
  HoverParent,
  HoverPopover,
  Menu,
  Platform,
  TAbstractFile,
  TFile,
  TextFileView,
  ViewStateResult,
  WorkspaceLeaf,
  debounce,
  normalizePath,
} from 'obsidian';
import { createElement } from 'preact';
import { render, unmountComponentAtNode } from 'preact/compat';

import {
  DEFAULT_SETTINGS,
  KanbanFormat,
  KanbanSettings,
  KanbanViewSettings,
  SettingsModal,
} from './Settings';
import { Kanban } from './components/Kanban';
import { BasicMarkdownRenderer } from './components/MarkdownRenderer/MarkdownRenderer';
import { c } from './components/helpers';
import { Board, Item, ItemData } from './components/types';
import { DndContext } from './dnd/components/DndContext';
import { getParentWindow } from './dnd/util/getWindow';
import {
  gotoNextDailyNote,
  gotoPrevDailyNote,
  hasFrontmatterKey,
  hasFrontmatterKeyRaw,
} from './helpers';
import { debugLog } from './helpers/debugLogger';
import { bindMarkdownEvents } from './helpers/renderMarkdown';
import { PromiseQueue } from './helpers/util';
import { t } from './lang/helpers';
import KanbanPlugin from './main';
import { frontmatterKey } from './parsers/common';

export const kanbanViewType = 'kanban';
export const kanbanIcon = 'lucide-trello';

// Added TargetHighlightLocation interface definition
interface TargetHighlightLocation {
  blockId?: string;
  cardTitle?: string;
  listName?: string;
  match?: any; // Added for search results
}

export class KanbanView extends TextFileView implements HoverParent {
  plugin: KanbanPlugin;
  hoverPopover: HoverPopover | null;
  emitter: EventEmitter;
  actionButtons: Record<string, HTMLElement> = {};

  previewCache: Map<string, BasicMarkdownRenderer>;
  previewQueue: PromiseQueue;

  activeEditor: any;
  viewSettings: KanbanViewSettings;
  public initialSearchQuery?: string;
  public targetHighlightLocation: TargetHighlightLocation | null = null;
  private pendingHighlightScroll: TargetHighlightLocation | null = null;
  private _reactState: any = {};
  private currentSearchMatch: any = null;
  private _isPendingInitialRender: boolean = false;
  private _reactHasRenderedOnceInThisInstance = false;
  private _initialRenderTimeoutId: number | null = null;
  private scrollTimeoutId: number | null = null;

  get isPrimary(): boolean {
    return this.plugin.getStateManager(this.file)?.getAView() === this;
  }

  get id(): string {
    return `${(this.leaf as any).id}:::${this.file?.path}`;
  }

  get isShiftPressed(): boolean {
    return this.plugin.isShiftPressed;
  }

  constructor(leaf: WorkspaceLeaf, plugin: KanbanPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.emitter = new EventEmitter();
    this.previewCache = new Map();
    this.viewSettings = {
      [frontmatterKey]: DEFAULT_SETTINGS[frontmatterKey],
      'list-collapse': DEFAULT_SETTINGS['list-collapse'],
      'tag-symbols': DEFAULT_SETTINGS['tag-symbols'] || [],
      savedWorkspaceViews: DEFAULT_SETTINGS.savedWorkspaceViews || [],
      hideHashForTagsWithoutSymbols: DEFAULT_SETTINGS.hideHashForTagsWithoutSymbols || false,
      teamMembers: DEFAULT_SETTINGS.teamMembers || [],
      teamMemberColors: DEFAULT_SETTINGS.teamMemberColors || {},
      editable: DEFAULT_SETTINGS.editable || false,
      'auto-move-done-to-lane': DEFAULT_SETTINGS['auto-move-done-to-lane'] || false,
      'auto-add-lane-tag': false,
      'auto-add-board-tag': false,
      'hide-lane-tag-display': false,
      'hide-board-tag-display': false,
      memberAssignmentPrefix: '@@',
      enableDueDateEmailReminders: false,
      dueDateReminderLastRun: 0,
      dueDateReminderTimeframeDays: 1,
      enableAutomaticEmailSending: false,
      automaticEmailSenderAddress: '',
      automaticEmailAppPassword: '',
      automaticEmailSendingFrequencyDays: 1,
      hideDoneLane: false,
      timelineDayWidth: 50,
      timelineCardHeight: 40,
      'enable-kanban-card-embeds': true,
      'enable-kanban-code-blocks': true,
      'use-kanban-board-background-colors': true,
      'member-view-lane-width': 350,
    };

    this.previewQueue = new PromiseQueue(() => this.emitter.emit('queueEmpty'));

    this.emitter.on('hotkey', ({ commandId }) => {
      switch (commandId) {
        case 'daily-notes:goto-prev': {
          gotoPrevDailyNote(this.app, this.file);
          break;
        }
        case 'daily-notes:goto-next': {
          gotoNextDailyNote(this.app, this.file);
          break;
        }
      }
    });

    bindMarkdownEvents(this);
  }

  async prerender(board: Board) {
    board.children.forEach((lane) => {
      lane.children.forEach((item) => {
        if (this.previewCache.has(item.id)) return;

        this.previewQueue.add(async () => {
          // Clean the titleRaw for display (remove metadata but keep task lists)
          const cleanTitle = this.getCleanTitleForDisplay(item.data.titleRaw);
          const preview = this.addChild(new BasicMarkdownRenderer(this, cleanTitle));
          this.previewCache.set(item.id, preview);
          await preview.renderCapability.promise;
        });
      });
    });

    if (this.previewQueue.isRunning) {
      await new Promise((res) => {
        this.emitter.once('queueEmpty', res);
      });
    }

    this.initHeaderButtons();
  }

  validatePreviewCache(board: Board) {
    const seenKeys = new Set<string>();
    board.children.forEach((lane) => {
      seenKeys.add(lane.id);
      lane.children.forEach((item) => {
        seenKeys.add(item.id);
      });
    });

    for (const k of this.previewCache.keys()) {
      if (!seenKeys.has(k)) {
        this.removeChild(this.previewCache.get(k));
        this.previewCache.delete(k);
      }
    }
  }

  setView(view: KanbanFormat) {
    this.setViewState(frontmatterKey, view);
    this.app.fileManager.processFrontMatter(this.file, (frontmatter) => {
      frontmatter[frontmatterKey] = view;
    });
  }

  setBoard(board: Board, shouldSave: boolean = true) {
    const stateManager = this.plugin.stateManagers.get(this.file);
    stateManager.setState(board, shouldSave);
  }

  getCleanTitleForDisplay(titleRaw: string): string {
    if (!titleRaw) return '';

    let cleanTitle = titleRaw;

    // Remove priority tags
    const priorityRegex = /(?:^|\s)(!low|!medium|!high)(?=\s|$)/gi;
    cleanTitle = cleanTitle.replace(priorityRegex, ' ');

    // Remove member assignments
    const memberRegex = /(?:^|\s)(@@\w+)(?=\s|$)/gi;
    cleanTitle = cleanTitle.replace(memberRegex, ' ');

    // Handle tags based on settings
    const tagStateManager = this.plugin.getStateManager(this.file);
    if (tagStateManager) {
      const moveTags = tagStateManager.getSetting('move-tags');
      const hideLaneTagDisplay = tagStateManager.getSetting('hide-lane-tag-display');
      const hideBoardTagDisplay = tagStateManager.getSetting('hide-board-tag-display');

      // DEBUG: Log the actual settings being used
      console.log('[KanbanView] getCleanTitleForDisplay settings:', {
        moveTags,
        hideLaneTagDisplay,
        hideBoardTagDisplay,
        boardName: tagStateManager.file?.basename,
        titleRaw: titleRaw.substring(0, 50) + (titleRaw.length > 50 ? '...' : ''),
      });

      if (moveTags) {
        // If move-tags is enabled, remove all tags (they go to tag section)
        const tagRegex = /(?:^|\s)(#[\w-]+(?:\/[\w-]+)*)(?=\s|$)/gi;
        cleanTitle = cleanTitle.replace(tagRegex, ' ');
        console.log(
          '[KanbanView] getCleanTitleForDisplay: Removed ALL tags due to move-tags setting'
        );
      } else if (hideLaneTagDisplay || hideBoardTagDisplay) {
        // If move-tags is disabled but hide settings are enabled, only remove board/lane tags
        const board = tagStateManager.state;
        const boardName = tagStateManager.file?.basename;

        if (hideBoardTagDisplay && boardName) {
          const boardTagPattern = boardName.toLowerCase().replace(/\s+/g, '-');
          const boardTagRegex = new RegExp(
            `(?:^|\\s)(#${boardTagPattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})(?=\\s|$)`,
            'gi'
          );
          const beforeReplace = cleanTitle;
          cleanTitle = cleanTitle.replace(boardTagRegex, ' ');
          console.log('[KanbanView] getCleanTitleForDisplay: Board tag filtering:', {
            boardName,
            boardTagPattern,
            beforeReplace,
            afterReplace: cleanTitle,
            changed: beforeReplace !== cleanTitle,
          });
        }

        if (hideLaneTagDisplay && board) {
          for (const lane of board.children) {
            const laneTagPattern = lane.data.title.toLowerCase().replace(/\s+/g, '-');
            const laneTagRegex = new RegExp(
              `(?:^|\\s)(#${laneTagPattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})(?=\\s|$)`,
              'gi'
            );
            const beforeReplace = cleanTitle;
            cleanTitle = cleanTitle.replace(laneTagRegex, ' ');
            if (beforeReplace !== cleanTitle) {
              console.log('[KanbanView] getCleanTitleForDisplay: Removed lane tag:', {
                laneTitle: lane.data.title,
                laneTagPattern,
                beforeReplace,
                afterReplace: cleanTitle,
              });
            }
          }
        }
      } else {
        console.log(
          '[KanbanView] getCleanTitleForDisplay: No tag filtering applied - settings disabled'
        );
      }
      // If move-tags is disabled and hide settings are disabled, keep all tags inline
    }

    // Get settings from state manager if available
    const stateManager = this.plugin.getStateManager(this.file);
    if (stateManager) {
      // Remove date triggers
      const dateTrigger = stateManager.getSetting('date-trigger');
      if (dateTrigger) {
        const escapeRegExpStr = (str: string) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

        // Handle basic date trigger format: @{date}
        const dateBraceRegex = new RegExp(
          `(?:^|\\s)${escapeRegExpStr(dateTrigger)}{([^}]+)}`,
          'gi'
        );
        cleanTitle = cleanTitle.replace(dateBraceRegex, ' ');

        // Handle date trigger with wikilinks: @[[date]]
        const dateBracketRegex = new RegExp(
          `(?:^|\\s)${escapeRegExpStr(dateTrigger)}\\[\\[([^]]+)\\]\\]`,
          'gi'
        );
        cleanTitle = cleanTitle.replace(dateBracketRegex, ' ');

        // Handle date trigger with prefixes like @start{date}, @end{date}, etc.
        const dateWithPrefixBraceRegex = new RegExp(
          `(?:^|\\s)${escapeRegExpStr(dateTrigger)}\\w*{([^}]+)}`,
          'gi'
        );
        cleanTitle = cleanTitle.replace(dateWithPrefixBraceRegex, ' ');

        // Handle date trigger with prefixes and wikilinks like @start[[date]], @end[[date]], etc.
        const dateWithPrefixBracketRegex = new RegExp(
          `(?:^|\\s)${escapeRegExpStr(dateTrigger)}\\w*\\[\\[([^]]+)\\]\\]`,
          'gi'
        );
        cleanTitle = cleanTitle.replace(dateWithPrefixBracketRegex, ' ');
      }

      // Remove time triggers
      const timeTrigger = stateManager.getSetting('time-trigger');
      if (timeTrigger) {
        const escapeRegExpStr = (str: string) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const timeRegex = new RegExp(`(?:^|\\s)${escapeRegExpStr(timeTrigger)}{([^}]+)}`, 'gi');
        cleanTitle = cleanTitle.replace(timeRegex, ' ');
      }
    }

    // Clean up multiple spaces but preserve newlines
    cleanTitle = cleanTitle.replace(/[ \t]{2,}/g, ' ').trim();

    console.log('[KanbanView] getCleanTitleForDisplay: Final result:', {
      originalTitle: titleRaw.substring(0, 50) + (titleRaw.length > 50 ? '...' : ''),
      cleanedTitle: cleanTitle.substring(0, 50) + (cleanTitle.length > 50 ? '...' : ''),
    });

    return cleanTitle;
  }

  getBoard(): Board | null {
    if (!this.file) {
      console.warn('[KanbanView] getBoard: this.file is null. Cannot get StateManager.');
      return null;
    }
    const stateManager = this.plugin.stateManagers.get(this.file);
    debugLog(
      `[KanbanView] getBoard: For file ${this.file.path}. StateManager found: ${!!stateManager}.`
    );
    if (!stateManager) {
      console.warn(`[KanbanView] getBoard: StateManager not found for file: ${this.file.path}`);
      return null;
    }
    // Detailed log for stateManager.state
    debugLog(
      `[KanbanView] getBoard: Checking stateManager.state for ${this.file.path}. stateManager.state is currently:`,
      stateManager.state ? JSON.stringify(stateManager.state.id) : 'null or undefined' // Log ID if state exists
    );
    if (!stateManager.state) {
      console.warn(
        `[KanbanView] getBoard: StateManager found for ${this.file.path}, but stateManager.state is null/undefined. Current StateManager file prop: ${stateManager.file?.path}`
      );
      return null;
    }
    debugLog(
      `[KanbanView] getBoard: Returning state for ${this.file.path}. Board ID from SM: ${stateManager.state.id}, SM file prop: ${stateManager.file?.path}`
    );
    return stateManager.state;
  }

  getViewType() {
    return kanbanViewType;
  }

  getIcon() {
    return kanbanIcon;
  }

  getDisplayText() {
    return this.file?.basename || 'Kanban';
  }

  getWindow() {
    return getParentWindow(this.containerEl) as Window & typeof globalThis;
  }

  async loadFile(file: TFile) {
    this.plugin.removeView(this);
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    return super.loadFile(file);
  }

  async onLoadFile(file: TFile) {
    try {
      return await super.onLoadFile(file);
    } catch (e) {
      const stateManager = this.plugin.stateManagers.get(this.file);
      stateManager?.setError(e);
      throw e;
    }
  }

  onload() {
    super.onload();
    if (Platform.isMobile) {
      this.containerEl.setCssProps({
        '--mobile-navbar-height': (this.app as any).mobileNavbar.containerEl.clientHeight + 'px',
      });
    }

    debugLog(
      '[KanbanView] onload: Entered. targetHighlightLocation will be set by setState if eState is provided directly.'
    );

    this.registerEvent(
      this.app.vault.on('rename', (file, oldPath) => {
        // Check if this specific view instance is still valid and its file matches the oldPath
        // This check helps prevent errors if the view is already closed or no longer relevant
        if (this.file && this.file.path === oldPath) {
          this.handleRename(file, oldPath);
        } else if (this.file && this.file.path === file.path && this.file.path !== oldPath) {
          // This handles the case where this.file might have already been updated to the new path
          // by the time the event fires, but we still need to process it based on oldPath.
          this.handleRename(file, oldPath);
        }
      })
    );

    // Check for pending highlight state stored on the leaf by the monkeypatch
    const pendingHighlightState = (this.leaf as any)._kanbanPendingHighlightState;
    if (pendingHighlightState) {
      debugLog(
        '[KanbanView] onload: Found _kanbanPendingHighlightState on leaf:',
        JSON.stringify(pendingHighlightState, null, 2)
      );
      if (pendingHighlightState.blockId) {
        this.targetHighlightLocation = { blockId: pendingHighlightState.blockId };
        debugLog(
          '[KanbanView] onload: Applied blockId from _kanbanPendingHighlightState to targetHighlightLocation.'
        );
      } else if (pendingHighlightState.match) {
        this.targetHighlightLocation = pendingHighlightState;
        debugLog(
          '[KanbanView] onload: Applied full match object from _kanbanPendingHighlightState to targetHighlightLocation.'
        );
      }
      delete (this.leaf as any)._kanbanPendingHighlightState;
      debugLog('[KanbanView] onload: Cleared _kanbanPendingHighlightState from leaf.');
    }

    // Schedule initial render / React state update
    // This ensures that even if setState doesn't trigger it due to no specific conditions being met,
    // the React component still gets a chance to render and register with StateManager.
    setTimeout(() => {
      debugLog('[KanbanView] onload (setTimeout): Triggering initial setReactState.');
      this.setReactState({}); // Pass empty state to ensure it uses current view state
    }, 50); // Small delay to allow other sync onload processes to complete

    this.register(
      this.containerEl.onWindowMigrated(() => {
        this.plugin.removeView(this);
        this.plugin.addView(this, this.data, this.isPrimary);
        // Ensure React state is updated after migration as well
        debugLog('[KanbanView] onWindowMigrated: Triggering setReactState after addView.');
        this.setReactState({});
      })
    );

    // Ensure this is added after super.onload() and other initial setup
    this.registerDomEvent(this.contentEl, 'click', this.handleBoardClickToClearHighlight, {
      capture: true,
    });
  }

  onunload(): void {
    super.onunload();
    unmountComponentAtNode(this.contentEl);

    this.previewQueue.clear();
    this.previewCache.clear();
    this.emitter.emit('queueEmpty');

    this.plugin.removeView(this);
    this.emitter.removeAllListeners();
    this.activeEditor = null;
    this.actionButtons = {};
  }

  async handleRename(file: TAbstractFile, oldPath: string) {
    // Ensure this.file exists and file is a TFile
    if (this.file && file instanceof TFile) {
      // Check if the currently open file in this view is the one that was renamed.
      // this.file should ideally be the new file object by the time this is called.
      if (this.file.path === file.path && this.file.path !== oldPath) {
        debugLog(
          `[KanbanView] handleRename: View for ${file.path} (formerly ${oldPath}) detected rename.`
        );
        // It's important that handleViewFileRename can correctly update based on oldPath
        // and the view instance (this), which now holds the new file.
        this.plugin.handleViewFileRename(this, oldPath);
      } else if (this.file.path === oldPath && file.path !== oldPath) {
        // This is a fallback if this.file somehow hasn't updated yet.
        // This view instance is still associated with the oldPath.
        debugLog(
          `[KanbanView] handleRename: View for ${oldPath} (now ${file.path}) detected rename. Instance file path matches oldPath.`
        );
        // We still pass 'this' (which refers to the view of oldPath) and oldPath.
        // handleViewFileRename needs to manage the transition.
        this.plugin.handleViewFileRename(this, oldPath);
        // It's possible Obsidian's TextFileView superclass might update `this.file` to `file` AFTER this handler,
        // or `this.plugin.handleViewFileRename` should handle updating `this.file` if necessary.
      }
    }
  }

  requestSaveToDisk(data: string) {
    if (this.data !== data && this.isPrimary) {
      this.data = data;
      this.requestSave();
    } else {
      this.data = data;
    }
  }

  getViewData() {
    // In theory, we could unparse the board here.  In practice, the board can be
    // in an error state, so we return the last good data here.  (In addition,
    // unparsing is slow, and getViewData() can be called more often than the
    // data actually changes.)
    return this.data;
  }

  async setViewData(data: string, clear?: boolean) {
    if (!hasFrontmatterKeyRaw(data)) {
      this.plugin.kanbanFileModes[(this.leaf as any).id || this.file.path] = 'markdown';
      this.plugin.removeView(this);
      // Do not await setMarkdownView if it's not critical path before returning
      this.plugin.setMarkdownView(this.leaf, false);
      return;
    }

    if (clear) {
      this.activeEditor = null;
      this.previewQueue.clear();
      this.previewCache.clear();
      this.emitter.emit('queueEmpty');
      Object.values(this.actionButtons).forEach((b) => b.remove());
      this.actionButtons = {};
    }

    // Await the addView process to ensure StateManager is fully ready
    debugLog(
      `[KanbanView] setViewData: About to call await this.plugin.addView for ${this.file?.path}`
    );
    await this.plugin.addView(this, data, this.isPrimary);
    debugLog(
      `[KanbanView] setViewData: Call to plugin.addView completed for ${this.file?.path}. Data length: ${data?.length}, clear: ${clear}, isPrimary: ${this.isPrimary}`
    );

    // Ensure React component is rendered/updated AFTER StateManager is fully initialized by the awaited addView
    this.setReactState({});
  }

  async setState(state: any, result: ViewStateResult) {
    debugLog('[KanbanView] setState called with state:', state, 'and result:', result);

    // Debug: Log all properties of state to see where the hash might be
    debugLog('[KanbanView] setState: Full state object keys:', Object.keys(state));
    if (state.eState) {
      debugLog('[KanbanView] setState: eState object keys:', Object.keys(state.eState));
      debugLog('[KanbanView] setState: eState object:', state.eState);
    }

    this.currentSearchMatch = null;
    this.targetHighlightLocation = null;

    // Check for blockId from URL hash (subpath)
    if (state?.subpath && state.subpath.startsWith('#^')) {
      const blockId = state.subpath.substring(2); // Remove #^
      this.targetHighlightLocation = { blockId };
      debugLog(
        '[KanbanView] setState: Determined targetHighlightLocation from URL subpath (blockId):',
        this.targetHighlightLocation
      );
    }

    // Check for blockId in other possible locations
    if (!this.targetHighlightLocation && state?.hash) {
      debugLog('[KanbanView] setState: Found hash in state:', state.hash);
      if (state.hash.startsWith('^') || state.hash.startsWith('%5E')) {
        const blockId = state.hash.startsWith('%5E')
          ? decodeURIComponent(state.hash).substring(1)
          : state.hash.substring(1);
        this.targetHighlightLocation = { blockId };
        debugLog(
          '[KanbanView] setState: Determined targetHighlightLocation from state.hash (blockId):',
          this.targetHighlightLocation
        );
      }
    }

    // Check window location hash as fallback
    if (!this.targetHighlightLocation) {
      const windowHash = this.getWindow().location.hash;
      debugLog('[KanbanView] setState: Window location hash:', windowHash);
      if (windowHash && windowHash.startsWith('#^')) {
        const blockId = windowHash.substring(2); // Remove #^
        this.targetHighlightLocation = { blockId };
        debugLog(
          '[KanbanView] setState: Determined targetHighlightLocation from window.location.hash (blockId):',
          this.targetHighlightLocation
        );
      }
    }

    if (!this.targetHighlightLocation && state?.eState) {
      if (state.eState.blockId || state.eState.cardTitle || state.eState.listName) {
        this.targetHighlightLocation = {
          blockId: state.eState.blockId,
          cardTitle: state.eState.cardTitle,
          listName: state.eState.listName,
        };
        debugLog(
          '[KanbanView] setState: Determined targetHighlightLocation from eState (blockId/cardTitle/listName):',
          this.targetHighlightLocation
        );
      } else if (state.eState.match) {
        this.targetHighlightLocation = { match: state.eState.match };
        debugLog(
          '[KanbanView] setState: Determined targetHighlightLocation from eState.match:',
          this.targetHighlightLocation
        );
      }
    }

    if (!this.targetHighlightLocation && state?.targetHighlightLocation) {
      this.targetHighlightLocation = state.targetHighlightLocation;
      debugLog(
        '[KanbanView] setState: Used targetHighlightLocation from persisted state:',
        this.targetHighlightLocation
      );
    }

    if (!this.targetHighlightLocation) {
      debugLog(
        '[KanbanView] setState: No specific highlight determined or persisted. targetHighlightLocation remains null.'
      );
    }

    const previousFilePath = this.file?.path;

    debugLog(
      '[KanbanView] setState: Calling super.setState. Current this.targetHighlightLocation:',
      this.targetHighlightLocation,
      'Current this.currentSearchMatch:',
      this.currentSearchMatch
    );
    const stateForSuper = {
      ...state,
      targetHighlightLocation: this.targetHighlightLocation,
    };
    await super.setState(stateForSuper, result);
    debugLog('[KanbanView] setState: super.setState completed.');

    const incomingFilePath = state?.file;

    let fileHasEffectivelyChanged = false;
    if (incomingFilePath && previousFilePath) {
      fileHasEffectivelyChanged =
        normalizePath(incomingFilePath) !== normalizePath(previousFilePath);
    } else if (incomingFilePath && !previousFilePath) {
      fileHasEffectivelyChanged = true;
    } else if (!incomingFilePath && previousFilePath) {
      fileHasEffectivelyChanged = true;
    }

    debugLog(
      `[KanbanView] setState: File change check: previous='${previousFilePath}', incoming='${incomingFilePath}', fileHasEffectivelyChanged=${fileHasEffectivelyChanged}`
    );

    const shouldProcessViewData = state?.eState && !state.eState.preventSetViewData;

    if (fileHasEffectivelyChanged || shouldProcessViewData) {
      if (this.file) {
        debugLog(
          `[KanbanView] setState: File effectively changed to ${this.file.path} or eState received. Resetting _isPendingInitialRender and _reactState. Will call setViewData.`
        );
        if (fileHasEffectivelyChanged) {
          this._reactHasRenderedOnceInThisInstance = false;
          debugLog(
            '[KanbanView] setState: File changed, so _reactHasRenderedOnceInThisInstance is reset to false for a clean render.'
          );
        }
        this._isPendingInitialRender = true;
        this._reactState = {};

        const fileContent = await this.app.vault.cachedRead(this.file);
        await this.setViewData(fileContent, true);
      } else {
        debugLog(
          '[KanbanView] setState: File effectively changed or eState processing, but this.file is not (or no longer) set. Clearing view.'
        );
        if (fileHasEffectivelyChanged) {
          this._reactHasRenderedOnceInThisInstance = false;
        }
        this.clear();
        this._isPendingInitialRender = true;
        this._reactState = {};
      }
    } else if (this.file && this.targetHighlightLocation) {
      debugLog(
        '[KanbanView] setState: File did NOT change, but targetHighlightLocation is set. Calling setReactState for highlight.'
      );
      this.setReactState({ targetHighlight: this.targetHighlightLocation, forceRerender: true });
    } else {
      debugLog(
        '[KanbanView] setState: No specific action taken to call setViewData or setReactState after super.setState. This may be normal if no relevant state changed.'
      );
    }
  }

  getState() {
    const state = super.getState();
    state.kanbanViewState = { ...this.viewSettings };
    return state;
  }

  setViewState<K extends keyof KanbanViewSettings>(
    key: K,
    val?: KanbanViewSettings[K],
    globalUpdater?: (old: KanbanViewSettings[K]) => KanbanViewSettings[K]
  ) {
    if (globalUpdater) {
      const stateManager = this.plugin.getStateManager(this.file);
      stateManager.viewSet.forEach((view) => {
        view.viewSettings[key] = globalUpdater(view.viewSettings[key]);
      });
    } else if (val) {
      this.viewSettings[key] = val;
    }

    this.app.workspace.requestSaveLayout();
  }

  populateViewState(settings: KanbanSettings) {
    this.viewSettings['kanban-plugin'] ??= settings['kanban-plugin'] || 'board';
    this.viewSettings['list-collapse'] ??= settings['list-collapse'] || [];
  }

  getViewState<K extends keyof KanbanViewSettings>(key: K) {
    if (!this.file) return this.viewSettings[key]; // Or a more specific default if key implies one
    const stateManager = this.plugin.stateManagers.get(this.file);
    if (!stateManager) {
      // console.warn(`[KanbanView] getViewState: StateManager not found for file: ${this.file.path}. Returning viewSettings only for key: ${String(key)}`);
      return this.viewSettings[key]; // Fallback to local viewSettings or undefined
    }
    const settingVal = stateManager.getSetting(key);
    return this.viewSettings[key] ?? settingVal;
  }

  useViewState<K extends keyof KanbanViewSettings>(key: K) {
    if (!this.file) return this.viewSettings[key];
    const stateManager = this.plugin.getStateManager(this.file);
    if (!stateManager) {
      // console.warn(`[KanbanView] useViewState: StateManager not found for file: ${this.file.path}. Returning viewSettings only for key: ${String(key)}`);
      return this.viewSettings[key];
    }
    const settingVal = stateManager.useSetting(key);
    return this.viewSettings[key] ?? settingVal;
  }

  getPortal() {
    const stateManager = this.plugin.getStateManager(this.file);
    if (!stateManager) {
      console.error(
        `KanbanView.getPortal(): StateManager for file ${this.file?.path} is not yet available.`
      );
      return <div style={{ padding: '20px', textAlign: 'center' }}>Loading Kanban board...</div>;
    }
    // Ensure this.file is available, similar to setReactState guard
    if (!this.file) {
      console.warn('[KanbanView] getPortal: this.file is null. Cannot render portal content.');
      return (
        <div style={{ padding: '20px', textAlign: 'center' }}>
          File not available for Kanban board.
        </div>
      );
    }

    return (
      <Kanban
        // Props as passed in setReactState for consistency
        plugin={this.plugin}
        view={this}
        stateManager={stateManager}
        settings={this.viewSettings}
        board={this.getBoard()}
        app={this.app}
        file={this.file}
        reactState={this._reactState || {}}
        setReactState={this.setReactState.bind(this)}
        emitter={this.emitter}
        dispatch={(...args: any) => this.plugin.onDbChange(this.file, ...args)}
        onwardsNavigate={this.plugin.onwardsNavigate}
        archivedCount={this.getBoard()?.data?.archive?.length || 0}
      />
    );
  }

  getBoardSettings() {
    const stateManager = this.plugin.stateManagers.get(this.file);
    const board = stateManager.state;

    new SettingsModal(
      this,
      {
        onSettingsChange: (settings) => {
          const updatedBoard = update(board, {
            data: {
              settings: {
                $set: settings,
              },
            },
          });

          // Save to disk, compute text of new board
          stateManager.setState(updatedBoard);
        },
      },
      board.data.settings
    ).open();
  }

  onPaneMenu(menu: Menu, source: string, callSuper: boolean = true) {
    if (source !== 'more-options') {
      super.onPaneMenu(menu, source);
      return;
    }
    // Add a menu item to force the board to markdown view
    menu
      .addItem((item) => {
        item
          .setTitle(t('Open as markdown'))
          .setIcon('lucide-file-text')
          .setSection('pane')
          .onClick(() => {
            this.plugin.kanbanFileModes[(this.leaf as any).id || this.file.path] = 'markdown';
            this.plugin.setMarkdownView(this.leaf);
          });
      })
      .addItem((item) => {
        item
          .setTitle(t('Open board settings'))
          .setIcon('lucide-settings')
          .setSection('pane')
          .onClick(() => {
            this.getBoardSettings();
          });
      })
      .addItem((item) => {
        item
          .setTitle(t('Archive completed cards'))
          .setIcon('lucide-archive')
          .setSection('pane')
          .onClick(() => {
            const stateManager = this.plugin.stateManagers.get(this.file);
            stateManager.archiveCompletedCards();
          });
      });

    if (callSuper) {
      super.onPaneMenu(menu, source);
    }
  }

  initHeaderButtons = debounce(() => this._initHeaderButtons(), 10, true);

  _initHeaderButtons = async () => {
    if (Platform.isPhone) return;
    const stateManager = this.plugin.getStateManager(this.file);

    if (!stateManager) return;

    if (
      stateManager.getSetting('show-board-settings') &&
      !this.actionButtons['show-board-settings']
    ) {
      this.actionButtons['show-board-settings'] = this.addAction(
        'lucide-settings',
        t('Open board settings'),
        () => {
          this.getBoardSettings();
        }
      );
    } else if (
      !stateManager.getSetting('show-board-settings') &&
      this.actionButtons['show-board-settings']
    ) {
      this.actionButtons['show-board-settings'].remove();
      delete this.actionButtons['show-board-settings'];
    }

    if (stateManager.getSetting('show-set-view') && !this.actionButtons['show-set-view']) {
      this.actionButtons['show-set-view'] = this.addAction(
        'lucide-view',
        t('Board view'),
        (evt) => {
          const view = this.viewSettings[frontmatterKey] || stateManager.getSetting(frontmatterKey);
          new Menu()
            .addItem((item) =>
              item
                .setTitle(t('View as board'))
                .setIcon('lucide-trello')
                .setChecked(view === 'basic' || view === 'board')
                .onClick(() => this.setView('board'))
            )
            .addItem((item) =>
              item
                .setTitle(t('View as table'))
                .setIcon('lucide-table')
                .setChecked(view === 'table')
                .onClick(() => this.setView('table'))
            )
            .addItem((item) =>
              item
                .setTitle(t('View as list'))
                .setIcon('lucide-server')
                .setChecked(view === 'list')
                .onClick(() => this.setView('list'))
            )
            .showAtMouseEvent(evt);
        }
      );
    } else if (!stateManager.getSetting('show-set-view') && this.actionButtons['show-set-view']) {
      this.actionButtons['show-set-view'].remove();
      delete this.actionButtons['show-set-view'];
    }

    if (stateManager.getSetting('show-search') && !this.actionButtons['show-search']) {
      this.actionButtons['show-search'] = this.addAction('lucide-search', t('Search...'), () => {
        this.emitter.emit('hotkey', { commandId: 'editor:open-search' });
      });
    } else if (!stateManager.getSetting('show-search') && this.actionButtons['show-search']) {
      this.actionButtons['show-search'].remove();
      delete this.actionButtons['show-search'];
    }

    if (
      stateManager.getSetting('show-view-as-markdown') &&
      !this.actionButtons['show-view-as-markdown']
    ) {
      this.actionButtons['show-view-as-markdown'] = this.addAction(
        'lucide-file-text',
        t('Open as markdown'),
        () => {
          this.plugin.kanbanFileModes[(this.leaf as any).id || this.file.path] = 'markdown';
          this.plugin.setMarkdownView(this.leaf);
        }
      );
    } else if (
      !stateManager.getSetting('show-view-as-markdown') &&
      this.actionButtons['show-view-as-markdown']
    ) {
      this.actionButtons['show-view-as-markdown'].remove();
      delete this.actionButtons['show-view-as-markdown'];
    }

    if (stateManager.getSetting('show-archive-all') && !this.actionButtons['show-archive-all']) {
      this.actionButtons['show-archive-all'] = this.addAction(
        'lucide-archive',
        t('Archive completed cards'),
        () => {
          const stateManager = this.plugin.stateManagers.get(this.file);
          stateManager.archiveCompletedCards();
        }
      );
    } else if (
      !stateManager.getSetting('show-archive-all') &&
      this.actionButtons['show-archive-all']
    ) {
      this.actionButtons['show-archive-all'].remove();
      delete this.actionButtons['show-archive-all'];
    }

    if (stateManager.getSetting('show-add-list') && !this.actionButtons['show-add-list']) {
      const btn = this.addAction('lucide-plus-circle', t('Add a list'), () => {
        this.emitter.emit('showLaneForm', undefined);
      });

      btn.addClass(c('ignore-click-outside'));

      this.actionButtons['show-add-list'] = btn;
    } else if (!stateManager.getSetting('show-add-list') && this.actionButtons['show-add-list']) {
      this.actionButtons['show-add-list'].remove();
      delete this.actionButtons['show-add-list'];
    }
  };

  clear() {
    unmountComponentAtNode(this.contentEl);
  }

  async setReactState(newState?: any) {
    debugLog('[KanbanView] setReactState called with:', newState);
    let stateManager = this.plugin.stateManagers.get(this.file);

    if (!stateManager && this.file && this.data) {
      console.warn(
        `[KanbanView] setReactState: StateManager not found for ${this.file.path}. Attempting to re-initialize with plugin.addView.`
      );
      try {
        await this.plugin.addView(this, this.data, this.isPrimary);
        stateManager = this.plugin.stateManagers.get(this.file);
        if (stateManager) {
          debugLog(
            `[KanbanView] setReactState: StateManager re-established for ${this.file.path} after plugin.addView.`
          );
        } else {
          console.error(
            `[KanbanView] setReactState: Failed to re-establish StateManager for ${this.file.path} after plugin.addView. Cannot render.`
          );
          this.contentEl.empty();
          this.contentEl.createDiv({
            text: 'Error: Failed to connect to Kanban data manager.',
          });
          return;
        }
      } catch (e) {
        console.error(
          `[KanbanView] setReactState: Error during plugin.addView for ${this.file.path}:`,
          e
        );
        this.contentEl.empty();
        this.contentEl.createDiv({ text: 'Error: Could not initialize Kanban board view.' });
        return;
      }
    }

    // Header element visibility (simplified, ensure headerEl exists and has show/hide)
    if (
      (this as any).headerEl &&
      typeof (this as any).headerEl.hide === 'function' &&
      typeof (this as any).headerEl.show === 'function'
    ) {
      const headerEl = (this as any).headerEl;
      // Assuming a global setting for show-board-settings, replace with actual logic if different
      if (this.plugin.settings['show-board-settings']) {
        // This might need to be a board-specific setting
        headerEl.show();
      } else {
        headerEl.hide();
      }
    } else {
      // console.warn('[KanbanView] setReactState: this.headerEl is not available or does not have hide/show methods.');
    }

    if (stateManager) {
      if (newState) {
        this._reactState = update(this._reactState, { $merge: newState });
      }

      const win = this.getWindow();
      if (this._initialRenderTimeoutId) {
        win.clearTimeout(this._initialRenderTimeoutId);
      }
      this._isPendingInitialRender = true; // Flag that a render is intended

      const renderBoardCallback = (currentBoardState: Board | null, isPrimaryView: boolean) => {
        if (!this.contentEl || (this.leaf as any).detached) {
          debugLog(
            '[KanbanView] setReactState (renderBoardCallback): Content element not available or leaf detached. Skipping render.'
          );
          this._isPendingInitialRender = false;
          return;
        }

        debugLog(
          '[KanbanView] renderBoardCallback: Value received from this.getBoard(): ',
          currentBoardState ? `Board object with ID: ${currentBoardState.id}` : 'null'
        );

        if (this.contentEl) {
          const unmounted = unmountComponentAtNode(this.contentEl);
          debugLog(
            `[KanbanView] setReactState (renderBoardCallback): Attempted unmount. Was component unmounted? ${unmounted}. contentEl children after unmount: ${this.contentEl.children.length}`
          );
          // Aggressive cleanup if unmount fails or leaves children
          if (!unmounted || this.contentEl.children.length > 0) {
            debugLog(
              `[KanbanView] setReactState (renderBoardCallback): Unmount returned ${unmounted} or children still exist. Clearing innerHTML.`
            );
            this.contentEl.innerHTML = '';
          }
          this._reactHasRenderedOnceInThisInstance = true;
        } else {
          console.warn(
            '[KanbanView] setReactState (renderBoardCallback): contentEl is null or undefined before attempting to unmount/render.'
          );
        }

        if (currentBoardState) {
          this.pendingHighlightScroll = null; // Clear pending scroll state
          this.currentSearchMatch = null;

          render(
            createElement(
              DndContext,
              { win: this.getWindow(), onDrop: this.handleDrop.bind(this) },
              createElement(Kanban, {
                key: `${this.file?.path}-${currentBoardState?.data?.frontmatter?.['kanban-plugin']}`,
                plugin: this.plugin,
                view: this,
                stateManager: stateManager,
                settings: this.viewSettings,
                board: currentBoardState,
                app: this.app,
                file: this.file,
                reactState: this._reactState,
                setReactState: (s: any) => this.setReactState(s), // Pass bound version
                emitter: this.emitter,
                dispatch: (...args: any) => this.plugin.onDbChange(this.file, ...args),
                onwardsNavigate: this.plugin.onwardsNavigate,
                archivedCount: currentBoardState?.data?.archive?.length || 0,
              })
            ),
            this.contentEl
          );
          debugLog(
            '[KanbanView] setReactState (renderBoardCallback): React component rendered/updated.'
          );
          this._isPendingInitialRender = false;

          if (this.targetHighlightLocation) {
            debugLog(
              '[KanbanView] setReactState (renderBoardCallback): Scheduling applyHighlight after render with a short delay for target:',
              JSON.stringify(this.targetHighlightLocation)
            );

            // Try highlighting with increasing delays to ensure DOM is ready
            const tryHighlight = (attempt: number, maxAttempts: number = 5) => {
              const delay = attempt * 100; // 0ms, 100ms, 200ms, 300ms, 400ms (faster retries)

              this.getWindow().setTimeout(() => {
                const hasFocus = this.contentEl.contains(document.activeElement);
                const viewStillActive = this.contentEl && !(this.leaf as any).detached;
                let targetHighlightLocationString = 'null';
                try {
                  targetHighlightLocationString = JSON.stringify(this.targetHighlightLocation);
                } catch (e_shl) {
                  console.error(
                    '[KanbanView] ERROR stringifying this.targetHighlightLocation in setReactState:',
                    e_shl.message
                  );
                  targetHighlightLocationString = `UNSTRINGIFIABLE: ${Object.keys(this.targetHighlightLocation || {}).join(', ')}`;
                }
                debugLog(
                  `[KanbanView] setReactState (renderBoardCallback setTimeout attempt ${attempt + 1}): Checking conditions before applyHighlight. Target: ${targetHighlightLocationString}, HasFocus: ${hasFocus}, ViewStillActive: ${viewStillActive}`
                );

                if (this.targetHighlightLocation && viewStillActive) {
                  debugLog(
                    `[KanbanView] setReactState (renderBoardCallback setTimeout attempt ${attempt + 1}): Conditions met. Calling applyHighlight.`
                  );

                  // Check if we can find the element before calling applyHighlight
                  const blockId = this.targetHighlightLocation.blockId;
                  if (blockId) {
                    const normalizedBlockId = blockId.replace(/^[#^]+/, '');
                    const testElement = this.contentEl.querySelector(
                      `[data-id='${normalizedBlockId}']`
                    );

                    if (testElement) {
                      debugLog(
                        `[KanbanView] setReactState: Element found on attempt ${attempt + 1}, proceeding with highlight.`
                      );
                      this.applyHighlight();
                      return; // Success, don't retry
                    } else if (attempt < maxAttempts - 1) {
                      debugLog(
                        `[KanbanView] setReactState: Element not found on attempt ${attempt + 1}, will retry...`
                      );
                      tryHighlight(attempt + 1, maxAttempts);
                      return; // Retry
                    } else {
                      debugLog(
                        `[KanbanView] setReactState: Element not found after ${maxAttempts} attempts, calling applyHighlight anyway for debugging.`
                      );
                      this.applyHighlight();
                      return;
                    }
                  } else {
                    // No blockId, just call applyHighlight
                    this.applyHighlight();
                  }
                } else if (this.targetHighlightLocation) {
                  if (!viewStillActive)
                    debugLog(
                      `[KanbanView] setReactState (renderBoardCallback setTimeout attempt ${attempt + 1}): Aborted applyHighlight because view is no longer active or contentEl is missing.`
                    );
                } else {
                  debugLog(
                    `[KanbanView] setReactState (renderBoardCallback setTimeout attempt ${attempt + 1}): Aborted applyHighlight because targetHighlightLocation is now null.`
                  );
                }
              }, delay);
            };

            // Start the retry sequence
            tryHighlight(0);
          }
        } else {
          console.error(
            `[KanbanView] setReactState (renderBoardCallback): currentBoardState (from this.getBoard()) is null for file ${this.file?.path}. Cannot render board.`
          );
          this.contentEl.empty();
          this.contentEl.createDiv({
            text: 'Error: Kanban data not available for rendering.',
          });
          this._isPendingInitialRender = false;
        }
      };

      // Determine if immediate render or timeout render
      if (this._reactHasRenderedOnceInThisInstance) {
        if (!this._isPendingInitialRender || (newState && newState.forceRerender)) {
          // If already rendered, and not in a pending initial state (or forced), render directly
          renderBoardCallback(this.getBoard(), this.isPrimary);
        } else {
          // If pending initial render, ensure it happens via timeout
          if (this._initialRenderTimeoutId) win.clearTimeout(this._initialRenderTimeoutId);
          this._initialRenderTimeoutId = win.setTimeout(
            () => renderBoardCallback(this.getBoard(), this.isPrimary),
            0 // Execute as soon as possible
          );
        }
      } else {
        // First render always goes through timeout to ensure DOM is ready etc.
        this._initialRenderTimeoutId = win.setTimeout(
          () => renderBoardCallback(this.getBoard(), this.isPrimary),
          0 // Execute as soon as possible
        );
      }
    } else {
      console.warn(
        `[KanbanView] setReactState: StateManager not found for file ${this.file?.path}. Cannot render board.`
      );
      this.contentEl.empty();
      this.contentEl.createDiv({
        text: 'Error: Kanban data manager not found for this file.',
      });
    }
  }

  applyHighlight() {
    let targetHighlightLocationString = 'null';
    try {
      targetHighlightLocationString = JSON.stringify(this.targetHighlightLocation);
    } catch (e_ahl) {
      console.error(
        '[KanbanView] ERROR stringifying this.targetHighlightLocation in applyHighlight:',
        e_ahl.message
      );
      targetHighlightLocationString = `UNSTRINGIFIABLE: ${Object.keys(this.targetHighlightLocation || {}).join(', ')}`;
    }
    debugLog(
      `[KanbanView] applyHighlight: Called. Current targetHighlightLocation: ${targetHighlightLocationString}`
    );

    this.contentEl.querySelectorAll('.search-result-highlight').forEach((el) => {
      el.removeClass('search-result-highlight');
    });

    if (!this.targetHighlightLocation) {
      debugLog('[KanbanView] applyHighlight: No targetHighlightLocation. Aborting.');
      return;
    }

    const board = this.getBoard();
    if (!board) {
      console.error(
        `[KanbanView] applyHighlight: Board data not available for file: ${this.file?.path}. Aborting highlight.`
      );
      return;
    }

    let targetItemElement: HTMLElement | null = null;
    let blockIdToSearch: string | undefined = this.targetHighlightLocation.blockId;
    let cardTitleForSearch: string | undefined = this.targetHighlightLocation.cardTitle;
    let listNameForSearch: string | undefined = this.targetHighlightLocation.listName;

    // 1. Handle global search result from targetHighlightLocation.match
    if (this.targetHighlightLocation.match && !blockIdToSearch && !cardTitleForSearch) {
      const matchData = this.targetHighlightLocation.match;
      debugLog('[KanbanView] applyHighlight: Processing global search match:', matchData);

      // Attempt to get blockId from matchData.subpath if it exists
      if (matchData.subpath && matchData.subpath.startsWith('#^')) {
        blockIdToSearch = matchData.subpath.substring(2); // Remove #^
        debugLog(
          `[KanbanView] applyHighlight: Extracted blockId '${blockIdToSearch}' from matchData.subpath.`
        );
        cardTitleForSearch = undefined; // Prioritize blockId from subpath
        listNameForSearch = undefined;
      } else if (
        matchData.matches &&
        matchData.matches.length > 0 &&
        matchData.matches[0].length === 2
      ) {
        // Use character offsets from the search match to find the correct card
        const matchStartOffset = matchData.matches[0][0] as number;
        const matchEndOffset = matchData.matches[0][1] as number;
        debugLog(
          `[KanbanView] applyHighlight: Using match offsets: start=${matchStartOffset}, end=${matchEndOffset}`
        );

        let foundItemViaOffset: Item | null = null; // Changed from ItemData to Item
        for (const lane of board.children) {
          for (const item of lane.children) {
            // item here is of type Item
            if (
              item.data.position &&
              item.data.position.start &&
              item.data.position.end &&
              typeof item.data.position.start.offset === 'number' &&
              typeof item.data.position.end.offset === 'number'
            ) {
              if (
                matchStartOffset >= item.data.position.start.offset &&
                matchEndOffset <= item.data.position.end.offset
              ) {
                foundItemViaOffset = item; // Store the whole Item
                break;
              }
            }
          }
          if (foundItemViaOffset) break;
        }

        if (foundItemViaOffset) {
          blockIdToSearch = foundItemViaOffset.data.blockId || foundItemViaOffset.id; // Use Item.data.blockId or Item.id
          cardTitleForSearch = undefined;
          listNameForSearch = undefined;
          debugLog(
            `[KanbanView] applyHighlight: Found card from global search via OFFSET. ID/BlockID to use: '${blockIdToSearch}' for card title: '${foundItemViaOffset.data.titleRaw}'`
          );
        } else {
          console.warn(
            `[KanbanView] applyHighlight: Global search match offsets (start: ${matchStartOffset}, end: ${matchEndOffset}) did not fall within any card's position offsets.`
          );
          // Fallback to old text matching if offset matching fails
          if (matchData.content && matchData.matches && matchData.matches.length > 0) {
            const content = matchData.content as string;
            const firstMatchOffsets = matchData.matches[0] as [number, number];
            const matchedText = content.substring(firstMatchOffsets[0], firstMatchOffsets[1]);
            debugLog(
              `[KanbanView] applyHighlight: FALLBACK - Extracted matchedText from global search: '${matchedText}'`
            );

            let foundCard = null;
            for (const lane of board.children) {
              for (const item of lane.children) {
                if (item.data.titleRaw?.toLowerCase().includes(matchedText.toLowerCase())) {
                  foundCard = item;
                  break;
                }
                if (
                  !foundCard &&
                  item.data.title?.toLowerCase().includes(matchedText.toLowerCase())
                ) {
                  foundCard = item;
                  break;
                }
              }
              if (foundCard) break;
            }

            if (foundCard) {
              blockIdToSearch = foundCard.data.blockId || foundCard.id;
              cardTitleForSearch = undefined;
              listNameForSearch = undefined;
              debugLog(
                `[KanbanView] applyHighlight: FALLBACK - Found card from global search via matchedText. ID/BlockID: '${blockIdToSearch}' from card title: '${foundCard.data.titleRaw}'`
              );
            } else {
              console.warn(
                `[KanbanView] applyHighlight: FALLBACK - Global search matchedText '${matchedText}' not found in any card title.`
              );
            }
          }
        }
      } else {
        console.warn(
          '[KanbanView] applyHighlight: Malformed global search match data in targetHighlightLocation (missing matches, or matches[0] is not an array of two numbers):',
          matchData
        );
      }
    }

    // 2. Attempt to find by blockId (either from direct nav or resolved from global search)
    if (blockIdToSearch) {
      const normalizedBlockId = blockIdToSearch.replace(/^[#^]+/, '');
      debugLog(
        `[KanbanView] applyHighlight: Searching for card with blockId: '${normalizedBlockId}'`
      );

      // First, search through the board data to find which card contains this blockId
      let targetCardInternalId: string | null = null;

      if (board) {
        debugLog(
          `[KanbanView] applyHighlight: Searching through ${board.children.length} lanes for blockId '${normalizedBlockId}'`
        );

        for (const lane of board.children) {
          debugLog(
            `[KanbanView] applyHighlight: Checking lane '${lane.data.title}' with ${lane.children.length} cards`
          );

          for (const item of lane.children) {
            // Check if this item has the blockId we're looking for
            const itemBlockId = item.data.blockId;
            const itemId = item.id;

            debugLog(
              `[KanbanView] applyHighlight: Card '${item.data.title}' - itemId: '${itemId}', blockId: '${itemBlockId}'`
            );

            if (itemBlockId === normalizedBlockId || itemBlockId === `^${normalizedBlockId}`) {
              targetCardInternalId = itemId;
              debugLog(
                `[KanbanView] applyHighlight: Found matching card! Internal ID: '${targetCardInternalId}', blockId: '${itemBlockId}'`
              );
              break;
            }

            // Also check if the blockId appears in the card's raw content
            if (item.data.titleRaw && item.data.titleRaw.includes(`^${normalizedBlockId}`)) {
              targetCardInternalId = itemId;
              debugLog(
                `[KanbanView] applyHighlight: Found matching card by titleRaw content! Internal ID: '${targetCardInternalId}'`
              );
              break;
            }
          }

          if (targetCardInternalId) break;
        }
      }

      if (targetCardInternalId) {
        debugLog(
          `[KanbanView] applyHighlight: Looking for DOM element with data-id: '${targetCardInternalId}'`
        );

        // Now find the DOM element using the internal ID
        const parentItemElement = this.contentEl.querySelector(
          `div.kanban-plugin__item[data-id='${targetCardInternalId}']`
        ) as HTMLElement;

        if (parentItemElement) {
          debugLog(
            '[KanbanView] applyHighlight: Found parent item element by internal ID:',
            parentItemElement
          );
          targetItemElement =
            (parentItemElement.querySelector(
              'div.kanban-plugin__item-content-wrapper'
            ) as HTMLElement) || parentItemElement;

          if (targetItemElement) {
            debugLog(
              '[KanbanView] applyHighlight: Found content wrapper for blockId:',
              targetItemElement
            );
          } else {
            debugLog(
              '[KanbanView] applyHighlight: Parent item found, but .kanban-plugin__item-content-wrapper not found. Using parent.'
            );
            targetItemElement = parentItemElement;
          }
        } else {
          debugLog(
            `[KanbanView] applyHighlight: DOM element with data-id '${targetCardInternalId}' not found`
          );
        }
      } else {
        debugLog(
          `[KanbanView] applyHighlight: No card found with blockId '${normalizedBlockId}' in board data`
        );

        // Debug: Log all available cards and their blockIds
        if (board) {
          debugLog('[KanbanView] applyHighlight: Available cards in board:');
          for (const lane of board.children) {
            debugLog(`  Lane '${lane.data.title}':`);
            for (const item of lane.children) {
              debugLog(
                `    - Card '${item.data.title}' (ID: ${item.id}, blockId: ${item.data.blockId})`
              );
            }
          }
        }
      }
    }

    // 3. If not found by blockId, and cardTitleForSearch/listNameForSearch are available (from direct nav)
    if (!targetItemElement && cardTitleForSearch && listNameForSearch) {
      debugLog(
        `[KanbanView] applyHighlight: Attempting title/list lookup. Title: '${cardTitleForSearch}', List: '${listNameForSearch}'`
      );
      const targetLane = board.children.find(
        (lane) => lane.data.title.toLowerCase() === listNameForSearch?.toLowerCase()
      );
      if (targetLane) {
        debugLog(
          `[KanbanView] applyHighlight: Found target lane by title: ${targetLane.data.title}. It has ${targetLane.children.length} items.`
        );
        for (const item of targetLane.children) {
          const currentItemTitle = item.data.title;
          debugLog(
            `[KanbanView] applyHighlight: Item ID ${item.id} in lane, Title from data: "'${currentItemTitle}'", Target Title: "'${cardTitleForSearch}'"`
          );
          // Use includes for partial match, as cardTitle might be a snippet
          if (currentItemTitle?.toLowerCase().includes(cardTitleForSearch.toLowerCase())) {
            const itemDomId = item.data.blockId ? item.data.blockId.replace(/^[#^]+/, '') : item.id;
            const parentItemElement = this.contentEl.querySelector(
              `div.kanban-plugin__item[data-id='${itemDomId}']`
            ) as HTMLElement;
            if (parentItemElement) {
              targetItemElement =
                (parentItemElement.querySelector(
                  'div.kanban-plugin__item-content-wrapper'
                ) as HTMLElement) || parentItemElement;
              debugLog(
                '[KanbanView] applyHighlight: Found item by title/list in lane (DOM element):',
                targetItemElement
              );
            } else {
              debugLog(
                `[KanbanView] applyHighlight: Matched item data by title/list (ID: ${item.id}), but its DOM element with data-id '${itemDomId}' not found.`
              );
            }
            break; // Found the first matching card by title
          }
        }
      } else {
        debugLog(`[KanbanView] applyHighlight: Lane '${listNameForSearch}' not found.`);
      }
      debugLog(
        `[KanbanView] applyHighlight: Result of title/list lookup for item '${cardTitleForSearch}' in list '${listNameForSearch}':`,
        targetItemElement
      );
    }

    if (targetItemElement) {
      debugLog(
        '[KanbanView] applyHighlight: Applying .search-result-highlight to:',
        targetItemElement
      );
      targetItemElement.addClass('search-result-highlight');
      // Scroll into view with a slight delay to ensure layout is stable
      setTimeout(() => {
        targetItemElement?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, 50);
    } else {
      debugLog(
        `[KanbanView] applyHighlight: No target item element found for highlighting. target: ${JSON.stringify(this.targetHighlightLocation)}. No ID could be determined (direct, subpath, or offset). Title/list search for title: '${this.targetHighlightLocation.cardTitle}' in list: '${this.targetHighlightLocation.listName}' also failed or was not applicable.`
      );
    }
  }

  clearActiveSearchHighlight() {
    debugLog(
      '[KanbanView] clearActiveSearchHighlight (for BORDER) called. Current this.targetHighlightLocation:',
      this.targetHighlightLocation
    );
    if (this.targetHighlightLocation) {
      this.targetHighlightLocation = null; // Clear the state that might trigger re-highlighting
      this.contentEl.querySelectorAll('.search-result-highlight').forEach((el) => {
        el.removeClass('search-result-highlight');
      });
      debugLog('[KanbanView] clearActiveSearchHighlight: Cleared BORDER highlight and DOM class.');
    } else {
      debugLog('[KanbanView] clearActiveSearchHighlight: No active BORDER highlight to clear.');
    }
  }

  handleBoardClickToClearHighlight = (event: MouseEvent) => {
    const target = event.target as HTMLElement;

    // Don't clear if the click is on an item itself, or interactive elements like links, buttons, inputs, etc.
    if (
      target.closest('.kanban-plugin__item') ||
      target.tagName === 'A' ||
      target.tagName === 'BUTTON' ||
      target.tagName === 'INPUT' ||
      target.tagName === 'TEXTAREA' ||
      target.tagName === 'SELECT' ||
      (target.hasAttribute('contenteditable') &&
        target.getAttribute('contenteditable') === 'true') ||
      target.closest('.setting-item') // Don't clear if clicking within a setting item (e.g., in a modal over the board)
    ) {
      return; // Do nothing, let the interaction proceed
    }

    // If we reach here, the click was on the board background or a non-interactive area
    this.clearActiveSearchHighlight();

    // Also clear any global search match stored
    if (this.currentSearchMatch) {
      debugLog(
        '[KanbanView] handleBoardClickToClearHighlight: Clearing currentSearchMatch for global search highlight.',
        this.currentSearchMatch
      );
      this.currentSearchMatch = null;
      this.setReactState({}); // Trigger a re-render to remove any search-specific UI elements
    } else {
      // debugLog('[KanbanView] handleBoardClickToClearHighlight: No currentSearchMatch to clear for global search highlight.');
    }

    // Handle card edit saving/cancellation if the setting is enabled
    if (this.plugin.settings.clickOutsideCardToSaveEdit) {
      debugLog(
        '[KanbanView] handleBoardClickToClearHighlight: Emitting "saveAllCardEdits" (setting enabled)'
      );
      this.emitter.emit('saveAllCardEdits');
    } else {
      debugLog(
        '[KanbanView] handleBoardClickToClearHighlight: Emitting "cancelAllCardEdits" (setting disabled)'
      );
      this.emitter.emit('cancelAllCardEdits');
    }
  };

  handleDrop(dragEntity: any, dropEntity: any) {
    // Enhanced logging for drag and drop entities
    debugLog(
      '[KanbanView] handleDrop RAW DRAG ENTITY (top-level props):',
      Object.keys(dragEntity).join(', ')
    );
    debugLog(
      '[KanbanView] handleDrop RAW DROP ENTITY (top-level props):',
      Object.keys(dropEntity).join(', ')
    );

    const dragData = dragEntity.getData();
    const dropData = dropEntity.getData();

    // Create copies for logging, excluding the circular 'win' property
    const dragDataForLog = { ...dragData };
    delete dragDataForLog.win;
    // debugLog('[KanbanView] handleDrop DRAG ENTITY DATA:', JSON.stringify(dragDataForLog, null, 2));

    const dropDataForLog = { ...dropData };
    delete dropDataForLog.win;
    // debugLog('[KanbanView] handleDrop DROP ENTITY DATA:', JSON.stringify(dropDataForLog, null, 2));

    const board = this.getBoard();
    if (!board) {
      console.error('[KanbanView] handleDrop: Could not get board data.');
      return;
    }
    debugLog(`[KanbanView] handleDrop: Board ID: ${board.id}, File: ${this.file?.path}`);
    let newBoard: Board;

    // Card to Lane/List Drag (or reorder within lane)
    if (
      dragData?.type === 'item' &&
      (dropData?.type === 'lane' || dropData?.type === 'placeholder')
    ) {
      const cardId = dragData.id; // ID of the card being dragged
      const sourceLaneId = dragData.parentLaneId; // Custom: Lane ID the card came from
      const originalCardIndex = dragData.originalIndex; // Custom: Original index in source lane

      let targetLaneId: string | undefined;
      let targetVisualIndex: number | undefined;

      if (dropData.type === 'lane') {
        targetLaneId = dropData.id; // ID of the lane being dropped onto
        targetVisualIndex =
          typeof dropData.index === 'number'
            ? dropData.index
            : board.children.find((lane) => lane.id === targetLaneId)?.children.length || 0;
        debugLog('[KanbanView] handleDrop (Card To Lane): Drop target is a LANE.', {
          targetLaneId,
          targetVisualIndex,
        });
      } else {
        // dropData.type === 'placeholder'
        try {
          debugLog(
            '[KanbanView] handleDrop (Card To Placeholder): Raw dropEntity.getPath() output:',
            JSON.stringify(dropEntity.getPath())
          );
        } catch (e) {
          console.error('[KanbanView] ERROR stringifying dropEntity.getPath():', e.message);
          debugLog(
            '[KanbanView] dropEntity.getPath() raw object (if available):',
            dropEntity.getPath()
          );
        }
        try {
          debugLog(
            '[KanbanView] handleDrop (Card To Placeholder): Full dropData for placeholder:',
            JSON.stringify(dropDataForLog, null, 2)
          );
        } catch (e) {
          console.error('[KanbanView] ERROR stringifying dropDataForLog (placeholder):', e.message);
          debugLog('[KanbanView] dropDataForLog (placeholder) keys:', Object.keys(dropDataForLog));
        }

        const placeholderPath = dropEntity.getPath();
        if (placeholderPath && placeholderPath.length > 0) {
          const targetLaneBoardIndex = placeholderPath[0];
          if (targetLaneBoardIndex >= 0 && targetLaneBoardIndex < board.children.length) {
            const potentialTargetLane = board.children[targetLaneBoardIndex];
            if (potentialTargetLane && potentialTargetLane.id) {
              targetLaneId = potentialTargetLane.id;
              // The placeholder's index within the lane is often the second part of the path, or dropData.index
              targetVisualIndex =
                typeof dropData.index === 'number'
                  ? dropData.index
                  : placeholderPath.length > 1
                    ? placeholderPath[1]
                    : potentialTargetLane.children.length;
              debugLog(
                '[KanbanView] handleDrop (Card To Placeholder): Determined target lane from path.',
                { targetLaneId, targetVisualIndex, targetLaneBoardIndex, placeholderPath }
              );
            } else {
              console.error(
                '[KanbanView] handleDrop (Card To Placeholder): Lane at path index ' +
                  targetLaneBoardIndex +
                  ' is invalid or has no ID.'
              );
            }
          } else {
            console.error(
              '[KanbanView] handleDrop (Card To Placeholder): Path lane index ' +
                targetLaneBoardIndex +
                ' is out of bounds for board.children.'
            );
          }
        } else {
          console.error(
            '[KanbanView] handleDrop (Card To Placeholder): dropEntity.getPath() returned empty or invalid path.'
          );
        }

        // If targetLaneId is still undefined after path logic, we have a problem.
        if (!targetLaneId) {
          console.error(
            '[KanbanView] handleDrop (Card To Placeholder): CRITICAL - Could not determine target lane using path. Placeholder data:'
          );
          try {
            console.error(JSON.stringify(dropDataForLog, null, 2)); // Log problematic data here
          } catch (e_crit) {
            console.error(
              '[KanbanView] ERROR stringifying dropDataForLog in CRITICAL block:',
              e_crit.message
            );
            debugLog(
              '[KanbanView] dropDataForLog (CRITICAL block) keys:',
              Object.keys(dropDataForLog)
            );
          }
          return; // Early exit
        }
      }

      debugLog(
        '[KanbanView] handleDrop (Card To Lane/Placeholder): Extracted IDs and Indices:',
        // Removed JSON.stringify here for now to avoid potential errors on the main log object if complex values exist.
        {
          cardId,
          sourceLaneId,
          originalCardIndex,
          targetLaneId,
          targetVisualIndex,
          dragDataType: dragData?.type,
          dropDataType: dropData?.type,
        }
      );

      if (
        cardId === undefined ||
        sourceLaneId === undefined ||
        targetLaneId === undefined || // Check the resolved targetLaneId
        typeof originalCardIndex !== 'number' ||
        typeof targetVisualIndex !== 'number' // Ensure targetVisualIndex is a number
      ) {
        console.error('[KanbanView] handleDrop (Card): Missing critical IDs or indices.');
        try {
          console.error(
            JSON.stringify(
              {
                cardId,
                sourceLaneId,
                originalCardIndex,
                targetLaneId,
                targetVisualIndex,
                dragData: dragDataForLog,
                dropData: dropDataForLog,
              },
              null,
              2
            )
          );
        } catch (e_ids) {
          console.error(
            '[KanbanView] ERROR stringifying data in Missing Critical IDs block:',
            e_ids.message
          );
          debugLog('[KanbanView] dragDataForLog (Missing IDs) keys:', Object.keys(dragDataForLog));
          debugLog('[KanbanView] dropDataForLog (Missing IDs) keys:', Object.keys(dropDataForLog));
        }
        return;
      }

      const sourceLaneIndex = board.children.findIndex((lane) => lane.id === sourceLaneId);
      const targetLaneIndex = board.children.findIndex((lane) => lane.id === targetLaneId);

      if (sourceLaneIndex === -1 || targetLaneIndex === -1) {
        console.error(
          '[KanbanView] handleDrop (Card): Source or target lane not found in board data.'
        );
        try {
          console.error(
            JSON.stringify(
              { sourceLaneId, targetLaneId, sourceLaneIndex, targetLaneIndex },
              null,
              2
            )
          );
        } catch (e_stl) {
          console.error(
            '[KanbanView] ERROR stringifying source/target lane details in handleDrop:',
            e_stl.message
          );
          debugLog(
            '[KanbanView] source/target lane details object keys (handleDrop):',
            Object.keys({ sourceLaneId, targetLaneId, sourceLaneIndex, targetLaneIndex })
          );
        }
        return;
      }

      const cardToMove = board.children[sourceLaneIndex]?.children[originalCardIndex];

      if (!cardToMove) {
        console.error(
          '[KanbanView] handleDrop (Card): Card to move not found in source lane at original index.'
        );
        return;
      }

      // const cardToMoveDetails = board.children[sourceLaneIndex]?.children[originalCardIndex];
      // debugLog('[KanbanView] handleDrop: Processed data for card drag/drop decision:', JSON.stringify({ cardId, sourceLaneId, originalCardIndex, targetLaneId, targetVisualIndex, cardToMoveId: cardToMoveDetails?.id, cardToMoveTitle: cardToMoveDetails?.data?.titleRaw, targetLaneExists: !!board.children[targetLaneIndex] }, null, 2));
      // ^^^^ THIS LINE IS COMMENTED OUT TO PREVENT CIRCULAR STRINGIFY ERROR

      // IMMUTABILITY HELPER LOGIC (simplified for card move)
      if (sourceLaneId === targetLaneId) {
        // Reordering within the same lane
        debugLog(
          `[KanbanView] handleDrop: Reordering card ${cardId} in lane ${sourceLaneId} from index ${originalCardIndex} to ${targetVisualIndex}`
        );
        // Ensure targetVisualIndex is valid for splice
        const actualTargetDropIndex = Math.min(
          targetVisualIndex,
          board.children[sourceLaneIndex].children.length -
            (originalCardIndex < targetVisualIndex ? 1 : 0)
        );

        if (originalCardIndex === actualTargetDropIndex) return; // No change

        newBoard = update(board, {
          children: {
            [sourceLaneIndex]: {
              children: {
                $splice: [
                  [originalCardIndex, 1], // Remove from old position
                  [actualTargetDropIndex, 0, cardToMove], // Add to new position
                ],
              },
            },
          },
        });
      } else {
        // Moving card to a different lane
        debugLog(
          `[KanbanView] handleDrop: Moving card ${cardId} from lane ${sourceLaneId} (idx ${sourceLaneIndex}, card original idx ${originalCardIndex}) to lane ${targetLaneId} (idx ${targetLaneIndex}) at targetVisualIndex ${targetVisualIndex}`
        );
        // Ensure targetVisualIndex is valid for splice in target lane
        const actualTargetDropIndex = Math.min(
          targetVisualIndex,
          board.children[targetLaneIndex].children.length
        );

        newBoard = update(board, {
          children: {
            [sourceLaneIndex]: {
              children: {
                $splice: [[originalCardIndex, 1]], // Remove from source lane using its original index
              },
            },
            [targetLaneIndex]: {
              children: {
                $splice: [[actualTargetDropIndex, 0, cardToMove]],
              },
            },
          },
        });
      }
      this.setBoard(newBoard);
      // Lane Reordering
      // Assumes lane has type 'lane' and its data contains its original 'index' among siblings.
      // Assumes the drop target (if another lane) also has type 'lane' and an 'index'.
    } else if (
      dragData?.type === 'lane' &&
      dropData?.type === 'lane' && // Check if drop target is also a lane
      dragData.id &&
      dropData.id && // Ensure IDs are present
      dragData.id !== dropData.id
    ) {
      const draggedLaneId = dragData.id;
      const targetLaneId = dropData.id;

      const oldLaneIndex = board.children.findIndex((lane) => lane.id === draggedLaneId);
      const newLaneTargetIndex = board.children.findIndex((lane) => lane.id === targetLaneId);

      debugLog(
        `[KanbanView] handleDrop (Lane): Reordering lane ${draggedLaneId} (old index ${oldLaneIndex}) to target lane ${targetLaneId} (target index ${newLaneTargetIndex})`
      );

      if (oldLaneIndex === -1 || newLaneTargetIndex === -1) {
        console.error(
          '[KanbanView] handleDrop (Lane): Dragged or target lane not found in board data by ID.',
          { draggedLaneId, targetLaneId, oldLaneIndex, newLaneTargetIndex }
        );
        return;
      }

      // Effective new index is the index of the target lane (insert before it)
      const effectiveNewLaneIndex = newLaneTargetIndex;

      // If dragging a lane downwards, and it's placed before a target that was originally after it,
      // the target's index effectively decreases by one once the dragged lane is removed from its old spot.
      // So, if oldLaneIndex < newLaneTargetIndex, the insertion happens at newLaneTargetIndex, but it might appear as newLaneTargetIndex-1 if the target shifted.
      // Let's simplify: if we drop ON lane Y, we want to insert BEFORE Y.
      // The newLaneTargetIndex is the index of Y. So, that's our insertion point.
      // However, if the dragged lane was originally before Y, removing it will shift Y to the left by 1.
      if (oldLaneIndex < newLaneTargetIndex) {
        // Dragging down: Insert at newLaneTargetIndex. The actual splice index for insertion needs to account for removal if it affects target's original pos.
        // No, this is simpler: the newLaneTargetIndex is where we want it. If it was previously before, it moves. If after, it moves.
      } else {
        // Dragging up: Insert at newLaneTargetIndex. This is correct.
      }

      if (oldLaneIndex === effectiveNewLaneIndex) {
        debugLog('[KanbanView] handleDrop (Lane): No effective change in order.');
        return; // No change
      }

      const laneToMove = board.children[oldLaneIndex];
      if (!laneToMove || laneToMove.id !== draggedLaneId) {
        console.error(
          `[KanbanView] handleDrop (Lane): Lane to move with ID ${draggedLaneId} at index ${oldLaneIndex} not found or ID mismatch. Found:`,
          laneToMove?.id
        );
        return;
      }

      // The splice operation for insertion should use the index of the target lane.
      // If the dragged lane is moved from an earlier position to a later position (e.g. index 0 to index 2),
      // it should be inserted at index 2. The item at original index 2 becomes index 3.
      // If moved from index 2 to index 0, it's inserted at index 0. Item at original 0 becomes 1.
      // The `effectiveNewLaneIndex` should be the visual slot it moves into.
      // The actual insertion index for splice needs care if oldLaneIndex < newLaneTargetIndex.
      // If oldIdx = 0, newTargetIdx = 2. Remove from 0. Lanes at 1,2 become 0,1. Insert at 2 (which is now board.children.length if originally 3 lanes).
      // No, immutability helper handles this. We remove from old, then insert at new relative to the modified array.

      newBoard = update(board, {
        children: {
          $splice: [
            [oldLaneIndex, 1], // Remove from old position
            [effectiveNewLaneIndex, 0, laneToMove], // Add to new position
          ],
        },
      });
      this.setBoard(newBoard);
    } else if (dragData?.type === 'item' && dropData?.type === 'item') {
      // Card onto Card drop
      const draggedCardId = dragData.id;
      const sourceLaneId = dragData.parentLaneId;
      const originalCardIndexInSourceLane = dragData.originalIndex;

      const targetCardId = dropData.id;
      const targetLaneId = dropData.parentLaneId; // Lane of the card being dropped onto
      const targetCardIndexInTargetLane = dropData.originalIndex; // Index of the card being dropped onto, in its lane

      debugLog('[KanbanView] handleDrop (Card To Card): Processing drag.', {
        draggedCardId,
        sourceLaneId,
        originalCardIndexInSourceLane,
        targetCardId,
        targetLaneId,
        targetCardIndexInTargetLane,
      });

      if (
        draggedCardId === undefined ||
        sourceLaneId === undefined ||
        typeof originalCardIndexInSourceLane !== 'number' ||
        targetCardId === undefined ||
        targetLaneId === undefined ||
        typeof targetCardIndexInTargetLane !== 'number'
      ) {
        console.error('[KanbanView] handleDrop (Card To Card): Missing critical IDs or indices.');
        try {
          console.error(
            JSON.stringify(
              {
                draggedCardId,
                sourceLaneId,
                originalCardIndexInSourceLane,
                targetCardId,
                targetLaneId,
                targetCardIndexInTargetLane,
                dragData: dragDataForLog,
                dropData: dropDataForLog,
              },
              null,
              2
            )
          );
        } catch (e_cc_ids) {
          console.error(
            '[KanbanView] ERROR stringifying data in CardToCard Missing IDs block:',
            e_cc_ids.message
          );
        }
        return;
      }

      const sourceLaneBoardIndex = board.children.findIndex((lane) => lane.id === sourceLaneId);
      const targetLaneBoardIndex = board.children.findIndex((lane) => lane.id === targetLaneId);

      if (sourceLaneBoardIndex === -1 || targetLaneBoardIndex === -1) {
        console.error(
          '[KanbanView] handleDrop (Card To Card): Source or target lane not found in board data.',
          { sourceLaneId, targetLaneId, sourceLaneBoardIndex, targetLaneBoardIndex }
        );
        return;
      }

      const cardToMove =
        board.children[sourceLaneBoardIndex]?.children[originalCardIndexInSourceLane];

      if (!cardToMove || cardToMove.id !== draggedCardId) {
        console.error(
          '[KanbanView] handleDrop (Card To Card): Card to move not found in source lane or ID mismatch.',
          {
            draggedCardId,
            foundCardId: cardToMove?.id,
            sourceLaneBoardIndex,
            originalCardIndexInSourceLane,
          }
        );
        return;
      }

      const insertionIndexInTargetLane = targetCardIndexInTargetLane;

      if (sourceLaneId === targetLaneId) {
        // Reordering within the same lane, dropping onto another card
        debugLog(
          `[KanbanView] handleDrop (Card To Card): Reordering card ${draggedCardId} in lane ${sourceLaneId} from index ${originalCardIndexInSourceLane} to before target card ${targetCardId} at index ${targetCardIndexInTargetLane}`
        );

        if (
          originalCardIndexInSourceLane === targetCardIndexInTargetLane ||
          originalCardIndexInSourceLane === targetCardIndexInTargetLane - 1
        ) {
          // If card is dropped on itself or on the card immediately succeeding it (which means no change in order)
          // This also handles if it's dropped on the card immediately before it, resulting in no change if target is calculated as item before.
          // More precise: if dropping card X onto card Y, and X is already immediately before Y, no change.
          // If X is at index i, and Y is at index i+1. targetCardIndexInTargetLane is i+1. insertionIndexInTargetLane becomes i+1.
          // If originalCardIndexInSourceLane (i) < insertionIndexInTargetLane (i+1), then adjustedInsertionIndex becomes i+1 -1 = i.
          // So it's removed from i and inserted at i. This is a no-op.
          debugLog('[KanbanView] handleDrop (Card to Card): No effective change in order.');
          return;
        }

        // If the card is dragged downwards (original index is less than target's original index)
        // and we are inserting *before* the target, the target's effective index will be one less after removal.
        const adjustedInsertionIndex =
          originalCardIndexInSourceLane < targetCardIndexInTargetLane
            ? targetCardIndexInTargetLane - 1
            : targetCardIndexInTargetLane;

        newBoard = update(board, {
          children: {
            [sourceLaneBoardIndex]: {
              children: {
                $splice: [
                  [originalCardIndexInSourceLane, 1], // Remove from old position
                  [adjustedInsertionIndex, 0, cardToMove], // Add to new position (before target card)
                ],
              },
            },
          },
        });
      } else {
        // Moving card to a different lane, dropping onto a card in that lane
        debugLog(
          `[KanbanView] handleDrop (Card To Card): Moving card ${draggedCardId} from lane ${sourceLaneId} to lane ${targetLaneId}, to be placed before target card ${targetCardId} at its index ${targetCardIndexInTargetLane}`
        );
        // insertionIndexInTargetLane is already targetCardIndexInTargetLane, which is where it should be placed before.
        newBoard = update(board, {
          children: {
            [sourceLaneBoardIndex]: {
              children: {
                $splice: [[originalCardIndexInSourceLane, 1]], // Remove from source lane
              },
            },
            [targetLaneBoardIndex]: {
              children: {
                $splice: [[insertionIndexInTargetLane, 0, cardToMove]], // Insert before target card in target lane
              },
            },
          },
        });
      }
      this.setBoard(newBoard);
    } else {
      let dragDataToLogStr = 'UNABLE_TO_STRINGIFY_DRAG_DATA';
      let dropDataToLogStr = 'UNABLE_TO_STRINGIFY_DROP_DATA';
      try {
        dragDataToLogStr = JSON.stringify(dragDataForLog, null, 2);
      } catch (e_drag) {
        console.error(
          '[KanbanView] ERROR stringifying dragDataForLog in unhandled drop:',
          e_drag.message
        );
        dragDataToLogStr = `UNSTRINGIFIABLE_DRAG_DATA: ${Object.keys(dragDataForLog || {}).join(', ')}`;
      }
      try {
        dropDataToLogStr = JSON.stringify(dropDataForLog, null, 2);
      } catch (e_drop) {
        console.error(
          '[KanbanView] ERROR stringifying dropDataForLog in unhandled drop:',
          e_drop.message
        );
        dropDataToLogStr = `UNSTRINGIFIABLE_DROP_DATA: ${Object.keys(dropDataForLog || {}).join(', ')}`;
      }
      console.warn(
        '[KanbanView] handleDrop: Unhandled drag/drop. dragData:',
        dragDataToLogStr,
        'dropData:',
        dropDataToLogStr
      );
    }
  }
}
