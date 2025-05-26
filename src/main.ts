// Import the compiled stylesheet
import moment from 'moment';
import { around } from 'monkey-around';
import {
  MarkdownView,
  Platform,
  Plugin,
  TFile,
  TFolder,
  ViewState,
  WorkspaceLeaf,
  debounce,
} from 'obsidian';
import { render, unmountComponentAtNode, useEffect, useState } from 'preact/compat';

import { createApp } from './DragDropApp';
import { KanbanView, kanbanIcon, kanbanViewType } from './KanbanView';
import {
  KANBAN_WORKSPACE_ICON,
  KANBAN_WORKSPACE_VIEW_TYPE,
  KanbanWorkspaceView,
} from './KanbanWorkspaceView';
import {
  DEFAULT_SETTINGS,
  KanbanSettings,
  KanbanSettingsTab,
  SettingsManagerConfig,
} from './Settings';
import { StateManager } from './StateManager';
import { DateSuggest, TimeSuggest } from './components/Editor/suggest';
import { ReminderModal } from './components/ReminderModal';
import { Item, ItemData } from './components/types';
import { getParentWindow } from './dnd/util/getWindow';
import { hasFrontmatterKey } from './helpers';
import { t } from './lang/helpers';
import { ListFormat } from './parsers/List';
import { basicFrontmatter, frontmatterKey } from './parsers/common';
import './styles.less';

interface WindowRegistry {
  viewMap: Map<string, KanbanView>;
  viewStateReceivers: Array<(views: KanbanView[]) => void>;
  appRoot: HTMLElement;
}

function getEditorClass(app: any) {
  const md = app.embedRegistry.embedByExtension.md(
    { app: app, containerEl: createDiv(), state: {} },
    null,
    ''
  );

  md.load();
  md.editable = true;
  md.showEditor();

  const MarkdownEditor = Object.getPrototypeOf(Object.getPrototypeOf(md.editMode)).constructor;

  md.unload();

  return MarkdownEditor;
}

export default class KanbanPlugin extends Plugin {
  settingsTab: KanbanSettingsTab;
  settings: KanbanSettings;

  // leafid => view mode
  kanbanFileModes: Record<string, string> = {};
  stateManagers: Map<TFile, StateManager> = new Map();

  windowRegistry: Map<Window, WindowRegistry> = new Map();

  _loaded: boolean = false;

  isShiftPressed: boolean = false;

  // Added properties
  public archive: any = {
    getArchive: (file: TFile): Item[] => {
      // console.warn(`[KanbanPlugin] archive.getArchive called for ${file.path} - placeholder implementation.`);
      return []; // Return empty array as a valid default
    },
  };
  public dispatch: (...args: any[]) => void = (...args: any[]) => {
    // console.warn('[KanbanPlugin] dispatch called - placeholder implementation.', args);
  };

  // Placeholder for onDbChange
  public onDbChange(file: TFile, ...args: any[]) {
    console.log(`[KanbanPlugin] onDbChange called for file: ${file?.path}`, args);
    // Actual database change logic will go here
  }

