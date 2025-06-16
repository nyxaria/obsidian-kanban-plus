// Import the compiled stylesheet
import moment from 'moment';
import { around } from 'monkey-around';
import {
  MarkdownView,
  Notice,
  Platform,
  Plugin,
  TAbstractFile,
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
import { TIMELINE_ICON, TIMELINE_VIEW_TYPE, TimelineView } from './TimelineView';
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

  // Global tag colors CSS injection
  private globalTagColorsStyleEl: HTMLStyleElement | null = null;

  // Global tag symbols CSS injection
  private globalTagSymbolsStyleEl: HTMLStyleElement | null = null;

  // Event emitter for settings changes
  private settingsChangeListeners: Map<string, Array<(value: any) => void>> = new Map();

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

    // Update global tag colors when settings change
    this.updateGlobalTagColors();

    // Update global tag symbols when settings change
    this.updateGlobalTagSymbols();
  }

  private updateGlobalTagColors() {
    // Remove existing global styles
    this.removeGlobalTagColors();

    // Add new global styles if enabled
    if (this.settings['apply-tag-colors-globally'] && this.settings['tag-colors']) {
      this.injectGlobalTagColors();
    }
  }

  private injectGlobalTagColors() {
    if (!this.settings['tag-colors'] || this.settings['tag-colors'].length === 0) {
      return;
    }

    // Remove any existing global tag colors style element
    const existingStyle = document.head.querySelector('#kanban-global-tag-colors');
    if (existingStyle) {
      existingStyle.remove();
    }

    // Create CSS rules for each tag color
    const cssRules: string[] = [];

    this.settings['tag-colors'].forEach((tagColor) => {
      if (tagColor.tagKey && (tagColor.color || tagColor.backgroundColor)) {
        // Remove leading # from tagKey if present, then handle nested tags by escaping forward slashes
        const cleanTagKey = tagColor.tagKey.startsWith('#')
          ? tagColor.tagKey.slice(1)
          : tagColor.tagKey;
        const tagForSelector = cleanTagKey.replace(/\//g, '\\/');
        const tagForClass = cleanTagKey.replace(/\//g, '');

        // Create CSS rules for both reading mode and editing mode
        // Reading mode: a.tag elements
        const readingModeRule = `body a.tag[href="#${tagForSelector}"] {
          ${tagColor.color ? `color: ${tagColor.color} !important;` : ''}
          ${tagColor.backgroundColor ? `background-color: ${tagColor.backgroundColor} !important;` : ''}
        }`;

        // Editing mode: CodeMirror spans with tag classes
        const editingModeRule = `body .cm-s-obsidian .cm-line span.cm-tag-${tagForClass}.cm-hashtag {
          ${tagColor.color ? `color: ${tagColor.color} !important;` : ''}
          ${tagColor.backgroundColor ? `background-color: ${tagColor.backgroundColor} !important;` : ''}
        }`;

        cssRules.push(readingModeRule);
        cssRules.push(editingModeRule);
      }
    });

    if (cssRules.length > 0) {
      // Create and inject the style element with custom attribute for easy removal
      this.globalTagColorsStyleEl = document.createElement('style');
      this.globalTagColorsStyleEl.id = 'kanban-global-tag-colors';
      this.globalTagColorsStyleEl.setAttribute('kanban-global-tag-style', '');
      this.globalTagColorsStyleEl.textContent = cssRules.join('\n');
      document.head.appendChild(this.globalTagColorsStyleEl);
    }
  }

  private removeGlobalTagColors() {
    // Remove by element reference
    if (this.globalTagColorsStyleEl) {
      this.globalTagColorsStyleEl.remove();
      this.globalTagColorsStyleEl = null;
    }

    // Also remove by selector as a fallback
    const existingStyles = document.head.querySelectorAll('[kanban-global-tag-style]');
    existingStyles.forEach((style) => style.remove());
  }

  private updateGlobalTagSymbols() {
    // Remove existing global styles
    this.removeGlobalTagSymbols();

    // Add new global styles if enabled
    if (this.settings['apply-tag-symbols-globally'] && this.settings['tag-symbols']) {
      this.injectGlobalTagSymbols();
    }
  }

  private injectGlobalTagSymbols() {
    if (!this.settings['tag-symbols'] || this.settings['tag-symbols'].length === 0) {
      return;
    }

    // Remove any existing global tag symbols style element
    const existingStyle = document.head.querySelector('#kanban-global-tag-symbols');
    if (existingStyle) {
      existingStyle.remove();
    }

    // Create CSS rules for each tag symbol
    const cssRules: string[] = [];

    this.settings['tag-symbols'].forEach((tagSymbolSetting) => {
      if (tagSymbolSetting.data && tagSymbolSetting.data.tagKey && tagSymbolSetting.data.symbol) {
        const tagKey = tagSymbolSetting.data.tagKey;
        const symbol = tagSymbolSetting.data.symbol;
        const hideTag = tagSymbolSetting.data.hideTag;

        // Remove leading # from tagKey if present
        const cleanTagKey = tagKey.startsWith('#') ? tagKey.slice(1) : tagKey;
        const tagForSelector = cleanTagKey.replace(/\//g, '\\/');
        const tagForClass = cleanTagKey.replace(/\//g, '');

        // Create CSS rules for both reading mode and editing mode
        // Reading mode: a.tag elements - hide text but keep background styling
        const readingModeRule = `body a.tag[href="#${tagForSelector}"] {
          color: transparent !important;
          position: relative;
          padding-right: 15px;
        }
        body a.tag[href="#${tagForSelector}"]:before {
          content: "${symbol}${cleanTagKey}";
          color: var(--text-on-accent);
          position: absolute;
          left: 0;
          top: 0;
          width: 100%;
          height: 100%;
          display: flex;
          align-items: center;
          justify-content: center;
        }`;

        // Editing mode: CodeMirror spans with tag classes
        // Hide the # text but keep background, show symbol instead
        const editingModeRule = `body .cm-s-obsidian .cm-line span.cm-tag-${tagForClass}.cm-hashtag.cm-hashtag-begin {
          color: transparent !important;
          position: relative;
          padding-right: 7px;
        }
        body .cm-s-obsidian .cm-line span.cm-tag-${tagForClass}.cm-hashtag.cm-hashtag-begin:before {
          content: "${symbol}";
          color: var(--text-on-accent);
          position: absolute;
          left: 7px;
          top: 1px;
        }`;

        cssRules.push(readingModeRule);
        cssRules.push(editingModeRule);
      }
    });

    if (cssRules.length > 0) {
      // Create and inject the style element with custom attribute for easy removal
      this.globalTagSymbolsStyleEl = document.createElement('style');
      this.globalTagSymbolsStyleEl.id = 'kanban-global-tag-symbols';
      this.globalTagSymbolsStyleEl.setAttribute('kanban-global-tag-symbols-style', '');
      this.globalTagSymbolsStyleEl.textContent = cssRules.join('\n');
      document.head.appendChild(this.globalTagSymbolsStyleEl);
    }
  }

  private removeGlobalTagSymbols() {
    // Remove by element reference
    if (this.globalTagSymbolsStyleEl) {
      this.globalTagSymbolsStyleEl.remove();
      this.globalTagSymbolsStyleEl = null;
    }

    // Also remove by selector as a fallback
    const existingStyles = document.head.querySelectorAll('[kanban-global-tag-symbols-style]');
    existingStyles.forEach((style) => style.remove());
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

    // Clean up global tag colors
    this.removeGlobalTagColors();

    // Clean up global tag symbols
    this.removeGlobalTagSymbols();

    (this.app.workspace as any).unregisterHoverLinkSource(frontmatterKey);
  }

  MarkdownEditor: any;

  async onload() {
    await this.loadSettings();

    this.MarkdownEditor = getEditorClass(this.app);

    // Intercept URL actions directly by listening to the console or app events
    // Since we can see "Received URL action" in the logs, let's try to capture it
    this.app.workspace.onLayoutReady(() => {
      // Try to hook into the URL action processing after layout is ready
      const originalConsoleLog = console.log;
      console.log = (...args: any[]) => {
        // Check if this is the "Received URL action" log we see
        if (
          args.length >= 2 &&
          typeof args[0] === 'string' &&
          args[0].includes('Received URL action') &&
          typeof args[1] === 'object' &&
          args[1].hash
        ) {
          const action = args[1];
          console.log('[Kanban Main] Intercepted URL action from console:', action);

          if (action.hash && action.hash.includes('%5E')) {
            const hashMatch = action.hash.match(/%5E([a-zA-Z0-9]+)/);
            if (hashMatch && hashMatch[1]) {
              const blockId = hashMatch[1];
              console.log('[Kanban Main] Storing blockId from intercepted URL action:', blockId);
              // Store on the app for later retrieval
              (this.app as any)._kanbanPendingBlockId = blockId;
              // Clear it after a short delay to prevent stale data
              setTimeout(() => {
                delete (this.app as any)._kanbanPendingBlockId;
              }, 5000);
            }
          }
        }

        // Call the original console.log
        return originalConsoleLog.apply(console, args);
      };

      // Restore original console.log when plugin unloads
      this.register(() => {
        console.log = originalConsoleLog;
      });
    });

    this.registerEditorSuggest(new TimeSuggest(this.app, this));
    this.registerEditorSuggest(new DateSuggest(this.app, this));

    // Register global CodeMirror extension for kanban code blocks in edit mode
    this.registerEditorExtension([this.createGlobalKanbanCodeBlockExtension()]);

    // Register global CodeMirror extension for kanban card embeds in edit mode
    this.registerEditorExtension([this.createKanbanCardEmbedExtension()]);

    // Register markdown post-processor for Kanban card embeds
    this.registerMarkdownPostProcessor((element, context) => {
      this.processKanbanCardEmbeds(element, context);
    });

    // Register markdown post-processor for ```kanban``` code blocks
    this.registerMarkdownPostProcessor((element, context) => {
      this.processKanbanCodeBlocks(element, context);
    });

    // Hook into URL handling by monkey patching the app's openWithDefaultApp method
    this.register(
      around(this.app as any, {
        openWithDefaultApp(next: any) {
          return function (path: string) {
            console.log('[Kanban Main] openWithDefaultApp called with path:', path);
            // Check if this is an obsidian:// URL with a hash
            if (path && path.includes('#%5E')) {
              const hashMatch = path.match(/#%5E([a-zA-Z0-9]+)/);
              if (hashMatch && hashMatch[1]) {
                const blockId = hashMatch[1];
                console.log('[Kanban Main] Storing blockId from URL path:', blockId);
                // Store on the app for later retrieval
                (this.app as any)._kanbanPendingBlockId = blockId;
                // Clear it after a short delay to prevent stale data
                setTimeout(() => {
                  delete (this.app as any)._kanbanPendingBlockId;
                }, 5000);
              }
            }
            return next.call(this, path);
          };
        },
      })
    );

    // Also hook into the URL action handler that processes obsidian:// URLs
    // Try multiple possible method names for URL handling
    const urlHandlerMethods = ['handleUrlAction', 'handleOpenUrl', 'openUrl', 'processUrl'];

    urlHandlerMethods.forEach((methodName) => {
      if (typeof (this.app as any)[methodName] === 'function') {
        console.log(`[Kanban Main] Found URL handler method: ${methodName}`);
        this.register(
          around(this.app as any, {
            [methodName](next: any) {
              return function (action: any) {
                console.log(`[Kanban Main] ${methodName} called with action:`, action);
                // Check if this action has a hash with blockId
                if (action && action.hash && action.hash.includes('%5E')) {
                  const hashMatch = action.hash.match(/%5E([a-zA-Z0-9]+)/);
                  if (hashMatch && hashMatch[1]) {
                    const blockId = hashMatch[1];
                    console.log(`[Kanban Main] Storing blockId from ${methodName} hash:`, blockId);
                    // Store on the app for later retrieval
                    (this.app as any)._kanbanPendingBlockId = blockId;
                    // Clear it after a short delay to prevent stale data
                    setTimeout(() => {
                      delete (this.app as any)._kanbanPendingBlockId;
                    }, 5000);
                  }
                }
                return next.call(this, action);
              };
            },
          })
        );
      }
    });

    // Also try to hook into workspace methods that might handle URL actions
    this.register(
      around(this.app.workspace as any, {
        openLinkText(next: any) {
          return function (
            linktext: string,
            sourcePath: string,
            newLeaf?: boolean,
            openViewState?: any
          ) {
            console.log('[Kanban Main] openLinkText called with:', {
              linktext,
              sourcePath,
              newLeaf,
              openViewState,
            });

            // Check if linktext contains a blockId hash
            if (linktext && linktext.includes('#^')) {
              const hashMatch = linktext.match(/#\^([a-zA-Z0-9]+)/);
              if (hashMatch && hashMatch[1]) {
                const blockId = hashMatch[1];
                console.log('[Kanban Main] Storing blockId from openLinkText:', blockId);
                // Store on the app for later retrieval
                (this.app as any)._kanbanPendingBlockId = blockId;
                // Clear it after a short delay to prevent stale data
                setTimeout(() => {
                  delete (this.app as any)._kanbanPendingBlockId;
                }, 5000);
              }
            }

            return next.call(this, linktext, sourcePath, newLeaf, openViewState);
          };
        },
      })
    );

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

        // Trigger re-render of embedded components when lane color setting changes
        this.triggerSettingChange(
          'use-kanban-board-background-colors',
          newSettings['use-kanban-board-background-colors']
        );
      },
    });

    this.addSettingTab(this.settingsTab);

    this.registerView(kanbanViewType, (leaf) => new KanbanView(leaf, this));
    this.registerView(KANBAN_WORKSPACE_VIEW_TYPE, (leaf) => new KanbanWorkspaceView(leaf, this));
    this.registerView(TIMELINE_VIEW_TYPE, (leaf) => new TimelineView(leaf, this));
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

    this.addRibbonIcon(TIMELINE_ICON, 'Open Timeline View', () => {
      this.app.workspace.getLeaf(true).setViewState({
        type: TIMELINE_VIEW_TYPE,
        active: true,
      });
    });

    // Call processDueDateReminders on load
    this.app.workspace.onLayoutReady(async () => {
      // Wait for layout to be ready to ensure settings are loaded and workspace is available
      await this.processDueDateReminders();

      // Initialize global tag colors after layout is ready
      this.updateGlobalTagColors();

      // Initialize global tag symbols after layout is ready
      this.updateGlobalTagSymbols();
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
    // Register editor-menu event for right-click context menu in editor
    this.registerEvent(
      this.app.workspace.on('editor-menu', (menu, editor, view) => {
        // Only add the menu item for markdown views that are NOT kanban boards
        if (view instanceof MarkdownView && view.file && !hasFrontmatterKey(view.file)) {
          console.log('[Kanban Plugin] Adding Insert linked kanbans to editor context menu');
          menu.addItem((item) => {
            item
              .setTitle('Insert linked kanbans')
              .setIcon('lucide-kanban-square')
              .onClick(() => {
                console.log('[Kanban Plugin] Insert linked kanbans clicked from editor menu');
                // Check if the feature is enabled
                if (this.settings['enable-kanban-code-blocks'] === false) {
                  new Notice('Kanban code blocks are disabled in settings');
                  return;
                }

                // Insert the kanban code block at cursor position
                const cursor = editor.getCursor();
                const kanbanCodeBlock = '```kanban\n```\n';

                editor.replaceRange(kanbanCodeBlock, cursor);

                // Position cursor between the code blocks for potential content
                editor.setCursor(cursor.line + 1, 0);
              });
          });
        }
      })
    );

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
      this.app.vault.on('rename', (file: TAbstractFile, oldPath: string) => {
        // Handle KanbanView leaves
        const kanbanLeaves = this.app.workspace.getLeavesOfType(kanbanViewType);
        kanbanLeaves.forEach((leaf: WorkspaceLeaf) => {
          const view = leaf.view as KanbanView;
          if (view && typeof view.handleRename === 'function') {
            view.handleRename(file, oldPath);
          }
        });

        // Handle KanbanWorkspaceView leaves
        const workspaceLeaves = this.app.workspace.getLeavesOfType(KANBAN_WORKSPACE_VIEW_TYPE);
        workspaceLeaves.forEach((leaf: WorkspaceLeaf) => {
          const view = leaf.view as KanbanWorkspaceView;
          if (view && typeof view.handleRename === 'function') {
            view.handleRename(file, oldPath);
          }
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
      name: 'Open workspace view',
      callback: () => {
        this.app.workspace.getLeaf(true).setViewState({
          type: KANBAN_WORKSPACE_VIEW_TYPE,
          active: true,
        });
      },
    });

    this.addCommand({
      id: 'open-timeline-view',
      name: 'Open timeline view',
      callback: () => {
        this.app.workspace.getLeaf(true).setViewState({
          type: TIMELINE_VIEW_TYPE,
          active: true,
        });
      },
    });

    this.addCommand({
      id: 'insert-linked-kanbans',
      name: 'Insert linked kanbans',
      editorCallback: (editor, view) => {
        // Check if the feature is enabled
        if (this.settings['enable-kanban-code-blocks'] === false) {
          new Notice('Kanban code blocks are disabled in settings');
          return;
        }

        // Insert the kanban code block at cursor position
        const cursor = editor.getCursor();
        const kanbanCodeBlock = '```kanban\n```';

        editor.replaceRange(kanbanCodeBlock, cursor);

        // Position cursor between the code blocks for potential content
        editor.setCursor(cursor.line + 1, 0);

        new Notice('Linked kanban code block inserted');
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
            console.log(
              '[Kanban Main] setViewState MONKEYPATCH ENTRY. Incoming ViewState (JSON):',
              JSON.stringify(viewState, null, 2),
              'Incoming navState:',
              JSON.stringify(navState, null, 2)
            );

            let eStateForHighlighting: any = null;

            // Check for blockId from URL hash first
            const windowHash = window.location.hash;
            console.log('[Kanban Main] setViewState: Window location hash:', windowHash);
            if (windowHash && windowHash.startsWith('#^')) {
              const blockId = windowHash.substring(2); // Remove #^
              eStateForHighlighting = { blockId };
              console.log(
                '[Kanban Main] setViewState: Determined eState from window.location.hash (blockId):',
                eStateForHighlighting
              );
            }

            // Check for pending blockId stored from URL action
            if (!eStateForHighlighting && (self.app as any)._kanbanPendingBlockId) {
              const blockId = (self.app as any)._kanbanPendingBlockId;
              eStateForHighlighting = { blockId };
              console.log(
                '[Kanban Main] setViewState: Determined eState from pending blockId:',
                eStateForHighlighting
              );
              // Clear the pending blockId since we've used it
              delete (self.app as any)._kanbanPendingBlockId;
            }

            // If no hash found, check existing eState sources
            if (!eStateForHighlighting) {
              if (viewState.state?.eState) {
                eStateForHighlighting = viewState.state.eState;
                console.log(
                  '[Kanban Main] setViewState: Found eState directly in viewState.state.eState:',
                  JSON.stringify(eStateForHighlighting, null, 2)
                );
              } else if ((viewState as any).eState) {
                eStateForHighlighting = (viewState as any).eState;
                console.log(
                  '[Kanban Main] setViewState: Found eState at viewState.eState (top-level):',
                  JSON.stringify(eStateForHighlighting, null, 2)
                );
              } else if (navState) {
                eStateForHighlighting = navState;
                console.log(
                  '[Kanban Main] setViewState: Using eState from explicit navState argument:',
                  JSON.stringify(eStateForHighlighting, null, 2)
                );
              }
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

  // --- BEGIN HELPER METHOD for Converting Wikilinks to Obsidian URLs ---
  convertWikilinksToObsidianUrls(text: string): string {
    if (!text) return text;

    // Get the vault name for the obsidian:// URL
    const vaultName = this.app.vault.getName();

    let result = text;

    // Replace external markdown links [text](url) first
    result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (match, linkText, url) => {
      return `${linkText} (${url})`;
    });

    // Replace wikilinks with Obsidian URLs
    // Pattern matches: [[filename]] or [[path/filename]] or [[filename|display text]]
    result = result.replace(
      /\[\[([^\]|]+)(\|([^\]]+))?\]\]/g,
      (match, filePath, pipe, displayText) => {
        // Use display text if provided, otherwise use the filename
        const linkText = displayText || filePath.split('/').pop() || filePath;

        // Encode the file path for URL
        const encodedPath = encodeURIComponent(filePath);

        // Create the obsidian:// URL
        const obsidianUrl = `obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodedPath}`;

        // Return as a clickable link (for plain text emails, this will show as a URL)
        return `${linkText} (${obsidianUrl})`;
      }
    );

    // Convert markdown lists to plain text format
    result = this.convertMarkdownListsToText(result);

    return result;
  }

  convertMarkdownListsToText(text: string): string {
    if (!text) return text;

    // Split by lines to process each line
    const lines = text.split('\n');
    const processedLines: string[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmedLine = line.trim();

      // Check for task list items (- [ ], - [x])
      const taskMatch = trimmedLine.match(/^-\s+\[([ x])\]\s+(.*)$/);
      // Check for unordered list items (-, *, +)
      const unorderedMatch = trimmedLine.match(/^[-*+]\s+(.*)$/);
      // Check for ordered list items (1., 2., etc.)
      const orderedMatch = trimmedLine.match(/^\d+\.\s+(.*)$/);

      if (taskMatch) {
        // Task list item - preserve the checkbox format
        const isChecked = taskMatch[1] === 'x';
        const content = taskMatch[2];
        const checkbox = isChecked ? '[x]' : '[ ]';
        processedLines.push(`  • ${checkbox} ${content}`);
      } else if (unorderedMatch) {
        // Regular unordered list item
        processedLines.push(`  • ${unorderedMatch[1]}`);
      } else if (orderedMatch) {
        // Ordered list item
        processedLines.push(`  ${trimmedLine}`);
      } else {
        // Not a list item - preserve as is
        processedLines.push(line);
      }
    }

    return processedLines.join('\n');
  }

  convertWikilinksToHtmlLinks(text: string): string {
    if (!text) return text;

    // Get the vault name for the obsidian:// URL
    const vaultName = this.app.vault.getName();

    let result = text;

    // Replace external markdown links [text](url) with HTML anchor tags first
    result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (match, linkText, url) => {
      // Escape HTML characters in link text
      const escapedLinkText = linkText
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
      return `<a href="${url}" target="_blank">${escapedLinkText}</a>`;
    });

    // Replace wikilinks with HTML anchor tags
    // Pattern matches: [[filename]] or [[path/filename]] or [[filename|display text]]
    result = result.replace(
      /\[\[([^\]|]+)(\|([^\]]+))?\]\]/g,
      (match, filePath, pipe, displayText) => {
        // Use display text if provided, otherwise use the filename
        const linkText = displayText || filePath.split('/').pop() || filePath;

        // Escape HTML characters in link text
        const escapedLinkText = linkText
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;');

        // Encode the file path for URL
        const encodedPath = encodeURIComponent(filePath);

        // Create the obsidian:// URL
        const obsidianUrl = `obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodedPath}`;

        // Return as an HTML anchor tag
        return `<a href="${obsidianUrl}">${escapedLinkText}</a>`;
      }
    );

    // Convert markdown lists to HTML
    result = this.convertMarkdownListsToHtml(result);

    return result;
  }

  convertMarkdownListsToHtml(text: string): string {
    if (!text) return text;

    // Split by lines to process each line
    const lines = text.split('\n');
    const processedLines: string[] = [];
    let inList = false;
    let listType: 'ul' | 'ol' | null = null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmedLine = line.trim();

      // Check for unordered list items (-, *, +)
      const unorderedMatch = trimmedLine.match(/^[-*+]\s+(.*)$/);
      // Check for task list items (- [ ], - [x])
      const taskMatch = trimmedLine.match(/^-\s+\[([ x])\]\s+(.*)$/);
      // Check for ordered list items (1., 2., etc.)
      const orderedMatch = trimmedLine.match(/^\d+\.\s+(.*)$/);

      if (taskMatch) {
        // Task list item
        if (!inList || listType !== 'ul') {
          if (inList) processedLines.push('</ul>');
          processedLines.push('<ul>');
          inList = true;
          listType = 'ul';
        }
        const isChecked = taskMatch[1] === 'x';
        const content = taskMatch[2];
        const checkbox = isChecked
          ? '<input type="checkbox" checked disabled style="margin-right: 8px;">'
          : '<input type="checkbox" disabled style="margin-right: 8px;">';
        processedLines.push(`<li>${checkbox}${content}</li>`);
      } else if (unorderedMatch) {
        // Regular unordered list item
        if (!inList || listType !== 'ul') {
          if (inList) processedLines.push(listType === 'ul' ? '</ul>' : '</ol>');
          processedLines.push('<ul>');
          inList = true;
          listType = 'ul';
        }
        processedLines.push(`<li>${unorderedMatch[1]}</li>`);
      } else if (orderedMatch) {
        // Ordered list item
        if (!inList || listType !== 'ol') {
          if (inList) processedLines.push(listType === 'ul' ? '</ul>' : '</ol>');
          processedLines.push('<ol>');
          inList = true;
          listType = 'ol';
        }
        processedLines.push(`<li>${orderedMatch[1]}</li>`);
      } else {
        // Not a list item
        if (inList) {
          processedLines.push(listType === 'ul' ? '</ul>' : '</ol>');
          inList = false;
          listType = null;
        }
        // Convert newlines to <br> for non-list content, but only if the line isn't empty
        if (trimmedLine === '') {
          processedLines.push('<br>');
        } else {
          processedLines.push(line);
        }
      }
    }

    // Close any open list
    if (inList) {
      processedLines.push(listType === 'ul' ? '</ul>' : '</ol>');
    }

    return processedLines.join('');
  }

  createBoardLink(boardName: string, boardPath: string, isHtml: boolean): string {
    // Get the vault name for the obsidian:// URL
    const vaultName = this.app.vault.getName();

    // Encode the file path for URL
    const encodedPath = encodeURIComponent(boardPath);

    // Create the obsidian:// URL
    const obsidianUrl = `obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodedPath}`;

    if (isHtml) {
      // Escape HTML characters in board name
      const escapedBoardName = boardName
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
      return `<a href="${obsidianUrl}">${escapedBoardName}</a>`;
    } else {
      // Text version
      return `${boardName} (${obsidianUrl})`;
    }
  }

  createDirectCardLink(
    cardTitle: string,
    boardName: string,
    boardPath: string,
    blockId: string | undefined,
    isHtml: boolean
  ): string {
    // Get the vault name for the obsidian:// URL
    const vaultName = this.app.vault.getName();

    // Encode the file path for URL
    const encodedPath = encodeURIComponent(boardPath);

    let obsidianUrl: string;
    if (blockId) {
      // Create URL with blockId for direct card navigation and highlighting
      obsidianUrl = `obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodedPath}#^${blockId}`;
    } else {
      // Fallback to board URL if no blockId available
      obsidianUrl = `obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodedPath}`;
    }

    if (isHtml) {
      // Escape HTML characters in card title
      const escapedCardTitle = cardTitle
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
      return `<a href="${obsidianUrl}">${escapedCardTitle}</a>`;
    } else {
      // Text version
      return `${cardTitle} (${obsidianUrl})`;
    }
  }

  createDirectCardLinkIcon(
    boardName: string,
    boardPath: string,
    blockId: string | undefined,
    isHtml: boolean
  ): string {
    // Get the vault name for the obsidian:// URL
    const vaultName = this.app.vault.getName();

    // Encode the file path for URL
    const encodedPath = encodeURIComponent(boardPath);

    let obsidianUrl: string;
    if (blockId) {
      // Create URL with blockId for direct card navigation and highlighting
      obsidianUrl = `obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodedPath}#^${blockId}`;
    } else {
      // Fallback to board URL if no blockId available
      obsidianUrl = `obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodedPath}`;
    }

    if (isHtml) {
      // HTML version with chain link icon
      return `<a href="${obsidianUrl}" title="Open card in Obsidian" style="text-decoration: none; margin-right: 8px;">🔗</a>`;
    } else {
      // Text version with simple link indicator
      return `🔗 `;
    }
  }

  cleanTitleForEmail(titleRaw: string): string {
    if (!titleRaw) return '';

    let cleanTitle = titleRaw;

    // Remove date triggers (like @{date}, @start{date}, etc.)
    cleanTitle = cleanTitle.replace(/@\w*\{[^}]+\}/g, '');
    cleanTitle = cleanTitle.replace(/@\w*\[\[[^\]]+\]\]/g, '');

    // Remove priority tags
    cleanTitle = cleanTitle.replace(/!\w+/g, '');

    // Remove member assignments
    cleanTitle = cleanTitle.replace(/@@\w+/g, '');

    // Remove tags
    cleanTitle = cleanTitle.replace(/#\w+(\/\w+)*\s?/g, '');

    // Clean up multiple spaces but preserve newlines (only collapse spaces/tabs)
    cleanTitle = cleanTitle.replace(/[ \t]{2,}/g, ' ').trim();

    return cleanTitle;
  }
  // --- END HELPER METHOD for Converting Wikilinks to Obsidian URLs ---

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
        laneName: string;
        blockId?: string; // Add blockId for direct card linking
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
                            title: cardItemData.titleRaw || cardItemData.title,
                            boardName: boardFile.basename,
                            boardPath: boardFile.path,
                            dueDate: dueDate.format('YYYY-MM-DD'),
                            tags: cardItemData.metadata?.tags || [],
                            priority: cardItemData.metadata?.priority,
                            laneName: lane.data.title,
                            blockId: cardItemData.blockId, // Add blockId for direct card linking
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
        let timeframeText = '';
        if (timeframeDays % 7 === 0) {
          const weeks = timeframeDays / 7;
          timeframeText = weeks === 1 ? 'week' : `${weeks} weeks`;
        } else {
          timeframeText = timeframeDays === 1 ? 'day' : `${timeframeDays} days`;
        }

        for (const emailAddress in tasksByEmail) {
          const userTasks = tasksByEmail[emailAddress];
          if (userTasks.length > 0) {
            // Sort tasks for this user
            userTasks.sort((a, b) => moment(a.dueDate).diff(moment(b.dueDate)));

            let emailBodyText = `You have the following tasks due in the next ${timeframeText}:\n\n`;
            let emailBodyHtml = `<p>You have the following tasks due in the next ${timeframeText}:</p><ul>`;

            userTasks.forEach((task) => {
              const dueDateMoment = moment(task.dueDate);
              const today = moment().startOf('day');
              const daysUntilDue = dueDateMoment.diff(today, 'days');
              let dueInText = '';
              if (daysUntilDue < 0) {
                const overdueDays = Math.abs(daysUntilDue);
                dueInText = `overdue by ${overdueDays} day${overdueDays === 1 ? '' : 's'}`;
              } else if (daysUntilDue === 0) {
                dueInText = 'today';
              } else if (daysUntilDue === 1) {
                dueInText = '1 day';
              } else {
                dueInText = `${daysUntilDue} days`;
              }

              // Clean the title while preserving newlines and list structure
              const cleanTitle = this.cleanTitleForEmail(task.title);

              // Create direct card link icons (with highlighting if blockId available)
              const cardLinkIconText = this.createDirectCardLinkIcon(
                task.boardName,
                task.boardPath,
                task.blockId,
                false
              );
              const cardLinkIconHtml = this.createDirectCardLinkIcon(
                task.boardName,
                task.boardPath,
                task.blockId,
                true
              );

              // Create board links for context
              const boardLinkText = this.createBoardLink(task.boardName, task.boardPath, false);
              const boardLinkHtml = this.createBoardLink(task.boardName, task.boardPath, true);

              let priorityDisplay = '';
              if (task.priority) {
                priorityDisplay = `[${task.priority.charAt(0).toUpperCase() + task.priority.slice(1)}] `;
              }

              // Process the clean title for wikilinks
              const titleWithObsidianLinksText = this.convertWikilinksToObsidianUrls(cleanTitle);
              const titleWithObsidianLinksHtml = this.convertWikilinksToHtmlLinks(cleanTitle);

              // Text version
              emailBodyText += `- ${cardLinkIconText}${titleWithObsidianLinksText} @ ${boardLinkText}:${task.laneName} ${priorityDisplay}[${dueInText}]\n\n`;

              // HTML version
              emailBodyHtml += `<li>${cardLinkIconHtml}${titleWithObsidianLinksHtml} @ <strong>${boardLinkHtml}:${task.laneName}</strong> ${priorityDisplay}<em>[${dueInText}]</em></li>`;
            });

            emailBodyText += 'Regards,\nYour Kanban Plugin';
            emailBodyHtml += '</ul><p>Regards,<br>Your Kanban Plugin</p>';

            const subject = 'Kanban Task Reminders - Due Soon';
            attemptSmtpEmailSend(
              sender,
              appPass,
              emailAddress,
              subject,
              emailBodyText,
              emailBodyHtml
            )
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

  // --- BEGIN Kanban Card Embed Post-Processor ---
  processKanbanCardEmbeds(element: HTMLElement, context: any) {
    // Check if the feature is enabled
    if (this.settings['enable-kanban-card-embeds'] === false) {
      return;
    }

    // Find all internal links with block references
    const internalLinks = element.querySelectorAll('a.internal-link');

    for (const linkEl of Array.from(internalLinks)) {
      const href = linkEl.getAttribute('href') || linkEl.getAttribute('data-href');
      if (!href || !href.includes('#^')) continue;

      // Extract file path and block ID
      const [filePath, blockRef] = href.split('#');
      if (!blockRef || !blockRef.startsWith('^')) continue;

      const blockId = blockRef.substring(1); // Remove ^

      // Check if the target file is a Kanban board
      const file = this.app.metadataCache.getFirstLinkpathDest(filePath, context.sourcePath);
      if (!file || !hasFrontmatterKey(file)) continue;

      // Create the card embed
      this.createCardEmbed(linkEl as HTMLElement, file.path, blockId, context.sourcePath);
    }
  }

  createCardEmbed(linkEl: HTMLElement, filePath: string, blockId: string, sourcePath: string) {
    // Import the necessary components
    const { createElement } = require('preact');
    const { render } = require('preact/compat');

    // Dynamically import the SimpleKanbanCardEmbed component
    import('./components/SimpleKanbanCardEmbed')
      .then(({ SimpleKanbanCardEmbed }) => {
        // Create a container for the embed
        const embedContainer = document.createElement('div');
        // Make the container inline-block so multiple cards can appear side by side
        embedContainer.style.display = 'inline-block';
        embedContainer.style.verticalAlign = 'top';
        // Add small horizontal margin to ensure spacing when adjacent
        embedContainer.style.marginRight = '4px';

        // Render the SimpleKanbanCardEmbed component
        render(
          createElement(SimpleKanbanCardEmbed, {
            filePath,
            blockId,
            plugin: this,
            sourcePath,
            displayText: linkEl.textContent || linkEl.getAttribute('aria-label') || '',
          }),
          embedContainer
        );

        // Replace the link with the embed
        linkEl.parentNode?.replaceChild(embedContainer, linkEl);
      })
      .catch((error) => {
        console.error('[KanbanPlugin] Failed to load SimpleKanbanCardEmbed component:', error);
      });
  }
  // --- END Kanban Card Embed Post-Processor ---

  // --- BEGIN Kanban Code Block Post-Processor ---
  processKanbanCodeBlocks(element: HTMLElement, context: any) {
    // Check if the feature is enabled
    if (this.settings['enable-kanban-code-blocks'] === false) {
      return;
    }

    // Find all code blocks with language "kanban"
    const codeBlocks = element.querySelectorAll('pre > code.language-kanban');

    for (const codeEl of Array.from(codeBlocks)) {
      const preEl = codeEl.parentElement;
      if (!preEl || preEl.tagName !== 'PRE') continue;

      // Create the linked cards display
      this.createLinkedCardsDisplay(preEl, context.sourcePath);
    }
  }

  createLinkedCardsDisplay(preEl: HTMLElement, sourcePath: string) {
    // Import the necessary components
    const { createElement } = require('preact');
    const { render } = require('preact/compat');

    // Dynamically import the LinkedCardsDisplay component
    import('./components/LinkedCardsDisplay')
      .then(({ LinkedCardsDisplay }) => {
        // Create a container for the linked cards display
        const linkedCardsContainer = document.createElement('div');
        linkedCardsContainer.className = 'kanban-plugin__linked-cards-code-block-container';

        // Render the LinkedCardsDisplay component
        render(
          createElement(LinkedCardsDisplay, {
            plugin: this,
            currentFilePath: sourcePath,
          }),
          linkedCardsContainer
        );

        // Replace the code block with the linked cards display
        preEl.parentNode?.replaceChild(linkedCardsContainer, preEl);
      })
      .catch((error) => {
        console.error('[KanbanPlugin] Failed to load LinkedCardsDisplay component:', error);

        // Show error message in place of code block
        const errorContainer = document.createElement('div');
        errorContainer.className = 'kanban-plugin__linked-cards-error';
        errorContainer.innerHTML =
          '⚠️ Error loading linked Kanban cards. Check console for details.';
        preEl.parentNode?.replaceChild(errorContainer, preEl);
      });
  }
  // --- END Kanban Code Block Post-Processor ---

  // --- BEGIN Global Kanban Code Block Extension ---
  createGlobalKanbanCodeBlockExtension() {
    // Import necessary modules
    const { Extension, StateField } = require('@codemirror/state');
    const { ViewPlugin, WidgetType, Decoration, DecorationSet } = require('@codemirror/view');
    const { createElement } = require('preact');
    const { render, unmountComponentAtNode } = require('preact/compat');

    // Define state field for plugin instance
    const pluginStateField = StateField.define({
      create: () => this,
      update: (value: any) => value,
    });

    // Widget for rendering LinkedCardsDisplay
    class GlobalKanbanCodeBlockWidget extends WidgetType {
      constructor(plugin: any, currentFilePath: any) {
        super();
        this.plugin = plugin;
        this.currentFilePath = currentFilePath;
        this.container = null;
      }

      eq(widget: any) {
        return this.plugin === widget.plugin && this.currentFilePath === widget.currentFilePath;
      }

      toDOM() {
        this.container = document.createElement('div');
        this.container.className = 'kanban-plugin__linked-cards-global-edit-mode-container';

        // Check if the feature is enabled
        if (this.plugin.settings['enable-kanban-code-blocks'] === false) {
          this.container.innerHTML =
            '<div class="kanban-plugin__linked-cards-disabled">Kanban code blocks are disabled in settings</div>';
          return this.container;
        }

        // Dynamically import and render the LinkedCardsDisplay component
        import('./components/LinkedCardsDisplay')
          .then(({ LinkedCardsDisplay }) => {
            if (this.container) {
              render(
                createElement(LinkedCardsDisplay, {
                  plugin: this.plugin,
                  currentFilePath: this.currentFilePath,
                }),
                this.container
              );
            }
          })
          .catch((error) => {
            console.error(
              '[KanbanPlugin] Failed to load LinkedCardsDisplay in global edit mode:',
              error
            );
            if (this.container) {
              this.container.innerHTML =
                '<div class="kanban-plugin__linked-cards-error">⚠️ Error loading linked cards</div>';
            }
          });

        return this.container;
      }

      destroy() {
        if (this.container) {
          unmountComponentAtNode(this.container);
          this.container = null;
        }
      }

      ignoreEvent(event: Event) {
        // Ignore mouse events within the widget to prevent cursor position changes
        // that would switch back to raw markdown mode
        if (
          event.type === 'mousedown' ||
          event.type === 'click' ||
          event.type === 'mouseup' ||
          event.type === 'mouseover' ||
          event.type === 'mouseout' ||
          event.type === 'mousemove'
        ) {
          return true;
        }
        // Allow other events (like keyboard events) to pass through
        return false;
      }
    }

    // Plugin that handles the code block detection and replacement
    const globalKanbanCodeBlockPlugin = ViewPlugin.define(
      (view: any) => {
        const pluginInstance = {
          decorations: this.buildGlobalKanbanDecorations(view),
          lastCursorInBlockState: new Map(), // Track which blocks had cursor last time
          update: (update: any) => {
            // Rebuild decorations when:
            // 1. Document changes and might affect kanban blocks
            // 2. Cursor moves between inside/outside kanban blocks
            // 3. Viewport changes
            let shouldRebuild = false;

            if (update.docChanged) {
              // Only rebuild for very specific kanban-related changes
              let changesAffectKanbanBlocks = false;

              update.changes.iterChanges(
                (fromA: number, toA: number, fromB: number, toB: number, inserted: any) => {
                  const insertedText = inserted.toString();
                  const deletedLength = toA - fromA;

                  // Only rebuild for these specific cases:
                  // 1. Text contains "```kanban" (complete kanban code block start)
                  // 2. Large deletions that might remove entire blocks
                  if (
                    insertedText.includes('```kanban') ||
                    deletedLength > 20 // Increased threshold for large deletions
                  ) {
                    console.log(
                      '[Kanban] Rebuild triggered by:',
                      insertedText.includes('```kanban')
                        ? '```kanban detected'
                        : `large deletion (${deletedLength} chars)`
                    );
                    changesAffectKanbanBlocks = true;
                    return;
                  }

                  // Only check for completing ```kanban if we're typing specific characters
                  if (insertedText === 'n' && deletedLength === 0) {
                    // Get context to see if we're completing ```kanban
                    const doc = update.view.state.doc;
                    const contextStart = Math.max(0, fromB - 10);
                    const contextEnd = Math.min(doc.length, toB);
                    const contextText = doc.sliceString(contextStart, contextEnd);

                    if (contextText.endsWith('```kanba') && insertedText === 'n') {
                      console.log('[Kanban] Rebuild triggered by: completing ```kanban');
                      changesAffectKanbanBlocks = true;
                      return;
                    }
                  }
                }
              );

              if (changesAffectKanbanBlocks) {
                shouldRebuild = true;
              }
            }

            // Smart selection change detection - rebuild if cursor moves between inside/outside kanban blocks OR selection state changes
            if (update.selectionSet && !update.docChanged) {
              const oldSelection = update.startState.selection.main;
              const newSelection = update.state.selection.main;

              // Check if cursor head position changed OR selection range changed
              const cursorChanged = oldSelection.head !== newSelection.head;
              const selectionChanged =
                oldSelection.from !== newSelection.from || oldSelection.to !== newSelection.to;

              if (cursorChanged || selectionChanged) {
                console.log(
                  '[Kanban] Selection changed - cursor:',
                  cursorChanged,
                  'selection:',
                  selectionChanged
                );

                // Check if the cursor or selection state changed for any kanban blocks
                const doc = update.view.state.doc;
                const cursorPos = newSelection.head;
                const editorHasFocus = update.view.hasFocus;

                // Calculate old and new selection ranges
                const oldSelectionFrom = Math.min(oldSelection.from, oldSelection.to);
                const oldSelectionTo = Math.max(oldSelection.from, oldSelection.to);
                const oldHasSelection = oldSelectionFrom !== oldSelectionTo;

                const newSelectionFrom = Math.min(newSelection.from, newSelection.to);
                const newSelectionTo = Math.max(newSelection.from, newSelection.to);
                const newHasSelection = newSelectionFrom !== newSelectionTo;

                // Find all kanban blocks and check if cursor or selection state changed for any of them
                for (let lineNum = 1; lineNum <= doc.lines; lineNum++) {
                  const line = doc.line(lineNum);
                  if (line.text.trim() === '```kanban') {
                    // Find the end of this code block
                    let endLineNum = lineNum + 1;
                    while (endLineNum <= doc.lines) {
                      const endLine = doc.line(endLineNum);
                      if (endLine.text.trim() === '```') {
                        break;
                      }
                      endLineNum++;
                    }

                    if (endLineNum <= doc.lines) {
                      const startLine = doc.line(lineNum);
                      const endLine = doc.line(endLineNum);
                      const blockStart = startLine.from;
                      const blockEnd = endLine.to;
                      const blockId = `${blockStart}-${blockEnd}`;

                      // Check cursor state
                      const cursorInBlock =
                        editorHasFocus && cursorPos >= blockStart && cursorPos <= blockEnd;

                      // Check selection overlap state
                      const oldSelectionOverlapsBlock =
                        oldHasSelection &&
                        ((oldSelectionFrom <= blockStart && oldSelectionTo >= blockEnd) ||
                          (oldSelectionFrom >= blockStart && oldSelectionFrom < blockEnd) ||
                          (oldSelectionTo > blockStart && oldSelectionTo <= blockEnd) ||
                          (blockStart >= oldSelectionFrom && blockEnd <= oldSelectionTo));

                      const newSelectionOverlapsBlock =
                        newHasSelection &&
                        ((newSelectionFrom <= blockStart && newSelectionTo >= blockEnd) ||
                          (newSelectionFrom >= blockStart && newSelectionFrom < blockEnd) ||
                          (newSelectionTo > blockStart && newSelectionTo <= blockEnd) ||
                          (blockStart >= newSelectionFrom && blockEnd <= newSelectionTo));

                      // Determine if the block should be hidden (cursor in block OR selection overlaps)
                      const oldBlockHidden = cursorInBlock || oldSelectionOverlapsBlock;
                      const newBlockHidden = cursorInBlock || newSelectionOverlapsBlock;

                      const lastState = pluginInstance.lastCursorInBlockState.get(blockId);

                      console.log(
                        '[Kanban] Block',
                        blockId,
                        '- hidden state:',
                        newBlockHidden,
                        'last state:',
                        lastState,
                        'cursor in block:',
                        cursorInBlock,
                        'selection overlaps:',
                        newSelectionOverlapsBlock
                      );

                      if (lastState !== newBlockHidden) {
                        console.log(
                          '[Kanban] Rebuild triggered by: block visibility state change for block',
                          blockId,
                          'from',
                          lastState,
                          'to',
                          newBlockHidden
                        );
                        pluginInstance.lastCursorInBlockState.set(blockId, newBlockHidden);
                        shouldRebuild = true;
                        break;
                      }
                    }

                    lineNum = endLineNum; // Skip past this block
                  }
                }
              }
            }

            // Note: Removed viewport change detection as it was triggering on every keystroke
            // Viewport changes will be handled by document changes and cursor movement instead

            if (shouldRebuild) {
              console.log('[Kanban] Rebuilding decorations');
              pluginInstance.decorations = this.buildGlobalKanbanDecorations(update.view);
            }
          },
        };
        return pluginInstance;
      },
      {
        decorations: (plugin: any) => plugin.decorations,
      }
    );

    return [pluginStateField, globalKanbanCodeBlockPlugin];
  }

  buildGlobalKanbanDecorations(view: any) {
    const { Decoration } = require('@codemirror/view');

    const decorations = [];
    const doc = view.state.doc;
    const selection = view.state.selection.main;
    const cursorPos = selection.head;

    // Check if the editor has focus - if not, cursor is elsewhere (title, metadata, etc.)
    const editorHasFocus = view.hasFocus;

    // Get current file path
    let currentFilePath = '';
    try {
      // Try to get the file path from the editor
      const activeFile = this.app.workspace.getActiveFile();
      if (activeFile) {
        currentFilePath = activeFile.path;
      }
    } catch (e) {
      console.warn('[KanbanPlugin] Could not determine current file path:', e);
    }

    // Look for ```kanban blocks line by line to avoid line break issues
    for (let lineNum = 1; lineNum <= doc.lines; lineNum++) {
      const line = doc.line(lineNum);
      const lineText = line.text;

      // Check if this line starts a kanban code block
      if (lineText.trim() === '```kanban') {
        // Find the end of the code block
        let endLineNum = lineNum + 1;
        let foundEnd = false;

        while (endLineNum <= doc.lines) {
          const endLine = doc.line(endLineNum);
          if (endLine.text.trim() === '```') {
            foundEnd = true;
            break;
          }
          endLineNum++;
        }

        if (foundEnd) {
          const startLine = doc.line(lineNum);
          const endLine = doc.line(endLineNum);
          const blockStart = startLine.from;
          const blockEnd = endLine.to;

          // Check if cursor is inside this kanban code block
          // Show rendered view if:
          // 1. Editor doesn't have focus (cursor is in title/metadata), OR
          // 2. Editor has focus but cursor is outside this code block
          const cursorInBlock = editorHasFocus && cursorPos >= blockStart && cursorPos <= blockEnd;

          // Check if there's a text selection that overlaps with this code block
          const selectionFrom = Math.min(selection.from, selection.to);
          const selectionTo = Math.max(selection.from, selection.to);
          const hasSelection = selectionFrom !== selectionTo;
          const selectionOverlapsBlock =
            hasSelection &&
            // Selection contains the entire block
            ((selectionFrom <= blockStart && selectionTo >= blockEnd) ||
              // Selection starts inside the block
              (selectionFrom >= blockStart && selectionFrom < blockEnd) ||
              // Selection ends inside the block
              (selectionTo > blockStart && selectionTo <= blockEnd) ||
              // Block is completely inside the selection
              (blockStart >= selectionFrom && blockEnd <= selectionTo));

          if (!cursorInBlock && !selectionOverlapsBlock) {
            // Cursor is not in this block, show the widget and hide content

            // Add a widget decoration after the opening ``` line
            const insertPos = line.to;
            const pluginInstance = this; // Capture the KanbanPlugin instance
            decorations.push(
              Decoration.widget({
                widget: new (class extends require('@codemirror/view').WidgetType {
                  constructor() {
                    super();
                    this.plugin = pluginInstance; // Use the actual KanbanPlugin instance
                    this.currentFilePath = currentFilePath;
                    this.container = null;
                  }

                  eq(widget: any) {
                    return this.currentFilePath === widget.currentFilePath;
                  }

                  toDOM() {
                    this.container = document.createElement('div');
                    this.container.className =
                      'kanban-plugin__linked-cards-global-edit-mode-container';

                    // Check if the feature is enabled
                    if (
                      this.plugin.settings &&
                      this.plugin.settings['enable-kanban-code-blocks'] === false
                    ) {
                      this.container.innerHTML =
                        '<div class="kanban-plugin__linked-cards-disabled">Kanban code blocks are disabled in settings</div>';
                      return this.container;
                    }

                    // Dynamically import and render the LinkedCardsDisplay component
                    import('./components/LinkedCardsDisplay')
                      .then(({ LinkedCardsDisplay }) => {
                        if (this.container) {
                          const { createElement } = require('preact');
                          const { render } = require('preact/compat');

                          render(
                            createElement(LinkedCardsDisplay, {
                              plugin: this.plugin,
                              currentFilePath: this.currentFilePath,
                            }),
                            this.container
                          );
                        }
                      })
                      .catch((error) => {
                        console.error(
                          '[KanbanPlugin] Failed to load LinkedCardsDisplay in global edit mode:',
                          error
                        );
                        if (this.container) {
                          this.container.innerHTML =
                            '<div class="kanban-plugin__linked-cards-error">⚠️ Error loading linked cards</div>';
                        }
                      });

                    return this.container;
                  }

                  destroy() {
                    if (this.container) {
                      const { unmountComponentAtNode } = require('preact/compat');
                      unmountComponentAtNode(this.container);
                      this.container = null;
                    }
                  }

                  ignoreEvent(event: Event) {
                    const target = event.target as HTMLElement;

                    console.log('[Kanban Widget 1] ignoreEvent called:', {
                      eventType: event.type,
                      targetTag: target?.tagName,
                      targetClass: target?.className,
                      targetId: target?.id,
                      targetText: target?.textContent?.substring(0, 50),
                      isMouseEvent:
                        event.type.startsWith('mouse') ||
                        event.type === 'click' ||
                        event.type === 'dblclick',
                    });

                    // Handle events without a target or with non-element targets
                    if (!target || typeof target.closest !== 'function') {
                      // For events without a proper HTML element target, ignore selection-related events that could cause cursor movement
                      if (event.type === 'selectionchange') {
                        console.log(
                          '[Kanban Widget 1] Ignoring selectionchange event without proper target'
                        );
                        return true;
                      }
                      console.log(
                        '[Kanban Widget 1] Allowing event without proper target:',
                        event.type
                      );
                      return false;
                    }

                    // Always allow interactive elements to work, but exclude CodeMirror elements
                    const interactiveElement = target.closest(
                      'input, button, a, label, [role="button"], [tabindex]'
                    );
                    const isCodeMirrorElement = target.closest(
                      '.cm-editor, .cm-scroller, .cm-content'
                    );
                    const isInteractive = interactiveElement && !isCodeMirrorElement;

                    if (interactiveElement && isCodeMirrorElement) {
                      console.log(
                        '[Kanban Widget 1] Blocking CodeMirror element that would be interactive:',
                        interactiveElement.tagName,
                        interactiveElement.className
                      );
                    }

                    if (isInteractive) {
                      console.log(
                        '[Kanban Widget 1] Allowing interactive element:',
                        interactiveElement.tagName,
                        interactiveElement.className
                      );
                      return false; // Let CodeMirror process these events normally
                    }

                    // Check if this is a card click - but we need to prevent cursor movement
                    const isCardClick = target.closest('.kanban-plugin__linked-card-item');
                    if (isCardClick) {
                      console.log('[Kanban Widget 1] Card click detected:', isCardClick.className);
                      // For card clicks, we want to handle the click but prevent cursor movement
                      // So we allow the click event but block mouse/pointer events that cause cursor movement
                      if (event.type === 'click') {
                        console.log('[Kanban Widget 1] Allowing card click event');
                        return false; // Allow click to be processed
                      } else if (
                        event.type === 'mousedown' ||
                        event.type === 'pointerdown' ||
                        event.type === 'mouseup' ||
                        event.type === 'pointerup'
                      ) {
                        console.log(
                          '[Kanban Widget 1] Blocking card mouse/pointer event to prevent cursor movement:',
                          event.type
                        );
                        return true; // Block these to prevent cursor movement
                      }
                    }

                    // Ignore mouse events that would cause cursor movement
                    if (
                      event.type === 'mousedown' ||
                      event.type === 'click' ||
                      event.type === 'mouseup' ||
                      event.type === 'dblclick' ||
                      event.type === 'pointerdown' ||
                      event.type === 'pointerup' ||
                      event.type === 'mouseover' ||
                      event.type === 'mouseout' ||
                      event.type === 'mousemove'
                    ) {
                      console.log(
                        '[Kanban Widget 1] Ignoring mouse event to prevent cursor movement:',
                        event.type
                      );
                      return true; // Ignore these to prevent cursor movement
                    }

                    // Catch any other mouse/pointer events that might slip through
                    if (
                      event.type.startsWith('mouse') ||
                      event.type.startsWith('pointer') ||
                      event.type.includes('click')
                    ) {
                      console.log(
                        '[Kanban Widget 1] Ignoring unhandled mouse/pointer event:',
                        event.type
                      );
                      return true; // Ignore any mouse/pointer events we might have missed
                    }

                    console.log('[Kanban Widget 1] Allowing other event:', event.type);
                    // Allow other events (like keyboard events) to pass through
                    return false;
                  }
                })(),
                side: 1,
              }).range(insertPos)
            );

            // Also hide the content between the ``` markers
            for (let hideLineNum = lineNum + 1; hideLineNum < endLineNum; hideLineNum++) {
              const hideLine = doc.line(hideLineNum);
              if (hideLine.text.trim() !== '') {
                decorations.push(Decoration.replace({}).range(hideLine.from, hideLine.to));
              }
            }
          }
          // If cursor is in the block, don't add any decorations - show raw code

          // Skip past this code block
          lineNum = endLineNum;
        }
      }
    }

    const { Decoration: DecorationSet } = require('@codemirror/view');
    return Decoration.set(decorations);
  }
  // --- END Global Kanban Code Block Extension ---

  // --- BEGIN Kanban Card Embed Extension ---
  createKanbanCardEmbedExtension() {
    const { StateField } = require('@codemirror/state');
    const { ViewPlugin, Decoration } = require('@codemirror/view');

    // Define state field for plugin instance
    const pluginStateField = StateField.define({
      create: () => this,
      update: (value: any) => value,
    });

    // Plugin that handles the card link detection and replacement
    const kanbanCardEmbedPlugin = ViewPlugin.define(
      (view: any) => {
        const pluginInstance = {
          decorations: this.buildKanbanCardEmbedDecorations(view),
          lastCursorInLinkState: new Map(), // Track which links had cursor last time
          update: (update: any) => {
            let shouldRebuild = false;

            if (update.docChanged) {
              // Only rebuild for very specific wikilink-related changes
              let changesAffectWikilinks = false;

              update.changes.iterChanges(
                (fromA: number, toA: number, fromB: number, toB: number, inserted: any) => {
                  const insertedText = inserted.toString();
                  const deletedLength = toA - fromA;

                  // Only rebuild for these specific cases:
                  // 1. Text contains complete wikilink patterns
                  // 2. Large deletions that might remove entire links
                  if (
                    /\[\[.*?#\^.*?\]\]/.test(insertedText) ||
                    deletedLength > 20 // Large deletions
                  ) {
                    changesAffectWikilinks = true;
                    return;
                  }

                  // Check for completing wikilink patterns
                  if ((insertedText === ']' || insertedText === '^') && deletedLength === 0) {
                    // Get context to see if we're completing a wikilink
                    const doc = update.view.state.doc;
                    const contextStart = Math.max(0, fromB - 20);
                    const contextEnd = Math.min(doc.length, toB);
                    const contextText = doc.sliceString(contextStart, contextEnd);

                    if (/\[\[.*?#\^[a-zA-Z0-9]*$/.test(contextText)) {
                      changesAffectWikilinks = true;
                      return;
                    }
                  }
                }
              );

              if (changesAffectWikilinks) {
                shouldRebuild = true;
              }
            }

            // Smart selection change detection - rebuild if cursor moves between inside/outside wikilinks OR selection state changes
            if (update.selectionSet && !update.docChanged) {
              const oldSelection = update.startState.selection.main;
              const newSelection = update.state.selection.main;

              // Check if cursor head position changed OR selection range changed
              const cursorChanged = oldSelection.head !== newSelection.head;
              const selectionChanged =
                oldSelection.from !== newSelection.from || oldSelection.to !== newSelection.to;

              if (cursorChanged || selectionChanged) {
                const doc = update.view.state.doc;
                const text = doc.toString();
                const newCursorPos = newSelection.head;
                const oldCursorPos = oldSelection.head;
                const editorHasFocus = update.view.hasFocus;

                // Calculate old and new selection ranges
                const oldSelectionFrom = Math.min(oldSelection.from, oldSelection.to);
                const oldSelectionTo = Math.max(oldSelection.from, oldSelection.to);
                const oldHasSelection = oldSelectionFrom !== oldSelectionTo;

                const newSelectionFrom = Math.min(newSelection.from, newSelection.to);
                const newSelectionTo = Math.max(newSelection.from, newSelection.to);
                const newHasSelection = newSelectionFrom !== newSelectionTo;

                // Find all wikilinks and check if cursor or selection state changed for any of them
                const wikilinkRegex = /\[\[([^\]|]+)#\^([a-zA-Z0-9]+)(?:\|([^\]]+))?\]\]/g;
                let match;
                let hasStateChanges = false;

                // Check all links and track state changes
                while ((match = wikilinkRegex.exec(text)) !== null) {
                  const fullMatch = match[0];
                  const from = match.index;
                  const to = match.index + fullMatch.length;
                  const linkId = `${from}-${to}`;

                  // Check cursor state
                  const newCursorInLink =
                    editorHasFocus && newCursorPos >= from && newCursorPos <= to;
                  const oldCursorInLink =
                    editorHasFocus && oldCursorPos >= from && oldCursorPos <= to;

                  // Check selection overlap state
                  const oldSelectionOverlapsLink =
                    oldHasSelection &&
                    ((oldSelectionFrom <= from && oldSelectionTo >= to) ||
                      (oldSelectionFrom >= from && oldSelectionFrom < to) ||
                      (oldSelectionTo > from && oldSelectionTo <= to) ||
                      (from >= oldSelectionFrom && to <= oldSelectionTo));

                  const newSelectionOverlapsLink =
                    newHasSelection &&
                    ((newSelectionFrom <= from && newSelectionTo >= to) ||
                      (newSelectionFrom >= from && newSelectionFrom < to) ||
                      (newSelectionTo > from && newSelectionTo <= to) ||
                      (from >= newSelectionFrom && to <= newSelectionTo));

                  // Determine if the link should be hidden (cursor in link OR selection overlaps)
                  const oldLinkHidden = oldCursorInLink || oldSelectionOverlapsLink;
                  const newLinkHidden = newCursorInLink || newSelectionOverlapsLink;

                  const lastState = pluginInstance.lastCursorInLinkState.get(linkId);

                  // Only rebuild if the visibility state actually changed
                  if (lastState !== undefined && lastState !== newLinkHidden) {
                    pluginInstance.lastCursorInLinkState.set(linkId, newLinkHidden);
                    hasStateChanges = true;
                  } else if (lastState === undefined) {
                    // Initialize the state without triggering a rebuild
                    pluginInstance.lastCursorInLinkState.set(linkId, newLinkHidden);
                  }
                }

                // Only rebuild if there were actual state changes
                if (hasStateChanges) {
                  shouldRebuild = true;
                }
              }
            }

            if (shouldRebuild) {
              pluginInstance.decorations = this.buildKanbanCardEmbedDecorations(update.view);
            }
          },
        };
        return pluginInstance;
      },
      {
        decorations: (plugin: any) => plugin.decorations,
      }
    );

    return [pluginStateField, kanbanCardEmbedPlugin];
  }

  buildKanbanCardEmbedDecorations(view: any) {
    const { Decoration } = require('@codemirror/view');
    const { hasFrontmatterKey } = require('./helpers');

    const decorations = [];
    const doc = view.state.doc;
    const text = doc.toString();
    const selection = view.state.selection.main;
    const cursorPos = selection.head;
    const editorHasFocus = view.hasFocus;

    // Get current file path
    let currentFilePath = '';
    try {
      const activeFile = this.app.workspace.getActiveFile();
      if (activeFile) {
        currentFilePath = activeFile.path;
      }
    } catch (e) {
      console.warn('[KanbanPlugin] Could not determine current file path:', e);
    }

    // Regular expression to match wikilinks with block references
    const wikilinkRegex = /\[\[([^\]|]+)#\^([a-zA-Z0-9]+)(?:\|([^\]]+))?\]\]/g;
    let match;

    while ((match = wikilinkRegex.exec(text)) !== null) {
      const fullMatch = match[0];
      const filePath = match[1];
      const blockId = match[2];
      const displayText = match[3] || fullMatch;
      const from = match.index;
      const to = match.index + fullMatch.length;

      console.log('[KanbanCardEmbed] Found link:', {
        fullMatch,
        filePath,
        blockId,
        from,
        to,
        surroundingText: text.substring(Math.max(0, from - 10), Math.min(text.length, to + 10)),
      });

      // Check if cursor is within this link (cursor-aware behavior)
      const cursorInLink = editorHasFocus && cursorPos >= from && cursorPos <= to;

      // Check if there's a text selection that overlaps with this link
      const selectionFrom = Math.min(selection.from, selection.to);
      const selectionTo = Math.max(selection.from, selection.to);
      const hasSelection = selectionFrom !== selectionTo;
      const selectionOverlapsLink =
        hasSelection &&
        // Selection contains the entire link
        ((selectionFrom <= from && selectionTo >= to) ||
          // Selection starts inside the link
          (selectionFrom >= from && selectionFrom < to) ||
          // Selection ends inside the link
          (selectionTo > from && selectionTo <= to) ||
          // Link is completely inside the selection
          (from >= selectionFrom && to <= selectionTo));

      // Only show the card embed if cursor is NOT in this link AND there's no overlapping selection
      if (!cursorInLink && !selectionOverlapsLink) {
        // Check if the target file is a Kanban board
        const file = this.app.metadataCache.getFirstLinkpathDest(filePath, currentFilePath);
        if (!file || !hasFrontmatterKey(file)) {
          console.log('[KanbanCardEmbed] Skipping - not a kanban board:', filePath);
          continue;
        }

        console.log('[KanbanCardEmbed] Creating decoration for:', {
          fullMatch,
          filePath: file.path,
          blockId,
          from,
          to,
        });

        // Create a widget decoration to replace the link
        const pluginInstance = this;
        decorations.push(
          Decoration.replace({
            widget: new (class extends require('@codemirror/view').WidgetType {
              constructor() {
                super();
                this.plugin = pluginInstance;
                this.filePath = file.path;
                this.blockId = blockId;
                this.sourcePath = currentFilePath;
                this.displayText = displayText;
                this.container = null;
              }

              eq(widget: any) {
                return (
                  this.filePath === widget.filePath &&
                  this.blockId === widget.blockId &&
                  this.sourcePath === widget.sourcePath &&
                  this.displayText === widget.displayText
                );
              }

              toDOM() {
                this.container = document.createElement('div');
                this.container.className = 'kanban-plugin__card-embed-edit-mode-container';

                // Check if the feature is enabled
                if (this.plugin.settings['enable-kanban-card-embeds'] === false) {
                  this.container.innerHTML =
                    '<div class="kanban-plugin__linked-cards-disabled">Kanban card embeds are disabled in settings</div>';
                  return this.container;
                }

                // Dynamically import and render the SimpleKanbanCardEmbed component
                import('./components/SimpleKanbanCardEmbed')
                  .then(({ SimpleKanbanCardEmbed }) => {
                    if (this.container) {
                      const { createElement } = require('preact');
                      const { render } = require('preact/compat');

                      render(
                        createElement(SimpleKanbanCardEmbed, {
                          filePath: this.filePath,
                          blockId: this.blockId,
                          plugin: this.plugin,
                          sourcePath: this.sourcePath,
                          displayText: this.displayText,
                        }),
                        this.container
                      );
                    }
                  })
                  .catch((error) => {
                    console.error(
                      '[KanbanPlugin] Failed to load SimpleKanbanCardEmbed in edit mode:',
                      error
                    );
                    if (this.container) {
                      this.container.innerHTML =
                        '<div class="kanban-plugin__linked-cards-error">⚠️ Error loading card embed</div>';
                    }
                  });

                return this.container;
              }

              destroy() {
                if (this.container) {
                  const { unmountComponentAtNode } = require('preact/compat');
                  unmountComponentAtNode(this.container);
                  this.container = null;
                }
              }

              ignoreEvent(event: Event) {
                const target = event.target as HTMLElement;

                // Handle events without a target or with non-element targets
                if (!target || typeof target.closest !== 'function') {
                  return false;
                }

                // Always allow interactive elements to work, but exclude CodeMirror elements
                const interactiveElement = target.closest(
                  'input, button, a, label, [role="button"], [tabindex]'
                );
                const isCodeMirrorElement = target.closest('.cm-editor, .cm-scroller, .cm-content');
                const isInteractive = interactiveElement && !isCodeMirrorElement;

                if (isInteractive) {
                  return false; // Let CodeMirror process these events normally
                }

                // Check if this is a card click - allow it but prevent cursor movement
                const isCardClick = target.closest('.kanban-plugin__card-embed-item');
                if (isCardClick) {
                  // Allow the card click but prevent cursor movement
                  if (
                    event.type === 'click' ||
                    event.type === 'mousedown' ||
                    event.type === 'contextmenu'
                  ) {
                    event.stopPropagation();
                    event.preventDefault();
                  }
                  return true;
                }

                // For other mouse events, ignore them to prevent cursor movement
                if (
                  event.type === 'mousedown' ||
                  event.type === 'click' ||
                  event.type === 'mouseup' ||
                  event.type === 'mouseover' ||
                  event.type === 'mouseout' ||
                  event.type === 'mousemove' ||
                  event.type === 'contextmenu'
                ) {
                  return true;
                }

                return false;
              }
            })(),
          }).range(from, to)
        );
      }
    }

    return Decoration.set(decorations);
  }
  // --- END Kanban Card Embed Extension ---

  // Methods for managing settings change listeners
  onSettingChange(settingKey: string, callback: (value: any) => void) {
    if (!this.settingsChangeListeners.has(settingKey)) {
      this.settingsChangeListeners.set(settingKey, []);
    }
    this.settingsChangeListeners.get(settingKey)!.push(callback);
  }

  offSettingChange(settingKey: string, callback: (value: any) => void) {
    const listeners = this.settingsChangeListeners.get(settingKey);
    if (listeners) {
      const index = listeners.indexOf(callback);
      if (index > -1) {
        listeners.splice(index, 1);
      }
    }
  }

  private triggerSettingChange(settingKey: string, value: any) {
    const listeners = this.settingsChangeListeners.get(settingKey);
    if (listeners) {
      listeners.forEach((callback) => callback(value));
    }
  }
}

// --- SMTP Email Sending Function ---
async function attemptSmtpEmailSend(
  senderAddress: string,
  appPassword: string,
  recipientEmail: string,
  subject: string,
  textBody: string,
  htmlBody?: string
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
    const mailOptions: any = {
      from: senderAddress,
      to: recipientEmail,
      subject: subject,
      text: textBody, // Plain text body
    };

    // Add HTML body if provided
    if (htmlBody) {
      mailOptions.html = htmlBody;
    }

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
  console.log('Text Body:\n', textBody);
  if (htmlBody) console.log('HTML Body:\n', htmlBody);
  console.log('--- END SIMULATED EMAIL ---');
  return false; // Indicate failure as no email was actually sent
  */
}
// --- END SMTP Email Sending Function ---
