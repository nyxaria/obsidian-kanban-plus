import EventEmitter from 'eventemitter3';
import update from 'immutability-helper';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { frontmatterFromMarkdown } from 'mdast-util-frontmatter';
import { frontmatter } from 'micromark-extension-frontmatter';
import moment from 'moment';
import {
  HoverParent,
  HoverPopover,
  ItemView,
  Menu,
  Notice,
  Platform,
  TAbstractFile,
  TFile,
  ViewStateResult,
  WorkspaceLeaf,
  debounce,
  normalizePath,
} from 'obsidian';
import { createElement } from 'preact';
import { render, unmountComponentAtNode } from 'preact/compat';
import { visit } from 'unist-util-visit';

import { DEFAULT_SETTINGS, KanbanFormat, KanbanSettings, KanbanViewSettings } from './Settings';
import { StateManager } from './StateManager';
import { BasicMarkdownRenderer } from './components/MarkdownRenderer/MarkdownRenderer';
import { MemberBoard } from './components/MemberBoard';
import { c } from './components/helpers';
import { generateInstanceId } from './components/helpers';
import { Board, Item, Lane } from './components/types';
import { DndContext } from './dnd/components/DndContext';
import { getParentWindow } from './dnd/util/getWindow';
import { hasFrontmatterKeyRaw } from './helpers';
import { debugLog } from './helpers/debugLogger';
import { PromiseQueue } from './helpers/util';
import { t } from './lang/helpers';
import KanbanPlugin from './main';
import { frontmatterKey } from './parsers/common';
import { blockidExtension, blockidFromMarkdown } from './parsers/extensions/blockid';
import { tagExtension, tagFromMarkdown } from './parsers/extensions/tag';
import { gfmTaskListItem, gfmTaskListItemFromMarkdown } from './parsers/extensions/taskList';
import { getNodeContentBoundary, getStringFromBoundary } from './parsers/helpers/ast';
import { dedentNewLines, removeBlockId, replaceBrs } from './parsers/helpers/parser';
import { parseMarkdown } from './parsers/parseMarkdown';

export const memberViewType = 'member-board';
export const memberIcon = 'lucide-user';

interface MemberCard {
  id: string;
  title: string;
  titleRaw: string;
  checked: boolean;
  hasDoing: boolean;
  sourceBoardPath: string;
  sourceBoardName: string;
  sourceStartLine?: number;
  blockId?: string;
  assignedMembers: string[];
  tags: string[];
  date?: moment.Moment;
  priority?: string;
  depth?: number; // Nesting depth for multi-layer lists
}

export class MemberView extends ItemView implements HoverParent {
  plugin: KanbanPlugin;
  hoverPopover: HoverPopover | null;
  emitter: EventEmitter;
  actionButtons: Record<string, HTMLElement> = {};

  previewCache: Map<string, BasicMarkdownRenderer>;
  previewQueue: PromiseQueue;

  activeEditor: any;
  viewSettings: KanbanViewSettings;
  private _reactState: any = {};
  private _reactHasRenderedOnceInThisInstance = false;
  private _initialRenderTimeoutId: number | null = null;
  private _isRendering = false;

  // Member-specific state
  private selectedMember: string = '';
  private memberCards: MemberCard[] = [];
  private isLoading: boolean = false;
  private error: string | null = null;
  private scanRootPath: string = '';
  public hasInitialScan = false;
  // Add sorting state
  private sortBy: 'dueDate' | 'priority' = 'dueDate';
  private sortOrder: 'asc' | 'desc' = 'asc';
  // Track files that are currently being updated to prevent refresh loops
  private pendingFileUpdates: Set<string> = new Set();
  // Track member cards that are being updated optimistically
  private pendingMemberUpdates: Set<string> = new Set();
  // Track file update timeouts to prevent refresh loops
  private fileUpdateTimeouts: Map<string, NodeJS.Timeout> = new Map();
  private pendingRerenderTimeout: NodeJS.Timeout | null = null;
  private pendingRerenderCards: Set<string> = new Set();

  // Debug flag - set to false for production to reduce console noise
  private debugDragDrop: boolean = false;
  // Debounce onRefresh to prevent rapid successive calls
  private lastRefreshTime: number = 0;
  private refreshDebounceDelay: number = 1000; // 1 second debounce

  // Mock file property for compatibility with components that expect view.file
  file: TFile;

  get id(): string {
    return `${(this.leaf as any).id}:::member-board`;
  }

  get isShiftPressed(): boolean {
    return this.plugin.isShiftPressed;
  }

  constructor(leaf: WorkspaceLeaf, plugin: KanbanPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.emitter = new EventEmitter();
    this.previewCache = new Map();

    // Initialize mock file property for compatibility with components that expect view.file
    this.file = {
      path: 'member-board-virtual',
      name: 'Member Board',
      basename: 'Member Board',
      extension: 'md',
      stat: { mtime: Date.now(), ctime: Date.now(), size: 0 },
      vault: this.app.vault,
    } as TFile;

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
      'member-view-lane-width': DEFAULT_SETTINGS['member-view-lane-width'],
      'show-checkboxes': false, // Hide checkboxes in member view
    };