  // Placeholder for onwardsNavigate
  public onwardsNavigate(path: string, payload: any) {
    console.log('[KanbanPlugin] onwardsNavigate called with path:', path, 'payload:', payload);
    // Actual navigation logic will go here
    // For example, using app.workspace.openLinkText or similar
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  unload(): void {
    super.unload();
    Promise.all(
      this.app.workspace.getLeavesOfType(kanbanViewType).map((leaf) => {
        this.kanbanFileModes[(leaf as any).id] = 'markdown';
        return this.setMarkdownView(leaf);
      })
    );
  }

  onunload() {
    this.MarkdownEditor = null;
    this.windowRegistry.forEach((reg, win) => {
      reg.viewStateReceivers.forEach((fn) => fn([]));
      this.unmount(win);
    });

    this.unmount(window);

    this.stateManagers.clear();
    this.windowRegistry.clear();
    this.kanbanFileModes = {};

    (this.app.workspace as any).unregisterHoverLinkSource(frontmatterKey);
  }

  MarkdownEditor: any;

  async onload() {
    await this.loadSettings();

    this.MarkdownEditor = getEditorClass(this.app);

    this.registerEditorSuggest(new TimeSuggest(this.app, this));
    this.registerEditorSuggest(new DateSuggest(this.app, this));

    this.registerEvent(
      this.app.workspace.on('window-open', (_: any, win: Window) => {
        this.mount(win);
      })
    );

    this.registerEvent(
      this.app.workspace.on('window-close', (_: any, win: Window) => {
        this.unmount(win);
      })
    );

    this.settingsTab = new KanbanSettingsTab(this, {
      onSettingsChange: async (newSettings) => {
        this.settings = newSettings;
        await this.saveSettings();

        // Force a complete re-render when settings change
        this.stateManagers.forEach((stateManager) => {
          stateManager.forceRefresh();
        });
      },
    });

    this.addSettingTab(this.settingsTab);

    this.registerView(kanbanViewType, (leaf) => new KanbanView(leaf, this));
    this.registerView(KANBAN_WORKSPACE_VIEW_TYPE, (leaf) => new KanbanWorkspaceView(leaf, this));
    this.registerMonkeyPatches();
    this.registerCommands();
    this.registerEvents();

    this.registerEvent(
      this.app.workspace.on('file-open', async (file: TFile | null) => {
        if (!file) {
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
        const activeLeaf = this.app.workspace.activeLeaf;
        if (!activeLeaf || !activeLeaf.view) {
          // console.log("[Kanban Main] 'file-open': No active leaf or active leaf has no view.");
          return;
        }
        if (!(activeLeaf.view instanceof KanbanView)) {
          // This logic for clearing highlights on non-active Kanban views should remain if desired,
          // but the click-to-clear on the active KanbanView is the primary mechanism now.
          // For maximum cleanup, this could also be removed if the click-to-clear is deemed sufficient.
          // this.app.workspace.getLeavesOfType(kanbanViewType).forEach((leaf) => {
          //   if (leaf.view instanceof KanbanView) {
          //     leaf.view.clearActiveSearchHighlight();
          //   }
          // });
          return;
        }
        const kanbanView = activeLeaf.view as KanbanView;
        if (kanbanView.file !== file) {
          // kanbanView.clearActiveSearchHighlight(); // This was part of the previous strategy
          // kanbanView.processHighlightFromExternal(null); // todo: this line causes a linter error, commenting out
          return;
        }
        let eStateToUse: any = null;
        const currentHistoryState = (activeLeaf as any).history?.current;
        if (currentHistoryState && currentHistoryState.eState) {
          eStateToUse = currentHistoryState.eState;
        } else {
          const viewState = activeLeaf.getViewState();
          if (viewState && viewState.state?.eState) {
            eStateToUse = viewState.state?.eState;
          }
        }
        if (eStateToUse && (eStateToUse.blockId || eStateToUse.match)) {
          // kanbanView.processHighlightFromExternal(eStateToUse); // Commenting out due to linter error: Property 'processHighlightFromExternal' does not exist on type 'KanbanView'.
        } else {
          // This specific call might be redundant if click-to-clear is effective,
          // but harmless if clearActiveSearchHighlight handles null state gracefully.
          // For now, let it be, or remove if click-to-clear is robust enough.
          // kanbanView.clearActiveSearchHighlight();
        }
      })
    );

    this.mount(window);

    (this.app.workspace as any).floatingSplit?.children?.forEach((c: any) => {
      this.mount(c.win);
    });

    this.registerDomEvent(window, 'keydown', this.handleShift);
    this.registerDomEvent(window, 'keyup', this.handleShift);

    this.addRibbonIcon(kanbanIcon, t('Create new board'), () => {
      this.newKanban();
    });

    this.addRibbonIcon(KANBAN_WORKSPACE_ICON, 'Open Kanban Workspace View', () => {
      this.app.workspace.getLeaf(true).setViewState({
        type: KANBAN_WORKSPACE_VIEW_TYPE,
        active: true,
      });
    });

    // Call processDueDateReminders on load
    this.app.workspace.onLayoutReady(async () => {
      // Wait for layout to be ready to ensure settings are loaded and workspace is available
      await this.processDueDateReminders();
    });
  }

  handleShift = (e: KeyboardEvent) => {
    this.isShiftPressed = e.shiftKey;
  };

  getKanbanViews(win: Window) {
    const reg = this.windowRegistry.get(win);

    if (reg) {
      return Array.from(reg.viewMap.values());
    }

    return [];
  }

  getKanbanView(id: string, win: Window) {
    const reg = this.windowRegistry.get(win);

    if (reg?.viewMap.has(id)) {
      return reg.viewMap.get(id);
    }

    for (const reg of this.windowRegistry.values()) {
      if (reg.viewMap.has(id)) {
        return reg.viewMap.get(id);
      }
    }

    return null;
  }

  getStateManager(file: TFile) {
    return this.stateManagers.get(file);
  }

  getStateManagerFromViewID(id: string, win: Window) {
    const view = this.getKanbanView(id, win);

    if (!view) {
      return null;
    }

    return this.stateManagers.get(view.file);
  }

  useKanbanViews(win: Window): KanbanView[] {
    const [state, setState] = useState(this.getKanbanViews(win));

    useEffect(() => {
      const reg = this.windowRegistry.get(win);

      reg?.viewStateReceivers.push(setState);

      return () => {
        reg?.viewStateReceivers.remove(setState);
      };
    }, [win]);

    return state;
  }

  async addView(view: KanbanView, data: string, shouldParseData: boolean) {
    const win = view.getWindow();
    const reg = this.windowRegistry.get(win);

    if (!reg) {
      console.warn(`[KanbanPlugin] addView: No window registry found for window. View: ${view.id}`);
      return; // Early exit if no window registry
    }
    if (!reg.viewMap.has(view.id)) {
      reg.viewMap.set(view.id, view);
    }

    const file = view.file;
    if (!file) {
      console.warn(
        `[KanbanPlugin] addView: View ${view.id} has no file associated. Cannot get/create StateManager.`
      );
      return; // Early exit if no file
    }

    let stateManager = this.stateManagers.get(file);
    let isNewStateManager = false;

    if (!stateManager) {
      console.log(`[KanbanPlugin] addView: Creating new StateManager for ${file.path}`);
      stateManager = new StateManager(
        this.app,
        view, // Pass the view for file context
        // data, // Data is no longer passed to constructor for parsing
        () => this.stateManagers.delete(file),
        () => this.settings
      );
      this.stateManagers.set(file, stateManager);
      isNewStateManager = true;
      // The new SM constructor (once fixed) won't call registerView.
      // So, we call it here explicitly and await it.
    } else {
      console.log(`[KanbanPlugin] addView: Using existing StateManager for ${file.path}`);
    }

    // Always call and await registerView here to ensure state is ready.
    // For a new SM, this is its first parsing. For an existing one, it re-registers/re-parses if needed.
    if (stateManager) {
      try {
        console.log(
          `[KanbanPlugin] addView: Calling await stateManager.registerView for ${file.path}. shouldParseData: ${shouldParseData}`
        );
        await stateManager.registerView(view, data, shouldParseData);
        console.log(
          `[KanbanPlugin] addView: stateManager.registerView completed for ${file.path}. StateManager state ID: ${stateManager.state?.id}`
        );
        // Log the state directly from the stateManager instance here
        console.log(
          `[KanbanPlugin] addView: After registerView, stateManager for ${file.path} has state ID: `,
          stateManager.state ? stateManager.state.id : 'null or undefined'
        );
      } catch (e) {
        console.error(
          `[KanbanPlugin] addView: Error during stateManager.registerView for ${file.path}:`,
          e
        );
        stateManager.setError(e); // Ensure error is set on SM
      }
    } else {
      // This case should ideally not be reached if SM creation was successful
      console.error(
        `[KanbanPlugin] addView: StateManager is unexpectedly null for ${file.path} after get/create.`
      );
      return;
    }

    reg.viewStateReceivers.forEach((fn) => fn(this.getKanbanViews(win)));

    // Check if the view was pending an initial render because StateManager wasn't ready
    // Now, stateManager.state should be populated (or be an error state) by the awaited registerView.
    // THIS IS THE CALL WE ARE INTERESTED IN:
    // if (view._isPendingInitialRender && stateManager.state) {
    //   console.log(
    //     `[KanbanPlugin] addView: View ${view.id} was pending initial render and SM state is now available. Triggering setReactState.`
    //   );
    //   view.setReactState({}); // <--- Potential source of premature render
    //   view._isPendingInitialRender = false;
    // }
  }

  removeView(view: KanbanView) {
    const entry = Array.from(this.windowRegistry.entries()).find(([, reg]) => {
      return reg.viewMap.has(view.id);
    }, []);

    if (!entry) return;

    const [win, reg] = entry;
    const file = view.file;

    if (reg.viewMap.has(view.id)) {
      reg.viewMap.delete(view.id);
    }

    if (this.stateManagers.has(file)) {
      this.stateManagers.get(file).unregisterView(view);
      reg.viewStateReceivers.forEach((fn) => fn(this.getKanbanViews(win)));
    }
  }

  handleViewFileRename(view: KanbanView, oldPath: string) {
    const win = view.getWindow();
    if (!this.windowRegistry.has(win)) {
      return;
    }

    const reg = this.windowRegistry.get(win);
    const oldId = `${(view.leaf as any).id}:::${oldPath}`;

    if (reg.viewMap.has(oldId)) {
      reg.viewMap.delete(oldId);
    }

    if (!reg.viewMap.has(view.id)) {
      reg.viewMap.set(view.id, view);
    }

    if (view.isPrimary) {
      this.getStateManager(view.file).softRefresh();
    }
  }

  mount(win: Window) {
    if (this.windowRegistry.has(win)) {
      return;
    }

    const el = win.document.body.createDiv();

    this.windowRegistry.set(win, {
      viewMap: new Map(),
      viewStateReceivers: [],
      appRoot: el,
    });

    render(createApp(win, this), el);
  }

  unmount(win: Window) {
    if (!this.windowRegistry.has(win)) {
      return;
    }

    const reg = this.windowRegistry.get(win);

    for (const view of reg.viewMap.values()) {
      this.removeView(view);
    }

    unmountComponentAtNode(reg.appRoot);

    reg.appRoot.remove();
    reg.viewMap.clear();
    reg.viewStateReceivers.length = 0;
    reg.appRoot = null;

    this.windowRegistry.delete(win);
  }

  async setMarkdownView(leaf: WorkspaceLeaf, focus: boolean = true) {
    const currentKanbanState = leaf.view.getState();
    await leaf.setViewState(
      {
        type: 'markdown',
        state: {
          // Preserve some potentially useful generic state if they exist and are simple types
          // but prioritize a clean state for MarkdownView.
          file: (leaf.view as KanbanView).file?.path || currentKanbanState.file,
          mode: 'source',
          source: false,
          // Attempt to carry over scroll position if available and simple
          scroll:
            typeof currentKanbanState.scroll === 'number' ? currentKanbanState.scroll : undefined,
        },
        popstate: true,
      } as ViewState,
      { focus }
    );
  }

  async setKanbanView(leaf: WorkspaceLeaf) {
    await leaf.setViewState({
      type: kanbanViewType,
      state: leaf.view.getState(),
      popstate: true,
    } as ViewState);
  }

  async newKanban(folder?: TFolder) {
    const targetFolder = folder
      ? folder
      : this.app.fileManager.getNewFileParent(this.app.workspace.getActiveFile()?.path || '');

    try {
      const kanban: TFile = await (this.app.fileManager as any).createNewMarkdownFile(
        targetFolder,
        t('Untitled Kanban')
      );

      await this.app.vault.modify(kanban, basicFrontmatter);
      await this.app.workspace.getLeaf().setViewState({
        type: kanbanViewType,
        state: { file: kanban.path },
      });
    } catch (e) {
      console.error('Error creating kanban board:', e);
    }
  }

  registerEvents() {
    this.registerEvent(
      this.app.workspace.on('file-menu', (menu, file, source, leaf) => {
        if (source === 'link-context-menu') return;

        const fileIsFile = file instanceof TFile;
        const fileIsFolder = file instanceof TFolder;
        const leafIsMarkdown = leaf?.view instanceof MarkdownView;
        const leafIsKanban = leaf?.view instanceof KanbanView;

        // Add a menu item to the folder context menu to create a board
        if (fileIsFolder) {
          menu.addItem((item) => {
            item
              .setSection('action-primary')
              .setTitle(t('New kanban board'))
              .setIcon(kanbanIcon)
              .onClick(() => this.newKanban(file));
          });
          return;
        }

        if (
          !Platform.isMobile &&
          fileIsFile &&
          leaf &&
          source === 'sidebar-context-menu' &&
          hasFrontmatterKey(file)
        ) {
          const views = this.getKanbanViews(getParentWindow(leaf.view.containerEl));
          let haveKanbanView = false;

          for (const view of views) {
            if (view.file === file) {
              view.onPaneMenu(menu, 'more-options', false);
              haveKanbanView = true;
              break;
            }
          }

          if (!haveKanbanView) {
            menu.addItem((item) => {
              item
                .setTitle(t('Open as kanban board'))
                .setIcon(kanbanIcon)
                .setSection('pane')
                .onClick(() => {
                  this.kanbanFileModes[(leaf as any).id || file.path] = kanbanViewType;
                  this.setKanbanView(leaf);
                });
            });

            return;
          }
        }

        if (
          leafIsMarkdown &&
          fileIsFile &&
          ['more-options', 'pane-more-options', 'tab-header'].includes(source) &&
          hasFrontmatterKey(file)
        ) {
          menu.addItem((item) => {
            item
              .setTitle(t('Open as kanban board'))
              .setIcon(kanbanIcon)
              .setSection('pane')
              .onClick(() => {
                this.kanbanFileModes[(leaf as any).id || file.path] = kanbanViewType;
                this.setKanbanView(leaf);
              });
          });
        }

        if (fileIsFile && leafIsKanban) {
          if (['pane-more-options', 'tab-header'].includes(source)) {
            menu.addItem((item) => {
              item
                .setTitle(t('Open as markdown'))
                .setIcon(kanbanIcon)
                .setSection('pane')
                .onClick(() => {
                  this.kanbanFileModes[(leaf as any).id || file.path] = 'markdown';
                  this.setMarkdownView(leaf);
                });
            });
          }

          if (Platform.isMobile) {
            const stateManager = this.stateManagers.get(file);
            const kanbanView = leaf.view as KanbanView;
            const boardView =
              kanbanView.viewSettings[frontmatterKey] || stateManager.getSetting(frontmatterKey);

            menu
              .addItem((item) => {
                item
                  .setTitle(t('Add a list'))
                  .setIcon('lucide-plus-circle')
                  .setSection('pane')
                  .onClick(() => {
                    kanbanView.emitter.emit('showLaneForm', undefined);
                  });
              })
              .addItem((item) => {
                item
                  .setTitle(t('Archive completed cards'))
                  .setIcon('lucide-archive')
                  .setSection('pane')
                  .onClick(() => {
                    stateManager.archiveCompletedCards();
                  });
              })
              .addItem((item) => {
                item
                  .setTitle(t('Archive completed cards'))
                  .setIcon('lucide-archive')
                  .setSection('pane')
                  .onClick(() => {
                    const stateManager = this.stateManagers.get(file);
                    stateManager.archiveCompletedCards();
                  });
              })
              .addItem((item) =>
                item
                  .setTitle(t('View as board'))
                  .setSection('pane')
                  .setIcon('lucide-trello')
                  .setChecked(boardView === 'basic' || boardView === 'board')
                  .onClick(() => kanbanView.setView('board'))
              )
              .addItem((item) =>
                item
                  .setTitle(t('View as table'))
                  .setSection('pane')
                  .setIcon('lucide-table')
                  .setChecked(boardView === 'table')
                  .onClick(() => kanbanView.setView('table'))
              )
              .addItem((item) =>
                item
                  .setTitle(t('View as list'))
                  .setSection('pane')
                  .setIcon('lucide-server')
                  .setChecked(boardView === 'list')
                  .onClick(() => kanbanView.setView('list'))
              )
              .addItem((item) =>
                item
                  .setTitle(t('Open board settings'))
                  .setSection('pane')
                  .setIcon('lucide-settings')
                  .onClick(() => kanbanView.getBoardSettings())
              );
          }
        }
      })
    );

    this.registerEvent(
      this.app.vault.on('rename', (file: TFile, oldPath: string) => {
        const kanbanLeaves = this.app.workspace.getLeavesOfType(kanbanViewType);

        kanbanLeaves.forEach((leaf: WorkspaceLeaf) => {
          (leaf.view as KanbanView).handleRename(file.path, oldPath);
        });
      })
    );

    const notifyFileChange = debounce(
      (file: TFile) => {
        this.stateManagers.forEach((manager) => {
          if (manager.file !== file) {
            manager.onFileMetadataChange();
          }
        });
      },
      2000,
      true
    );

    this.registerEvent(
      this.app.vault.on('modify', (file: TFile) => {
        if (file instanceof TFile) {
          notifyFileChange(file);
        }
      })
    );

    this.registerEvent(
      this.app.metadataCache.on('changed', (file: TFile) => {
        notifyFileChange(file);
      })
    );

    this.registerEvent(
      (this.app as any).metadataCache.on('dataview:metadata-change', (_: any, file: TFile) => {
        notifyFileChange(file);
      })
    );

    this.registerEvent(
      (this.app as any).metadataCache.on('dataview:api-ready', () => {
        this.stateManagers.forEach((manager) => {
          manager.forceRefresh();
        });
      })
    );

    (this.app.workspace as any).registerHoverLinkSource(frontmatterKey, {
      display: 'Kanban',
      defaultMod: true,
    });
  }

  registerCommands() {
    this.addCommand({
      id: 'create-new-kanban-board',
      name: t('Create new board'),
      callback: () => this.newKanban(),
    });

    this.addCommand({
      id: 'archive-completed-cards',
      name: t('Archive completed cards in active board'),
      checkCallback: (checking) => {
        const activeView = this.app.workspace.getActiveViewOfType(KanbanView);

        if (!activeView) return false;
        if (checking) return true;

        this.stateManagers.get(activeView.file).archiveCompletedCards();
      },
    });

    this.addCommand({
      id: 'toggle-kanban-view',
      name: t('Toggle between Kanban and markdown mode'),
      checkCallback: (checking) => {
        const activeFile = this.app.workspace.getActiveFile();

        if (!activeFile) return false;

        const fileCache = this.app.metadataCache.getFileCache(activeFile);
        const fileIsKanban = !!fileCache?.frontmatter && !!fileCache.frontmatter[frontmatterKey];

        if (checking) {
          return fileIsKanban;
        }

        const activeView = this.app.workspace.getActiveViewOfType(KanbanView);

        if (activeView) {
          this.kanbanFileModes[(activeView.leaf as any).id || activeFile.path] = 'markdown';
          this.setMarkdownView(activeView.leaf);
        } else if (fileIsKanban) {
          const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);

          if (activeView) {
            this.kanbanFileModes[(activeView.leaf as any).id || activeFile.path] = kanbanViewType;
            this.setKanbanView(activeView.leaf);
          }
        }
      },
    });

    this.addCommand({
      id: 'convert-to-kanban',
      name: t('Convert empty note to Kanban'),
      checkCallback: (checking) => {
        const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);

        if (!activeView) return false;

        const isFileEmpty = activeView.file.stat.size === 0;

        if (checking) return isFileEmpty;
        if (isFileEmpty) {
          this.app.vault
            .modify(activeView.file, basicFrontmatter)
            .then(() => {
              this.setKanbanView(activeView.leaf);
            })
            .catch((e: any) => console.error(e));
        }
      },
    });

    this.addCommand({
      id: 'add-kanban-lane',
      name: t('Add a list'),
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(KanbanView);

        if (checking) {
          return view && view instanceof KanbanView;
        }

        if (view && view instanceof KanbanView) {
          view.emitter.emit('showLaneForm', undefined);
        }
      },
    });

