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
  date?: any;
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
  private scanRootPath: string = ''; // Added scan root path state

  // Debug flag - set to false for production to reduce console noise
  private debugDragDrop: boolean = false;

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
    const tagRegex = /(?:^|\s)(#\w+(?:\/\w+)*)(?=\s|$)/gi;
    cleanTitle = cleanTitle.replace(tagRegex, ' ');

    // For MemberView, we don't have a StateManager with settings, so skip date/time trigger removal
    // This is a simplified version compared to KanbanView

    // Clean up multiple spaces but preserve newlines
    cleanTitle = cleanTitle.replace(/[ \t]{2,}/g, ' ').trim();

    return cleanTitle;
  }

  onload() {
    super.onload();
    if (Platform.isMobile) {
      this.containerEl.setCssProps({
        '--mobile-navbar-height': (this.app as any).mobileNavbar.containerEl.clientHeight + 'px',
      });
    }

    // Initialize with first team member if available
    const teamMembers = this.plugin.settings.teamMembers || [];
    if (teamMembers.length > 0 && !this.selectedMember) {
      this.selectedMember = teamMembers[0];
    }

    // Register for active leaf changes to refresh when tabbing in/out
    this.registerEvent(
      this.app.workspace.on('active-leaf-change', (leaf) => {
        if (leaf === this.leaf && this.selectedMember) {
          // This view just became active - refresh the cards
          debugLog('[MemberView] View became active, refreshing cards');
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
    if (state?.selectedMember) {
      this.selectedMember = state.selectedMember;
    }

    if (state?.scanRootPath !== undefined) {
      this.scanRootPath = state.scanRootPath;
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
    return state;
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

  async scanMemberCards() {
    // Check if view is properly initialized
    if (!this.app || !this.plugin || (this.leaf as any).detached) {
      debugLog('[MemberView] View not properly initialized, skipping scan');
      return;
    }

    if (!this.selectedMember) {
      this.memberCards = [];
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
      this.setReactState({});
    } catch (e) {
      console.error('[MemberView] Error scanning member cards:', e);
      this.error = `Error scanning cards: ${e.message}`;
      this.isLoading = false;
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

      // Use KanbanView approach: get the content boundary and extract content
      const startNode = listItemNode.children[0];
      const endNode = listItemNode.children[listItemNode.children.length - 1];

      const start =
        startNode.type === 'paragraph'
          ? getNodeContentBoundary(startNode).start
          : startNode.position.start.offset;
      const end =
        endNode.type === 'paragraph'
          ? getNodeContentBoundary(endNode).end
          : endNode.position.end.offset;

      const itemBoundary = { start, end };
      let titleRaw = getStringFromBoundary(fileContent, itemBoundary);

      // Handle empty task (same as KanbanView)
      if (titleRaw === '[' + (listItemNode.checked ? listItemNode.checkChar || ' ' : ' ') + ']') {
        titleRaw = '';
      }

      if (!titleRaw) {
        debugLog('[MemberView] No titleRaw extracted, skipping');
        return null;
      }

      debugLog('[MemberView] parseListItemToMemberCard: Processing item:', {
        titleRaw,
        filePath: file.path,
        laneTitle,
        depth,
        selectedMember: this.selectedMember,
      });

      // Extract block ID - look for ^blockId anywhere in the content
      const blockIdMatch = titleRaw.match(/\^([a-zA-Z0-9]+)/);
      const blockId = blockIdMatch ? blockIdMatch[1] : undefined;

      debugLog('[MemberView] Block ID extraction debug:', {
        titleRaw: titleRaw,
        blockIdMatch: blockIdMatch,
        extractedBlockId: blockId,
        regexPattern: '/\\^([a-zA-Z0-9]+)/',
      });

      // PROMINENT DEBUG: Show blockId extraction result
      if (blockId) {
        debugLog(
          `🔍 [MemberView] BLOCK ID FOUND: "${blockId}" in card: "${titleRaw.substring(0, 50)}..."`
        );
      } else {
        debugLog(`❌ [MemberView] NO BLOCK ID FOUND in card: "${titleRaw.substring(0, 50)}..."`);
      }

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

      // Process titleRaw like KanbanView does
      const processedTitleRaw = removeBlockId(dedentNewLines(replaceBrs(titleRaw)));

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
        .replace(/\s*#\w+(?:\/\w+)*/g, '') // Remove tags (including preceding spaces)
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
      };

      debugLog('[MemberView] Created member card:', {
        id: result.id,
        title: result.title,
        titleRaw: result.titleRaw,
        blockId: result.blockId,
        assignedMembers: result.assignedMembers,
        tags: result.tags,
        dateStr: result.dateStr,
        timeStr: result.timeStr,
        checked: result.checked,
        hasDoing: result.hasDoing,
        willBeIncluded: assignedMembers.includes(this.selectedMember),
      });

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

    // Categorize cards
    this.memberCards.forEach((card) => {
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

      debugLog('[MemberView] Created item with metadata:', {
        itemId: item.id,
        title: item.data.title,
        hasMetadata: !!item.data.metadata,
        tags: item.data.metadata.tags,
        priority: item.data.metadata.priority,
        dateStr: item.data.metadata.dateStr,
        timeStr: item.data.metadata.timeStr,
        hasDate: !!item.data.metadata.date,
        hasTime: !!item.data.metadata.time,
        checked: card.checked,
        hasDoing: card.hasDoing,
        determinedLane: card.checked ? 'done' : card.hasDoing ? 'doing' : 'backlog',
      });

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

    if (newState) {
      this._reactState = { ...this._reactState, ...newState };
    }

    const win = this.getWindow();
    if (this._initialRenderTimeoutId) {
      win.clearTimeout(this._initialRenderTimeoutId);
    }

    const renderCallback = () => {
      if (this._isRendering) {
        return;
      }

      this._isRendering = true;

      try {
        // Check if component is still mounted and valid
        if (!this.contentEl || (this.leaf as any).detached || !this.contentEl.isConnected) {
          debugLog('[MemberView] Content element not available, detached, or not connected to DOM');
          return;
        }

        // Additional safety checks
        if (!this.plugin || !this.app) {
          console.error('[MemberView] Plugin or app not available during render');
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
              this.scanMemberCards();
            },
            onScanRootChange: (path: string) => {
              this.scanRootPath = path;
              if (this.selectedMember) {
                this.scanMemberCards();
              }
            },
            onRefresh: () => this.scanMemberCards(),
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
    // Handle drag and drop for member board
    debugLog(
      '[MemberView] handleDrop: CALLED - dragEntity:',
      dragEntity,
      'dropEntity:',
      dropEntity
    );

    const dragData = dragEntity.getData();
    const dropData = dropEntity.getData();

    debugLog('[MemberView] handleDrop: Full dragData:', dragData);
    debugLog('[MemberView] handleDrop: Full dropData:', dropData);
    debugLog('[MemberView] handleDrop: dropData.type:', dropData?.type);
    debugLog('[MemberView] handleDrop: dropData.id:', dropData?.id);
    debugLog('[MemberView] handleDrop: dropData.memberBoardLane:', dropData?.memberBoardLane);
    debugLog('[MemberView] handleDrop: dropData.memberBoardLaneId:', dropData?.memberBoardLaneId);
    debugLog('[MemberView] handleDrop: dropEntity type and methods:', {
      entityType: typeof dropEntity,
      hasGetPath: typeof dropEntity.getPath === 'function',
      hasGetData: typeof dropEntity.getData === 'function',
      dropEntityKeys: Object.keys(dropEntity),
    });

    if (
      dragData?.type === 'item' &&
      (dropData?.type === 'lane' || dropData?.type === 'placeholder' || dropData?.type === 'item')
    ) {
      const itemId = dragData.id;

      // Debug: log the full drop data to understand the structure
      debugLog('[MemberView] handleDrop: Full dropData:', dropData);

      let targetLaneId;

      // CRITICAL FIX: Force member board lane mapping regardless of source
      // The member board always has exactly 3 lanes in this order: [backlog, doing, done]
      const MEMBER_BOARD_LANES = ['backlog', 'doing', 'done'];

      if (dropData.type === 'lane') {
        // Direct lane drop - use the lane ID if it's a member board lane
        if (MEMBER_BOARD_LANES.includes(dropData.id)) {
          targetLaneId = dropData.id;
          debugLog(
            '[MemberView] handleDrop: Drop target is MEMBER BOARD LANE with ID:',
            targetLaneId
          );
        } else {
          console.error(
            '[MemberView] handleDrop: Drop target is not a member board lane:',
            dropData.id
          );
          return;
        }
      } else if (dropData.type === 'placeholder') {
        // For placeholder, we need to find the parent lane ID from the entity path
        const path = dropEntity.getPath();
        debugLog('[MemberView] handleDrop: Drop entity path:', path);

        if (path && path.length > 0) {
          // CRITICAL: The path should reference the member board structure
          const laneIndex = path[0];

          // Validate that the lane index is within member board bounds
          if (laneIndex >= 0 && laneIndex < MEMBER_BOARD_LANES.length) {
            targetLaneId = MEMBER_BOARD_LANES[laneIndex];
            debugLog(
              '[MemberView] handleDrop: Resolved MEMBER BOARD lane from path - index:',
              laneIndex,
              'lane:',
              targetLaneId,
              'MEMBER_BOARD_LANES:',
              MEMBER_BOARD_LANES,
              'full path:',
              path
            );
          } else {
            console.error('[MemberView] handleDrop: Lane index out of member board bounds:', {
              laneIndex,
              memberBoardLaneCount: MEMBER_BOARD_LANES.length,
              path,
            });
            return;
          }
        } else {
          console.error('[MemberView] handleDrop: Invalid or empty path from dropEntity:', path);
          return;
        }
      } else if (dropData.type === 'item') {
        // Dropping onto an existing item - determine lane from entity path or item data
        const path = dropEntity.getPath();
        debugLog('[MemberView] handleDrop: Drop target is ITEM, entity path:', path);

        // Try to get lane from entity path first (most reliable)
        if (path && path.length > 0) {
          const laneIndex = path[0];

          // Validate that the lane index is within member board bounds
          if (laneIndex >= 0 && laneIndex < MEMBER_BOARD_LANES.length) {
            targetLaneId = MEMBER_BOARD_LANES[laneIndex];
            debugLog(
              '[MemberView] handleDrop: Resolved MEMBER BOARD lane from item path - index:',
              laneIndex,
              'lane:',
              targetLaneId,
              'MEMBER_BOARD_LANES:',
              MEMBER_BOARD_LANES
            );
          } else {
            console.error('[MemberView] handleDrop: Item lane index out of member board bounds:', {
              laneIndex,
              memberBoardLaneCount: MEMBER_BOARD_LANES.length,
              path,
            });
            return;
          }
        } else if (dropData.parentLaneId && MEMBER_BOARD_LANES.includes(dropData.parentLaneId)) {
          // Fallback to parentLaneId from item data (only if it's a member board lane)
          targetLaneId = dropData.parentLaneId;
          debugLog(
            '[MemberView] handleDrop: Using member board parentLaneId from item data:',
            targetLaneId
          );
        } else {
          // Last resort: try to determine from item properties
          if (dropData.checked) {
            targetLaneId = 'done';
          } else if (
            dropData.metadata?.tags?.includes('doing') ||
            dropData.metadata?.tags?.includes('#doing')
          ) {
            targetLaneId = 'doing';
          } else {
            targetLaneId = 'backlog';
          }
          debugLog(
            '[MemberView] handleDrop: Determined member board lane from item properties:',
            targetLaneId,
            'checked:',
            dropData.checked,
            'tags:',
            dropData.metadata?.tags
          );
        }
      } else {
        console.error(
          '[MemberView] handleDrop: Unhandled drop type:',
          dropData.type,
          'dropData:',
          dropData
        );
        return;
      }

      // Validate that we have a valid member board target lane
      if (!targetLaneId || !MEMBER_BOARD_LANES.includes(targetLaneId)) {
        console.error(
          '[MemberView] handleDrop: Invalid or non-member-board target lane:',
          targetLaneId,
          'Valid member board lanes:',
          MEMBER_BOARD_LANES,
          'dropData:',
          dropData
        );
        return;
      }

      debugLog('[MemberView] handleDrop: Final MEMBER BOARD target lane determined:', targetLaneId);

      // Find the member card that was dragged
      const memberCard = this.memberCards.find((card) => card.id === itemId);
      if (!memberCard) {
        console.error('[MemberView] Could not find member card for item:', itemId);
        return;
      }

      debugLog('[MemberView] handleDrop: Moving item', itemId, 'to lane', targetLaneId);

      try {
        // Use KanbanView-style approach: update via StateManager instead of manual file manipulation
        await this.updateCardViaStateManager(memberCard, targetLaneId);

        debugLog('[MemberView] handleDrop: Successfully updated card via StateManager');
      } catch (error) {
        console.error('[MemberView] Error updating card via StateManager:', error);

        // Fallback to manual file update if StateManager approach fails
        debugLog('[MemberView] Falling back to manual file update...');
        try {
          // 1. Optimistically update the card in memory first for immediate visual feedback
          const originalCard = { ...memberCard };
          this.updateCardInMemory(memberCard, targetLaneId);

          // 2. Trigger immediate visual update with optimistic state
          this.setReactState({ optimisticUpdate: true });

          // 3. Update the file in the background
          await this.updateCardForLane(originalCard, targetLaneId);

          // 4. Refresh from file to get the actual state (this will correct any optimistic errors)
          await this.scanMemberCards();

          debugLog('[MemberView] handleDrop: Successfully updated card via fallback method');
        } catch (fallbackError) {
          console.error('[MemberView] Error in fallback update:', fallbackError);

          // Revert optimistic changes on error
          await this.scanMemberCards();

          // Show error notification
          new Notice(`Failed to update card: ${fallbackError.message}`);
        }
      }
    }
  }

  // New method: Update card via StateManager (KanbanView approach)
  private async updateCardViaStateManager(memberCard: MemberCard, targetLaneId: string) {
    // Find the source file's StateManager
    const sourceFile = this.app.vault.getAbstractFileByPath(memberCard.sourceBoardPath);
    if (!sourceFile || !(sourceFile instanceof TFile)) {
      throw new Error(`Could not find source file: ${memberCard.sourceBoardPath}`);
    }

    // Get or create StateManager for the file
    let stateManager = this.plugin.stateManagers.get(sourceFile);
    if (!stateManager) {
      debugLog(`[MemberView] Creating on-demand StateManager for ${sourceFile.path}`);

      // Create a temporary mock view for StateManager initialization
      const mockView = {
        file: sourceFile,
        getWindow: () => this.getWindow(),
        prerender: async () => {}, // No-op for mock view
        populateViewState: () => {}, // No-op for mock view
        initHeaderButtons: () => {}, // No-op for mock view
        validatePreviewCache: () => {}, // No-op for mock view
        requestSaveToDisk: async (data: string) => {
          // Save the file directly using the vault API
          await this.app.vault.modify(sourceFile, data);
        },
        data: '', // Initialize with empty data, will be set by StateManager
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
                .replace(/\s*#\w+/g, '') // Remove tags
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
        updatedCardData.titleRaw = updatedCardData.titleRaw.replace(/^(\s*-\s*)\[[x ]\]/, '$1[x]');
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

    // 1. IMMEDIATE: Update local member cards first for instant visual feedback
    const updatedMemberCard = { ...memberCard };
    this.updateCardInMemory(updatedMemberCard, targetLaneId);

    // Find and update the card in our memberCards array
    const memberCardIndex = this.memberCards.findIndex((card) => card.id === memberCard.id);
    if (memberCardIndex !== -1) {
      this.memberCards[memberCardIndex] = updatedMemberCard;
    }

    // 2. IMMEDIATE: Trigger visual update for instant UI response
    this.setReactState({ optimisticUpdate: true });

    // 3. BACKGROUND: Save via StateManager (this will automatically update the file)
    // Use setTimeout to make this non-blocking for immediate UI response
    setTimeout(() => {
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
    }, 0);
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
          // Find the end of the task content (before any existing tags or block ID)
          const tagMatch = updatedLine.match(
            /^(\s*-\s*\[[x ]\]\s*)(.*?)(\s*#.*)?(\s*\^[a-zA-Z0-9]+)?$/
          );
          if (tagMatch) {
            const prefix = tagMatch[1]; // "- [ ] " or "- [x] "
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
          // Clean up excessive spaces but preserve newlines
          updatedLine = updatedLine.replace(/[ \t]+/g, ' ').replace(/[ \t]+$/gm, '');
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
          // Clean up excessive spaces but preserve newlines
          updatedLine = updatedLine.replace(/[ \t]+/g, ' ').replace(/[ \t]+$/gm, '');
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

    // Wait for file system and cache to process the changes
    // Similar to how KanbanWorkspaceView handles it
    debugLog(
      '[MemberView] updateCardForLane: Waiting for file system and cache to process changes...'
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
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
}
