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

import { KanbanFormat, KanbanSettings, KanbanViewSettings, SettingsModal } from './Settings';
import { Kanban } from './components/Kanban';
import { BasicMarkdownRenderer } from './components/MarkdownRenderer/MarkdownRenderer';
import { c } from './components/helpers';
import { Board } from './components/types';
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
  public targetHighlightLocation: any = null;

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

  getBoard(): Board {
    const stateManager = this.plugin.stateManagers.get(this.file);
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

    // Remove draggables from render, as the DOM has already detached
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

    this.plugin.addView(this, data, !clear && this.isPrimary);
  }

  async setState(state: any, result: ViewStateResult): Promise<void> {
    console.log(
      `[KanbanView] setState ENTRY: File: ${this.file?.path}, State Type: ${state?.type}, Data available: ${!!this.data}`
    );
    console.log('[KanbanView] setState: Full incoming state object (raw):', state);
    console.log(
      '[KanbanView] setState: Full incoming state object (JSON):',
      JSON.stringify(state, null, 2)
    );

    const eStateFromPatch = state.eState;
    console.log(
      '[KanbanView] setState: eState (from the state.eState property received by KanbanView.setState):',
      JSON.stringify(eStateFromPatch, null, 2)
    );

    if (eStateFromPatch && eStateFromPatch.blockId) {
      this.targetHighlightLocation = { blockId: eStateFromPatch.blockId };
      console.log(
        '[KanbanView] setState: Updated targetHighlightLocation with blockId from eStateFromPatch:',
        this.targetHighlightLocation
      );
    } else if (eStateFromPatch && eStateFromPatch.match) {
      this.targetHighlightLocation = eStateFromPatch;
      console.log(
        '[KanbanView] setState: Updated targetHighlightLocation with match object from eStateFromPatch:',
        this.targetHighlightLocation
      );
    } else if (!eStateFromPatch) {
      console.log(
        '[KanbanView] setState: eStateFromPatch is null or undefined. No direct update to targetHighlightLocation based on it. ' +
          'Existing targetHighlightLocation (possibly from onload): ',
        JSON.stringify(this.targetHighlightLocation, null, 2)
      );
    } else {
      console.log(
        '[KanbanView] setState: eStateFromPatch is present but not a recognized highlight structure. ' +
          'No direct update to targetHighlightLocation based on it. Existing targetHighlightLocation: ',
        JSON.stringify(this.targetHighlightLocation, null, 2)
      );
    }

    let typeWasForcedToKanban = false;

    if (this.file && state) {
      let isKanbanFile = false;
      const dataIsAvailable = this.data && this.data.trim() !== '';

      if (dataIsAvailable) {
        isKanbanFile = hasFrontmatterKeyRaw(this.data);
        console.log(
          `[KanbanView] setState: Checked this.data for ${this.file.path}. IsKanban via data: ${isKanbanFile}`
        );
      } else {
        console.log(
          `[KanbanView] setState: this.data is not available for ${this.file.path}. Attempting metadataCache fallback.`
        );
      }

      if (!isKanbanFile) {
        if (this.file) {
          const fileCache = this.app.metadataCache.getFileCache(this.file);
          if (fileCache?.frontmatter?.[frontmatterKey]) {
            isKanbanFile = true;
          }
        }
        console.log(
          `[KanbanView] setState: Checked metadataCache directly for ${this.file?.path}. IsKanban via cache: ${isKanbanFile}`
        );
      }

      if (isKanbanFile) {
        if (state.type !== kanbanViewType) {
          console.log(
            `[KanbanView] setState: File ${this.file.path} IS a Kanban board. Current type: '${state.type}'. Forcing type to '${kanbanViewType}'.`
          );
          state.type = kanbanViewType;
          typeWasForcedToKanban = true;
          if (this.plugin && this.leaf && (this.leaf as any).id) {
            this.plugin.kanbanFileModes[(this.leaf as any).id] = kanbanViewType;
          }
        } else {
          console.log(
            `[KanbanView] setState: File ${this.file.path} IS a Kanban board and type is already '${kanbanViewType}'. No change needed.`
          );
        }
      } else {
        console.log(
          `[KanbanView] setState: File ${this.file.path} is NOT a Kanban board (checked data and/or cache). Current type: '${state.type}'.`
        );
      }
    }

    let highlightToPassToReact = null;
    if (this.targetHighlightLocation) {
      highlightToPassToReact = this.targetHighlightLocation;
      console.log(
        '[KanbanView] setState: Will pass targetHighlightLocation to setReactState:',
        JSON.stringify(highlightToPassToReact, null, 2)
      );
    }

    await super.setState(state, result);

    if (typeWasForcedToKanban) {
      console.log(
        `[KanbanView] setState: Type was forced to 'kanban'. Re-triggering addView for ${this.file?.path}.`
      );
      this.plugin.addView(this, this.data, this.isPrimary);
      if (highlightToPassToReact) {
        setTimeout(() => {
          console.log(
            '[KanbanView] setState (type forced): Delayed call to setReactState with targetHighlight:',
            highlightToPassToReact
          );
          this.setReactState({ targetHighlight: highlightToPassToReact });
        }, 100);
      }
    } else if (highlightToPassToReact) {
      console.log(
        '[KanbanView] setState (no type force): Calling setReactState directly with targetHighlight:',
        highlightToPassToReact
      );
      this.setReactState({ targetHighlight: highlightToPassToReact });
    }

    this.initialSearchQuery = state.initialSearchQuery || state.state?.initialSearchQuery;

    if (
      state &&
      state.type === kanbanViewType &&
      this.plugin &&
      this.leaf &&
      (this.leaf as any).id
    ) {
      this.plugin.kanbanFileModes[(this.leaf as any).id] = kanbanViewType;
    }

    this.viewSettings = { ...(state.kanbanViewState || {}) };
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
    const stateManager = this.plugin.stateManagers.get(this.file);
    if (stateManager) {
      console.log(
        '[KanbanView] setReactState: Requesting StateManager to update board data with targetHighlight:',
        newState.targetHighlight
      );
      stateManager.setState((currentBoard) => {
        return update(currentBoard, {
          data: {
            // Ensure 'targetHighlight' is a valid field in Board.data (added in types.ts)
            targetHighlight: { $set: newState.targetHighlight },
          },
        });
      }, false); // 'false' to not save to disk just for a highlight change
    } else {
      console.warn('[KanbanView] setReactState: StateManager not found for file:', this.file?.path);
    }
  }

  public clearActiveSearchHighlight() {
    console.log(
      '[KanbanView] clearActiveSearchHighlight called. Current this.targetHighlightLocation:',
      JSON.stringify(this.targetHighlightLocation)
    );
    if (this.targetHighlightLocation !== null) {
      console.log(
        '[KanbanView] Condition (this.targetHighlightLocation !== null) is true. Proceeding to clear.'
      );
      this.targetHighlightLocation = null;
      this.setReactState({ targetHighlight: null });
    } else {
      console.log(
        '[KanbanView] Condition (this.targetHighlightLocation !== null) is false. Highlight already considered null at KanbanView level.'
      );
    }
  }

  public processHighlightFromExternal(eState: any) {
    if (eState && eState.blockId) {
      // Check for eState.blockId specifically
      console.log(
        '[KanbanView] processHighlightFromExternal: Received eState with blockId:',
        JSON.stringify(eState, null, 2)
      );
      this.targetHighlightLocation = { blockId: eState.blockId }; // Store only what's needed

      setTimeout(() => {
        if (this.targetHighlightLocation) {
          console.log(
            '[KanbanView] processHighlightFromExternal: setTimeout triggering setReactState with targetHighlightLocation:',
            JSON.stringify(this.targetHighlightLocation, null, 2)
          );
          this.setReactState({ targetHighlight: this.targetHighlightLocation });
        }
      }, 100);
    } else {
      console.log(
        '[KanbanView] processHighlightFromExternal: Received eState without blockId or null/undefined eState.'
      );
      // Optionally, if eState is null/undefined, we might want to clear existing highlight
      if (!eState && this.targetHighlightLocation) {
        this.targetHighlightLocation = null;
        this.setReactState({ targetHighlight: null });
      }
    }
  }

  private handleBoardClickToClearHighlight = (event: MouseEvent) => {
    console.log('[KanbanView] handleBoardClickToClearHighlight triggered. Target:', event.target);
    const targetElement = event.target as HTMLElement;

    // Check if the click originated from within an item or an item's interactive parts
    if (targetElement.closest('.kanban-plugin__item')) {
      // More specific checks can be added here if clicking an item should sometimes clear highlight
      // For now, if the click is anywhere on/in an item, don't clear.
      // This also implicitly handles clicks on item menus, buttons within items, etc.
      return;
    }

    // Check for other known interactive elements that shouldn't clear the highlight
    if (
      targetElement.tagName === 'A' ||
      targetElement.tagName === 'BUTTON' ||
      targetElement.tagName === 'INPUT' ||
      targetElement.tagName === 'TEXTAREA' ||
      targetElement.tagName === 'SELECT' ||
      targetElement.closest('.menu') || // Any generic menu
      (targetElement.hasAttribute('contenteditable') &&
        targetElement.getAttribute('contenteditable') === 'true')
    ) {
      return;
    }

    console.log(
      '[KanbanView] Board area clicked (not on an item or specific control). Clearing active search highlight.'
    );
    this.clearActiveSearchHighlight();
  };
}