    this.addCommand({
      id: 'view-board',
      name: t('View as board'),
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(KanbanView);

        if (checking) {
          return view && view instanceof KanbanView;
        }

        if (view && view instanceof KanbanView) {
          view.setView('board');
        }
      },
    });

    this.addCommand({
      id: 'view-table',
      name: t('View as table'),
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(KanbanView);

        if (checking) {
          return view && view instanceof KanbanView;
        }

        if (view && view instanceof KanbanView) {
          view.setView('table');
        }
      },
    });

    this.addCommand({
      id: 'view-list',
      name: t('View as list'),
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(KanbanView);

        if (checking) {
          return view && view instanceof KanbanView;
        }

        if (view && view instanceof KanbanView) {
          view.setView('list');
        }
      },
    });

    this.addCommand({
      id: 'open-board-settings',
      name: t('Open board settings'),
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(KanbanView);

        if (!view) return false;
        if (checking) return true;

        view.getBoardSettings();
      },
    });

    this.addCommand({
      id: 'open-kanban-workspace-view',
      name: 'Kanban Workspace: Open tag filter view',
      callback: () => {
        this.app.workspace.getLeaf(true).setViewState({
          type: KANBAN_WORKSPACE_VIEW_TYPE,
          active: true,
        });
      },
    });
  }

  registerMonkeyPatches() {
    const self = this;

    this.app.workspace.onLayoutReady(() => {
      this.register(
        around((this.app as any).commands, {
          executeCommand(next) {
            return function (command: any) {
              const view = self.app.workspace.getActiveViewOfType(KanbanView);

              if (view && command?.id) {
                view.emitter.emit('hotkey', { commandId: command.id });
              }

              return next.call(this, command);
            };
          },
        })
      );
    });

    this.register(
      around(this.app.workspace, {
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore
        setActiveLeaf(next) {
          return function (...args) {
            next.apply(this, args);
            const view = this.getActiveViewOfType(KanbanView);
            if (view?.activeEditor) {
              this.activeEditor = view.activeEditor;
            }
          };
        },
      })
    );

    // Monkey patch WorkspaceLeaf to open Kanbans with KanbanView by default
    this.register(
      around(WorkspaceLeaf.prototype, {
        // Kanbans can be viewed as markdown or kanban, and we keep track of the mode
        // while the file is open. When the file closes, we no longer need to keep track of it.
        detach(next) {
          return function () {
            const state = this.view?.getState();

            if (state?.file && self.kanbanFileModes[this.id || state.file]) {
              delete self.kanbanFileModes[this.id || state.file];
            }

            return next.apply(this);
          };
        },

        setViewState: (originalMethod: any) => {
          return async function (viewState: ViewState, navState?: any) {
            // console.log(
            //   '[Kanban Main] setViewState MONKEYPATCH ENTRY. Incoming ViewState (JSON):',
            //   JSON.stringify(viewState, null, 2),
            //   'Incoming navState:',
            //   JSON.stringify(navState, null, 2)
            // );

            let eStateForHighlighting: any = null;
            if (viewState.state?.eState) {
              eStateForHighlighting = viewState.state.eState;
              // console.log(
              //   '[Kanban Main] setViewState: Found eState directly in viewState.state.eState:',
              //   JSON.stringify(eStateForHighlighting, null, 2)
              // );
            } else if ((viewState as any).eState) {
              eStateForHighlighting = (viewState as any).eState;
              // console.log(
              //   '[Kanban Main] setViewState: Found eState at viewState.eState (top-level):',
              //   JSON.stringify(eStateForHighlighting, null, 2)
              // );
            } else if (navState) {
              eStateForHighlighting = navState;
              // console.log(
              //   '[Kanban Main] setViewState: Using eState from explicit navState argument:',
              //   JSON.stringify(eStateForHighlighting, null, 2)
              // );
            }

            if (
              (!eStateForHighlighting || !eStateForHighlighting.blockId) &&
              viewState.type === 'markdown' &&
              viewState.state?.file
            ) {
              // console.log(
              //   '[Kanban Main] setViewState: eState (with blockId) not found directly, trying global search query for file:',
              //   viewState.state.file
              // );
              try {
                const searchPluginInstance = (this.app as any).internalPlugins?.getPluginById(
                  'global-search'
                )?.instance;
                if (searchPluginInstance) {
                  let potentialQuery: string | undefined;
                  if (searchPluginInstance.searchQueryInputEl?.value) {
                    potentialQuery = searchPluginInstance.searchQueryInputEl.value;
                  } else if (searchPluginInstance.lastSearch?.query) {
                    potentialQuery = searchPluginInstance.lastSearch.query;
                  } else if (searchPluginInstance.query) {
                    potentialQuery = searchPluginInstance.query;
                  } else if (searchPluginInstance.searchQuery) {
                    potentialQuery = searchPluginInstance.searchQuery;
                  }
                  if (
                    potentialQuery &&
                    typeof potentialQuery === 'string' &&
                    potentialQuery.trim() !== ''
                  ) {
                    // console.log(
                    //   '[Kanban Main] setViewState: Found potentialQuery from global search:',
                    //   potentialQuery
                    // );
                    const blockIdMatch = potentialQuery.match(/#\^([a-zA-Z0-9]+)/);
                    if (blockIdMatch && blockIdMatch[1]) {
                      const blockIdFromQuery = blockIdMatch[1];
                      const targetFilePath = viewState.state.file as string;
                      const targetFileName = targetFilePath.substring(
                        targetFilePath.lastIndexOf('/') + 1
                      );
                      const targetFileNameNoExt = targetFileName.replace(/\.md$/, '');
                      const normalizedQuery = potentialQuery.toLowerCase();
                      const normalizedFileName = targetFileNameNoExt.toLowerCase();
                      const normalizedFilePath = targetFilePath.toLowerCase();
                      if (
                        normalizedQuery.includes(normalizedFileName) ||
                        normalizedQuery.includes(normalizedFilePath)
                      ) {
                        eStateForHighlighting = {
                          blockId: blockIdFromQuery,
                          sourceQuery: potentialQuery,
                        };
                        // console.log(
                        //   `[Kanban Main] setViewState: Constructed eState from global search query. BlockId: ${blockIdFromQuery}, Target File: ${targetFileName}`
                        // );
                      } else {
                        // console.log(
                        //   `[Kanban Main] setViewState: Query contains blockId ${blockIdFromQuery}, but target filename "${targetFileNameNoExt}" not detected in query "${potentialQuery}".`
                        // );
                      }
                    } else {
                      // console.log(
                      //   '[Kanban Main] setViewState: Global search query did not contain a #^blockId pattern:',
                      //   potentialQuery
                      // );
                    }
                  } else {
                    // console.log(
                    //   '[Kanban Main] setViewState: No usable potentialQuery found in global search instance.'
                    // );
                  }
                } else {
                  // console.log(
                  //   '[Kanban Main] setViewState: Global search plugin instance not found when trying to get query.'
                  // );
                }
              } catch (err) {
                // console.warn(
                //   '[Kanban Main] setViewState: Error trying to get global search query for eState:',
                //   err
                // );
              }
            }
            if (!eStateForHighlighting?.blockId) {
              // console.log(
              //   '[Kanban Main] setViewState: No blockId found for highlighting after all checks.'
              // );
            } else {
              // console.log(
              //   '[Kanban Main] setViewState: eStateForHighlighting that will be used (JSON):'
              //   JSON.stringify(eStateForHighlighting, null, 2)
              // );
            }
            const newState = { ...viewState };
            if (newState.state) {
              newState.state.eState = eStateForHighlighting || null;
            } else {
              newState.state = { eState: eStateForHighlighting || null } as any;
            }

            let isKanbanFile = false;
            const filePathForModeCheck = newState.state?.file as string | undefined;

            if (filePathForModeCheck) {
              const file = self.app.vault.getAbstractFileByPath(filePathForModeCheck);
              if (file instanceof TFile) {
                isKanbanFile = hasFrontmatterKey(file);
              }
            }

            if (isKanbanFile && filePathForModeCheck) {
              const leafId = (this as any).id || filePathForModeCheck; // Use leaf.id if available, else filePath
              const explicitMode = self.kanbanFileModes[leafId];

              if (explicitMode === 'markdown') {
                newState.type = 'markdown';
              } else {
                // Default to Kanban view for Kanban files unless explicitly set to markdown for this leaf
                newState.type = kanbanViewType;
              }
            } else if (isKanbanFile && !filePathForModeCheck) {
              // It's a Kanban file but we don't have a path for mode checking (should be rare)
              // Default to Kanban view
              newState.type = kanbanViewType;
            }
            // If not a KanbanFile, newState.type remains as Obsidian determined it.

            return originalMethod.call(this, newState, eStateForHighlighting);
          };
        },
      })
    );
  }

  // --- BEGIN ADDED METHOD for Due Date Reminders ---
  async processDueDateReminders() {
    console.log('[KanbanPlugin] processDueDateReminders called');
    if (!this.settings.enableDueDateEmailReminders) {
      console.log('[KanbanPlugin] Due date email reminders are disabled in settings.');
      return;
    }

    const now = new Date().getTime();
    // Use the new setting for frequency, default to 1 day if not set or invalid
    const frequencyDays =
      this.settings.automaticEmailSendingFrequencyDays !== undefined &&
      this.settings.automaticEmailSendingFrequencyDays >= 1
        ? this.settings.automaticEmailSendingFrequencyDays
        : 1;
    const frequencyMilliseconds = frequencyDays * 24 * 60 * 60 * 1000;
    const lastRun = this.settings.dueDateReminderLastRun || 0;

    // Check if the configured frequency has passed since the last run
    if (now - lastRun < frequencyMilliseconds) {
      const timeSinceLastRun = now - lastRun;
      const hoursSinceLastRun = (timeSinceLastRun / (1000 * 60 * 60)).toFixed(1);
      const daysConfigured = frequencyDays;
      console.log(
        `[KanbanPlugin] Due date reminders run too recently (${hoursSinceLastRun} hours ago). Configured frequency: ${daysConfigured} day(s). Skipping.`
      );
      return;
    }

    console.log('[KanbanPlugin] Processing due date reminders...');

    // Structure to hold tasks grouped by email
    // { "email@example.com": [{ title: "Task 1", board: "Board A" }, { title: "Task 2", board: "Board B" }] }
    const tasksByEmail: Record<
      string,
      Array<{
        title: string;
        boardName: string;
        boardPath: string;
        dueDate: string;
        tags?: string[];
        priority?: 'high' | 'medium' | 'low';
      }>
    > = {};

    const allMarkdownFiles = this.app.vault.getMarkdownFiles();
    const kanbanBoards: TFile[] = [];

    for (const file of allMarkdownFiles) {
      // A simple check for a kanban board, can be refined
      // This assumes a board is a markdown file with a frontmatter key specific to kanban
      // or that it would be opened by KanbanView. For a more robust check,
      // we might need to parse frontmatter more deeply or check if it has kanban content.
      // For now, we'll use hasFrontmatterKey as a proxy.
      const fileCache = this.app.metadataCache.getFileCache(file);
      if (fileCache?.frontmatter && fileCache.frontmatter[frontmatterKey]) {
        kanbanBoards.push(file);
      }
    }

    console.log(`[KanbanPlugin] Found ${kanbanBoards.length} potential Kanban boards to scan.`);

    for (const boardFile of kanbanBoards) {
      try {
        const fileContent = await this.app.vault.cachedRead(boardFile);
        // We need a way to parse the board content to get cards, their due dates, and assigned members.
        // This is non-trivial and would ideally reuse parsing logic from KanbanView or StateManager.
        // For this initial step, we'll represent this with a placeholder.
        // TODO: Implement proper board parsing logic here.

        // Placeholder: Simulate finding cards
        // In a real implementation, this would involve parsing the markdown content of boardFile
        // similar to how KanbanWorkspaceView does it, to extract ItemData for each card.

        // Example of how to get a StateManager (though we need settings for it)
        // This might be tricky without a view context, but essential for using existing parsers.
        let tempStateManager: StateManager | null = null;
        try {
          tempStateManager = new StateManager(
            this.app,
            { file: boardFile } as any, // Cast to avoid type errors for missing view properties
            () => {
              /* onDbChange, can be no-op for this purpose */
            },
            () => this.settings // Provide global settings
          );
        } catch (e) {
          console.warn(
            `[KanbanPlugin] Could not create temporary StateManager for ${boardFile.path}:`,
            e
          );
          continue; // Skip this board if StateManager fails
        }

        if (!tempStateManager) continue;

        // const { board } = tempStateManager.parseBoard(fileContent) as any; // Assuming parseBoard exists and returns a board structure
        // Corrected parsing:
        let board;
        try {
          const parser = new ListFormat(tempStateManager); // Assuming ListFormat is the default or most common
          const parsedResult = parser.mdToBoard(fileContent);
          board = parsedResult; // mdToBoard returns the board directly
        } catch (e) {
          console.warn(`[KanbanPlugin] Error parsing board ${boardFile.path} with ListFormat:`, e);
          continue; // Skip this board if parsing fails
        }

        if (board && board.children) {
          for (const lane of board.children) {
            if (lane.children) {
              for (const cardNode of lane.children) {
                const cardItemData = cardNode.data as ItemData; // Correct: cardNode.data is ItemData

                if (cardItemData?.metadata?.date) {
                  const dueDate = moment(cardItemData.metadata.date);
                  const timeframeDays =
                    this.settings.dueDateReminderTimeframeDays !== undefined
                      ? this.settings.dueDateReminderTimeframeDays
                      : 1;
                  const targetDueDate = moment().add(timeframeDays, 'day').endOf('day');

                  if (
                    dueDate.isValid() &&
                    dueDate.isSameOrBefore(targetDueDate) &&
                    !cardItemData.checked
                  ) {
                    const assignedMembers = cardItemData.assignedMembers || [];
                    if (assignedMembers.length > 0) {
                      console.log(
                        `[KanbanPlugin] Task "${cardItemData.title}" in board "${boardFile.basename}" is due soon: ${dueDate.format('YYYY-MM-DD')}`
                      );
                      for (const memberName of assignedMembers) {
                        const memberConfig = this.settings.teamMemberColors?.[memberName];
                        if (memberConfig?.email) {
                          if (!tasksByEmail[memberConfig.email]) {
                            tasksByEmail[memberConfig.email] = [];
                          }
                          tasksByEmail[memberConfig.email].push({
                            title: cardItemData.title,
                            boardName: boardFile.basename,
                            boardPath: boardFile.path,
                            dueDate: dueDate.format('YYYY-MM-DD'),
                            tags: cardItemData.metadata?.tags || [],
                            priority: cardItemData.metadata?.priority,
                          });
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      } catch (e) {
        console.error(`[KanbanPlugin] Error processing board ${boardFile.path} for reminders:`, e);
      }
    }

    if (Object.keys(tasksByEmail).length > 0) {
      console.log('[KanbanPlugin] Tasks due soon found:', tasksByEmail);

      if (
        this.settings.enableAutomaticEmailSending &&
        this.settings.automaticEmailSenderAddress &&
        this.settings.automaticEmailAppPassword
      ) {
        console.log(
          '[KanbanPlugin] Automatic email sending is enabled. Attempting to send emails.'
        );
        const sender = this.settings.automaticEmailSenderAddress;
        const appPass = this.settings.automaticEmailAppPassword;
        const timeframeDays = this.settings.dueDateReminderTimeframeDays ?? 1;
        const timeframeText = timeframeDays === 1 ? 'day' : `${timeframeDays} days`;

        for (const emailAddress in tasksByEmail) {
          const userTasks = tasksByEmail[emailAddress];
          if (userTasks.length > 0) {
            // Sort tasks for this user
            userTasks.sort((a, b) => moment(a.dueDate).diff(moment(b.dueDate)));

            let emailBody = `You have the following tasks due in the next ${timeframeText}:\n\n`;
            userTasks.forEach((task) => {
              const dueDateMoment = moment(task.dueDate);
              const today = moment().startOf('day');
              const daysUntilDue = dueDateMoment.diff(today, 'days');
              let dueInText = '';
              if (daysUntilDue < 0) {
                dueInText = `overdue by ${Math.abs(daysUntilDue)} day(s)`;
              } else if (daysUntilDue === 0) {
                dueInText = 'today';
              } else if (daysUntilDue === 1) {
                dueInText = '1 day';
              } else {
                dueInText = `${daysUntilDue} days`;
              }

              const cleanTitle = task.title
                .replace(/@\{[^}]+\}/g, '')
                .replace(/!\[[^]]+\]/g, '')
                .replace(/!\w+/g, '')
                .replace(/@@\w+/g, '')
                .replace(/#\w+(\/\w+)*\s?/g, '')
                .replace(/\s{2,}/g, ' ')
                .trim();

              let priorityDisplay = '';
              if (task.priority) {
                priorityDisplay = `[${task.priority.charAt(0).toUpperCase() + task.priority.slice(1)}] `;
              }
              emailBody += `- ${cleanTitle} ${priorityDisplay}[${dueInText}]\n\n`;
            });
            emailBody += 'Regards,\nYour Kanban Plugin';

            const subject = 'Kanban Task Reminders - Due Soon';
            attemptSmtpEmailSend(sender, appPass, emailAddress, subject, emailBody)
              .then((success) => {
                if (success) {
                  console.log(`[KanbanPlugin] Email reminder sent successfully to ${emailAddress}`);
                  new Notification('Kanban Plugin', {
                    body: `${userTasks.length} Kanban task reminders sent to ${emailAddress}.`,
                    silent: true,
                  });
                } else {
                  console.warn(
                    `[KanbanPlugin] Failed to send email to ${emailAddress}. Check console for details.`
                  );
                  new Notification('Kanban Plugin', {
                    body: `Failed to send reminders to ${emailAddress}. Check console for details.`,
                    silent: false,
                  });
                }
              })
              .catch((error) => {
                console.error(`[KanbanPlugin] Error sending email to ${emailAddress}:`, error);
                new Notification('Kanban Plugin', {
                  body: `Error sending reminders to ${emailAddress}. Check console for details.`,
                  silent: false,
                });
              });
          }
        }
      } else {
        new Notification('Kanban Plugin', {
          body: `You have ${Object.values(tasksByEmail).reduce((sum, tasks) => sum + tasks.length, 0)} Kanban tasks due soon. Open settings to configure automatic sending or view details in modal.`,
          silent: true,
        });
        // Display in a modal (basic example if not auto-sending)
        const reminderModal = new ReminderModal(
          this.app,
          tasksByEmail,
          this.settings.dueDateReminderTimeframeDays ?? 1
        );
        reminderModal.open();
      }
    } else {
      console.log('[KanbanPlugin] No tasks due soon for members with emails configured.');
    }

    // Update the last run timestamp
    this.settings.dueDateReminderLastRun = now;
    await this.saveSettings();
    console.log('[KanbanPlugin] Due date reminders processing finished.');
  }
  // --- END ADDED METHOD for Due Date Reminders ---
}

// --- SMTP Email Sending Function ---
async function attemptSmtpEmailSend(
  senderAddress: string,
  appPassword: string,
  recipientEmail: string,
  subject: string,
  body: string
): Promise<boolean> {
  console.log('[KanbanPlugin] Attempting to send email via SMTP...');
  console.log(`To: ${recipientEmail}`);
  console.log(`Subject: ${subject}`);

  // STEP 1: (User Task) Install and set up Nodemailer or a similar SMTP library.
  // For example, if using Nodemailer, you would uncomment the following lines
  // after installing it (npm install nodemailer) and ensuring it's bundled with your plugin.

  const nodemailer = require('nodemailer'); // <<< USER ACTION REQUIRED (ensure library is installed and bundled)

  // STEP 2: (User Task) Configure the transporter using your SMTP library
  try {
    if (!nodemailer) {
      // Check if the library was loaded
      console.error(
        '[KanbanPlugin] Nodemailer library is not available. Email not sent. Please install and configure it.'
      );
      throw new Error('Nodemailer library not available.');
    }

    const transporter = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 465, // Use 465 for SSL
      secure: true, // true for 465, false for other ports like 587 (TLS)
      auth: {
        user: senderAddress, // Your Gmail address
        pass: appPassword, // Your Gmail App Password
      },
      tls: {
        // do not fail on invalid certs (useful for local testing, remove for production if not needed)
        // rejectUnauthorized: false
      },
    });

    // STEP 3: (User Task) Define email options and send
    const mailOptions = {
      from: senderAddress,
      to: recipientEmail,
      subject: subject,
      text: body, // Plain text body
      // html: "<b>Hello world?</b>", // HTML body version (if you switch to HTML)
    };

    const info = await transporter.sendMail(mailOptions);
    console.log('[KanbanPlugin] Email sent successfully via SMTP. Message ID:', info.messageId); // Changed log message
    return true; // Indicate success
  } catch (error) {
    console.error('[KanbanPlugin] Error sending email via SMTP:', error);
    // Consider more specific error messages based on the type of error
    // e.g., authentication failure, network issue, etc.
    // Re-throwing the error will allow the calling function to catch it and notify the user.
    throw error;
  }

  // Fallback for when Nodemailer is not implemented (This part should ideally not be reached if the above try block is active)
  /* 
  console.warn('[KanbanPlugin] ACTUAL EMAIL SENDING NOT IMPLEMENTED. ' +
               'The SmtpEmailSend function needs to be completed with a real SMTP library like Nodemailer.');
  console.log('--- SIMULATED EMAIL (NOT SENT) ---');
  console.log(`From: ${senderAddress}`);
  console.log(`To: ${recipientEmail}`);
  console.log(`Subject: ${subject}`);
  console.log('Body:\n', body);
  console.log('--- END SIMULATED EMAIL ---');
  return false; // Indicate failure as no email was actually sent
  */
}
// --- END SMTP Email Sending Function ---
