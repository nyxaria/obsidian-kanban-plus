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
  normalizePath,
} from 'obsidian';
import * as React from 'react';
import * as ReactDOM from 'react-dom';

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
    console.log(
      `[KanbanView] getBoard: For file ${this.file.path}. StateManager found: ${!!stateManager}.`
    );
    if (!stateManager) {
      console.warn(`[KanbanView] getBoard: StateManager not found for file: ${this.file.path}`);
      return null;
    }
    if (!stateManager.state) {
      console.warn(
        `[KanbanView] getBoard: StateManager found for ${this.file.path}, but stateManager.state is null/undefined. Current StateManager file prop: ${stateManager.file?.path}`
      );
      return null;
    }
    console.log(
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
        this.targetHighlightLocation = pendingHighlightState;
        console.log(
          '[KanbanView] onload: Applied full match object from _kanbanPendingHighlightState to targetHighlightLocation.'
        );
      }
      delete (this.leaf as any)._kanbanPendingHighlightState;
      console.log('[KanbanView] onload: Cleared _kanbanPendingHighlightState from leaf.');
    }

    // Schedule initial render / React state update
    // This ensures that even if setState doesn't trigger it due to no specific conditions being met,
    // the React component still gets a chance to render and register with StateManager.
    setTimeout(() => {
      console.log('[KanbanView] onload (setTimeout): Triggering initial setReactState.');
      this.setReactState({}); // Pass empty state to ensure it uses current view state
    }, 50); // Small delay to allow other sync onload processes to complete

    this.register(
      this.containerEl.onWindowMigrated(() => {
        this.plugin.removeView(this);
        this.plugin.addView(this, this.data, this.isPrimary);
        // Ensure React state is updated after migration as well
        console.log('[KanbanView] onWindowMigrated: Triggering setReactState after addView.');
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
    console.log(
      `[KanbanView] setViewData: About to call await this.plugin.addView for ${this.file?.path}`
    );
    await this.plugin.addView(this, data, this.isPrimary);
    console.log(
      `[KanbanView] setViewData: Call to plugin.addView completed for ${this.file?.path}. Data length: ${data?.length}, clear: ${clear}, isPrimary: ${this.isPrimary}`
    );

    // Ensure React component is rendered/updated AFTER StateManager is fully initialized by the awaited addView
    this.setReactState({});
  }

  async setState(state: any, result: ViewStateResult) {
    console.log('[KanbanView] setState called with state:', state, 'and result:', result);

    this.currentSearchMatch = null;
    this.targetHighlightLocation = null;

    if (state?.eState) {
      if (state.eState.blockId || state.eState.cardTitle || state.eState.listName) {
        this.targetHighlightLocation = {
          blockId: state.eState.blockId,
          cardTitle: state.eState.cardTitle,
          listName: state.eState.listName,
        };
        console.log(
          '[KanbanView] setState: Determined targetHighlightLocation from eState (blockId/cardTitle/listName):',
          this.targetHighlightLocation
        );
      } else if (state.eState.match) {
        this.targetHighlightLocation = { match: state.eState.match };
        console.log(
          '[KanbanView] setState: Determined targetHighlightLocation from eState.match:',
          this.targetHighlightLocation
        );
      }
    }

    if (!this.targetHighlightLocation && state?.targetHighlightLocation) {
      this.targetHighlightLocation = state.targetHighlightLocation;
      console.log(
        '[KanbanView] setState: Used targetHighlightLocation from persisted state:',
        this.targetHighlightLocation
      );
    }

    if (!this.targetHighlightLocation) {
      console.log(
        '[KanbanView] setState: No specific highlight determined or persisted. targetHighlightLocation remains null.'
      );
    }

    const previousFilePath = this.file?.path;

    console.log(
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
    console.log('[KanbanView] setState: super.setState completed.');

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

    console.log(
      `[KanbanView] setState: File change check: previous='${previousFilePath}', incoming='${incomingFilePath}', fileHasEffectivelyChanged=${fileHasEffectivelyChanged}`
    );

    const shouldProcessViewData = state?.eState && !state.eState.preventSetViewData;

    if (fileHasEffectivelyChanged || shouldProcessViewData) {
      if (this.file) {
        console.log(
          `[KanbanView] setState: File effectively changed to ${this.file.path} or eState received. Resetting _isPendingInitialRender and _reactState. Will call setViewData.`
        );
        if (fileHasEffectivelyChanged) {
          this._reactHasRenderedOnceInThisInstance = false;
          console.log(
            '[KanbanView] setState: File changed, so _reactHasRenderedOnceInThisInstance is reset to false for a clean render.'
          );
        }
        this._isPendingInitialRender = true;
        this._reactState = {};

        const fileContent = await this.app.vault.cachedRead(this.file);
        await this.setViewData(fileContent, true);
      } else {
        console.log(
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
      console.log(
        '[KanbanView] setState: File did NOT change, but targetHighlightLocation is set. Calling setReactState for highlight.'
      );
      this.setReactState({ targetHighlight: this.targetHighlightLocation, forceRerender: true });
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
        settings={this.viewSettings}
        board={this.getBoard()} // Already present and correct
        app={this.app}
        archivedCount={this.plugin.archive?.getArchive?.(this.file)?.length ?? 0} // Ensure number
        file={this.file} // Already implicitly used by stateManager, but good to be explicit if Kanban needs it
        reactState={this._reactState || {}} // Already present
        setReactState={this.setReactState.bind(this)}
        emitter={this.emitter}
        dispatch={this.plugin.dispatch}
        stateManager={stateManager} // Already present and correct
        onwardsNavigate={(path: string, payload: any) => {
          const targetFile = this.app.vault.getAbstractFileByPath(path) as TFile;
          if (targetFile) {
            const leaf = this.app.workspace.getLeaf(false);
            leaf.openFile(targetFile, payload);
          } else {
            console.warn(`[KanbanView] getPortal onwardsNavigate: File not found at path ${path}`);
          }
        }}
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
    ReactDOM.unmountComponentAtNode(this.contentEl);
  }

  handleDrop(dragEntity: any, dropEntity: any) {
    console.log('[KanbanView] handleDrop called', dragEntity, dropEntity);
    // Actual drop logic will go here
  }

  async setReactState(newState: { targetHighlight?: any; forceRerender?: boolean }) {
    let stateManager = this.plugin.stateManagers.get(this.file);

    // If StateManager is not found, try to re-establish it via plugin.addView
    // This can happen if the view was inactive and is now being updated for highlighting.
    if (!stateManager && this.file && this.data) {
      // Check this.data too
      console.warn(
        `[KanbanView] setReactState: StateManager not found for ${this.file.path}. Attempting to re-initialize with plugin.addView.`
      );
      try {
        await this.plugin.addView(this, this.data, this.isPrimary);
        stateManager = this.plugin.stateManagers.get(this.file); // Re-fetch after addView
        if (stateManager) {
          console.log(
            `[KanbanView] setReactState: StateManager re-established for ${this.file.path} after plugin.addView.`
          );
        } else {
          console.error(
            `[KanbanView] setReactState: Failed to re-establish StateManager for ${this.file.path} after plugin.addView. Cannot render.`
          );
          this.contentEl.empty();
          this.contentEl.createDiv({ text: 'Error: Failed to connect to Kanban data manager.' });
          return;
        }
      } catch (error) {
        console.error(
          `[KanbanView] setReactState: Error during plugin.addView for ${this.file.path}:`,
          error
        );
        this.contentEl.empty();
        this.contentEl.createDiv({ text: 'Error: Could not initialize Kanban board view.' });
        return;
      }
    }

    // Check for headerEl property existence before using it, and cast for usage
    if (
      'headerEl' in this &&
      this.headerEl &&
      typeof (this.headerEl as any).hide === 'function' &&
      typeof (this.headerEl as any).show === 'function'
    ) {
      const headerEl = this.headerEl as HTMLElement; // Cast to HTMLElement for hide/show
      if (!this.plugin.settings['show-board-settings']) {
        headerEl.hide();
      } else {
        headerEl.show();
      }
    } else {
      console.warn(
        '[KanbanView] setReactState: this.headerEl is not available or does not have hide/show methods.'
      );
    }

    if (stateManager) {
      if (newState) {
        this._reactState = update(this._reactState, { $merge: newState });
      }

      const win = this.getWindow();

      // Ensure that the initial render (or re-render) happens after a slight delay
      // This is to prevent blocking the UI thread, especially during initial load or
      // when rapidly switching between files. It also gives Obsidian's layout
      // engine a chance to settle if the view is being resized or moved.
      if (this._initialRenderTimeoutId) {
        win.clearTimeout(this._initialRenderTimeoutId);
      }

      this._isPendingInitialRender = true;

      const renderBoard = () => {
        const board = this.getBoard();
        if (!board) {
          console.warn(
            `[KanbanView] renderBoard: getBoard() returned null for file ${this.file?.path}. Cannot render board.`
          );
          this.contentEl.empty();
          this.contentEl.createDiv({ text: 'Error: Kanban data not available for rendering.' });
          this._isPendingInitialRender = false;
          return;
        }

        if (!this.contentEl || (this.leaf as any).detached) {
          console.log(
            '[KanbanView] setReactState: Content element not available or leaf detached. Skipping render.'
          );
          this._isPendingInitialRender = false;
          return;
        }

        if (!this._reactHasRenderedOnceInThisInstance) {
          console.log(
            `[KanbanView] setReactState: First render attempt for this view instance (${this.file?.path}). Clearing contentEl.innerHTML.`
          );
          this.contentEl.innerHTML = ''; // Clear only on the very first render of this view instance
          this._reactHasRenderedOnceInThisInstance = true;
        } else {
          // For subsequent renders, unmounting is generally safer to avoid Preact/React issues
          // if the root component type changes or if there are state inconsistencies.
          // However, if the root component (Kanban) is stable, this might be too aggressive.
          // Consider if simply re-rendering (ReactDOM.render) is sufficient.
          // ReactDOM.unmountComponentAtNode(this.contentEl);
        }

        ReactDOM.render(
          React.createElement(
            DndContext,
            { win: this.getWindow(), onDrop: this.handleDrop.bind(this) },
            React.createElement(Kanban, {
              key: `${this.file?.path}-${board?.data?.frontmatter?.['kanban-plugin']}`,
              plugin: this.plugin,
              view: this,
              stateManager: stateManager,
              settings: this.viewSettings,
              board: board,
              app: this.app,
              file: this.file,
              reactState: this._reactState,
              setReactState: (s) => this.setReactState(s),
              emitter: this.emitter,
              dispatch: (...args: any) => this.plugin.onDbChange(this.file, ...args),
              onwardsNavigate: this.plugin.onwardsNavigate,
              archivedCount: board?.data?.archive?.length || 0,
            })
          ),
          this.contentEl
        );
        console.log('[KanbanView] setReactState: React component rendered/updated.');
        this._isPendingInitialRender = false;
        this.pendingHighlightScroll = null; // Clear pending scroll after render

        // After rendering, if there was a pending highlight scroll, apply it.
        if (this.targetHighlightLocation) {
          console.log(
            '[KanbanView] setReactState: Scheduling applyHighlight after render with a short delay for target:',
            JSON.stringify(this.targetHighlightLocation)
          );
          this.getWindow().setTimeout(() => {
            const hasFocus = this.contentEl.contains(document.activeElement);
            const viewStillActive = this.contentEl && !(this.leaf as any).detached;
            console.log(
              `[KanbanView] setReactState (setTimeout): Checking conditions before applyHighlight. Target: ${JSON.stringify(
                this.targetHighlightLocation
              )}, HasFocus: ${hasFocus}, ViewStillActive: ${viewStillActive}`
            );
            if (this.targetHighlightLocation && viewStillActive) {
              // Removed hasFocus check for now to see if that's the blocker, will add back if highlight happens when it shouldn't
              console.log(
                '[KanbanView] setReactState (setTimeout): Conditions met (or focus check bypassed). Calling applyHighlight.'
              );
              this.applyHighlight();
            } else if (!this.targetHighlightLocation) {
              console.log(
                '[KanbanView] setReactState (setTimeout): Aborted applyHighlight because targetHighlightLocation is now null.'
              );
            } else if (!viewStillActive) {
              console.log(
                '[KanbanView] setReactState (setTimeout): Aborted applyHighlight because view is no longer active or contentEl is missing.'
              );
            }
          }, 100); // Increased delay slightly to 100ms
        }
      };

      // For the very first render in the view's lifecycle, or if forced.
      if (!this._reactHasRenderedOnceInThisInstance) {
        this._initialRenderTimeoutId = win.setTimeout(renderBoard, 0);
      } else {
        // For subsequent updates, render immediately if not already pending
        // This helps with responsiveness for things like search updates
        if (!this._isPendingInitialRender || newState?.forceRerender) {
          renderBoard();
        } else {
          // If a render is already pending, ensure it runs, but don't stack them.
          // This scenario might be rare if logic is correct.
          if (this._initialRenderTimeoutId) win.clearTimeout(this._initialRenderTimeoutId);
          this._initialRenderTimeoutId = win.setTimeout(renderBoard, 0);
        }
      }
    } else {
      console.warn(
        `[KanbanView] setReactState: StateManager not found for file ${this.file?.path}. Cannot render board.`
      );
      this.contentEl.empty();
      this.contentEl.createDiv({ text: 'Error: Kanban data manager not found for this file.' });
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
        targetElement.getAttribute('contenteditable') === 'true') ||
      targetElement.closest('.setting-item') // Ignore clicks within settings items in a modal for example
    ) {
      return;
    }
    this.clearActiveSearchHighlight(); // Clears border highlight

    // Also clear global search highlight if active
    if (this.currentSearchMatch) {
      console.log(
        '[KanbanView] handleBoardClickToClearHighlight: Clearing currentSearchMatch for global search highlight.',
        this.currentSearchMatch
      );
      this.currentSearchMatch = null;
      this.setReactState({}); // Trigger re-render to remove global search highlights
    } else {
      console.log(
        '[KanbanView] handleBoardClickToClearHighlight: No currentSearchMatch to clear for global search highlight.'
      );
    }

    // Emit event to cancel any active card edits, if the setting is enabled
    if (this.plugin.settings.clickOutsideCardToSaveEdit) {
      console.log(
        '[KanbanView] handleBoardClickToClearHighlight: Emitting "cancelAllCardEdits" (setting enabled)'
      );
      this.emitter.emit('cancelAllCardEdits');
    } else {
      console.log(
        '[KanbanView] handleBoardClickToClearHighlight: "clickOutsideCardToSaveEdit" setting disabled. Not emitting event.'
      );
    }
  };

  public setTargetHighlightLocation(
    location: { blockId?: string; cardTitle?: string; listName?: string } | null
  ) {
    console.log('[KanbanView] setTargetHighlightLocation (for BORDER):', location);
    this.targetHighlightLocation = location;
    // DO NOT update this._reactState.targetHighlight here directly.
  }

  public applyHighlight() {
    console.log(
      `[KanbanView] applyHighlight: Called. Current targetHighlightLocation: ${JSON.stringify(
        this.targetHighlightLocation
      )}`
    );
    this.contentEl.querySelectorAll('.search-result-highlight').forEach((el) => {
      el.removeClass('search-result-highlight');
    });

    if (!this.targetHighlightLocation) {
      console.log('[KanbanView] applyHighlight: No targetHighlightLocation. Aborting.');
      return;
    }

    const board = this.getBoard();
    if (!board) {
      console.warn(
        `[KanbanView] applyHighlight: getBoard() returned null. This may prevent title-based highlighting. File: ${this.file?.path}`
      );
      if (this.targetHighlightLocation.cardTitle || !this.targetHighlightLocation.blockId) {
        console.error(
          '[KanbanView] applyHighlight: Board data not available, and lookup requires it. Aborting highlight.'
        );
        return;
      }
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
          ); // Closing parenthesis for console.log
          return false;
        }); // Closing parenthesis for items.find

        if (targetItem) {
          // Check if targetItem was found
          console.log(
            '[KanbanView] applyHighlight: Found target item by title in lane:',
            targetItem
          );
          // The element to highlight is the content wrapper
          targetItemElement = targetItem.querySelector(
            '.kanban-plugin__item-content-wrapper'
          ) as HTMLElement;
        }
      } else {
        // if (!targetLane)
        console.log('[KanbanView] applyHighlight: Target lane NOT found by title.');
      }
      console.log(
        `[KanbanView] applyHighlight: Result of title/list lookup for item '${this.targetHighlightLocation.cardTitle}' in list '${this.targetHighlightLocation.listName}':`,
        targetItemElement
      );
    }

    if (targetItemElement) {
      console.log(
        '[KanbanView] applyHighlight: Adding search-result-highlight to found element:',
        targetItemElement
      );
      targetItemElement.addClass('search-result-highlight');
      // Also attempt to scroll to it
      console.log('[KanbanView] applyHighlight: Scrolling to highlighted element.');
      targetItemElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } else {
      console.log(
        `[KanbanView] applyHighlight: No target item element found for highlighting with target: ${JSON.stringify(
          this.targetHighlightLocation
        )}. Searched by blockId: '${this.targetHighlightLocation.blockId}', and/or title: '${
          this.targetHighlightLocation.cardTitle
        }' in list: '${this.targetHighlightLocation.listName}'.`
      );
    }
  }

  // Restored scrollToCard method
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
      );
      const lanes = Array.from(this.contentEl.querySelectorAll('.kanban-plugin__lane'));
      const targetLane = lanes.find((lane) => {
        const laneTitleEl = lane.querySelector('.kanban-plugin__lane-title');
        return laneTitleEl && laneTitleEl.textContent?.trim() === location.listName;
      });

      if (targetLane) {
        console.log('[KanbanView] scrollToCard: Found target lane by title:', targetLane);
        const items = Array.from(targetLane.querySelectorAll('.kanban-plugin__item'));
        console.log(
          `[KanbanView] scrollToCard: Found ${items.length} items in lane '${location.listName}'. Checking titles:`
        );

        const targetItem = items.find((item, index) => {
          const contentWrapperEl = item.querySelector('.kanban-plugin__item-content-wrapper');
          if (contentWrapperEl) {
            const currentItemTitle = contentWrapperEl.textContent?.trim();
            console.log(
              `[KanbanView] scrollToCard: Item ${index} in lane, Title from .kanban-plugin__item-content-wrapper: "'${currentItemTitle}'", Target Title: "'${location.cardTitle}'"`
            );
            return currentItemTitle?.startsWith(location.cardTitle ?? '');
          }
          console.log(
            `[KanbanView] scrollToCard: Item ${index} in lane, .kanban-plugin__item-content-wrapper not found.`
          );
          return false;
        });
        if (targetItem) {
          console.log('[KanbanView] scrollToCard: Found target item by title in lane:', targetItem);
          targetItemElement = targetItem as HTMLElement;
        }
      } else {
        console.log('[KanbanView] scrollToCard: Target lane NOT found by title.');
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

  async onClose() {
    console.log(`[KanbanView] onClose: ${this.file?.path}`);
    // Clear any pending timeouts that might try to use this view
    if (this.scrollTimeoutId) {
      clearTimeout(this.scrollTimeoutId);
      this.scrollTimeoutId = null;
    }
    if (this._initialRenderTimeoutId) {
      clearTimeout(this._initialRenderTimeoutId);
      this._initialRenderTimeoutId = null;
    }

    this.emitter.removeAllListeners(); // Remove listeners before React unmount
    this.previewQueue.clear();
    this.previewCache.clear();
    this.emitter.emit('queueEmpty');

    this.plugin.removeView(this);
    this.activeEditor = null;
    this.actionButtons = {};
  }
}
