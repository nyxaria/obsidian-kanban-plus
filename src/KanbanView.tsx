import EventEmitter from 'eventemitter3';
import update from 'immutability-helper';
import {
  HoverParent,
  HoverPopover,
  Menu,
  Platform,
  TFile,
  TextFileView,
  ViewStateResult,
  WorkspaceLeaf,
  debounce,
} from 'obsidian';
import * as React from 'react';
import * as ReactDOM from 'react-dom';

import { KanbanFormat, KanbanSettings, KanbanViewSettings, SettingsModal } from './Settings';
import { Kanban } from './components/Kanban';
import { BasicMarkdownRenderer } from './components/MarkdownRenderer/MarkdownRenderer';
import { c } from './components/helpers';
import { Board } from './components/types';
import { DndContext } from './dnd/components/DndContext';
import { getParentWindow } from './dnd/util/getWindow';
import {
  gotoNextDailyNote,
  gotoPrevDailyNote,
  hasFrontmatterKey,
  hasFrontmatterKeyRaw,
} from './helpers';
import { bindMarkdownEvents } from './helpers/renderMarkdown';
import { PromiseQueue } from './helpers/util';
import { t } from './lang/helpers';
import KanbanPlugin from './main';
import { frontmatterKey } from './parsers/common';

export const kanbanViewType = 'kanban';
export const kanbanIcon = 'lucide-trello';

export class KanbanView extends TextFileView implements HoverParent {
  plugin: KanbanPlugin;
  hoverPopover: HoverPopover | null;
  emitter: EventEmitter;
  actionButtons: Record<string, HTMLElement> = {};

  previewCache: Map<string, BasicMarkdownRenderer>;
  previewQueue: PromiseQueue;

  activeEditor: any;
  viewSettings: KanbanViewSettings = {};
  public initialSearchQuery?: string;
  public targetHighlightLocation: TargetHighlightLocation | null = null;
  private pendingHighlightScroll: TargetHighlightLocation | null = null;
  private _reactState: any = {};
  private currentSearchMatch: any = null;

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
          const preview = this.addChild(new BasicMarkdownRenderer(this, item.data.title));
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

  getBoard(): Board | null {
    if (!this.file) {
      console.warn('[KanbanView] getBoard: this.file is null. Cannot get StateManager.');
      return null;
    }
    const stateManager = this.plugin.stateManagers.get(this.file);
    if (!stateManager) {
      console.warn(`[KanbanView] getBoard: StateManager not found for file: ${this.file.path}`);
      return null;
    }
    if (!stateManager.state) {
      console.warn(
        `[KanbanView] getBoard: StateManager found for ${this.file.path}, but stateManager.state is null/undefined.`
      );
      return null;
    }
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

    console.log(
      '[KanbanView] onload: Entered. targetHighlightLocation will be set by setState if eState is provided directly.'
    );

    // Check for pending highlight state stored on the leaf by the monkeypatch
    const pendingHighlightState = (this.leaf as any)._kanbanPendingHighlightState;
    if (pendingHighlightState) {
      console.log(
        '[KanbanView] onload: Found _kanbanPendingHighlightState on leaf:',
        JSON.stringify(pendingHighlightState, null, 2)
      );
      if (pendingHighlightState.blockId) {
        this.targetHighlightLocation = { blockId: pendingHighlightState.blockId };
        console.log(
          '[KanbanView] onload: Applied blockId from _kanbanPendingHighlightState to targetHighlightLocation.'
        );
      } else if (pendingHighlightState.match) {
        // If no blockId, but there's a 'match' object (e.g., from search navState)
        // Store the whole thing, ItemInner will need to know how to use it.
        this.targetHighlightLocation = pendingHighlightState; // Store the whole match object
        console.log(
          '[KanbanView] onload: Applied full match object from _kanbanPendingHighlightState to targetHighlightLocation.'
        );
      }
      // Clear the pending state from the leaf after consuming it
      delete (this.leaf as any)._kanbanPendingHighlightState;
      console.log('[KanbanView] onload: Cleared _kanbanPendingHighlightState from leaf.');

      // If we found a pending highlight, ensure React state is updated after a short delay
      // to allow board data to potentially load via setState/addView.
      setTimeout(() => {
        if (this.targetHighlightLocation) {
          console.log(
            '[KanbanView] onload (from pending): Delayed call to setReactState with targetHighlight:',
            this.targetHighlightLocation
          );
          this.setReactState({ targetHighlight: this.targetHighlightLocation });
        }
      }, 150); // Slightly longer delay to be safe
    }

    this.register(
      this.containerEl.onWindowMigrated(() => {
        this.plugin.removeView(this);
        this.plugin.addView(this, this.data, this.isPrimary);
      })
    );

    // Ensure this is added after super.onload() and other initial setup
    this.registerDomEvent(this.contentEl, 'click', this.handleBoardClickToClearHighlight, {
      capture: true,
    });
  }