    this.previewQueue = new PromiseQueue(() => this.emitter.emit('queueEmpty'));
  }

  getViewType() {
    return memberViewType;
  }

  getIcon() {
    return memberIcon;
  }

  getDisplayText() {
    return this.selectedMember ? `${this.selectedMember}'s Board` : 'Member Board';
  }

  getWindow() {
    return getParentWindow(this.containerEl) as Window & typeof globalThis;
  }

  registerFileChangeEvents() {
    // Create a debounced function to handle file changes
    const debouncedFileChange = debounce(
      async (file: TFile) => {
        if (this.shouldRefreshOnFileChange(file)) {
          await this.scanMemberCards();
        }
      },
      1000, // 1 second debounce
      true
    );

    // Register file modification events
    this.registerEvent(
      this.app.vault.on('modify', (file: TFile) => {
        if (file instanceof TFile) {
          debouncedFileChange(file);
        }
      })
    );

    // Register file creation events
    this.registerEvent(
      this.app.vault.on('create', (file: TAbstractFile) => {
        if (file instanceof TFile) {
          debouncedFileChange(file);
        }
      })
    );

    // Register file deletion events
    this.registerEvent(
      this.app.vault.on('delete', (file: TAbstractFile) => {
        if (file instanceof TFile) {
          debouncedFileChange(file);
        }
      })
    );

    // Register file rename events
    this.registerEvent(
      this.app.vault.on('rename', (file: TAbstractFile, oldPath: string) => {
        if (file instanceof TFile) {
          debouncedFileChange(file);
        }
      })
    );

    // Register metadata changes (for frontmatter changes)
    this.registerEvent(
      this.app.metadataCache.on('changed', (file: TFile) => {
        if (file instanceof TFile) {
          debouncedFileChange(file);
        }
      })
    );
  }

  private shouldRefreshOnFileChange(file: TFile): boolean {
    // Only refresh if selected member exists and view is not detached
    if (!this.selectedMember || this.containerEl.closest('body') === null) {
      debugLog('[MemberView] Skipping refresh: no selected member or view detached');
      return false;
    }

    // Only refresh if the view is currently active (visible to user)
    if (!this.app.workspace.getActiveViewOfType(MemberView)) {
      debugLog('[MemberView] Skipping refresh: view not active');
      return false;
    }

    // Don't refresh if we're currently making file changes ourselves
    if (this.pendingFileUpdates.has(file.path)) {
      debugLog('[MemberView] Skipping refresh: file is being updated by this view');
      return false;
    }

    // Only refresh for markdown files
    if (file.extension !== 'md') {
      return false;
    }

    // Check if file is within our scan root path
    const filePath = file.path;
    const scanRoot = this.scanRootPath;

    if (scanRoot && !filePath.startsWith(scanRoot)) {
      return false;
    }

    // Check if file has kanban frontmatter
    const cache = this.app.metadataCache.getFileCache(file);
    if (!cache?.frontmatter) {
      return false;
    }

    const frontmatter = cache.frontmatter;
    if (!(frontmatter.kanban || frontmatter['kanban-plugin'])) {
      return false;
    }

    debugLog('[MemberView] File change detected, refreshing cards:', file.path);
    return true;
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

    // Remove tags
    const tagRegex = /(?:^|\s)(#[\w-]+(?:\/[\w-]+)*)(?=\s|$)/gi;
    cleanTitle = cleanTitle.replace(tagRegex, ' ');

    // For MemberView, we don't have a StateManager with settings, so skip date/time trigger removal
    // This is a simplified version compared to KanbanView

    // Clean up multiple spaces but preserve newlines
    cleanTitle = cleanTitle.replace(/[ \t]{2,}/g, ' ').trim();

    return cleanTitle;
  }

  async onload() {
    super.onload();
    if (Platform.isMobile) {
      this.containerEl.setCssProps({
        '--mobile-navbar-height': (this.app as any).mobileNavbar.containerEl.clientHeight + 'px',
      });
    }

    // Load session data for member selection and scan root path
    const sessionData = this.plugin.sessionManager.getMemberBoardSession();

    // Initialize with session data if available, otherwise with first team member
    const teamMembers = this.plugin.settings.teamMembers || [];
    if (sessionData.selectedMember && teamMembers.includes(sessionData.selectedMember)) {
      this.selectedMember = sessionData.selectedMember;
    } else if (teamMembers.length > 0 && !this.selectedMember) {
      this.selectedMember = teamMembers[0];
    }

    // Initialize scan root path from session data
    if (sessionData.scanRootPath !== undefined) {
      this.scanRootPath = sessionData.scanRootPath;
    }

    // Initialize sort preferences from session data
    if (sessionData.sortBy) {
      this.sortBy = sessionData.sortBy;
    }
    if (sessionData.sortOrder) {
      this.sortOrder = sessionData.sortOrder;
    }

    // Register for file change events to refresh when kanban content changes
    this.registerFileChangeEvents();

    // Register for active leaf changes to do initial scan when view becomes active for first time
    this.registerEvent(
      this.app.workspace.on('active-leaf-change', (leaf) => {
        if (leaf === this.leaf && this.selectedMember && !this.hasInitialScan) {
          // Only scan if this is the first time the view becomes active and we haven't scanned yet
          debugLog('[MemberView] View became active for first time, performing initial scan');
          this.scanMemberCards();
        }
      })
    );

    // Wait for the next frame to ensure DOM is ready, then schedule render
    requestAnimationFrame(() => {
      setTimeout(() => {
        // Double-check that everything is still available before rendering
        if (
          this.app &&
          this.plugin &&
          this.contentEl &&
          this.contentEl.isConnected &&
          !(this.leaf as any).detached
        ) {
          debugLog('[MemberView] Initial render - contentEl ready');
          this.setReactState({});
        } else {
          debugLog('[MemberView] Initial render - contentEl not ready, retrying...');
          // Retry after a longer delay
          setTimeout(() => {
            if (
              this.app &&
              this.plugin &&
              this.contentEl &&
              this.contentEl.isConnected &&
              !(this.leaf as any).detached
            ) {
              debugLog('[MemberView] Retry render - contentEl ready');
              this.setReactState({});
            } else {
              console.warn('[MemberView] Failed to initialize after retry');
            }
          }, 200);
        }
      }, 50);
    });

    this.register(
      this.containerEl.onWindowMigrated(() => {
        // Add safety check for window migration
        requestAnimationFrame(() => {
          setTimeout(() => {
            if (
              this.app &&
              this.plugin &&
              this.contentEl &&
              this.contentEl.isConnected &&
              !(this.leaf as any).detached
            ) {
              this.setReactState({});
            }
          }, 50);
        });
      })
    );
  }

  onunload(): void {
    super.onunload();

    // Clear any pending render timeouts
    if (this._initialRenderTimeoutId) {
      const win = this.getWindow();
      win.clearTimeout(this._initialRenderTimeoutId);
      this._initialRenderTimeoutId = null;
    }

    // Clean up all file update timeouts
    for (const [filePath, timeout] of this.fileUpdateTimeouts) {
      clearTimeout(timeout);
    }
    this.fileUpdateTimeouts.clear();
    this.pendingFileUpdates.clear();
    this.pendingMemberUpdates.clear();

    // Clear pending re-render timeout
    if (this.pendingRerenderTimeout) {
      clearTimeout(this.pendingRerenderTimeout);
      this.pendingRerenderTimeout = null;
    }
    this.pendingRerenderCards.clear();

    // Reset rendering state
    this._isRendering = false;
    this._reactHasRenderedOnceInThisInstance = false;

    // Safely unmount React component
    try {
      if (this.contentEl) {
        unmountComponentAtNode(this.contentEl);
      }
    } catch (error) {
      console.error('[MemberView] Error during unmount:', error);
    }

    this.previewQueue.clear();
    this.previewCache.clear();
    this.emitter.emit('queueEmpty');

    this.emitter.removeAllListeners();
    this.activeEditor = null;
    this.actionButtons = {};
  }

  async setState(state: any, result: ViewStateResult) {
    await super.setState(state, result);

    // Handle member selection and scan root path from state
    if (state?.selectedMember && state.selectedMember !== this.selectedMember) {
      this.selectedMember = state.selectedMember;
      this.hasInitialScan = false; // Reset initial scan flag when member changes from state
    }

    if (state?.scanRootPath !== undefined && state.scanRootPath !== this.scanRootPath) {
      this.scanRootPath = state.scanRootPath;
      this.hasInitialScan = false; // Reset initial scan flag when scan root changes from state
    }

    // Handle sort preferences from state
    if (state?.sortBy && state.sortBy !== this.sortBy) {
      this.sortBy = state.sortBy;
    }

    if (state?.sortOrder && state.sortOrder !== this.sortOrder) {
      this.sortOrder = state.sortOrder;
    }

    // Only render if contentEl is ready
    if (this.contentEl && this.contentEl.isConnected) {
      this.setReactState({});
    } else {
      debugLog('[MemberView] setState called but contentEl not ready, waiting...');
      // Wait for contentEl to be ready
      requestAnimationFrame(() => {
        setTimeout(() => {
          if (this.contentEl && this.contentEl.isConnected && !(this.leaf as any).detached) {
            debugLog('[MemberView] setState delayed render - contentEl ready');
            this.setReactState({});
          }
        }, 100);
      });
    }
  }

  getState() {
    const state = super.getState();
    state.selectedMember = this.selectedMember;
    state.scanRootPath = this.scanRootPath;
    state.sortBy = this.sortBy;
    state.sortOrder = this.sortOrder;
    return state;
  }

  public refreshHeader() {
    debugLog(`[MemberView] refreshHeader: Updating tab title for member: ${this.selectedMember}`);

    // Standard header refresh approaches
    this.app.workspace.trigger('layout-change');
    this.app.workspace.trigger('layout-ready');
    (this.leaf as any).updateHeader?.();

    // DIRECT DOM UPDATE: Update the view header title directly
    this.updateViewHeaderTitle();

    // Schedule a delayed update in case the immediate one doesn't work
    setTimeout(() => {
      this.updateViewHeaderTitle();
    }, 100);
  }

  private updateViewHeaderTitle() {
    try {
      const newTitle = this.getDisplayText();
      debugLog(`[MemberView] Attempting to update view header title to: ${newTitle}`);

      // Try to find the view header title element in various locations
      const searchLocations = [
        this.containerEl,
        this.containerEl.parentElement,
        this.app.workspace.containerEl,
        document,
      ];

      for (const location of searchLocations) {
        if (!location) continue;

        const viewHeaderTitle = location.querySelector('.view-header-title');
        if (viewHeaderTitle) {
          debugLog(
            `[MemberView] Found view header title element in ${location === document ? 'document' : 'container'}, updating to: ${newTitle}`
          );
          viewHeaderTitle.textContent = newTitle;
          return; // Successfully updated, exit
        }
      }

      debugLog('[MemberView] View header title element not found in any location');
    } catch (error) {
      debugLog('[MemberView] Error updating view header title:', error);
    }
  }

  setViewState<K extends keyof KanbanViewSettings>(
    key: K,
    val?: KanbanViewSettings[K],
    globalUpdater?: (old: KanbanViewSettings[K]) => KanbanViewSettings[K]
  ) {
    if (val !== undefined) {
      this.viewSettings[key] = val;
    }
    this.app.workspace.requestSaveLayout();
  }

  getViewState<K extends keyof KanbanViewSettings>(key: K) {
    return this.viewSettings[key];
  }

  useViewState<K extends keyof KanbanViewSettings>(
    key: K
  ): KanbanViewSettings[K] | 'board' | any[] {
    // For member view, return static values that work with the component expectations
    if (key === frontmatterKey) {
      return 'board'; // Always use board view for member board
    }
    if (key === 'list-collapse') {
      return []; // No collapsed lanes by default
    }
    return this.viewSettings[key];
  }

  onPaneMenu(menu: Menu, source: string, callSuper: boolean = true) {
    if (source !== 'more-options') {
      super.onPaneMenu(menu, source);
      return;
    }

    menu.addItem((item) => {
      item
        .setTitle('Refresh member board')
        .setIcon('lucide-refresh-cw')
        .setSection('pane')
        .onClick(() => {
          this.scanMemberCards();
        });
    });

    if (callSuper) {
      super.onPaneMenu(menu, source);
    }
  }

  initHeaderButtons = debounce(() => this._initHeaderButtons(), 10, true);

  _initHeaderButtons = async () => {
    if (Platform.isPhone) return;

    if (!this.actionButtons['refresh-member-board']) {
      this.actionButtons['refresh-member-board'] = this.addAction(
        'lucide-refresh-cw',
        'Refresh member board',
        () => {
          this.scanMemberCards();
        }
      );
    }
  };

  clear() {
    unmountComponentAtNode(this.contentEl);
  }

  // Debounced refresh method to prevent rapid successive calls
  debouncedRefresh = () => {
    const now = Date.now();
    if (now - this.lastRefreshTime < this.refreshDebounceDelay) {
      debugLog('[MemberView] Refresh debounced - too soon since last refresh');
      return;
    }
    this.lastRefreshTime = now;
    this.scanMemberCards();
  };

  async scanMemberCards() {
    // Check if view is properly initialized
    if (!this.app || !this.plugin || (this.leaf as any).detached) {
      debugLog('[MemberView] View not properly initialized, skipping scan');
      return;
    }

    // Prevent concurrent scans
    if (this.isLoading) {
      debugLog('[MemberView] Scan already in progress, skipping');
      return;
    }

    if (!this.selectedMember) {
      this.memberCards = [];
      this.hasInitialScan = true; // Mark as scanned even if no member selected
      this.setReactState({});
      return;
    }

    this.isLoading = true;
    this.error = null;
    this.setReactState({});

    try {
      const allCards: MemberCard[] = [];

      // Check if app and vault are available
      if (!this.app || !this.app.vault) {
        console.error('[MemberView] App or vault not available');
        this.error = 'App or vault not available';
        this.isLoading = false;
        this.setReactState({});
        return;
      }

      // Filter files based on scan root path
      let allMdFiles = this.app.vault.getMarkdownFiles();

      if (this.scanRootPath && this.scanRootPath.trim() !== '') {
        // Filter files to only include those in the specified directory
        allMdFiles = allMdFiles.filter(
          (file) =>
            file.path.startsWith(this.scanRootPath + '/') || file.parent?.path === this.scanRootPath
        );
      }

      for (const mdFile of allMdFiles) {
        if (!hasFrontmatterKeyRaw(await this.app.vault.cachedRead(mdFile))) {
          continue;
        }

        try {
          const fileContent = await this.app.vault.cachedRead(mdFile);

          // Use direct fromMarkdown instead of parseMarkdown to avoid StateManager dependency
          // parseMarkdown calls stateManager.compileSettings() which causes errors when stateManager is null
          const ast = fromMarkdown(fileContent, {
            extensions: [
              frontmatter(['yaml']),
              gfmTaskListItem,
              tagExtension(),
              blockidExtension(),
            ],
            mdastExtensions: [
              frontmatterFromMarkdown(['yaml']),
              gfmTaskListItemFromMarkdown,
              tagFromMarkdown(),
              blockidFromMarkdown(),
            ],
          });

          let currentLaneTitle = 'Unknown Lane';
          for (const astNode of ast.children) {
            if (astNode.type === 'heading') {
              const firstChild = astNode.children?.[0];
              const headingText =
                firstChild && 'value' in firstChild ? firstChild.value : 'Unnamed Lane';
              currentLaneTitle = headingText.replace(/\s*\(\d+\)$/, '').trim();
            } else if (astNode.type === 'list') {
              // Process all list items recursively, including nested ones
              this.processListItemsRecursively(
                astNode,
                null, // No StateManager needed for member extraction
                fileContent,
                mdFile,
                currentLaneTitle,
                allCards,
                0 // depth level
              );
            }
          }
        } catch (parseError) {
          console.error(`[MemberView] Error processing board ${mdFile.path}:`, parseError);
        }
      }

      this.memberCards = allCards;
      this.isLoading = false;
      this.hasInitialScan = true; // Mark as scanned successfully

      this.setReactState({});
    } catch (e) {
      console.error('[MemberView] Error scanning member cards:', e);
      this.error = `Error scanning cards: ${e.message}`;
      this.isLoading = false;
      this.hasInitialScan = true; // Mark as scanned even if there was an error

      this.setReactState({});
    }
  }

  private processListItemsRecursively(
    listNode: any,
    stateManager: StateManager | null, // Make optional
    fileContent: string,
    file: TFile,
    laneTitle: string,
    allCards: MemberCard[],
    depth: number,
    processedItems: Set<any> = new Set() // Track already processed items to avoid duplicates
  ): void {
    if (!listNode || !listNode.children) return;

    for (const listItemNode of listNode.children) {
      if (listItemNode.type === 'listItem') {
        // Skip if this item was already processed as part of a parent's nested structure
        if (processedItems.has(listItemNode)) {
          continue;
        }

        // Check if this item or any of its descendants has member assignments for the selected member
        const hasSelectedMemberInTree = this.hasSelectedMemberInTree(listItemNode);

        if (hasSelectedMemberInTree) {
          // Process this item (including all its nested structure)
          const itemData = this.parseListItemToMemberCard(
            stateManager,
            fileContent,
            listItemNode,
            file,
            laneTitle,
            depth
          );

          if (itemData && itemData.assignedMembers.includes(this.selectedMember)) {
            allCards.push(itemData);

            // Mark all nested items as processed to avoid double-processing
            this.markNestedItemsAsProcessed(listItemNode, processedItems);
          }
        } else {
          // This item doesn't have the selected member, but continue checking nested items
          // in case there are deeply nested assignments
          if (listItemNode.children) {
            for (const childNode of listItemNode.children) {
              if (childNode.type === 'list') {
                this.processListItemsRecursively(
                  childNode,
                  stateManager,
                  fileContent,
                  file,
                  laneTitle,
                  allCards,
                  depth + 1,
                  processedItems
                );
              }
            }
          }
        }
      }
    }
  }

  // Helper method to check if an item tree contains the selected member
  private hasSelectedMemberInTree(listItemNode: any): boolean {
    // Check the current item using AST traversal
    let hasSelectedMember = false;

    // Visit the AST to find member assignments
    visit(listItemNode, (node: any) => {
      if (node.type === 'text' && node.value) {
        const memberPrefix = '@@'; // Default member assignment prefix
        const memberRegex = new RegExp(`${memberPrefix}(\\w+)`, 'g');
        let match;
        while ((match = memberRegex.exec(node.value)) !== null) {
          if (match[1] === this.selectedMember) {
            hasSelectedMember = true;
            return;
          }
        }
      }
    });

    if (hasSelectedMember) {
      return true;
    }

    // Check nested items recursively
    if (listItemNode.children) {
      for (const childNode of listItemNode.children) {
        if (childNode.type === 'list' && childNode.children) {
          for (const nestedListItem of childNode.children) {
            if (nestedListItem.type === 'listItem') {
              if (this.hasSelectedMemberInTree(nestedListItem)) {
                return true;
              }
            }
          }
        }
      }
    }

    return false;
  }

  // Helper method to mark all nested items as processed
  private markNestedItemsAsProcessed(listItemNode: any, processedItems: Set<any>): void {
    processedItems.add(listItemNode);

    if (listItemNode.children) {
      for (const childNode of listItemNode.children) {
        if (childNode.type === 'list' && childNode.children) {
          for (const nestedListItem of childNode.children) {
            if (nestedListItem.type === 'listItem') {
              this.markNestedItemsAsProcessed(nestedListItem, processedItems);
            }
          }
        }
      }
    }
  }

  // Helper method to extract all member assignments from an item tree
  private extractMembersFromItemTree(listItemNode: any): string[] {
    const allMembers: string[] = [];
    const memberPrefix = '@@'; // Default member assignment prefix
    const memberRegex = new RegExp(`${memberPrefix}(\\w+)`, 'g');

    // Extract from current item using AST traversal
    visit(listItemNode, (node: any) => {
      if (node.type === 'text' && node.value) {
        let match;
        while ((match = memberRegex.exec(node.value)) !== null) {
          if (!allMembers.includes(match[1])) {
            allMembers.push(match[1]);
          }
        }
      }
    });

    return allMembers;
  }

  private parseListItemToMemberCard(
    stateManager: StateManager | null, // Make optional
    fileContent: string,
    listItemNode: any,
    file: TFile,
    laneTitle: string,
    depth: number = 0
  ): MemberCard | null {
    try {
      // Check if it's a task
      const isTask = listItemNode.checked !== null;
      if (!isTask) {
        debugLog('[MemberView] Not a task, skipping');
        return null;
      }

      const checked = listItemNode.checked === true;

      // Use full list item boundaries to capture complete content including block ID
      // The getNodeContentBoundary function excludes block IDs, so we need the full item boundaries
      const fullListItemStart = listItemNode.position.start.offset;
      const fullListItemEnd = listItemNode.position.end.offset;

      const itemBoundary = { start: fullListItemStart, end: fullListItemEnd };
      let titleRaw = getStringFromBoundary(fileContent, itemBoundary);

      // Handle empty task (same as KanbanView)
      if (titleRaw === '[' + (listItemNode.checked ? listItemNode.checkChar || ' ' : ' ') + ']') {
        titleRaw = '';
      }

      if (!titleRaw) {
        debugLog('[MemberView] No titleRaw extracted, skipping');
        return null;
      }

      // debugLog('[MemberView] parseListItemToMemberCard: Processing item:', {
      //   titleRaw,
      //   filePath: file.path,
      //   laneTitle,
      //   depth,
      //   selectedMember: this.selectedMember,
      // });

      // Extract block ID - look for ^blockId anywhere in the content BEFORE processing
      const blockIdMatch = titleRaw.match(/\^([a-zA-Z0-9]+)/);
      const blockId = blockIdMatch ? blockIdMatch[1] : undefined;

      // Process titleRaw like KanbanView does - AFTER extracting block ID
      const processedTitleRaw = removeBlockId(dedentNewLines(replaceBrs(titleRaw)));

      // Extract assigned members from the entire item tree (including nested items)
      const assignedMembers = this.extractMembersFromItemTree(listItemNode);

      debugLog('[MemberView] Extracted members:', {
        assignedMembers,
        selectedMember: this.selectedMember,
        matches: assignedMembers.includes(this.selectedMember),
      });

      // Extract tags using AST traversal
      const tags: string[] = [];

      // Visit the AST to find hashtag nodes
      visit(listItemNode, (node: any) => {
        if (node.type === 'hashtag') {
          tags.push(node.value);
        }
      });

      // Check if has "doing" tag (handle both #doing and doing)
      const hasDoing = tags.some((tag) => {
        const cleanTag = tag.replace(/^#/, '').toLowerCase();
        return cleanTag === 'doing';
      });

      // Extract dates and times using regex patterns like regular parsing
      let dateStr: string | undefined;
      let timeStr: string | undefined;

      const dateTrigger = '@'; // Default date trigger
      const timeTrigger = '%'; // Default time trigger
      const escapeRegExpStr = (str: string) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

      // Extract dates: @{date}, @[[date]], @start{date}, etc.
      const dateRegExText = `(?:^|\\s)${escapeRegExpStr(dateTrigger)}(?:\\w*)?(?:\\{([^\\}]+?)\\}|\\[\\[([^\\]]+?)\\]\\])(?:\\s+${escapeRegExpStr(timeTrigger)}\\{([^\\}]+?)\\})?`;
      const dateRegEx = new RegExp(dateRegExText, 'gi');

      let dateMatch;
      while ((dateMatch = dateRegEx.exec(processedTitleRaw)) !== null) {
        const datePart = dateMatch[1] || dateMatch[2]; // From {} or [[]]
        const timePart = dateMatch[3]; // Optional time part
        if (datePart && !dateStr) {
          dateStr = datePart.trim();
          if (timePart && !timeStr) {
            timeStr = timePart.trim();
          }
          break; // Take the first date found
        }
      }

      // Extract standalone time if not already captured with date
      if (!timeStr) {
        const standaloneTimeRegExText = `(?:^|\\s)${escapeRegExpStr(timeTrigger)}\\{([^\\}]+?)\\}`;
        const standaloneTimeRegEx = new RegExp(standaloneTimeRegExText, 'gi');
        const timeMatch = standaloneTimeRegEx.exec(processedTitleRaw);
        if (timeMatch && timeMatch[1]) {
          timeStr = timeMatch[1].trim();
        }
      }

      // Clean title for display - use the processed content but clean it up
      const memberPrefix = '@@'; // Default member assignment prefix
      const memberRegex = new RegExp(`${memberPrefix}\\w+`, 'g');
      let cleanTitle = processedTitleRaw
        .replace(memberRegex, '') // Remove member assignments
        .replace(/\s*#[\w-]+(?:\/[\w-]+)*/g, '') // Remove tags (including preceding spaces)
        .replace(/\s*\^[a-zA-Z0-9]+$/, '') // Remove block ID (including preceding spaces)
        .replace(/\s+/g, ' ') // Normalize multiple spaces to single space
        .trim();

      // Extract priority with proper typing
      const priorityMatch = cleanTitle.match(/!(low|medium|high)/i);
      const priority: 'high' | 'medium' | 'low' | undefined = priorityMatch
        ? (priorityMatch[1].toLowerCase() as 'high' | 'medium' | 'low')
        : undefined;
      if (priority) {
        cleanTitle = cleanTitle.replace(/!(low|medium|high)/gi, '').trim();
      }

      const result = {
        id: blockId || generateInstanceId(),
        title: cleanTitle,
        titleRaw: processedTitleRaw, // Use the processed version like KanbanView
        checked,
        hasDoing,
        sourceBoardPath: file.path,
        sourceBoardName: file.basename,
        sourceStartLine: listItemNode.position?.start.line,
        blockId,
        assignedMembers,
        tags: tags.map((tag) => (tag.startsWith('#') ? tag : '#' + tag)), // Include # prefix for consistency
        priority,
        depth,
        // Add date information extracted from AST
        dateStr,
        timeStr,
        // Create proper date moment object for menu detection
        date: dateStr
          ? moment(dateStr, this.plugin.settings['date-format'] || 'YYYY-MM-DD')
          : undefined,
      };

      // debugLog('[MemberView] Created member card:', {
      //   id: result.id,
      //   title: result.title,
      //   titleRaw: result.titleRaw,
      //   blockId: result.blockId,
      //   assignedMembers: result.assignedMembers,
      //   tags: result.tags,
      //   dateStr: result.dateStr,
      //   timeStr: result.timeStr,
      //   checked: result.checked,
      //   hasDoing: result.hasDoing,
      //   willBeIncluded: assignedMembers.includes(this.selectedMember),
      // });

      return result;
    } catch (e) {
      console.error('[MemberView] Error parsing list item:', e);
      return null;
    }
  }

  createMemberBoard(): Board {
    const backlogCards: Item[] = [];
    const doingCards: Item[] = [];
    const doneCards: Item[] = [];

    // Sort member cards before categorizing
    const sortedCards = this.sortMemberCards(this.memberCards);

    // Categorize cards
    sortedCards.forEach((card) => {
      // Ensure card has all required properties with defaults
      const safeCard = {
        id: card.id || generateInstanceId(),
        title: card.title || '',
        titleRaw: card.titleRaw || '',
        checked: card.checked || false,
        blockId: card.blockId,
        assignedMembers: card.assignedMembers || [],
        tags: card.tags || [],
        priority: card.priority,
        dateStr: (card as any).dateStr,
        timeStr: (card as any).timeStr,
      };

      const item: Item = {
        id: safeCard.id,
        type: 'item',
        accepts: ['item'], // Allow items to accept other items for drop functionality
        children: [],
        data: {
          title: safeCard.title, // Use the title directly (now includes nested structure)
          titleRaw: safeCard.titleRaw,
          titleSearch: safeCard.title,
          titleSearchRaw: safeCard.titleRaw,
          checked: safeCard.checked,
          checkChar: safeCard.checked ? 'x' : ' ',
          blockId: safeCard.blockId,
          assignedMembers: safeCard.assignedMembers,
          metadata: {
            tags: safeCard.tags, // This should now include the # prefix
            priority: safeCard.priority as 'high' | 'medium' | 'low' | undefined,
            // Add date and time metadata from extracted data
            dateStr: safeCard.dateStr,
            timeStr: safeCard.timeStr,
            date: safeCard.dateStr
              ? moment(safeCard.dateStr, this.plugin.settings['date-format'] || 'YYYY-MM-DD')
              : undefined,
            time: safeCard.timeStr
              ? moment(safeCard.timeStr, this.plugin.settings['time-format'] || 'HH:mm')
              : undefined,
            // Add required metadata properties to prevent undefined errors
            fileMetadata: {},
            fileMetadataOrder: [],
            inlineMetadata: [],
          },
        },
      };

      // Validate that the item has proper metadata structure
      if (!item.data || !item.data.metadata) {
        console.error('[MemberView] CRITICAL: Item created without proper metadata structure:', {
          itemId: item.id,
          itemData: item.data,
          originalCard: card,
        });
        return; // Skip this item to prevent crashes
      }

      // Ensure tags is always an array
      if (!Array.isArray(item.data.metadata.tags)) {
        console.warn('[MemberView] Item metadata.tags is not an array, fixing:', {
          itemId: item.id,
          tags: item.data.metadata.tags,
        });
        item.data.metadata.tags = [];
      }

      // Ensure all required properties exist
      item.data.metadata.fileMetadata = item.data.metadata.fileMetadata || {};
      item.data.metadata.fileMetadataOrder = item.data.metadata.fileMetadataOrder || [];
      item.data.metadata.inlineMetadata = item.data.metadata.inlineMetadata || [];

      // Add parentLaneId to item data for drag and drop tracking
      (item.data as any).parentLaneId = card.checked ? 'done' : card.hasDoing ? 'doing' : 'backlog';

      // debugLog('[MemberView] Created item with metadata:', {
      //   itemId: item.id,
      //   title: item.data.title,
      //   hasMetadata: !!item.data.metadata,
      //   tags: item.data.metadata.tags,
      //   priority: item.data.metadata.priority,
      //   dateStr: item.data.metadata.dateStr,
      //   timeStr: item.data.metadata.timeStr,
      //   hasDate: !!item.data.metadata.date,
      //   hasTime: !!item.data.metadata.time,
      //   checked: card.checked,
      //   hasDoing: card.hasDoing,
      //   determinedLane: card.checked ? 'done' : card.hasDoing ? 'doing' : 'backlog',
      // });

      if (card.checked) {
        doneCards.push(item);
      } else if (card.hasDoing) {
        doingCards.push(item);
      } else {
        backlogCards.push(item);
      }
    });

    // Create lanes
    const backlogLane: Lane = {
      id: 'backlog',
      type: 'lane',
      accepts: ['item'],
      data: {
        title: 'Backlog',
      },
      children: backlogCards,
    };

    const doingLane: Lane = {
      id: 'doing',
      type: 'lane',
      accepts: ['item'],
      data: {
        title: 'Doing',
      },
      children: doingCards,
    };

    const doneLane: Lane = {
      id: 'done',
      type: 'lane',
      accepts: ['item'],
      data: {
        title: 'Done',
      },
      children: doneCards,
    };

    const board = {
      id: `member-board-${this.selectedMember}`,
      type: 'board',
      accepts: ['lane'],
      data: {
        settings: this.plugin.settings,
        frontmatter: {},
        archive: [] as any[],
        isSearching: false,
        errors: [] as any[],
      },
      children: [backlogLane, doingLane, doneLane],
    };

    // Debug: Validate all items in the board have proper metadata
    debugLog('[MemberView] Board validation:', {
      boardId: board.id,
      laneCount: board.children.length,
      totalItems: board.children.reduce((sum, lane) => sum + lane.children.length, 0),
    });

    board.children.forEach((lane, laneIndex) => {
      debugLog(
        `[MemberView] Lane ${laneIndex} (${lane.data?.title}): ${lane.children.length} items`
      );
      lane.children.forEach((item, itemIndex) => {
        if (!item.data || !item.data.metadata) {
          console.error(
            `[MemberView] CRITICAL: Item ${itemIndex} in lane ${laneIndex} has no metadata:`,
            {
              itemId: item.id,
              itemData: item.data,
            }
          );
        } else if (!Array.isArray(item.data.metadata.tags)) {
          console.error(
            `[MemberView] CRITICAL: Item ${itemIndex} in lane ${laneIndex} has invalid tags:`,
            {
              itemId: item.id,
              tags: item.data.metadata.tags,
              tagsType: typeof item.data.metadata.tags,
            }
          );
        }
      });
    });

    return board;
  }

  async setReactState(newState?: any) {
    // Prevent multiple simultaneous renders
    if (this._isRendering) {
      debugLog('[MemberView] Render already in progress, skipping');
      return;
    }

    // Check if component is still mounted and valid
    if (!this.contentEl || (this.leaf as any).detached || !this.contentEl.isConnected) {
      debugLog('[MemberView] Component not mounted, skipping setReactState');
      return;
    }

    // Additional safety checks
    if (!this.plugin || !this.app) {
      debugLog('[MemberView] Plugin or app not available, skipping setReactState');
      return;
    }

    if (newState) {
      this._reactState = { ...this._reactState, ...newState };
    }

    const win = this.getWindow();
    if (this._initialRenderTimeoutId) {
      win.clearTimeout(this._initialRenderTimeoutId);
    }

    const renderCallback = () => {
      if (this._isRendering) {
        debugLog('[MemberView] Render already in progress, skipping render callback');
        return;
      }

      this._isRendering = true;

      try {
        // Check if component is still mounted and valid
        if (!this.contentEl || (this.leaf as any).detached || !this.contentEl.isConnected) {
          debugLog('[MemberView] Content element not available, detached, or not connected to DOM');
          this._isRendering = false;
          return;
        }

        // Additional safety checks
        if (!this.plugin || !this.app) {
          console.error('[MemberView] Plugin or app not available during render');
          this._isRendering = false;
          return;
        }

        // Safely unmount previous component
        try {
          const unmounted = unmountComponentAtNode(this.contentEl);
          if (!unmounted || this.contentEl.children.length > 0) {
            this.contentEl.innerHTML = '';
          }
        } catch (unmountError) {
          console.warn('[MemberView] Error during unmount, clearing innerHTML:', unmountError);
          this.contentEl.innerHTML = '';
        }

        this._reactHasRenderedOnceInThisInstance = true;

        const memberBoard = this.createMemberBoard();

        // Final check before render
        if (!this.contentEl.isConnected) {
          debugLog('[MemberView] ContentEl disconnected before render, aborting');
          return;
        }

        render(
          createElement(MemberBoard, {
            key: `member-board-${this.selectedMember}`,
            plugin: this.plugin,
            view: this,
            board: memberBoard,
            selectedMember: this.selectedMember,
            teamMembers: this.plugin.settings.teamMembers || [],
            memberCards: this.memberCards,
            isLoading: this.isLoading,
            error: this.error,
            scanRootPath: this.scanRootPath,
            availableDirectories: this.getAvailableKanbanDirectories(),
            onMemberChange: (member: string) => {
              this.selectedMember = member;
              this.hasInitialScan = false; // Reset initial scan flag when member changes
              // Save to session
              this.plugin.sessionManager.setMemberBoardSession({ selectedMember: member });
              // Update tab title to reflect the new selected member
              this.refreshHeader();
              this.scanMemberCards();
            },
            onScanRootChange: (path: string) => {
              this.scanRootPath = path;
              this.hasInitialScan = false; // Reset initial scan flag when scan root changes
              // Save to session
              this.plugin.sessionManager.setMemberBoardSession({ scanRootPath: path });
              if (this.selectedMember) {
                this.scanMemberCards();
              }
            },
            onRefresh: () => this.scanMemberCards(),
            onSortChange: (sortBy: 'dueDate' | 'priority', sortOrder: 'asc' | 'desc') => {
              this.sortBy = sortBy;
              this.sortOrder = sortOrder;
              // Save to session
              this.plugin.sessionManager.setMemberBoardSession({ sortBy, sortOrder });
              // Re-render with new sort
              this.setReactState({ lastSortUpdate: Date.now() });
            },
            sortBy: this.sortBy,
            sortOrder: this.sortOrder,
            updateMemberAssignment: (cardId: string, member: string, isAssigning: boolean) =>
              this.updateMemberAssignment(cardId, member, isAssigning),
            reactState: this._reactState,
            setReactState: (s: any) => this.setReactState(s),
            emitter: this.emitter,
          }),
          this.contentEl
        );
      } catch (error) {
        console.error('[MemberView] Error during render:', error);
        // Show error message in the content element only if it's still connected
        if (this.contentEl && this.contentEl.isConnected) {
          this.contentEl.innerHTML = `
            <div style="padding: 20px; text-align: center; color: var(--text-error);">
              <p>Error rendering member board</p>
              <p style="font-size: 0.8em; opacity: 0.7;">${error.message}</p>
            </div>
          `;
        }
      } finally {
        this._isRendering = false;
      }
    };

    if (this._reactHasRenderedOnceInThisInstance) {
      renderCallback();
    } else {
      this._initialRenderTimeoutId = win.setTimeout(renderCallback, 0);
    }
  }

  async handleDrop(dragEntity: any, dropEntity: any) {
    if (!dragEntity || !dropEntity) {
      debugLog('[MemberView] handleDrop: Invalid drag or drop entity');
      return;
    }

    // Get the actual data from the drag and drop entities
    const dragData = dragEntity.getData();
    const dropData = dropEntity.getData();

    if (!dragData || !dropData) {
      debugLog('[MemberView] handleDrop: Invalid drag or drop data');
      return;
    }

    debugLog('[MemberView] handleDrop called with data:', {
      dragData,
      dropData,
    });

    // Find the member card by ID from our memberCards array
    const memberCard = this.memberCards.find((card) => card.id === dragData.id);

    // Get target lane ID from drop data
    let targetLaneId: string;

    // If dropping on a lane directly, use the lane ID
    if (dropData.type === 'lane') {
      targetLaneId = dropData.id;
    }
    // If dropping on an item, use the item's lane ID
    else if (dropData.memberBoardLaneId) {
      targetLaneId = dropData.memberBoardLaneId;
    }
    // Fallback to parentLaneId if available
    else if (dropData.parentLaneId) {
      targetLaneId = dropData.parentLaneId;
    }
    // Handle dropping on placeholder (empty drop zones)
    else if (dropData.type === 'placeholder') {
      // For placeholders, check the entity path to determine which lane we're in
      const dropPath = dropEntity.getPath();
      debugLog('[MemberView] handleDrop: Placeholder drop path:', dropPath);

      // The path should contain the lane index, use it to map to lane ID
      if (dropPath && dropPath.length > 0) {
        const laneIndex = dropPath[0]; // First element should be lane index
        const board = this.createMemberBoard();
        if (laneIndex >= 0 && laneIndex < board.children.length) {
          targetLaneId = board.children[laneIndex].id;
          debugLog('[MemberView] handleDrop: Found placeholder lane via path:', {
            laneIndex,
            targetLaneId,
            path: dropPath,
          });
        }
      }

      // Fallback: try to determine from drop entity scope or context
      if (!targetLaneId) {
        debugLog(
          '[MemberView] handleDrop: Could not determine lane from path, checking entity data'
        );

        // Try to find the lane by examining the entity's parent hierarchy
        // The placeholder should be a child of a Droppable that has lane data
        let currentEntity = dropEntity;
        let attempts = 0;
        const maxAttempts = 5;

        while (currentEntity && attempts < maxAttempts) {
          attempts++;

          // Check if this entity has lane data
          const entityData = currentEntity.getData();
          if (entityData && entityData.type === 'lane') {
            targetLaneId = entityData.id;
            debugLog('[MemberView] handleDrop: Found lane via entity hierarchy:', {
              attempts,
              targetLaneId,
              entityData,
            });
            break;
          }

          // Try to get the parent entity
          if (typeof currentEntity.getParent === 'function') {
            currentEntity = currentEntity.getParent();
          } else {
            break;
          }
        }

        // If still no lane found, try to use the entity's scopeId or context
        if (!targetLaneId) {
          // Check if scopeId contains lane information
          if (dropEntity.scopeId && typeof dropEntity.scopeId === 'string') {
            const scopeId = dropEntity.scopeId;
            debugLog('[MemberView] handleDrop: Checking scopeId for lane info:', scopeId);

            // Check if scopeId contains lane names
            if (scopeId.includes('backlog')) {
              targetLaneId = 'backlog';
            } else if (scopeId.includes('doing')) {
              targetLaneId = 'doing';
            } else if (scopeId.includes('done')) {
              targetLaneId = 'done';
            }

            if (targetLaneId) {
              debugLog('[MemberView] handleDrop: Found lane via scopeId:', {
                scopeId,
                targetLaneId,
              });
            }
          }
        }

        // Last resort: use DOM navigation to find the lane
        if (!targetLaneId) {
          try {
            // Try to find the lane by walking up the DOM tree
            const placeholderElement =
              dropEntity.elementRef?.current || dropEntity.measureRef?.current;
            if (placeholderElement) {
              let currentElement = placeholderElement.parentElement;
              let domAttempts = 0;
              const maxDomAttempts = 10;

              while (currentElement && domAttempts < maxDomAttempts) {
                domAttempts++;

                // First priority: Look for data-lane-id attribute (our new approach)
                if (currentElement.hasAttribute('data-lane-id')) {
                  const laneId = currentElement.getAttribute('data-lane-id');
                  if (laneId && ['backlog', 'doing', 'done'].includes(laneId)) {
                    targetLaneId = laneId;
                    debugLog('[MemberView] handleDrop: Found lane via data-lane-id:', {
                      domAttempts,
                      targetLaneId,
                      laneId,
                    });
                    break;
                  }
                }

                // Second priority: Look for a droppable element with lane data
                if (currentElement.hasAttribute('data-droppable-id')) {
                  const droppableId = currentElement.getAttribute('data-droppable-id');
                  if (droppableId && ['backlog', 'doing', 'done'].includes(droppableId)) {
                    targetLaneId = droppableId;
                    debugLog('[MemberView] handleDrop: Found lane via data-droppable-id:', {
                      domAttempts,
                      targetLaneId,
                      droppableId,
                    });
                    break;
                  }
                }

                currentElement = currentElement.parentElement;
              }
            }
          } catch (domError) {
            debugLog('[MemberView] handleDrop: DOM navigation error:', domError);
          }
        }

        // As a last resort, examine all available data
        if (!targetLaneId) {
          debugLog('[MemberView] handleDrop: Full drop entity debug:', {
            entityId: dropEntity.entityId,
            scopeId: dropEntity.scopeId,
            dropData: dropData,
            hasGetPath: typeof dropEntity.getPath === 'function',
            path: dropEntity.getPath(),
            hasGetParent: typeof dropEntity.getParent === 'function',
            hasElementRef: !!dropEntity.elementRef,
            hasMeasureRef: !!dropEntity.measureRef,
          });

          // Default to backlog if we can't determine
          targetLaneId = 'backlog';
          debugLog('[MemberView] handleDrop: Defaulting placeholder to backlog lane');
        }
      }
    } else {
      debugLog('[MemberView] handleDrop: Could not determine target lane ID');
      return;
    }

    if (!memberCard || !targetLaneId) {
      debugLog('[MemberView] handleDrop: Invalid member card or target lane', {
        hasMemberCard: !!memberCard,
        memberCardId: dragData.id,
        targetLaneId,
        dragData,
        dropData,
      });
      return;
    }

    debugLog('[MemberView] handleDrop called', {
      memberCard: {
        id: memberCard.id,
        title: memberCard.title,
        sourceBoardPath: memberCard.sourceBoardPath,
        blockId: memberCard.blockId,
      },
      targetLaneId,
    });

    // Update the card in memory immediately for responsive UI
    this.updateCardInMemory(memberCard, targetLaneId);

    // Try to update via StateManager first, fall back to direct file update if it fails
    try {
      await this.updateCardViaStateManager(memberCard, targetLaneId);
      debugLog('[MemberView] Successfully updated card via StateManager');
    } catch (stateManagerError) {
      console.warn(
        '[MemberView] StateManager update failed, trying direct file update:',
        stateManagerError
      );
      try {
        await this.updateCardForLane(memberCard, targetLaneId);
        debugLog('[MemberView] Successfully updated card via direct file update');
      } catch (directUpdateError) {
        console.error(
          '[MemberView] Both StateManager and direct file update failed:',
          directUpdateError
        );
        // Show error to user
        this.error = `Failed to update card: ${directUpdateError.message}`;
        this.setReactState({});
        return;
      }
    }

    // Trigger React re-render to show the optimistic updates without doing a full scan
    debugLog('[MemberView] Triggering React re-render to show drag and drop changes');
    this.setReactState({ lastDragDropUpdate: Date.now() });
  }

  // New method: Update card via StateManager (KanbanView approach)
  private async updateCardViaStateManager(memberCard: MemberCard, targetLaneId: string) {
    // Find the source file's StateManager
    const sourceFile = this.app.vault.getAbstractFileByPath(memberCard.sourceBoardPath);
    if (!sourceFile || !(sourceFile instanceof TFile)) {
      throw new Error(`Could not find source file: ${memberCard.sourceBoardPath}`);
    }

    // Track that we're updating this file to prevent file change detection from triggering a refresh
    this.trackFileUpdate(sourceFile.path);

    try {
      // Get or create StateManager for the file
      let stateManager = this.plugin.stateManagers.get(sourceFile);
      if (!stateManager) {
        debugLog(`[MemberView] Creating on-demand StateManager for ${sourceFile.path}`);

        try {
          // Create a temporary mock view for StateManager initialization
          const mockView = {
            file: sourceFile,
            app: this.app,
            plugin: this.plugin,
            data: '',
            getWindow: () => this.getWindow(),
            prerender: async () => {}, // No-op for mock view
            populateViewState: () => {}, // No-op for mock view
            initHeaderButtons: () => {}, // No-op for mock view
            validatePreviewCache: () => {}, // No-op for mock view
            requestSaveToDisk: async (data: string) => {
              // Save the file directly using the vault API
              await this.app.vault.modify(sourceFile, data);
            },
            showNotice: (message: string) => {
              // Show notice using the main plugin's notice system
              console.warn(`[MemberView] StateManager Notice: ${message}`);
            },
            // Add other required view properties/methods
            viewSettings: {},
            getViewState: () => ({}),
            setViewState: () => {},
          } as any;

          // Create StateManager
          stateManager = new StateManager(
            this.app,
            mockView,
            () => this.plugin.stateManagers.delete(sourceFile),
            () => this.plugin.settings
          );

          this.plugin.stateManagers.set(sourceFile, stateManager);

          // Initialize the StateManager with file data
          const fileContent = await this.app.vault.cachedRead(sourceFile);
          await stateManager.registerView(mockView, fileContent, true);

          debugLog(
            `[MemberView] Created StateManager for ${sourceFile.path}, state ID: ${stateManager.state?.id}`
          );
        } catch (error) {
          console.error(`[MemberView] Error creating StateManager for ${sourceFile.path}:`, error);
          // Remove the failed StateManager from the cache
          this.plugin.stateManagers.delete(sourceFile);
          throw new Error(`Failed to create StateManager for ${sourceFile.path}: ${error.message}`);
        }
      }

      const board = stateManager.state;
      if (!board) {
        throw new Error(`No board state found for file: ${memberCard.sourceBoardPath}`);
      }

      // Find the card in the board structure
      let foundCard: any = null;
      let sourceLaneIndex = -1;
      let cardIndex = -1;

      debugLog('[MemberView] updateCardViaStateManager: Searching for card in board structure', {
        searchingFor: {
          memberCardId: memberCard.id,
          memberCardTitle: memberCard.title,
          memberCardTitleRaw: memberCard.titleRaw,
          memberCardBlockId: memberCard.blockId,
        },
        boardStructure: {
          boardId: board.id,
          laneCount: board.children.length,
          lanes: board.children.map((lane, idx) => ({
            laneIndex: idx,
            laneId: lane.id,
            laneTitle: lane.data?.title,
            itemCount: lane.children.length,
          })),
        },
      });

      for (let laneIdx = 0; laneIdx < board.children.length; laneIdx++) {
        const lane = board.children[laneIdx];
        debugLog(
          `[MemberView] updateCardViaStateManager: Checking lane ${laneIdx} (${lane.data?.title}) with ${lane.children.length} items`
        );

        for (let itemIdx = 0; itemIdx < lane.children.length; itemIdx++) {
          const item = lane.children[itemIdx];

          debugLog(`[MemberView] updateCardViaStateManager: Checking item ${itemIdx}`, {
            itemId: item.id,
            itemTitle: item.data?.title,
            itemTitleRaw: item.data?.titleRaw,
            itemBlockId: item.data?.blockId,
            memberCardMatches: {
              idMatch: item.id === memberCard.id,
              titleMatch: item.data?.title === memberCard.title,
              titleRawMatch: item.data?.titleRaw === memberCard.titleRaw,
              blockIdMatch: memberCard.blockId && item.data?.blockId === memberCard.blockId,
            },
          });

          // Skip items without data
          if (!item.data) {
            debugLog(`[MemberView] updateCardViaStateManager: Skipping item ${itemIdx} - no data`);
            continue;
          }

          // Match by blockId or title - improved matching logic
          let isMatch = false;
          let matchReason = '';

          // Priority 1: Match by blockId (most reliable)
          if (memberCard.blockId && item.data?.blockId) {
            // Handle blockId with or without ^ prefix
            const memberBlockId = memberCard.blockId.replace(/^\^/, '');
            const itemBlockId = item.data.blockId.replace(/^\^/, '');
            if (memberBlockId === itemBlockId) {
              isMatch = true;
              matchReason = 'blockId';
            }
          }

          // Priority 2: Match by title (cleaned)
          if (!isMatch && memberCard.title && item.data?.title) {
            // Clean both titles for comparison (remove extra whitespace, newlines)
            const cleanMemberTitle = memberCard.title.trim().replace(/\s+/g, ' ');
            const cleanItemTitle = item.data.title.trim().replace(/\s+/g, ' ');
            if (cleanMemberTitle === cleanItemTitle) {
              isMatch = true;
              matchReason = 'title';
            }
          }

          // Priority 3: Match by titleRaw content (more flexible)
          if (!isMatch && memberCard.titleRaw && item.data?.titleRaw) {
            try {
              // Extract the main content before tags/assignments for comparison
              const extractMainContent = (titleRaw: string) => {
                // Remove tags, assignments, dates, priorities, and block IDs
                return titleRaw
                  .replace(/\s*@@\w+/g, '') // Remove member assignments
                  .replace(/\s*#[\w-]+/g, '') // Remove tags
                  .replace(/\s*!\w+/g, '') // Remove priorities
                  .replace(/\s*@\{[^}]+\}/g, '') // Remove dates
                  .replace(/\s*@start\{[^}]+\}/g, '') // Remove start dates
                  .replace(/\s*@end\{[^}]+\}/g, '') // Remove end dates
                  .replace(/\s*\^[a-zA-Z0-9]+/g, '') // Remove block IDs
                  .trim()
                  .replace(/\s+/g, ' '); // Normalize whitespace
              };

              const memberMainContent = extractMainContent(memberCard.titleRaw);
              const itemMainContent = extractMainContent(item.data.titleRaw);

              if (memberMainContent === itemMainContent && memberMainContent.length > 0) {
                isMatch = true;
                matchReason = 'titleRaw-content';
              }
            } catch (error) {
              console.error('[MemberView] Error in titleRaw content matching:', error);
            }
          }

          // Priority 4: Fallback to ID match (least reliable due to generation differences)
          if (!isMatch && memberCard.id === item.id) {
            isMatch = true;
            matchReason = 'id';
          }

          if (isMatch) {
            foundCard = item;
            sourceLaneIndex = laneIdx;
            cardIndex = itemIdx;
            debugLog(`[MemberView] updateCardViaStateManager: FOUND MATCHING CARD!`, {
              matchedBy: matchReason,
              foundCard: {
                id: foundCard.id,
                title: foundCard.data?.title,
                titleRaw: foundCard.data?.titleRaw,
                blockId: foundCard.data?.blockId,
              },
              memberCard: {
                id: memberCard.id,
                title: memberCard.title,
                titleRaw: memberCard.titleRaw,
                blockId: memberCard.blockId,
              },
            });
            break;
          }
        }
        if (foundCard) break;
      }

      if (!foundCard || sourceLaneIndex === -1 || cardIndex === -1) {
        throw new Error(`Card not found in board structure: ${memberCard.title}`);
      }

      debugLog('[MemberView] updateCardViaStateManager: Found card in board structure', {
        cardTitle: foundCard.data?.title,
        sourceLaneIndex,
        cardIndex,
        targetLaneId,
      });

      // Ensure foundCard.data exists
      if (!foundCard.data) {
        throw new Error(`Found card has no data: ${foundCard.id}`);
      }

      // Update the card's data based on target lane
      const updatedCardData = { ...foundCard.data };

      switch (targetLaneId) {
        case 'doing':
          // Uncheck if currently checked (moving from done to doing)
          if (updatedCardData.checked) {
            updatedCardData.checked = false;
            updatedCardData.checkChar = ' ';

            // Update titleRaw: change [x] back to [ ]
            updatedCardData.titleRaw = updatedCardData.titleRaw.replace(/^(\s*-\s*)\[x\]/, '$1[ ]');
          }

          // Add "doing" tag if not present
          if (
            !updatedCardData.metadata?.tags?.includes('doing') &&
            !updatedCardData.metadata?.tags?.includes('#doing')
          ) {
            updatedCardData.metadata = updatedCardData.metadata || {};
            updatedCardData.metadata.tags = updatedCardData.metadata.tags || [];
            updatedCardData.metadata.tags.push('#doing');

            // Update titleRaw to include the tag (preserve formatting)
            if (!updatedCardData.titleRaw.includes('#doing')) {
              // Insert #doing before any existing block ID, preserving newlines and formatting
              const blockIdMatch = updatedCardData.titleRaw.match(/^(.*?)(\s*\^[a-zA-Z0-9]+)?$/s);
              if (blockIdMatch) {
                const mainContent = blockIdMatch[1];
                const blockId = blockIdMatch[2] || '';
                updatedCardData.titleRaw = `${mainContent} #doing${blockId}`;
              } else {
                updatedCardData.titleRaw = `${updatedCardData.titleRaw} #doing`;
              }
            }
          }
          break;

        case 'backlog':
          // Uncheck if currently checked (moving from done to backlog)
          if (updatedCardData.checked) {
            updatedCardData.checked = false;
            updatedCardData.checkChar = ' ';

            // Update titleRaw: change [x] back to [ ]
            updatedCardData.titleRaw = updatedCardData.titleRaw.replace(/^(\s*-\s*)\[x\]/, '$1[ ]');
          }

          // Remove "doing" tag if present
          if (
            updatedCardData.metadata?.tags?.includes('doing') ||
            updatedCardData.metadata?.tags?.includes('#doing')
          ) {
            updatedCardData.metadata.tags = updatedCardData.metadata.tags.filter(
              (tag: string) => tag !== 'doing' && tag !== '#doing'
            );

            // Update titleRaw to remove the tag (preserve formatting)
            updatedCardData.titleRaw = updatedCardData.titleRaw.replace(/\s*#doing\b/g, '');
            // Only clean up excessive spaces, but preserve newlines
            updatedCardData.titleRaw = updatedCardData.titleRaw
              .replace(/[ \t]+/g, ' ')
              .replace(/[ \t]+$/gm, '');
          }
          break;

        case 'done':
          // Mark as done and remove "doing" tag
          updatedCardData.checked = true;
          updatedCardData.checkChar = 'x';

          if (
            updatedCardData.metadata?.tags?.includes('doing') ||
            updatedCardData.metadata?.tags?.includes('#doing')
          ) {
            updatedCardData.metadata.tags = updatedCardData.metadata.tags.filter(
              (tag: string) => tag !== 'doing' && tag !== '#doing'
            );
          }

          // Update titleRaw: change checkbox and remove doing tag (preserve formatting)
          updatedCardData.titleRaw = updatedCardData.titleRaw.replace(
            /^(\s*-\s*)\[[x ]\]/,
            '$1[x]'
          );
          updatedCardData.titleRaw = updatedCardData.titleRaw.replace(/\s*#doing\b/g, '');
          // Only clean up excessive spaces, but preserve newlines
          updatedCardData.titleRaw = updatedCardData.titleRaw
            .replace(/[ \t]+/g, ' ')
            .replace(/[ \t]+$/gm, '');

          // TRIGGER AUTO-MOVE AUTOMATION: If auto-move-done-to-lane is enabled, move to Done lane
          if (this.plugin.settings['auto-move-done-to-lane']) {
            debugLog(
              '[MemberView] updateCardViaStateManager: Auto-move-done-to-lane is enabled, will move card to Done lane in source board'
            );
            // The StateManager will automatically handle moving the card to the Done lane
            // when we call setState with the checked=true item
          }
          break;

        default:
          throw new Error(`Unknown target lane: ${targetLaneId}`);
      }

      // Create updated card
      const updatedCard = {
        ...foundCard,
        data: updatedCardData,
      };

      // Update the board using immutability-helper (same as KanbanView)
      const updatedBoard = update(board, {
        children: {
          [sourceLaneIndex]: {
            children: {
              [cardIndex]: {
                $set: updatedCard,
              },
            },
          },
        },
      });

      // Just save via StateManager (file update only, no UI update needed here)
      // The UI has already been optimistically updated by the caller
      stateManager.setState(updatedBoard, true);

      // If the card was moved to 'done' and auto-move setting is enabled,
      // trigger the auto-move automation explicitly
      if (targetLaneId === 'done' && this.plugin.settings['auto-move-done-to-lane']) {
        debugLog(
          '[MemberView] updateCardViaStateManager: Card moved to done lane with auto-move enabled - triggering automation'
        );

        // Use updateItem to trigger the handleAutoMoveDoneCard automation
        // Find the item in the updated board and call updateItem on it
        const lanes = updatedBoard.children;
        let itemForAutomation = null;

        // Find the item across all lanes
        for (const lane of lanes) {
          const item = lane.children.find((item: any) => item.id === foundCard.id);
          if (item) {
            itemForAutomation = item;
            break;
          }
        }

        if (itemForAutomation) {
          stateManager.updateItem(itemForAutomation.id, { checked: true }, lanes);
        }
      }
    } catch (error) {
      // If there's an error, clear the file tracking immediately
      this.clearFileUpdateTracking(sourceFile.path);
      throw error;
    }
    // File tracking will be automatically cleared by the timeout set in trackFileUpdate()
  }

  // Helper method to optimistically update card in memory
  private updateCardInMemory(memberCard: MemberCard, targetLaneId: string) {
    switch (targetLaneId) {
      case 'doing':
        memberCard.checked = false; // Uncheck if moving from done
        memberCard.hasDoing = true;
        if (!memberCard.tags.includes('doing') && !memberCard.tags.includes('#doing')) {
          memberCard.tags.push('#doing');
        }
        break;
      case 'backlog':
        memberCard.checked = false; // Uncheck if moving from done
        memberCard.hasDoing = false;
        memberCard.tags = memberCard.tags.filter((tag) => tag !== 'doing' && tag !== '#doing');
        break;
      case 'done':
        memberCard.checked = true;
        memberCard.hasDoing = false;
        memberCard.tags = memberCard.tags.filter((tag) => tag !== 'doing' && tag !== '#doing');
        break;
    }
  }

  // Background file update without blocking UI
  private async updateCardInBackgroundAsync(originalCard: MemberCard, targetLaneId: string) {
    const filePath = originalCard.sourceBoardPath;

    try {
      debugLog('[MemberView] Starting background file update for card:', originalCard.id);

      // Track that we're updating this file
      this.pendingFileUpdates.add(filePath);

      // Try StateManager approach first (more reliable)
      try {
        await this.updateCardViaStateManager(originalCard, targetLaneId);
        debugLog('[MemberView] Background update via StateManager successful');
        return;
      } catch (stateManagerError) {
        debugLog(
          '[MemberView] StateManager update failed, trying direct file update:',
          stateManagerError
        );
      }

      // Fallback to direct file update
      await this.updateCardForLane(originalCard, targetLaneId);
      debugLog('[MemberView] Background update via direct file modification successful');
    } catch (error) {
      console.error('[MemberView] Background file update failed:', error);

      // Revert the optimistic update by refreshing the specific card
      await this.refreshSingleCard(originalCard);

      // Show error notification
      new Notice(`Failed to save changes for "${originalCard.title}": ${error.message}`);
    } finally {
      // Always remove from pending updates
      this.pendingFileUpdates.delete(filePath);
    }
  }

  // Refresh only a specific card instead of the whole board
  private async refreshSingleCard(cardToRefresh: MemberCard) {
    try {
      debugLog('[MemberView] Refreshing single card:', cardToRefresh.id);

      // Skip full refresh if this card is pending a member update
      if (this.pendingMemberUpdates.has(cardToRefresh.id)) {
        debugLog('[MemberView] Card has pending member update, skipping refresh');
        return;
      }

      // Find the source file and re-parse just this card
      const file = this.app.vault.getAbstractFileByPath(cardToRefresh.sourceBoardPath);
      if (!file || !(file instanceof TFile)) {
        console.error(
          '[MemberView] Could not find source file for card refresh:',
          cardToRefresh.sourceBoardPath
        );
        return;
      }

      // Skip full refresh if this file is being updated by member assignment
      if (this.pendingFileUpdates.has(file.path)) {
        debugLog('[MemberView] File has pending update, skipping refresh');
        return;
      }

      const fileContent = await this.app.vault.cachedRead(file);

      // Find the card index in our member cards array
      const cardIndex = this.memberCards.findIndex((card) => card.id === cardToRefresh.id);
      if (cardIndex === -1) {
        debugLog('[MemberView] Card not found in memberCards array, doing full refresh');
        await this.scanMemberCards();
        return;
      }

      // For now, just refresh the whole board since parsing individual cards is complex
      // In the future, this could be optimized to parse just the affected lines
      await this.scanMemberCards();
    } catch (error) {
      console.error('[MemberView] Error refreshing single card:', error);
      // Fall back to full refresh
      await this.scanMemberCards();
    }
  }

  private async updateCardForLane(memberCard: MemberCard, targetLaneId: string) {
    const file = this.app.vault.getAbstractFileByPath(memberCard.sourceBoardPath);
    if (!file || !(file instanceof TFile)) {
      throw new Error(`Could not find source file: ${memberCard.sourceBoardPath}`);
    }

    const content = await this.app.vault.read(file);
    const lines = content.split('\n');

    // Convert 1-indexed line number to 0-indexed array index
    const lineIndex = (memberCard.sourceStartLine || 1) - 1;

    debugLog('[MemberView] updateCardForLane debug:', {
      cardId: memberCard.id,
      cardTitle: memberCard.title,
      sourceFile: memberCard.sourceBoardPath,
      sourceStartLine: memberCard.sourceStartLine,
      lineIndex: lineIndex,
      totalLines: lines.length,
      linesAroundTarget: {
        [lineIndex - 1]: lines[lineIndex - 1],
        [lineIndex]: lines[lineIndex],
        [lineIndex + 1]: lines[lineIndex + 1],
      },
    });

    if (lineIndex < 0 || lineIndex >= lines.length) {
      throw new Error(
        `Invalid source line number: ${memberCard.sourceStartLine} (converted to index ${lineIndex})`
      );
    }

    const originalLine = lines[lineIndex];
    let updatedLine = originalLine;

    // Check current line content for tags (not cached memberCard properties)
    const currentLineHasDoing = /\s*#doing\b/.test(originalLine);
    const currentLineIsChecked = /^(\s*-\s*)\[x\]/.test(originalLine);

    // Apply lane-specific rules
    switch (targetLaneId) {
      case 'doing':
        // Add "doing" tag if not present in the current line
        if (!currentLineHasDoing) {
          // Updated regex to handle indented/nested list items
          // This pattern allows for leading whitespace/tabs before the dash and checkbox
          const tagMatch = updatedLine.match(
            /^(\s*-\s*\[[x ]\]\s*)(.*?)(\s*#.*)?(\s*\^[a-zA-Z0-9]+)?$/
          );
          if (tagMatch) {
            const prefix = tagMatch[1]; // "    - [ ] " or "\t- [x] " etc.
            const content = tagMatch[2]; // main content
            const existingTags = tagMatch[3] || ''; // existing tags
            const blockId = tagMatch[4] || ''; // block ID
            updatedLine = `${prefix}${content} #doing${existingTags}${blockId}`;
          } else {
            // Fallback: just append the tag before any block ID
            const blockIdMatch = updatedLine.match(/^(.*?)(\s*\^[a-zA-Z0-9]+)?$/);
            if (blockIdMatch) {
              const mainContent = blockIdMatch[1];
              const blockId = blockIdMatch[2] || '';
              updatedLine = `${mainContent} #doing${blockId}`;
            } else {
              updatedLine = updatedLine.trim() + ' #doing';
            }
          }
        }
        break;

      case 'backlog':
        // Remove "doing" tag if present in the current line
        if (currentLineHasDoing) {
          updatedLine = updatedLine.replace(/\s*#doing\b/g, '');
          // Clean up excessive spaces but preserve leading indentation
          const leadingWhitespace = updatedLine.match(/^\s*/)?.[0] || '';
          const restOfLine = updatedLine.substring(leadingWhitespace.length);
          updatedLine =
            leadingWhitespace + restOfLine.replace(/[ \t]+/g, ' ').replace(/[ \t]+$/gm, '');
        }
        break;

      case 'done':
        // Mark as done and remove "doing" tag if present
        // Change [ ] to [x] (but don't change if already [x])
        if (!currentLineIsChecked) {
          updatedLine = updatedLine.replace(/^(\s*-\s*)\[[x ]\]/, '$1[x]');
        }

        // Remove "doing" tag if present in the current line
        if (currentLineHasDoing) {
          updatedLine = updatedLine.replace(/\s*#doing\b/g, '');
          // Clean up excessive spaces but preserve leading indentation
          const leadingWhitespace = updatedLine.match(/^\s*/)?.[0] || '';
          const restOfLine = updatedLine.substring(leadingWhitespace.length);
          updatedLine =
            leadingWhitespace + restOfLine.replace(/[ \t]+/g, ' ').replace(/[ \t]+$/gm, '');
        }

        // TRIGGER AUTO-MOVE AUTOMATION: If auto-move-done-to-lane is enabled
        if (this.plugin.settings['auto-move-done-to-lane']) {
          debugLog(
            '[MemberView] updateCardForLane: Auto-move-done-to-lane is enabled, will trigger automation after file save'
          );
          // After saving the file, we need to let the StateManager handle the auto-move
          // This will happen automatically when the file is processed by the StateManager
        }
        break;

      default:
        console.warn('[MemberView] Unknown target lane:', targetLaneId);
        return;
    }

    // Only update if the line actually changed
    if (updatedLine === originalLine) {
      debugLog('[MemberView] No changes needed for line');
      return;
    }

    // Update the line in the file
    lines[lineIndex] = updatedLine;
    const updatedContent = lines.join('\n');

    // Save the file
    await this.app.vault.modify(file, updatedContent);

    debugLog('[MemberView] Updated line:', {
      original: originalLine,
      updated: updatedLine,
      file: memberCard.sourceBoardPath,
      line: memberCard.sourceStartLine,
      lineIndex: lineIndex,
    });
  }

  // Efficiently update a specific card without full board refresh
  updateSpecificCard(
    cardId: string,
    updateFn: (card: MemberCard) => void,
    shouldRender: boolean = true
  ): boolean {
    const cardIndex = this.memberCards.findIndex((card) => card.id === cardId);
    if (cardIndex === -1) {
      debugLog('[MemberView] Card not found for specific update:', cardId);
      return false;
    }

    // Store original values for DOM comparison
    const originalAssignedMembers = [...(this.memberCards[cardIndex].assignedMembers || [])];
    const originalTags = [...(this.memberCards[cardIndex].tags || [])];
    const originalPriority = this.memberCards[cardIndex].priority;

    // Apply the update function to the card
    updateFn(this.memberCards[cardIndex]);

    // Check what changed and update DOM accordingly
    const newAssignedMembers = this.memberCards[cardIndex].assignedMembers || [];
    const newTags = this.memberCards[cardIndex].tags || [];
    const newPriority = this.memberCards[cardIndex].priority;

    const membersChanged =
      JSON.stringify(originalAssignedMembers) !== JSON.stringify(newAssignedMembers);
    const tagsChanged = JSON.stringify(originalTags) !== JSON.stringify(newTags);
    const priorityChanged = originalPriority !== newPriority;

    if (membersChanged) {
      // Update member badges in DOM immediately
      this.updateMemberBadgesInDOM(cardId, newAssignedMembers);
    }

    if (tagsChanged) {
      // Update tag badges in DOM immediately
      this.updateTagBadgesInDOM(cardId, newTags);
    }

    if (priorityChanged) {
      // Update priority badge in DOM immediately
      this.updatePriorityBadgeInDOM(cardId, newPriority as 'high' | 'medium' | 'low' | null);
    }

    // For metadata updates (members, tags, priority), we skip all rendering to prevent text flashing
    // The user gets immediate feedback from the DOM updates
    if (shouldRender) {
      // Only trigger React re-render for non-member updates (like priority, tags, etc.)
      this.setReactState({ lastCardUpdate: cardId, updateTime: Date.now() });
    }

    debugLog('[MemberView] Updated specific card:', cardId);
    return true;
  }

  // Handle card property updates without full refresh
  async updateCardProperty(cardId: string, property: string, value: any) {
    debugLog('[MemberView] Updating card property:', { cardId, property, value });

    // 1. Find the card
    const card = this.memberCards.find((c) => c.id === cardId);
    if (!card) {
      console.error('[MemberView] Card not found for property update:', cardId);
      return;
    }

    // 2. Store original value for potential revert
    const originalValue = (card as any)[property];

    // 3. Optimistically update the card property
    const updateSuccess = this.updateSpecificCard(cardId, (c) => {
      (c as any)[property] = value;
    });

    if (!updateSuccess) {
      return;
    }

    // 4. Update the file in background
    try {
      await this.updateCardPropertyInFile(card, property, value);
      debugLog('[MemberView] Card property update successful');
    } catch (error) {
      console.error('[MemberView] Failed to update card property in file:', error);

      // Revert the optimistic update
      this.updateSpecificCard(cardId, (c) => {
        (c as any)[property] = originalValue;
      });

      new Notice(`Failed to update ${property}: ${error.message}`);
    }
  }

  private async updateCardPropertyInFile(
    card: MemberCard,
    property: string,
    value: any
  ): Promise<void> {
    const filePath = card.sourceBoardPath;

    try {
      // Track that we're updating this file
      this.pendingFileUpdates.add(filePath);

      // This is a placeholder for property-specific file updates
      // Different properties (tags, priority, members, dates) would need different update logic
      debugLog('[MemberView] Property file update not yet implemented for:', property);

      // For now, fall back to the lane-based update system for status changes
      if (property === 'checked' || property === 'hasDoing') {
        let targetLaneId = 'backlog';
        if (card.checked) {
          targetLaneId = 'done';
        } else if (card.hasDoing) {
          targetLaneId = 'doing';
        }

        await this.updateCardForLane(card, targetLaneId);
      }
    } finally {
      // Always remove from pending updates
      this.pendingFileUpdates.delete(filePath);
    }
  }

  // Optimistically update member assignment without triggering refresh
  async updateMemberAssignment(cardId: string, member: string, isAssigning: boolean) {
    debugLog('[MemberView] Updating member assignment:', { cardId, member, isAssigning });

    // 1. Find the card
    const card = this.memberCards.find((c) => c.id === cardId);
    if (!card) {
      console.error('[MemberView] Card not found for member update:', cardId);
      return;
    }

    // 2. Store original value for potential revert
    const originalMembers = [...(card.assignedMembers || [])];

    // 3. Mark card as being updated
    this.pendingMemberUpdates.add(cardId);

    // 4. Optimistically update the card WITHOUT any rendering
    const updateSuccess = this.updateSpecificCard(
      cardId,
      (c) => {
        if (isAssigning) {
          // Add member if not already assigned
          if (!c.assignedMembers?.includes(member)) {
            c.assignedMembers = [...(c.assignedMembers || []), member];
          }
        } else {
          // Remove member if assigned
          c.assignedMembers = (c.assignedMembers || []).filter((m) => m !== member);
        }
      },
      false // NO RENDERING - user gets feedback from the member assignment UI button
    );

    if (!updateSuccess) {
      this.pendingMemberUpdates.delete(cardId);
      return;
    }

    // 5. Update the file in background WITHOUT triggering more renders
    try {
      await this.updateMemberInFileBackground(card, member, isAssigning);
      debugLog('[MemberView] Member assignment update successful');
      // NO additional render here - the optimistic update is already visible
    } catch (error) {
      console.error('[MemberView] Failed to update member in file:', error);

      // Revert the optimistic update (this will render to show the error state)
      this.updateSpecificCard(
        cardId,
        (c) => {
          c.assignedMembers = originalMembers;
        },
        true
      );

      new Notice(`Failed to update member assignment: ${error.message}`);
    } finally {
      this.pendingMemberUpdates.delete(cardId);
      // Don't trigger any React re-renders - rely purely on DOM updates
    }
  }

  // Update member in file without triggering refresh
  private async updateMemberInFileBackground(
    memberCard: MemberCard,
    member: string,
    isAssigning: boolean
  ) {
    const file = this.app.vault.getAbstractFileByPath(memberCard.sourceBoardPath);
    if (!file || !(file instanceof TFile)) {
      throw new Error(`Could not find source file: ${memberCard.sourceBoardPath}`);
    }

    // Track that we're updating this file with a timeout
    this.trackFileUpdate(file.path);

    try {
      const content = await this.app.vault.read(file);
      const lines = content.split('\n');
      const memberPrefix = '@@';
      const memberTag = `${memberPrefix}${member}`;

      debugLog('[MemberView] updateMemberInFileBackground debug:', {
        cardId: memberCard.id,
        cardTitle: memberCard.title,
        member,
        isAssigning,
        sourceStartLine: memberCard.sourceStartLine,
        memberTag,
        blockId: memberCard.blockId,
      });

      // Find the correct line that contains the member assignment
      let targetLineIndex = -1;
      let targetLine = '';

      if (isAssigning) {
        // For assignment, use the stored sourceStartLine if it doesn't already have the member
        const storedLineIndex = (memberCard.sourceStartLine || 1) - 1;
        if (storedLineIndex >= 0 && storedLineIndex < lines.length) {
          const storedLine = lines[storedLineIndex];
          if (!storedLine.includes(memberTag)) {
            targetLineIndex = storedLineIndex;
            targetLine = storedLine;
          }
        }
      } else {
        // For removal, search for the line that actually contains this member assignment
        // Start searching from the sourceStartLine and look within a reasonable range (e.g., 10 lines)
        const storedLineIndex = (memberCard.sourceStartLine || 1) - 1;
        const searchStartIndex = Math.max(0, storedLineIndex);
        const searchEndIndex = Math.min(lines.length, storedLineIndex + 10); // Search within 10 lines of the card

        debugLog('[MemberView] Searching for member in range:', {
          storedLineIndex,
          searchStartIndex,
          searchEndIndex,
          memberTag,
          blockId: memberCard.blockId,
        });

        // First, try to find it within the expected range
        for (let i = searchStartIndex; i < searchEndIndex; i++) {
          if (lines[i].includes(memberTag)) {
            // Verify this is actually a task line (contains checkbox)
            if (/\s*-\s*\[[x ]\]/.test(lines[i])) {
              targetLineIndex = i;
              targetLine = lines[i];
              debugLog('[MemberView] Found member in expected range:', {
                lineIndex: i,
                line: lines[i].substring(0, 100),
              });
              break;
            }
          }
        }

        // If we have a blockId, we can also try to find the card by its blockId and then search around it
        if (targetLineIndex === -1 && memberCard.blockId) {
          for (let i = 0; i < lines.length; i++) {
            if (lines[i].includes(`^${memberCard.blockId}`)) {
              // Found the line with the blockId, now search for member assignment in this area
              const blockIdLineIndex = i;
              const localSearchStart = Math.max(0, blockIdLineIndex);
              const localSearchEnd = Math.min(lines.length, blockIdLineIndex + 10);

              debugLog('[MemberView] Found blockId, searching around it:', {
                blockIdLineIndex,
                localSearchStart,
                localSearchEnd,
                blockIdLine: lines[i].substring(0, 100),
              });

              for (let j = localSearchStart; j < localSearchEnd; j++) {
                if (lines[j].includes(memberTag)) {
                  // Verify this is actually a task line (contains checkbox)
                  if (/\s*-\s*\[[x ]\]/.test(lines[j])) {
                    targetLineIndex = j;
                    targetLine = lines[j];
                    debugLog('[MemberView] Found member near blockId:', {
                      lineIndex: j,
                      line: lines[j].substring(0, 100),
                    });
                    break;
                  }
                }
              }
              break; // Stop after finding the blockId
            }
          }
        }

        // If still not found, fall back to the stored line (might be a parsing issue)
        if (targetLineIndex === -1) {
          const storedLineIndex = (memberCard.sourceStartLine || 1) - 1;
          if (storedLineIndex >= 0 && storedLineIndex < lines.length) {
            targetLineIndex = storedLineIndex;
            targetLine = lines[storedLineIndex];
            debugLog('[MemberView] Falling back to stored line:', {
              storedLineIndex,
              line: lines[storedLineIndex].substring(0, 100),
            });
          }
        }
      }

      if (targetLineIndex === -1 || targetLineIndex >= lines.length) {
        throw new Error(
          `Could not find target line for member update: ${memberCard.sourceStartLine}`
        );
      }

      debugLog('[MemberView] Found target line for member update:', {
        targetLineIndex,
        targetLine: targetLine.substring(0, 100),
        action: isAssigning ? 'assigning' : 'removing',
        memberTag,
      });

      let updatedLine = targetLine;

      if (isAssigning) {
        // Add member if not already present
        if (!updatedLine.includes(memberTag)) {
          // Updated regex to handle indented/nested list items
          // This pattern allows for leading whitespace/tabs before the dash and checkbox
          const tagMatch = updatedLine.match(
            /^(\s*-\s*\[[x ]\]\s*)(.*?)(\s*#.*)?(\s*\^[a-zA-Z0-9]+)?$/
          );
          if (tagMatch) {
            const prefix = tagMatch[1]; // "    - [ ] " or "\t- [x] " etc.
            const content = tagMatch[2]; // main content
            const existingTags = tagMatch[3] || ''; // existing tags
            const blockId = tagMatch[4] || ''; // block ID
            updatedLine = `${prefix}${content} ${memberTag}${existingTags}${blockId}`;
          } else {
            // Fallback: just append member before any block ID
            const blockIdMatch = updatedLine.match(/^(.*?)(\s*\^[a-zA-Z0-9]+)?$/);
            if (blockIdMatch) {
              const mainContent = blockIdMatch[1];
              const blockId = blockIdMatch[2] || '';
              updatedLine = `${mainContent} ${memberTag}${blockId}`;
            } else {
              updatedLine = updatedLine.trim() + ` ${memberTag}`;
            }
          }
        }
      } else {
        // Remove member
        const memberPattern = new RegExp(
          `\\s*${this.escapeRegExpStr(memberPrefix)}${this.escapeRegExpStr(member)}\\b`,
          'gi'
        );
        updatedLine = updatedLine.replace(memberPattern, '');
      }

      // Clean up multiple spaces but preserve leading indentation
      const leadingWhitespace = updatedLine.match(/^\s*/)?.[0] || '';
      const restOfLine = updatedLine.substring(leadingWhitespace.length);
      updatedLine = leadingWhitespace + restOfLine.replace(/\s+/g, ' ').trim();

      // Only update if the line actually changed
      if (updatedLine !== lines[targetLineIndex]) {
        lines[targetLineIndex] = updatedLine;
        const updatedContent = lines.join('\n');
        await this.app.vault.modify(file, updatedContent);
        debugLog('[MemberView] Updated member in file:', {
          file: file.path,
          member,
          isAssigning,
          targetLineIndex,
          originalLine: targetLine,
          updatedLine,
        });
      } else {
        debugLog('[MemberView] No changes needed for member update');
      }
    } catch (error) {
      // If there's an error, clear the tracking immediately
      this.clearFileUpdateTracking(file.path);
      throw error;
    }
    // No finally block needed - timeout will clean up tracking
  }

  // Helper to escape regex special characters
  private escapeRegExpStr(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // Get all directories that contain kanban boards
  getAvailableKanbanDirectories(): string[] {
    const directories = new Set<string>();
    directories.add(''); // Add empty string for vault root

    const allMdFiles = this.app.vault.getMarkdownFiles();

    for (const mdFile of allMdFiles) {
      // Check if file has kanban frontmatter (synchronously check cache first)
      const cache = this.app.metadataCache.getFileCache(mdFile);
      if (cache?.frontmatter && cache.frontmatter['kanban-plugin']) {
        // Add the parent directory path
        if (mdFile.parent && mdFile.parent.path !== '/') {
          directories.add(mdFile.parent.path);
        }
      }
    }

    return Array.from(directories).sort();
  }

  // Track a file update to prevent refresh loops with timeout
  private trackFileUpdate(filePath: string): void {
    // Clear any existing timeout for this file
    this.clearFileUpdateTracking(filePath);

    // Add to pending updates
    this.pendingFileUpdates.add(filePath);

    // Set a timeout to clear the tracking after 3 seconds
    const timeout = setTimeout(() => {
      this.clearFileUpdateTracking(filePath);
      debugLog('[MemberView] File update tracking timeout for:', filePath);
    }, 3000);

    this.fileUpdateTimeouts.set(filePath, timeout);
    debugLog('[MemberView] Tracking file update for 3 seconds:', filePath);
  }

  // Clear file update tracking
  private clearFileUpdateTracking(filePath: string): void {
    this.pendingFileUpdates.delete(filePath);

    const timeout = this.fileUpdateTimeouts.get(filePath);
    if (timeout) {
      clearTimeout(timeout);
      this.fileUpdateTimeouts.delete(filePath);
    }
  }

  // Public method to check if any updates are pending
  public hasPendingUpdates(): boolean {
    return this.pendingMemberUpdates.size > 0 || this.pendingFileUpdates.size > 0;
  }

  public hasPendingUpdatesForCard(cardId: string): boolean {
    return this.pendingMemberUpdates.has(cardId);
  }

  /**
   * Helper function to get initials from a member name
   */
  private getInitials(name: string): string {
    return name
      .split(' ')
      .map((word) => word.charAt(0).toUpperCase())
      .join('')
      .substring(0, 2);
  }

  /**
   * Helper function to get tag color from settings (using StateManager like KanbanView)
   */
  private getTagColor(tag: string): { color: string; backgroundColor: string } | null {
    // Get tag colors from plugin global settings (these are global, not per-board)
    const tagColors = this.plugin.settings['tag-colors'] || [];

    const colorSetting = tagColors.find((tc: any) => {
      // tagKey is stored with # prefix, so we need to match both ways
      return tc.tagKey === tag || tc.tagKey === `#${tag}`;
    });

    return colorSetting
      ? { color: colorSetting.color, backgroundColor: colorSetting.backgroundColor }
      : null;
  }

  /**
   * Helper function to get tag symbol from settings
   */
  private getTagSymbol(tag: string): { symbol: string; hideTag: boolean } | null {
    // Get tag symbols from plugin global settings (these are global, not per-board)
    const tagSymbols = this.plugin.settings['tag-symbols'] || [];

    const symbolSetting = tagSymbols.find((ts: any) => {
      // tagKey is stored with # prefix, so we need to match both ways
      return ts.data?.tagKey === tag || ts.data?.tagKey === `#${tag}`;
    });

    return symbolSetting?.data
      ? { symbol: symbolSetting.data.symbol, hideTag: symbolSetting.data.hideTag }
      : null;
  }

  /**
   * Helper function to get priority style
   */
  private getPriorityStyle(priority: 'high' | 'medium' | 'low'): {
    backgroundColor: string;
    color: string;
  } {
    switch (priority) {
      case 'high':
        return { backgroundColor: '#cd1e00', color: '#eeeeee' };
      case 'medium':
        return { backgroundColor: '#ff9600', color: '#ffffff' };
      case 'low':
        return { backgroundColor: '#008bff', color: '#eeeeee' };
      default:
        return { backgroundColor: 'var(--background-modifier-hover)', color: 'var(--text-normal)' };
    }
  }

  /**
   * Helper function to get date color based on settings (same logic as React components)
   */
  private getDateColor(date: moment.Moment): { color: string; backgroundColor: string } | null {
    const dateColors = this.plugin.settings['date-colors'] || [];

    // Use the same logic as the main getDateColorFn from helpers.ts
    const orders = dateColors.map<[moment.Moment | 'today' | 'before' | 'after', any]>((c: any) => {
      if (c.isToday) {
        return ['today', c];
      }
      if (c.isBefore) {
        return ['before', c];
      }
      if (c.isAfter) {
        return ['after', c];
      }
      const modifier = c.direction === 'after' ? 1 : -1;
      const date = moment();
      date.add(c.distance * modifier, c.unit);
      return [date, c];
    });

    const now = moment();
    orders.sort((a, b) => {
      if (a[0] === 'today') {
        return typeof b[0] === 'string' ? -1 : (b[0] as moment.Moment).isSame(now, 'day') ? 1 : -1;
      }
      if (b[0] === 'today') {
        return typeof a[0] === 'string' ? 1 : (a[0] as moment.Moment).isSame(now, 'day') ? -1 : 1;
      }
      if (a[0] === 'after') return 1;
      if (a[0] === 'before') return 1;
      if (b[0] === 'after') return -1;
      if (b[0] === 'before') return -1;
      return (a[0] as moment.Moment).isBefore(b[0] as moment.Moment) ? -1 : 1;
    });

    const result = orders.find((o) => {
      const key = o[1];
      if (key.isToday) return date.isSame(now, 'day');
      if (key.isAfter) return date.isAfter(now);
      if (key.isBefore) return date.isBefore(now);

      let granularity: moment.unitOfTime.StartOf = 'days';
      if (key.unit === 'hours') {
        granularity = 'hours';
      }

      if (key.direction === 'before') {
        return date.isBetween(o[0], now, granularity, '[]');
      }
      return date.isBetween(now, o[0], granularity, '[]');
    });

    return result ? result[1] : null;
  }

  /**
   * Helper function to get relative date text matching React component logic
   */
  private getRelativeDateText(date: moment.Moment): string {
    const now = moment();
    const startOfToday = moment().startOf('day');
    const startOfTomorrow = moment().add(1, 'day').startOf('day');
    const startOfYesterday = moment().subtract(1, 'day').startOf('day');
    const dateStartOfDay = moment(date).startOf('day');

    // Check if it's today, tomorrow, or yesterday
    if (dateStartOfDay.isSame(startOfToday)) {
      return 'today';
    } else if (dateStartOfDay.isSame(startOfTomorrow)) {
      return 'tomorrow';
    } else if (dateStartOfDay.isSame(startOfYesterday)) {
      return 'yesterday';
    }

    // For other dates, use moment's relative time but customize the format
    const diffDays = dateStartOfDay.diff(startOfToday, 'days');

    if (Math.abs(diffDays) < 7) {
      // Within a week - use "in X days" or "X days ago"
      if (diffDays > 0) {
        return `in ${diffDays} day${diffDays > 1 ? 's' : ''}`;
      } else {
        const absDays = Math.abs(diffDays);
        return `${absDays} day${absDays > 1 ? 's' : ''} ago`;
      }
    }

    // For dates more than a week away, use moment's built-in relative time
    return date.fromNow();
  }

  /**
   * Update member badges directly in the DOM without triggering React re-renders
   */
  private updateMemberBadgesInDOM(cardId: string, newAssignedMembers: string[]): void {
    try {
      // Find the card element by data-id
      const cardElement = this.contentEl.querySelector(`[data-id="${cardId}"]`);
      if (!cardElement) {
        debugLog('[MemberView] Card element not found for DOM update:', cardId);
        return;
      }

      // Find the assigned members container
      const membersContainer = cardElement.querySelector('.kanban-plugin__item-assigned-members');
      if (!membersContainer) {
        debugLog('[MemberView] Members container not found for DOM update:', cardId);
        return;
      }

      // Clear existing member badges
      membersContainer.innerHTML = '';

      // Add new member badges
      if (newAssignedMembers && newAssignedMembers.length > 0) {
        newAssignedMembers.forEach((member, index) => {
          const memberConfig = this.plugin.settings.teamMemberColors?.[member];
          const backgroundColor = memberConfig?.background || 'var(--background-modifier-hover)';
          const textColor =
            memberConfig?.text ||
            (memberConfig?.background ? 'var(--text-on-accent)' : 'var(--text-normal)');
          const initials = this.getInitials(member);

          // Create member badge element
          const memberBadge = document.createElement('div');
          memberBadge.className = 'kanban-plugin__item-assigned-member-initials';
          memberBadge.title = member;
          memberBadge.style.cssText = `
            background-color: ${backgroundColor};
            color: ${textColor};
            border-radius: 50%;
            width: 18px;
            height: 18px;
            display: flex;
            align-items: center;
            justify-content: center;
            margin-left: 4px;
            font-size: 12px;
            cursor: pointer;
            user-select: none;
          `;
          memberBadge.textContent = initials;

          // Add click handler for member search
          memberBadge.addEventListener('click', (e) => {
            e.preventDefault();
            const searchQueryTerm = `@@${member}`;
            const globalSearchPlugin = (this.app as any).internalPlugins.getPluginById(
              'global-search'
            );
            if (globalSearchPlugin) {
              globalSearchPlugin.instance.openGlobalSearch(searchQueryTerm);
            }
          });

          membersContainer.appendChild(memberBadge);
        });
      }

      debugLog('[MemberView] Successfully updated member badges in DOM:', {
        cardId,
        memberCount: newAssignedMembers.length,
        members: newAssignedMembers,
      });
    } catch (error) {
      debugLog('[MemberView] Error updating member badges in DOM:', error);
    }
  }

  /**
   * Update tag badges directly in the DOM without triggering React re-renders
   */
  private updateTagBadgesInDOM(cardId: string, newTags: string[]): void {
    try {
      // Find the card element by data-id
      const cardElement = this.contentEl.querySelector(`[data-id="${cardId}"]`);
      if (!cardElement) {
        debugLog('[MemberView] Card element not found for tag DOM update:', cardId);
        return;
      }

      // Find the tags container
      const tagsContainer = cardElement.querySelector('.kanban-plugin__item-tags');
      if (!tagsContainer) {
        debugLog('[MemberView] Tags container not found for DOM update:', cardId);
        return;
      }

      // Clear existing tags
      tagsContainer.innerHTML = '';

      // Add new tags
      if (newTags && newTags.length > 0) {
        const hideHashForTagsWithoutSymbols = this.plugin.settings.hideHashForTagsWithoutSymbols;
        const hideLaneTagDisplay = this.plugin.settings['hide-lane-tag-display'];
        const hideBoardTagDisplay = this.plugin.settings['hide-board-tag-display'];

        // Filter out lane and board tags if settings are enabled
        let filteredTags = newTags;
        if (hideLaneTagDisplay || hideBoardTagDisplay) {
          const boardName = this.plugin.app.workspace.getActiveFile()?.basename;

          filteredTags = newTags.filter((tag) => {
            const tagWithoutHash = tag.replace(/^#/, '').toLowerCase();

            // Check if this is a board tag (matches board name)
            if (hideBoardTagDisplay && boardName) {
              const boardTagPattern = boardName.toLowerCase().replace(/\s+/g, '-');
              if (tagWithoutHash === boardTagPattern) {
                return false; // Hide this tag
              }
            }

            // Check if this is a lane tag (matches lane name)
            if (hideLaneTagDisplay) {
              const laneNames = ['backlog', 'doing', 'done']; // Common lane names
              for (const laneName of laneNames) {
                const laneTagPattern = laneName.toLowerCase().replace(/\s+/g, '-');
                if (tagWithoutHash === laneTagPattern) {
                  return false; // Hide this tag
                }
              }
            }

            return true; // Show this tag
          });
        }

        filteredTags.forEach((tag) => {
          // Clean tag name for lookups (remove # if present)
          const cleanTag = tag.replace(/^#/, '');
          const tagColor = this.getTagColor(cleanTag);
          const symbolInfo = this.getTagSymbol(cleanTag);

          // Create tag element
          const tagElement = document.createElement('span');
          tagElement.className = 'tag kanban-plugin__item-tag';
          tagElement.title = tag;

          // Apply styling similar to original React components
          let styleCSS = 'cursor: pointer;';
          if (tagColor) {
            styleCSS += `
              color: ${tagColor.color} !important;
              background-color: ${tagColor.backgroundColor} !important;
              --tag-color: ${tagColor.color};
              --tag-background: ${tagColor.backgroundColor};
            `;
          }
          tagElement.style.cssText = styleCSS;

          // Set tag content with proper structure
          if (symbolInfo) {
            // Create symbol and text spans like React components
            const symbolSpan = document.createElement('span');
            symbolSpan.textContent = symbolInfo.symbol;
            tagElement.appendChild(symbolSpan);

            if (!symbolInfo.hideTag && cleanTag.length > 0) {
              const textSpan = document.createElement('span');
              textSpan.style.marginLeft = '0.2em';
              textSpan.textContent = cleanTag;
              tagElement.appendChild(textSpan);
            }
          } else {
            // Simple text content
            let tagContent = '';
            if (hideHashForTagsWithoutSymbols) {
              tagContent = cleanTag;
            } else {
              tagContent = tag;
            }
            tagElement.textContent = tagContent;
          }

          // Add click handler for tag search
          tagElement.addEventListener('click', (e) => {
            e.preventDefault();
            const globalSearchPlugin = (this.app as any).internalPlugins.getPluginById(
              'global-search'
            );
            if (globalSearchPlugin) {
              globalSearchPlugin.instance.openGlobalSearch(`tag:${tag}`);
            }
          });

          tagsContainer.appendChild(tagElement);
        });
      }

      debugLog('[MemberView] Successfully updated tag badges in DOM:', {
        cardId,
        tagCount: newTags.length,
        tags: newTags,
      });
    } catch (error) {
      debugLog('[MemberView] Error updating tag badges in DOM:', error);
    }
  }

  /**
   * Update date display directly in the DOM without triggering React re-renders
   */
  private updateDateDisplayInDOM(cardId: string, newDate: moment.Moment | undefined): void {
    try {
      // Find the card element by data-id
      const cardElement = this.contentEl.querySelector(`[data-id="${cardId}"]`);
      if (!cardElement) {
        debugLog('[MemberView] Card element not found for date DOM update:', cardId);
        return;
      }

      // Find the existing date lozenge (React component styling)
      const existingDateLozenge = cardElement.querySelector(
        '.kanban-plugin__item-metadata-date-lozenge'
      );

      if (!newDate) {
        // Remove date display if date was removed
        if (existingDateLozenge) {
          existingDateLozenge.remove();
        }
        debugLog('[MemberView] Removed date display from DOM:', { cardId });
        return;
      }

      // Format the date for display - match React component logic
      const dateFormat = this.plugin.settings['date-display-format'] || 'YYYY-MM-DD';
      const formattedDate = newDate.format(dateFormat);
      const shouldShowRelativeDate = this.plugin.settings['show-relative-date'];

      let displayText = formattedDate;
      let titleText = `Due: ${formattedDate}`;

      if (shouldShowRelativeDate) {
        // Use the same relative date logic as React components
        displayText = this.getRelativeDateText(newDate);
        titleText = `Due: ${formattedDate} (${displayText})`;
      }

      // Use the same date color logic as React components
      const dateColorResult = this.getDateColor(newDate);

      // Apply date colors from settings, or use fallback colors
      let dateColor: string;
      let backgroundColor: string;

      if (dateColorResult) {
        // Use configured date colors
        dateColor = dateColorResult.color;
        backgroundColor = dateColorResult.backgroundColor || 'rgba(0, 0, 0, 0.02)';
      } else {
        // Use fallback coloring if no date colors are configured (same as React components)
        let fallbackColor = 'var(--text-muted)';
        const fallbackBackground = 'transparent';

        if (newDate.isValid()) {
          const now = moment();
          if (newDate.isSame(now, 'day')) {
            // Today - blue
            fallbackColor = 'var(--color-blue)';
          } else if (newDate.isBefore(now, 'day')) {
            // Past - red
            fallbackColor = 'var(--color-red)';
          } else {
            // Future - green
            fallbackColor = 'var(--color-green)';
          }
        }

        dateColor = fallbackColor;
        backgroundColor = fallbackBackground;
      }

      if (existingDateLozenge) {
        // Update existing date lozenge - clear content completely first
        existingDateLozenge.innerHTML = '';

        // Create fresh inner span for text
        const textSpan = document.createElement('span');
        textSpan.style.cursor = 'pointer';
        textSpan.textContent = displayText;
        existingDateLozenge.appendChild(textSpan);

        (existingDateLozenge as HTMLElement).title = titleText;
        (existingDateLozenge as HTMLElement).style.color = dateColor;
        (existingDateLozenge as HTMLElement).style.backgroundColor = backgroundColor;
      } else {
        // Create new date lozenge matching React component styling
        const dateElement = document.createElement('div');
        dateElement.className = 'kanban-plugin__item-metadata-date-lozenge';
        dateElement.setAttribute('aria-label', 'Search date');
        dateElement.title = titleText;
        dateElement.style.cssText = `
          cursor: pointer;
          padding: 1px 5px;
          border-radius: 3px;
          font-size: 0.9em;
          display: inline-flex;
          align-items: center;
          background-color: ${backgroundColor};
          color: ${dateColor};
          flex-grow: 0;
          flex-shrink: 0;
          margin-right: 0px;
          margin-left: 4px;
          margin-bottom: 7px;
        `;

        // Create inner span for text
        const textSpan = document.createElement('span');
        textSpan.style.cursor = 'pointer';
        textSpan.textContent = displayText;
        dateElement.appendChild(textSpan);

        // Add click handler for date search
        dateElement.addEventListener('click', (e) => {
          e.preventDefault();
          const searchQueryTerm = `path:"${cardId}" /@\\{.*\\}/`;
          const globalSearchPlugin = (this.app as any).internalPlugins.getPluginById(
            'global-search'
          );
          if (globalSearchPlugin) {
            globalSearchPlugin.instance.openGlobalSearch(searchQueryTerm);
          }
        });

        // Insert into the left side of bottom metadata (same as React components)
        const bottomMetadata = cardElement.querySelector('.kanban-plugin__item-bottom-metadata');
        if (bottomMetadata) {
          const leftContainer = bottomMetadata.querySelector('div:first-child');
          if (leftContainer) {
            leftContainer.appendChild(dateElement);
          } else {
            // Create left container if it doesn't exist
            const newLeftContainer = document.createElement('div');
            newLeftContainer.style.cssText = 'display: flex; align-items: flex-end;';
            newLeftContainer.appendChild(dateElement);
            bottomMetadata.insertBefore(newLeftContainer, bottomMetadata.firstChild);
          }
        }
      }

      debugLog('[MemberView] Successfully updated date display in DOM:', {
        cardId,
        formattedDate,
        displayText,
        shouldShowRelativeDate,
      });

      // Set the date text again after 1ms to overwrite any React interference
      setTimeout(() => {
        const dateElement = cardElement.querySelector('.kanban-plugin__item-metadata-date-lozenge');
        if (dateElement) {
          // Clear and recreate content completely to prevent text appending
          dateElement.innerHTML = '';

          const textSpan = document.createElement('span');
          textSpan.style.cursor = 'pointer';
          textSpan.textContent = displayText;
          dateElement.appendChild(textSpan);

          debugLog('[MemberView] Re-applied date text after React interference:', {
            cardId,
            displayText,
            finalText: textSpan.textContent,
          });
        }
      }, 1);
    } catch (error) {
      debugLog('[MemberView] Error updating date display in DOM:', error);
    }
  }

  /**
   * Update priority badge directly in the DOM without triggering React re-renders
   */
  private updatePriorityBadgeInDOM(
    cardId: string,
    newPriority: 'high' | 'medium' | 'low' | null
  ): void {
    try {
      // Find the card element by data-id
      const cardElement = this.contentEl.querySelector(`[data-id="${cardId}"]`);
      if (!cardElement) {
        debugLog('[MemberView] Card element not found for priority DOM update:', cardId);
        return;
      }

      // Find all priority containers to ensure we update all instances
      const priorityContainers = cardElement.querySelectorAll('.kanban-plugin__item-priority');
      const priorityContainer = priorityContainers[0]; // Use first one for updating

      debugLog('[MemberView] Found priority containers:', {
        cardId,
        containerCount: priorityContainers.length,
        existingTexts: Array.from(priorityContainers).map((el) => el.textContent),
      });

      if (!newPriority) {
        // Remove all priority elements if they exist
        priorityContainers.forEach((container) => container.remove());
        debugLog('[MemberView] Removed priority badges from DOM:', {
          cardId,
          removedCount: priorityContainers.length,
        });
        return;
      }

      const priorityStyle = this.getPriorityStyle(newPriority);
      let displayPriority = newPriority.charAt(0).toUpperCase() + newPriority.slice(1);

      // Check if we need to abbreviate "Medium" based on assigned members count
      const membersContainer = cardElement.querySelector('.kanban-plugin__item-assigned-members');
      const memberCount = membersContainer ? membersContainer.children.length : 0;
      if (newPriority === 'medium' && memberCount >= 2) {
        displayPriority = 'Med';
      }

      if (priorityContainer) {
        // Update existing priority containers - remove extras and update the first one
        priorityContainers.forEach((container, index) => {
          if (index === 0) {
            // Update the first container
            container.innerHTML = '';
            (container as HTMLElement).style.cssText = `
              background-color: ${priorityStyle.backgroundColor};
              color: ${priorityStyle.color};
              padding: 1px 6px;
              border-radius: 4px;
              font-size: 0.85em;
              font-weight: 500;
              margin-left: -2px;
              margin-right: 7px;
              text-transform: capitalize;
              margin-bottom: 7px;
            `;
            container.textContent = displayPriority;
            (container as HTMLElement).title = `Priority: ${displayPriority}`;
          } else {
            // Remove duplicate containers
            container.remove();
          }
        });
      } else {
        // Create new priority element
        const priorityElement = document.createElement('div');
        priorityElement.className = 'kanban-plugin__item-priority';
        priorityElement.style.cssText = `
          background-color: ${priorityStyle.backgroundColor};
          color: ${priorityStyle.color};
          padding: 1px 6px;
          border-radius: 4px;
          font-size: 0.85em;
          font-weight: 500;
          margin-left: -2px;
          margin-right: 7px;
          text-transform: capitalize;
          margin-bottom: 7px;
        `;
        priorityElement.textContent = displayPriority;
        priorityElement.title = `Priority: ${displayPriority}`;

        // Insert priority at the right position (after members, before other elements)
        const bottomMetadataContainer = cardElement.querySelector(
          '.kanban-plugin__item-bottom-metadata'
        );
        if (bottomMetadataContainer) {
          const rightContainer = bottomMetadataContainer.querySelector('div:last-child');
          if (rightContainer) {
            rightContainer.appendChild(priorityElement);
          }
        }
      }

      debugLog('[MemberView] Successfully updated priority badge in DOM:', {
        cardId,
        priority: newPriority,
        displayPriority,
        finalText: cardElement.querySelector('.kanban-plugin__item-priority')?.textContent,
      });

      // Set the text again after 1ms to overwrite any React interference
      setTimeout(() => {
        const priorityElement = cardElement.querySelector('.kanban-plugin__item-priority');
        if (priorityElement) {
          priorityElement.textContent = displayPriority;
          debugLog('[MemberView] Re-applied priority text after React interference:', {
            cardId,
            displayPriority,
            finalText: priorityElement.textContent,
          });
        }
      }, 1);
    } catch (error) {
      debugLog('[MemberView] Error updating priority badge in DOM:', error);
    }
  }

  // Optimistically update tag assignment without triggering refresh
  async updateTagAssignment(cardId: string, tag: string, isAssigning: boolean) {
    debugLog('[MemberView] Updating tag assignment:', { cardId, tag, isAssigning });

    // 1. Find the card
    const card = this.memberCards.find((c) => c.id === cardId);
    if (!card) {
      console.error('[MemberView] Card not found for tag update:', cardId);
      return;
    }

    // 2. Store original value for potential revert
    const originalTags = [...(card.tags || [])];

    // 3. Mark card as being updated
    this.pendingMemberUpdates.add(cardId);

    // 4. Optimistically update the card WITHOUT any rendering
    const updateSuccess = this.updateSpecificCard(
      cardId,
      (c) => {
        const tagWithHash = tag.startsWith('#') ? tag : `#${tag}`;
        if (isAssigning) {
          // Add tag if not already assigned
          if (!c.tags?.includes(tagWithHash)) {
            c.tags = [...(c.tags || []), tagWithHash];
          }
        } else {
          // Remove tag if assigned
          c.tags = (c.tags || []).filter((t) => t !== tagWithHash);
        }
      },
      false // NO RENDERING - user gets feedback from the DOM update
    );

    if (!updateSuccess) {
      this.pendingMemberUpdates.delete(cardId);
      return;
    }

    // 5. Update the file in background WITHOUT triggering more renders
    try {
      await this.updateTagInFileBackground(card, tag, isAssigning);
      debugLog('[MemberView] Tag assignment update successful');
    } catch (error) {
      console.error('[MemberView] Failed to update tag in file:', error);

      // Revert the optimistic update
      this.updateSpecificCard(
        cardId,
        (c) => {
          c.tags = originalTags;
        },
        true
      );

      new Notice(`Failed to update tag assignment: ${error.message}`);
    } finally {
      this.pendingMemberUpdates.delete(cardId);
      // Don't trigger any React re-renders - rely purely on DOM updates
    }
  }

  // Update tag in file without triggering refresh
  private async updateTagInFileBackground(
    memberCard: MemberCard,
    tag: string,
    isAssigning: boolean
  ) {
    const file = this.app.vault.getAbstractFileByPath(memberCard.sourceBoardPath);
    if (!file || !(file instanceof TFile)) {
      throw new Error(`Could not find source file: ${memberCard.sourceBoardPath}`);
    }

    // Track that we're updating this file with a timeout
    this.trackFileUpdate(file.path);

    try {
      const content = await this.app.vault.read(file);
      const lines = content.split('\n');
      const tagClean = tag.replace(/^#/, '');
      const tagWithHash = `#${tagClean}`;

      debugLog('[MemberView] updateTagInFileBackground debug:', {
        cardId: memberCard.id,
        cardTitle: memberCard.title,
        tag,
        isAssigning,
        sourceStartLine: memberCard.sourceStartLine,
        tagWithHash,
        blockId: memberCard.blockId,
      });

      // Find the correct line that contains the tag assignment
      let targetLineIndex = -1;
      let targetLine = '';

      if (isAssigning) {
        // For assignment, use the stored sourceStartLine if it doesn't already have the tag
        const storedLineIndex = (memberCard.sourceStartLine || 1) - 1;
        if (storedLineIndex >= 0 && storedLineIndex < lines.length) {
          const storedLine = lines[storedLineIndex];
          if (!storedLine.includes(tagWithHash)) {
            targetLineIndex = storedLineIndex;
            targetLine = storedLine;
          }
        }
      } else {
        // For removal, search for the line that actually contains this tag
        // Start searching from the sourceStartLine and look within a reasonable range (e.g., 10 lines)
        const storedLineIndex = (memberCard.sourceStartLine || 1) - 1;
        const searchStartIndex = Math.max(0, storedLineIndex);
        const searchEndIndex = Math.min(lines.length, storedLineIndex + 10); // Search within 10 lines of the card

        debugLog('[MemberView] Searching for tag in range:', {
          storedLineIndex,
          searchStartIndex,
          searchEndIndex,
          tagWithHash,
          blockId: memberCard.blockId,
        });

        // First, try to find it within the expected range
        for (let i = searchStartIndex; i < searchEndIndex; i++) {
          if (lines[i].includes(tagWithHash)) {
            // Verify this is actually a task line (contains checkbox)
            if (/\s*-\s*\[[x ]\]/.test(lines[i])) {
              targetLineIndex = i;
              targetLine = lines[i];
              debugLog('[MemberView] Found tag in expected range:', {
                lineIndex: i,
                line: lines[i].substring(0, 100),
              });
              break;
            }
          }
        }

        // If we have a blockId, we can also try to find the card by its blockId and then search around it
        if (targetLineIndex === -1 && memberCard.blockId) {
          for (let i = 0; i < lines.length; i++) {
            if (lines[i].includes(`^${memberCard.blockId}`)) {
              // Found the line with the blockId, now search for tag in this area
              const blockIdLineIndex = i;
              const localSearchStart = Math.max(0, blockIdLineIndex);
              const localSearchEnd = Math.min(lines.length, blockIdLineIndex + 10);

              debugLog('[MemberView] Found blockId, searching around it for tag:', {
                blockIdLineIndex,
                localSearchStart,
                localSearchEnd,
                blockIdLine: lines[i].substring(0, 100),
              });

              for (let j = localSearchStart; j < localSearchEnd; j++) {
                if (lines[j].includes(tagWithHash)) {
                  // Verify this is actually a task line (contains checkbox)
                  if (/\s*-\s*\[[x ]\]/.test(lines[j])) {
                    targetLineIndex = j;
                    targetLine = lines[j];
                    debugLog('[MemberView] Found tag near blockId:', {
                      lineIndex: j,
                      line: lines[j].substring(0, 100),
                    });
                    break;
                  }
                }
              }
              break; // Stop after finding the blockId
            }
          }
        }

        // If still not found, fall back to the stored line (might be a parsing issue)
        if (targetLineIndex === -1) {
          const storedLineIndex = (memberCard.sourceStartLine || 1) - 1;
          if (storedLineIndex >= 0 && storedLineIndex < lines.length) {
            targetLineIndex = storedLineIndex;
            targetLine = lines[storedLineIndex];
            debugLog('[MemberView] Falling back to stored line for tag:', {
              storedLineIndex,
              line: lines[storedLineIndex].substring(0, 100),
            });
          }
        }
      }

      if (targetLineIndex === -1 || targetLineIndex >= lines.length) {
        throw new Error(`Could not find target line for tag update: ${memberCard.sourceStartLine}`);
      }

      debugLog('[MemberView] Found target line for tag update:', {
        targetLineIndex,
        targetLine: targetLine.substring(0, 100),
        action: isAssigning ? 'assigning' : 'removing',
        tagWithHash,
      });

      let updatedLine = targetLine;

      if (isAssigning) {
        // Add tag if not already present
        if (!updatedLine.includes(tagWithHash)) {
          // Insert tag before any block ID
          const blockIdMatch = updatedLine.match(/^(.*?)(\s*\^[a-zA-Z0-9]+)?$/);
          if (blockIdMatch) {
            const mainContent = blockIdMatch[1];
            const blockId = blockIdMatch[2] || '';
            updatedLine = `${mainContent} ${tagWithHash}${blockId}`;
          } else {
            updatedLine = updatedLine.trim() + ` ${tagWithHash}`;
          }
        }
      } else {
        // Remove tag
        const tagPattern = new RegExp(`\\s*#?${this.escapeRegExpStr(tagClean)}\\b`, 'gi');
        updatedLine = updatedLine.replace(tagPattern, '');
      }

      // Clean up multiple spaces but preserve leading indentation
      const leadingWhitespace = updatedLine.match(/^\s*/)?.[0] || '';
      const restOfLine = updatedLine.substring(leadingWhitespace.length);
      updatedLine = leadingWhitespace + restOfLine.replace(/\s+/g, ' ').trim();

      // Only update if the line actually changed
      if (updatedLine !== lines[targetLineIndex]) {
        lines[targetLineIndex] = updatedLine;
        const updatedContent = lines.join('\n');
        await this.app.vault.modify(file, updatedContent);
        debugLog('[MemberView] Updated tag in file:', {
          file: file.path,
          tag,
          isAssigning,
          targetLineIndex,
          originalLine: targetLine,
          updatedLine,
        });
      } else {
        debugLog('[MemberView] No changes needed for tag update');
      }
    } catch (error) {
      // If there's an error, clear the tracking immediately
      this.clearFileUpdateTracking(file.path);
      throw error;
    }
  }

  // Optimistically update priority without triggering refresh
  async updatePriorityAssignment(cardId: string, newPriority: 'high' | 'medium' | 'low' | null) {
    debugLog('[MemberView] Updating priority assignment:', { cardId, newPriority });

    // 1. Find the card
    const card = this.memberCards.find((c) => c.id === cardId);
    if (!card) {
      console.error('[MemberView] Card not found for priority update:', cardId);
      return;
    }

    // 2. Store original value for potential revert
    const originalPriority = card.priority;

    // 3. Mark card as being updated
    this.pendingMemberUpdates.add(cardId);

    // 4. Optimistically update the card WITHOUT any rendering
    const updateSuccess = this.updateSpecificCard(
      cardId,
      (c) => {
        c.priority = newPriority || undefined;
      },
      false // NO RENDERING - user gets feedback from the DOM update
    );

    if (!updateSuccess) {
      this.pendingMemberUpdates.delete(cardId);
      return;
    }

    // 5. Update the file in background WITHOUT triggering more renders
    try {
      await this.updatePriorityInFileBackground(card, newPriority);
      debugLog('[MemberView] Priority assignment update successful');
    } catch (error) {
      console.error('[MemberView] Failed to update priority in file:', error);

      // Revert the optimistic update
      this.updateSpecificCard(
        cardId,
        (c) => {
          c.priority = originalPriority;
        },
        true
      );

      new Notice(`Failed to update priority: ${error.message}`);
    } finally {
      this.pendingMemberUpdates.delete(cardId);
      // Don't trigger any React re-renders - rely purely on DOM updates
    }
  }

  // Optimistically update date without triggering refresh
  async updateDateAssignment(cardId: string, newTitleRaw: string) {
    debugLog('[MemberView] Updating date assignment:', { cardId, newTitleRaw });

    // 1. Find the card
    const card = this.memberCards.find((c) => c.id === cardId);
    if (!card) {
      console.error('[MemberView] Card not found for date update:', cardId);
      return;
    }

    // 2. Store original values for potential revert
    const originalTitleRaw = card.titleRaw;
    const originalDate = card.date;

    // 3. Mark card as being updated
    this.pendingMemberUpdates.add(cardId);

    // 4. Parse the new date from titleRaw
    const dateTrigger = '@'; // Default date trigger
    const escapeRegExpStr = (str: string) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const dateRegExText = `(?:^|\\s)${escapeRegExpStr(dateTrigger)}(?:\\w*)?(?:\\{([^\\}]+?)\\}|\\[\\[([^\\]]+?)\\]\\])`;
    const dateRegEx = new RegExp(dateRegExText, 'gi');

    let newDateStr: string | undefined;
    let newDate: moment.Moment | undefined;

    const dateMatch = dateRegEx.exec(newTitleRaw);
    if (dateMatch) {
      newDateStr = dateMatch[1] || dateMatch[2]; // From {} or [[]]
      if (newDateStr) {
        newDate = moment(newDateStr, this.plugin.settings['date-format'] || 'YYYY-MM-DD');
      }
    }

    // 5. Optimistically update the card WITHOUT any rendering
    const updateSuccess = this.updateSpecificCard(
      cardId,
      (c) => {
        c.titleRaw = newTitleRaw;
        c.date = newDate;
      },
      false // NO RENDERING - user gets feedback from the DOM update
    );

    if (!updateSuccess) {
      this.pendingMemberUpdates.delete(cardId);
      return;
    }

    // 6. Update DOM to show new date
    this.updateDateDisplayInDOM(cardId, newDate);

    // 7. Update the file in background WITHOUT triggering more renders
    try {
      await this.updateDateInFileBackground(card, newTitleRaw);
      debugLog('[MemberView] Date assignment update successful');
    } catch (error) {
      console.error('[MemberView] Failed to update date in file:', error);

      // Revert the optimistic update
      this.updateSpecificCard(
        cardId,
        (c) => {
          c.titleRaw = originalTitleRaw;
          c.date = originalDate;
        },
        true
      );

      // Revert DOM display
      this.updateDateDisplayInDOM(cardId, originalDate);

      new Notice(`Failed to update date: ${error.message}`);
    } finally {
      this.pendingMemberUpdates.delete(cardId);
      // Don't trigger any React re-renders - rely purely on DOM updates
    }
  }

  // Update date in file without triggering refresh
  private async updateDateInFileBackground(memberCard: MemberCard, newTitleRaw: string) {
    const file = this.app.vault.getAbstractFileByPath(memberCard.sourceBoardPath);
    if (!file || !(file instanceof TFile)) {
      throw new Error(`Could not find source file: ${memberCard.sourceBoardPath}`);
    }

    // Track that we're updating this file with a timeout
    this.trackFileUpdate(file.path);

    try {
      const content = await this.app.vault.read(file);
      const lines = content.split('\n');

      debugLog('[MemberView] updateDateInFileBackground debug:', {
        cardId: memberCard.id,
        cardTitle: memberCard.title,
        newTitleRaw,
        sourceStartLine: memberCard.sourceStartLine,
        blockId: memberCard.blockId,
      });

      // Find the correct line to update
      let targetLineIndex = -1;
      let targetLine = '';

      // Use the stored sourceStartLine as the primary target
      const storedLineIndex = (memberCard.sourceStartLine || 1) - 1;
      if (storedLineIndex >= 0 && storedLineIndex < lines.length) {
        targetLineIndex = storedLineIndex;
        targetLine = lines[storedLineIndex];
      }

      // If we have a blockId, we can also try to find the card by its blockId for verification
      if (memberCard.blockId && targetLineIndex !== -1) {
        const targetLineContainsBlockId = lines[targetLineIndex].includes(`^${memberCard.blockId}`);
        if (!targetLineContainsBlockId) {
          // Search for the line with this blockId
          for (let i = 0; i < lines.length; i++) {
            if (lines[i].includes(`^${memberCard.blockId}`)) {
              targetLineIndex = i;
              targetLine = lines[i];
              debugLog('[MemberView] Found line via blockId:', {
                lineIndex: i,
                line: lines[i].substring(0, 100),
              });
              break;
            }
          }
        }
      }

      if (targetLineIndex === -1 || targetLineIndex >= lines.length) {
        throw new Error(
          `Could not find target line for date update: ${memberCard.sourceStartLine}`
        );
      }

      debugLog('[MemberView] Found target line for date update:', {
        targetLineIndex,
        targetLine: targetLine.substring(0, 100),
        newTitleRaw: newTitleRaw.substring(0, 100),
      });

      // Replace the entire line with the new titleRaw
      lines[targetLineIndex] = newTitleRaw;
      const updatedContent = lines.join('\n');
      await this.app.vault.modify(file, updatedContent);

      debugLog('[MemberView] Updated date in file:', {
        file: file.path,
        targetLineIndex,
        originalLine: targetLine,
        updatedLine: newTitleRaw,
      });
    } catch (error) {
      // If there's an error, clear the tracking immediately
      this.clearFileUpdateTracking(file.path);
      throw error;
    }
  }

  // Update priority in file without triggering refresh
  private async updatePriorityInFileBackground(
    memberCard: MemberCard,
    newPriority: 'high' | 'medium' | 'low' | null
  ) {
    const file = this.app.vault.getAbstractFileByPath(memberCard.sourceBoardPath);
    if (!file || !(file instanceof TFile)) {
      throw new Error(`Could not find source file: ${memberCard.sourceBoardPath}`);
    }

    // Track that we're updating this file with a timeout
    this.trackFileUpdate(file.path);

    try {
      const content = await this.app.vault.read(file);
      const lines = content.split('\n');

      debugLog('[MemberView] updatePriorityInFileBackground debug:', {
        cardId: memberCard.id,
        cardTitle: memberCard.title,
        newPriority,
        sourceStartLine: memberCard.sourceStartLine,
        blockId: memberCard.blockId,
      });

      // Find the correct line that contains the priority or where priority should be added
      let targetLineIndex = -1;
      let targetLine = '';

      if (newPriority) {
        // For assignment, use the stored sourceStartLine if it doesn't already have a priority
        const storedLineIndex = (memberCard.sourceStartLine || 1) - 1;
        if (storedLineIndex >= 0 && storedLineIndex < lines.length) {
          targetLineIndex = storedLineIndex;
          targetLine = lines[storedLineIndex];
        }
      } else {
        // For removal, search for the line that actually contains a priority
        // Start searching from the sourceStartLine and look within a reasonable range (e.g., 10 lines)
        const storedLineIndex = (memberCard.sourceStartLine || 1) - 1;
        const searchStartIndex = Math.max(0, storedLineIndex);
        const searchEndIndex = Math.min(lines.length, storedLineIndex + 10); // Search within 10 lines of the card

        debugLog('[MemberView] Searching for priority in range:', {
          storedLineIndex,
          searchStartIndex,
          searchEndIndex,
          blockId: memberCard.blockId,
        });

        // First, try to find it within the expected range
        for (let i = searchStartIndex; i < searchEndIndex; i++) {
          if (/!(low|medium|high)\b/i.test(lines[i])) {
            // Verify this is actually a task line (contains checkbox)
            if (/\s*-\s*\[[x ]\]/.test(lines[i])) {
              targetLineIndex = i;
              targetLine = lines[i];
              debugLog('[MemberView] Found priority in expected range:', {
                lineIndex: i,
                line: lines[i].substring(0, 100),
              });
              break;
            }
          }
        }

        // If we have a blockId, we can also try to find the card by its blockId and then search around it
        if (targetLineIndex === -1 && memberCard.blockId) {
          for (let i = 0; i < lines.length; i++) {
            if (lines[i].includes(`^${memberCard.blockId}`)) {
              // Found the line with the blockId, now search for priority in this area
              const blockIdLineIndex = i;
              const localSearchStart = Math.max(0, blockIdLineIndex);
              const localSearchEnd = Math.min(lines.length, blockIdLineIndex + 10);

              debugLog('[MemberView] Found blockId, searching around it for priority:', {
                blockIdLineIndex,
                localSearchStart,
                localSearchEnd,
                blockIdLine: lines[i].substring(0, 100),
              });

              for (let j = localSearchStart; j < localSearchEnd; j++) {
                if (/!(low|medium|high)\b/i.test(lines[j])) {
                  // Verify this is actually a task line (contains checkbox)
                  if (/\s*-\s*\[[x ]\]/.test(lines[j])) {
                    targetLineIndex = j;
                    targetLine = lines[j];
                    debugLog('[MemberView] Found priority near blockId:', {
                      lineIndex: j,
                      line: lines[j].substring(0, 100),
                    });
                    break;
                  }
                }
              }
              break; // Stop after finding the blockId
            }
          }
        }

        // If still not found, fall back to the stored line (might be a parsing issue)
        if (targetLineIndex === -1) {
          const storedLineIndex = (memberCard.sourceStartLine || 1) - 1;
          if (storedLineIndex >= 0 && storedLineIndex < lines.length) {
            targetLineIndex = storedLineIndex;
            targetLine = lines[storedLineIndex];
            debugLog('[MemberView] Falling back to stored line for priority:', {
              storedLineIndex,
              line: lines[storedLineIndex].substring(0, 100),
            });
          }
        }
      }

      if (targetLineIndex === -1 || targetLineIndex >= lines.length) {
        throw new Error(
          `Could not find target line for priority update: ${memberCard.sourceStartLine}`
        );
      }

      debugLog('[MemberView] Found target line for priority update:', {
        targetLineIndex,
        targetLine: targetLine.substring(0, 100),
        action: newPriority ? 'setting' : 'removing',
        newPriority,
      });

      let updatedLine = targetLine;

      // Remove existing priority
      updatedLine = updatedLine.replace(/\s*!(low|medium|high)\b/gi, '');

      // Add new priority if specified
      if (newPriority) {
        // Updated regex to handle indented/nested list items
        // This pattern allows for leading whitespace/tabs before the dash and checkbox
        const tagMatch = updatedLine.match(
          /^(\s*-\s*\[[x ]\]\s*)(.*?)(\s*#.*)?(\s*\^[a-zA-Z0-9]+)?$/
        );
        if (tagMatch) {
          const prefix = tagMatch[1]; // "    - [ ] " or "\t- [x] " etc.
          const content = tagMatch[2]; // main content
          const existingTags = tagMatch[3] || ''; // existing tags
          const blockId = tagMatch[4] || ''; // block ID
          updatedLine = `${prefix}${content} !${newPriority}${existingTags}${blockId}`;
        } else {
          // Fallback: just append the priority before any block ID
          const blockIdMatch = updatedLine.match(/^(.*?)(\s*\^[a-zA-Z0-9]+)?$/);
          if (blockIdMatch) {
            const mainContent = blockIdMatch[1];
            const blockId = blockIdMatch[2] || '';
            updatedLine = `${mainContent} !${newPriority}${blockId}`;
          } else {
            updatedLine = updatedLine.trim() + ` !${newPriority}`;
          }
        }
      }

      // Clean up multiple spaces but preserve leading indentation
      const leadingWhitespace = updatedLine.match(/^\s*/)?.[0] || '';
      const restOfLine = updatedLine.substring(leadingWhitespace.length);
      updatedLine = leadingWhitespace + restOfLine.replace(/\s+/g, ' ').trim();

      // Only update if the line actually changed
      if (updatedLine !== lines[targetLineIndex]) {
        lines[targetLineIndex] = updatedLine;
        const updatedContent = lines.join('\n');
        await this.app.vault.modify(file, updatedContent);
        debugLog('[MemberView] Updated priority in file:', {
          file: file.path,
          newPriority,
          targetLineIndex,
          originalLine: targetLine,
          updatedLine,
        });
      } else {
        debugLog('[MemberView] No changes needed for priority update');
      }
    } catch (error) {
      // If there's an error, clear the tracking immediately
      this.clearFileUpdateTracking(file.path);
      throw error;
    }
  }

  // Sort member cards based on current sort settings
  private sortMemberCards(cards: MemberCard[]): MemberCard[] {
    return cards.sort((a, b) => {
      let primaryComparison = 0;
      let secondaryComparison = 0;

      if (this.sortBy === 'dueDate') {
        // Primary sort: Due date
        const aDate = a.date;
        const bDate = b.date;

        if (!aDate && !bDate) {
          primaryComparison = 0;
        } else if (!aDate) {
          primaryComparison = 1; // Cards without dates go to the end
        } else if (!bDate) {
          primaryComparison = -1; // Cards without dates go to the end
        } else {
          primaryComparison = aDate.isBefore(bDate) ? -1 : aDate.isAfter(bDate) ? 1 : 0;
        }

        // Secondary sort: Priority
        const aPriority = a.priority || 'none';
        const bPriority = b.priority || 'none';
        const priorityOrder: Record<string, number> = { high: 3, medium: 2, low: 1, none: 0 };
        secondaryComparison = priorityOrder[bPriority] - priorityOrder[aPriority];
      } else {
        // Primary sort: Priority
        const aPriority = a.priority || 'none';
        const bPriority = b.priority || 'none';
        const priorityOrder: Record<string, number> = { high: 3, medium: 2, low: 1, none: 0 };
        primaryComparison = priorityOrder[bPriority] - priorityOrder[aPriority];

        // Secondary sort: Due date
        const aDate = a.date;
        const bDate = b.date;

        if (!aDate && !bDate) {
          secondaryComparison = 0;
        } else if (!aDate) {
          secondaryComparison = 1; // Cards without dates go to the end
        } else if (!bDate) {
          secondaryComparison = -1; // Cards without dates go to the end
        } else {
          secondaryComparison = aDate.isBefore(bDate) ? -1 : aDate.isAfter(bDate) ? 1 : 0;
        }
      }

      // Apply primary comparison first, then secondary if primary is equal
      const finalComparison = primaryComparison !== 0 ? primaryComparison : secondaryComparison;

      // Apply sort order (asc/desc)
      return this.sortOrder === 'asc' ? finalComparison : -finalComparison;
    });
  }
}