  onunload(): void {
    super.onunload();

    this.previewQueue.clear();
    this.previewCache.clear();
    this.emitter.emit('queueEmpty');

    this.plugin.removeView(this);
    this.emitter.removeAllListeners();
    this.activeEditor = null;
    this.actionButtons = {};
  }

  handleRename(newPath: string, oldPath: string) {
    if (this.file.path === newPath) {
      this.plugin.handleViewFileRename(this, oldPath);
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

  setViewData(data: string, clear?: boolean) {
    if (!hasFrontmatterKeyRaw(data)) {
      this.plugin.kanbanFileModes[(this.leaf as any).id || this.file.path] = 'markdown';
      this.plugin.removeView(this);
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

    this.plugin.addView(this, data, this.isPrimary);
    console.log(
      `[KanbanView] setViewData: Called plugin.addView with data (length: ${data?.length}), clear: ${clear}, passed isPrimary: ${this.isPrimary}`
    );
  }

  async setState(state: any, result: ViewStateResult): Promise<void> {
    console.log(this.getViewType(), 'setState called with state:', state, 'and result:', result);

    let dataChangedDueToSearch = false;
    if (state.activeDocument?.content && this.data !== state.activeDocument.content) {
      console.log(
        '[KanbanView] setState: activeDocument.content received from search, updating this.data.'
      );
      this.data = state.activeDocument.content; // Update internal data cache
      dataChangedDueToSearch = true;
    }

    this.pendingHighlightScroll = null;
    let highlightForYellowBorder: {
      blockId?: string;
      cardTitle?: string;
      listName?: string;
    } | null = null;
    let searchMatchProcessedInThisCall = false;

    // Determine yellow border highlight first
    if (state.eState?.blockId || (state.eState?.cardTitle && state.eState?.listName)) {
      highlightForYellowBorder = {
        blockId: state.eState.blockId,
        cardTitle: state.eState.cardTitle,
        listName: state.eState.listName,
      };
      console.log(
        '[KanbanView] setState: Determined BORDER highlight from eState:',
        highlightForYellowBorder
      );
    } else if (
      state.targetHighlightLocation &&
      (state.targetHighlightLocation.blockId || state.targetHighlightLocation.cardTitle)
    ) {
      highlightForYellowBorder = state.targetHighlightLocation;
      console.log(
        '[KanbanView] setState: Determined BORDER highlight from persisted state.targetHighlightLocation:',
        highlightForYellowBorder
      );
    }

    if (highlightForYellowBorder) {
      this.setTargetHighlightLocation(highlightForYellowBorder);
      this.pendingHighlightScroll = highlightForYellowBorder;
      state.targetHighlightLocation = highlightForYellowBorder; // For persistence
    } else {
      if (this.targetHighlightLocation) {
        this.setTargetHighlightLocation(null);
      }
      if (
        state.targetHighlightLocation &&
        (state.targetHighlightLocation.blockId || state.targetHighlightLocation.cardTitle)
      ) {
        state.targetHighlightLocation = null;
      }
      console.log(
        '[KanbanView] setState: No BORDER highlight determined. Cleared active local border highlight if any.'
      );
    }

    // Handle currentSearchMatch based on eState
    if (state.eState) {
      if (state.eState.match) {
        this.currentSearchMatch = state.eState.match;
        searchMatchProcessedInThisCall = true;
        console.log(
          '[KanbanView] setState: Stored currentSearchMatch from eState.match:',
          this.currentSearchMatch
        );
      } else {
        if (this.currentSearchMatch !== null) {
          console.log(
            '[KanbanView] setState: Clearing currentSearchMatch as eState exists but has no match. Was:',
            this.currentSearchMatch
          );
          this.currentSearchMatch = null;
          searchMatchProcessedInThisCall = true; // Clearing is also a processing action
        }
      }
    }

    console.log(
      this.getViewType(),
      'setState: Calling super.setState with state.targetHighlightLocation:',
      state.targetHighlightLocation,
      'currentSearchMatch:',
      this.currentSearchMatch
    );
    await super.setState(state, result);
    console.log(this.getViewType(), 'setState: super.setState completed.');

    let shouldCallSetViewData = false;
    let reasonForSetViewData = '';
    let dataToSet = this.data;

    if (state.eState?.match) {
      shouldCallSetViewData = true;
      reasonForSetViewData = 'Global search match detected.';
      if (state.eState.match.content) {
        if (this.data !== state.eState.match.content) {
          console.log(
            '[KanbanView] setState: Updating this.data with eState.match.content for search consistency.'
          );
          this.data = state.eState.match.content;
          dataToSet = this.data;
        } else {
          console.log('[KanbanView] setState: this.data already matches eState.match.content.');
        }
      } else if (state.activeDocument?.content && this.data !== state.activeDocument.content) {
        console.log(
          '[KanbanView] setState: eState.match.content missing, updating this.data with activeDocument.content.'
        );
        this.data = state.activeDocument.content;
        dataToSet = this.data;
      } else {
        console.log(
          '[KanbanView] setState: Neither eState.match.content nor new activeDocument.content provided for search. Using existing this.data for setViewData.'
        );
      }
    } else if (highlightForYellowBorder) {
      shouldCallSetViewData = true;
      reasonForSetViewData = 'Border highlight navigation detected (not a global search match).';
    } else if (dataChangedDueToSearch) {
      shouldCallSetViewData = true;
      reasonForSetViewData = 'Data changed (not via search match or border highlight nav).';
    }

    if (shouldCallSetViewData) {
      console.log(`[KanbanView] setState: Triggering setViewData. Reason: ${reasonForSetViewData}`);
      this.setViewData(dataToSet, true);
    } else if (searchMatchProcessedInThisCall) {
      console.log(
        '[KanbanView] setState: Search related state change (e.g. cleared without data/border change), calling setReactState.'
      );
      this.setReactState({});
    } else if (this.pendingHighlightScroll) {
      console.log(
        '[KanbanView] setState: Fallback for this.pendingHighlightScroll. Calling setReactState.'
      );
      this.setReactState({});
    } else {
      console.log(
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
    const stateManager = this.plugin.stateManagers.get(this.file);
    const settingVal = stateManager.getSetting(key);
    return this.viewSettings[key] ?? settingVal;
  }

  useViewState<K extends keyof KanbanViewSettings>(key: K) {
    const stateManager = this.plugin.getStateManager(this.file);
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
    return <Kanban stateManager={stateManager} view={this} />;
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
    // this.contentEl.empty(); // Original line, keep if necessary
  }

  setReactState(newState: { targetHighlight?: any }) {
    console.log(
      '[KanbanView] setReactState: ENTRY (via StateManager or direct call). newState:',
      newState,
      'currentSearchMatch:',
      this.currentSearchMatch,
      'targetHighlightLocation (border):',
      this.targetHighlightLocation,
      'pendingHighlightScroll:',
      this.pendingHighlightScroll
    ); // Enhanced Entry log

    const oldReactTargetHighlight = this._reactState?.targetHighlight; // Store old value
    let newReactTargetHighlightVal: any = null;

    if (newState && Object.prototype.hasOwnProperty.call(newState, 'targetHighlight')) {
      newReactTargetHighlightVal = newState.targetHighlight;
      console.log(
        '[KanbanView] setReactState (Priority 1): Using newReactTargetHighlightVal from explicit newState:',
        newReactTargetHighlightVal
      );
    } else if (this.currentSearchMatch) {
      newReactTargetHighlightVal = this.currentSearchMatch;
      console.log(
        '[KanbanView] setReactState (Priority 2): Using newReactTargetHighlightVal from this.currentSearchMatch:',
        newReactTargetHighlightVal
      );
    } else if (this.pendingHighlightScroll && this.targetHighlightLocation) {
      newReactTargetHighlightVal = this.targetHighlightLocation;
      console.log(
        '[KanbanView] setReactState (Priority 3): Using newReactTargetHighlightVal from this.targetHighlightLocation (pending scroll for border):',
        newReactTargetHighlightVal
      );
    } else if (this.targetHighlightLocation) {
      newReactTargetHighlightVal = this.targetHighlightLocation;
      console.log(
        '[KanbanView] setReactState (Priority 4): Using newReactTargetHighlightVal from persisted this.targetHighlightLocation (no search/pending scroll):',
        newReactTargetHighlightVal
      );
    } else {
      newReactTargetHighlightVal = null;
      console.log(
        '[KanbanView] setReactState (Priority 5): Defaulting newReactTargetHighlightVal to null. Prev was:',
        oldReactTargetHighlight
      );
    }
    this._reactState = update(this._reactState ?? {}, {
      targetHighlight: { $set: newReactTargetHighlightVal },
    });

    // Check if the relevant part of the state actually changed to prevent loops
    if (
      newReactTargetHighlightVal === oldReactTargetHighlight &&
      newState &&
      Object.keys(newState).length === 0 &&
      !this.pendingHighlightScroll // Allow re-render if a scroll is pending, even if highlight value is same (e.g. re-nav to same search)
    ) {
      console.log(
        '[KanbanView] setReactState: targetHighlight unchanged, no other new state, and no pending scroll. Bailing out.'
      );
      return;
    }

    console.log(
      '[KanbanView] setReactState: Final _reactState.targetHighlight for React component:',
      this._reactState.targetHighlight
    );

    if (!this.file || !this.contentEl.isShown()) {
      console.log(
        '[KanbanView] setReactState: File not available or contentEl not shown. Aborting render.'
      );
      return;
    }

    const board = this.getBoard();
    if (!board) {
      console.warn('[KanbanView] setReactState: Board data not available. Aborting render.');
      if (this.file) {
        console.log(
          '[KanbanView] setReactState: Board data null, attempting to trigger data load via stateManager.'
        );
      }
      return;
    }

    const settings = board.data?.settings; // Settings are on board.data.settings

    const archived = this.plugin.archive?.getArchive?.(this.file) ?? []; // Safer access for archive

    console.log(
      '[KanbanView] setReactState: About to call ReactDOM.render. DOM contentEl.isShown():',
      this.contentEl.isShown(),
      'File:',
      this.file?.path
    ); // Log before render

    const stateManagerForKanbanComponent = this.plugin.stateManagers.get(this.file);
    if (!stateManagerForKanbanComponent) {
      console.error(
        '[KanbanView] setReactState: CRITICAL - StateManager instance from plugin.stateManagers.get(this.file) is null/undefined just before rendering Kanban component. Aborting render. File:',
        this.file?.path
      );
      // Attempt to log the state of the stateManagers map
      if (this.plugin.stateManagers) {
        console.log(
          '[KanbanView] setReactState: Current keys in plugin.stateManagers map:',
          Array.from(this.plugin.stateManagers.keys()).map((f) => f.path)
        );
      }
      return; // Abort rendering if StateManager is not found
    }

    try {
      ReactDOM.render(
        React.createElement(
          DndContext,
          {
            win: this.getWindow(),
            onDrop: (dragEntity: any, dropEntity: any) => {
              console.log('[KanbanView] DndContext onDrop:', { dragEntity, dropEntity });
              // Placeholder - actual drop handling logic to be implemented
              // This might involve calling something like this.plugin.handleDrop if it exists
              // or directly manipulating board state via this.stateManager.
            },
          },
          React.createElement(Kanban, {
            key: this.file.path,
            plugin: this.plugin,
            view: this,
            settings,
            board,
            app: this.app,
            archivedCount: archived.length,
            file: this.file,
            reactState: this._reactState,
            setReactState: this.setReactState.bind(this),
            emitter: this.emitter,
            dispatch: this.plugin.dispatch,
            stateManager: stateManagerForKanbanComponent,
            onwardsNavigate: (path: string, payload: any) => {
              const leaf = this.app.workspace.getLeaf(false);
              leaf.openFile(this.app.vault.getAbstractFileByPath(path) as TFile, payload);
            },
          })
        ),
        this.contentEl.children[0]
      );
      console.log(this.getViewType(), 'setReactState: React component rendered/updated.');

      if (this.pendingHighlightScroll && this.targetHighlightLocation) {
        const intendedLocation = { ...this.targetHighlightLocation }; // Capture current value
        const pendingScrollFlagOriginalValue = this.pendingHighlightScroll; // For logging
        this.pendingHighlightScroll = null; // Clear flag
        console.log(
          '[KanbanView] setReactState: Queued BORDER/SCROLL for:',
          JSON.stringify(intendedLocation),
          'pendingScrollFlag was:',
          pendingScrollFlagOriginalValue
        );

        setTimeout(() => {
          console.log(
            '[KanbanView] setReactState (setTimeout ENTRY): current this.targetHighlightLocation:',
            JSON.stringify(this.targetHighlightLocation),
            'intendedLocation was:',
            JSON.stringify(intendedLocation)
          );
          // Check this.targetHighlightLocation again, as it could have changed during the timeout
          if (
            this.targetHighlightLocation && // Ensure it's not null now
            intendedLocation && // Ensure original intendedLocation was not null/empty
            // Compare all relevant fields for border highlight
            (this.targetHighlightLocation.blockId === intendedLocation.blockId ||
              (!this.targetHighlightLocation.blockId && !intendedLocation.blockId)) && // Both undefined is OK
            this.targetHighlightLocation.cardTitle === intendedLocation.cardTitle &&
            this.targetHighlightLocation.listName === intendedLocation.listName
          ) {
            console.log(
              '[KanbanView] setReactState (setTimeout): Applying BORDER highlight and SCROLL for target:',
              JSON.stringify(this.targetHighlightLocation)
            );
            this.applyHighlight();
            this.scrollToCard(this.targetHighlightLocation);
          } else {
            console.log(
              '[KanbanView] setReactState (setTimeout): BORDER target changed, cleared, or was invalid. Current:',
              JSON.stringify(this.targetHighlightLocation),
              'Intended was:',
              JSON.stringify(intendedLocation)
            );
          }
        }, 50); // 50ms delay
      }
    } catch (err) {
      const error = err as Error;
      console.error('[KanbanView] setReactState render error:', error.message, error.stack);
      this.plugin.stateManagers.get(this.file)?.setError(error);
    }
  }

  public clearActiveSearchHighlight() {
    // This is for the BORDER highlight
    console.log(
      '[KanbanView] clearActiveSearchHighlight (for BORDER) called. Current this.targetHighlightLocation:',
      this.targetHighlightLocation
    );
    if (this.targetHighlightLocation) {
      // If any border highlight was active
      this.targetHighlightLocation = null;
      this.contentEl.querySelectorAll('.search-result-highlight').forEach((el) => {
        el.removeClass('search-result-highlight');
      });
      console.log(
        '[KanbanView] clearActiveSearchHighlight: Cleared BORDER highlight and DOM class.'
      );
    } else {
      console.log('[KanbanView] clearActiveSearchHighlight: No active BORDER highlight to clear.');
    }
  }

  public processHighlightFromExternal(eState: any) {
    if (eState && eState.blockId) {
      this.targetHighlightLocation = { blockId: eState.blockId };
      setTimeout(() => {
        if (this.targetHighlightLocation) {
          this.setReactState({ targetHighlight: this.targetHighlightLocation });
        }
      }, 100);
    } else {
      if (!eState && this.targetHighlightLocation) {
        this.targetHighlightLocation = null;
        this.setReactState({ targetHighlight: null });
      }
    }
  }

  private handleBoardClickToClearHighlight = (event: MouseEvent) => {
    const targetElement = event.target as HTMLElement;
    if (targetElement.closest('.kanban-plugin__item')) {
      return;
    }
    if (
      targetElement.tagName === 'A' ||
      targetElement.tagName === 'BUTTON' ||
      targetElement.tagName === 'INPUT' ||
      targetElement.tagName === 'TEXTAREA' ||
      targetElement.tagName === 'SELECT' ||
      (targetElement.hasAttribute('contenteditable') &&
        targetElement.getAttribute('contenteditable') === 'true')
    ) {
      return;
    }
    this.clearActiveSearchHighlight();
  };

  public setTargetHighlightLocation(
    location: { blockId?: string; cardTitle?: string; listName?: string } | null
  ) {
    console.log('[KanbanView] setTargetHighlightLocation (for BORDER):', location);
    this.targetHighlightLocation = location;
    // DO NOT update this._reactState.targetHighlight here directly.
  }

  public applyHighlight() {
    console.log('[KanbanView] applyHighlight called. Target:', this.targetHighlightLocation);
    this.contentEl.querySelectorAll('.search-result-highlight').forEach((el) => {
      el.removeClass('search-result-highlight');
    });

    if (!this.targetHighlightLocation) {
      console.log('[KanbanView] applyHighlight: No targetHighlightLocation. Aborting.'); // Added log
      return;
    }

    const board = this.getBoard();
    if (
      !board &&
      (this.targetHighlightLocation.cardTitle || !this.targetHighlightLocation.blockId)
    ) {
      console.warn('[KanbanView] applyHighlight: Board data not available for title-based lookup.');
    }

    let targetItemElement: HTMLElement | null = null;

    if (this.targetHighlightLocation.blockId) {
      targetItemElement = this.contentEl.querySelector(
        `[data-id='${this.targetHighlightLocation.blockId}'] .kanban-plugin__item-content-wrapper`
      ) as HTMLElement;
      if (!targetItemElement) {
        const itemEl = this.contentEl.querySelector(
          `[data-id='${this.targetHighlightLocation.blockId}']`
        ) as HTMLElement;
        if (itemEl) {
          targetItemElement = itemEl.querySelector(
            '.kanban-plugin__item-content-wrapper'
          ) as HTMLElement;
        }
      }
      console.log(
        `[KanbanView] applyHighlight: Attempting to find item by blockId: ${this.targetHighlightLocation.blockId}`,
        targetItemElement
      );
    }

    if (
      !targetItemElement &&
      this.targetHighlightLocation.cardTitle &&
      this.targetHighlightLocation.listName
    ) {
      console.log(
        `[KanbanView] applyHighlight: Attempting title/list lookup. Title: '${this.targetHighlightLocation.cardTitle}', List: '${this.targetHighlightLocation.listName}'`
      ); // Added log
      const lanes = Array.from(this.contentEl.querySelectorAll('.kanban-plugin__lane'));
      const targetLane = lanes.find((lane) => {
        const laneTitleEl = lane.querySelector('.kanban-plugin__lane-title');
        return (
          laneTitleEl && laneTitleEl.textContent?.trim() === this.targetHighlightLocation.listName
        );
      });

      if (targetLane) {
        console.log('[KanbanView] applyHighlight: Found target lane by title:', targetLane); // Added log
        const items = Array.from(targetLane.querySelectorAll('.kanban-plugin__item'));
        console.log(
          `[KanbanView] applyHighlight: Found ${items.length} items in lane '${this.targetHighlightLocation.listName}'. Checking titles:`
        ); // Added log

        const targetItem = items.find((item, index) => {
          // Try to find the content wrapper first, as this is also what gets highlighted
          const contentWrapperEl = item.querySelector('.kanban-plugin__item-content-wrapper');
          if (contentWrapperEl) {
            const currentItemTitle = contentWrapperEl.textContent?.trim();
            console.log(
              `[KanbanView] applyHighlight: Item ${index} in lane, Title from .kanban-plugin__item-content-wrapper: "'${currentItemTitle}'", Target Title: "'${this.targetHighlightLocation.cardTitle}'"`
            );
            // Use startsWith for a more flexible match, as DOM title might include tags
            return currentItemTitle?.startsWith(this.targetHighlightLocation.cardTitle ?? '');
          }
          console.log(
            `[KanbanView] applyHighlight: Item ${index} in lane, .kanban-plugin__item-content-wrapper not found.`
          );
          return false;
        });

        if (targetItem) {
          console.log(
            '[KanbanView] applyHighlight: Found target item by title in lane:',
            targetItem
          ); // Added log
          targetItemElement = targetItem.querySelector(
            '.kanban-plugin__item-content-wrapper'
          ) as HTMLElement;
        }
      } else {
        console.log('[KanbanView] applyHighlight: Target lane NOT found by title.'); // Added log
      }
      console.log(
        `[KanbanView] applyHighlight: Result of title/list lookup for item '${this.targetHighlightLocation.cardTitle}' in list '${this.targetHighlightLocation.listName}':`,
        targetItemElement
      );
    }

    if (targetItemElement) {
      console.log(
        '[KanbanView] applyHighlight: Adding search-result-highlight to:',
        targetItemElement
      );
      targetItemElement.addClass('search-result-highlight');
    } else {
      console.log('[KanbanView] applyHighlight: No target item element found for highlighting.');
    }
  }

  public scrollToCard(location: TargetHighlightLocation | null) {
    console.log('[KanbanView] scrollToCard called. Target:', location);
    if (!location) return;

    let targetItemElement: HTMLElement | null = null;

    if (location.blockId) {
      targetItemElement = this.contentEl.querySelector(
        `[data-id='${location.blockId}']`
      ) as HTMLElement;
      console.log(
        `[KanbanView] scrollToCard: Attempting to find item by blockId: ${location.blockId}`,
        targetItemElement
      );
    }

    if (!targetItemElement && location.cardTitle && location.listName) {
      console.log(
        `[KanbanView] scrollToCard: Attempting title/list lookup. Title: '${location.cardTitle}', List: '${location.listName}'`
      ); // Added log
      const lanes = Array.from(this.contentEl.querySelectorAll('.kanban-plugin__lane'));
      const targetLane = lanes.find((lane) => {
        const laneTitleEl = lane.querySelector('.kanban-plugin__lane-title');
        return laneTitleEl && laneTitleEl.textContent?.trim() === location.listName;
      });

      if (targetLane) {
        console.log('[KanbanView] scrollToCard: Found target lane by title:', targetLane); // Added log
        const items = Array.from(targetLane.querySelectorAll('.kanban-plugin__item'));
        console.log(
          `[KanbanView] scrollToCard: Found ${items.length} items in lane '${location.listName}'. Checking titles:`
        ); // Added log

        const targetItem = items.find((item, index) => {
          // Try to find the content wrapper first
          const contentWrapperEl = item.querySelector('.kanban-plugin__item-content-wrapper');
          if (contentWrapperEl) {
            const currentItemTitle = contentWrapperEl.textContent?.trim();
            console.log(
              `[KanbanView] scrollToCard: Item ${index} in lane, Title from .kanban-plugin__item-content-wrapper: "'${currentItemTitle}'", Target Title: "'${location.cardTitle}'"`
            );
            // Use startsWith for a more flexible match
            return currentItemTitle?.startsWith(location.cardTitle ?? '');
          }
          console.log(
            `[KanbanView] scrollToCard: Item ${index} in lane, .kanban-plugin__item-content-wrapper not found.`
          );
          return false;
        });
        if (targetItem) {
          console.log('[KanbanView] scrollToCard: Found target item by title in lane:', targetItem); // Added log
          targetItemElement = targetItem as HTMLElement;
        }
      } else {
        console.log('[KanbanView] scrollToCard: Target lane NOT found by title.'); // Added log
      }
      console.log(
        `[KanbanView] scrollToCard: Result of title/list lookup for item '${location.cardTitle}' in list '${location.listName}':`,
        targetItemElement
      );
    }

    if (targetItemElement) {
      console.log('[KanbanView] scrollToCard: Scrolling to element:', targetItemElement);
      targetItemElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } else {
      console.log('[KanbanView] scrollToCard: No target item element found for scrolling.');
    }
  }
}

interface TargetHighlightLocation {
  blockId?: string;
  cardTitle?: string;
  listName?: string;
  match?: any; // Added for search results
}
