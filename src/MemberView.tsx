import EventEmitter from 'eventemitter3';
import update from 'immutability-helper';
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
import { bindMarkdownEvents } from './helpers/renderMarkdown';
import { PromiseQueue } from './helpers/util';
import { t } from './lang/helpers';
import KanbanPlugin from './main';
import { frontmatterKey } from './parsers/common';
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
    };

    this.previewQueue = new PromiseQueue(() => this.emitter.emit('queueEmpty'));

    bindMarkdownEvents(this);
  }

  getViewType() {
    return memberViewType;
  }

  getIcon() {
    return memberIcon;
  }

  getDisplayText() {
    return this.selectedMember ? `Member Board - ${this.selectedMember}` : 'Member Board';
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
          console.log('[MemberView] Initial render - contentEl ready');
          this.setReactState({});
        } else {
          console.log('[MemberView] Initial render - contentEl not ready, retrying...');
          // Retry after a longer delay
          setTimeout(() => {
            if (
              this.app &&
              this.plugin &&
              this.contentEl &&
              this.contentEl.isConnected &&
              !(this.leaf as any).detached
            ) {
              console.log('[MemberView] Retry render - contentEl ready');
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

    // Handle member selection from state
    if (state?.selectedMember) {
      this.selectedMember = state.selectedMember;
    }

    // Only render if contentEl is ready
    if (this.contentEl && this.contentEl.isConnected) {
      this.setReactState({});
    } else {
      console.log('[MemberView] setState called but contentEl not ready, waiting...');
      // Wait for contentEl to be ready
      requestAnimationFrame(() => {
        setTimeout(() => {
          if (this.contentEl && this.contentEl.isConnected && !(this.leaf as any).detached) {
            console.log('[MemberView] setState delayed render - contentEl ready');
            this.setReactState({});
          }
        }, 100);
      });
    }
  }

  getState() {
    const state = super.getState();
    state.selectedMember = this.selectedMember;
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

  useViewState<K extends keyof KanbanViewSettings>(key: K) {
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
        .setTitle(t('Refresh member board'))
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
        t('Refresh member board'),
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
      console.log('[MemberView] View not properly initialized, skipping scan');
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

      const allMdFiles = this.app.vault.getMarkdownFiles();

      for (const mdFile of allMdFiles) {
        if (!hasFrontmatterKeyRaw(await this.app.vault.cachedRead(mdFile))) {
          continue;
        }

        try {
          const fileContent = await this.app.vault.cachedRead(mdFile);
          const tempStateManager = new StateManager(
            this.app,
            { file: mdFile } as any,
            () => {},
            () => this.plugin.settings
          );

          const { ast } = parseMarkdown(tempStateManager, fileContent) as {
            ast: any;
            settings: KanbanSettings;
          };

          let currentLaneTitle = 'Unknown Lane';
          for (const astNode of ast.children) {
            if (astNode.type === 'heading') {
              const headingText = astNode.children?.[0]?.value || 'Unnamed Lane';
              currentLaneTitle = headingText.replace(/\s*\(\d+\)$/, '').trim();
            } else if (astNode.type === 'list') {
              for (const listItemNode of astNode.children) {
                if (listItemNode.type === 'listItem') {
                  const itemData = this.parseListItemToMemberCard(
                    tempStateManager,
                    fileContent,
                    listItemNode,
                    mdFile,
                    currentLaneTitle
                  );

                  if (itemData && itemData.assignedMembers.includes(this.selectedMember)) {
                    allCards.push(itemData);
                  }
                }
              }
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

  private parseListItemToMemberCard(
    stateManager: StateManager,
    fileContent: string,
    listItemNode: any,
    file: TFile,
    laneTitle: string
  ): MemberCard | null {
    try {
      // Extract basic task info
      const titleRaw = this.extractTitleFromListItem(listItemNode);
      if (!titleRaw) return null;

      // Check if it's a task
      const isTask = listItemNode.checked !== null;
      if (!isTask) return null;

      const checked = listItemNode.checked === true;

      // Extract block ID
      const blockIdMatch = titleRaw.match(/\^([a-zA-Z0-9]+)$/);
      const blockId = blockIdMatch ? blockIdMatch[1] : undefined;

      // Extract assigned members
      const memberPrefix = stateManager.getSetting('member-assignment-prefix') || '@@';
      const memberRegex = new RegExp(`${memberPrefix}(\\w+)`, 'g');
      const assignedMembers: string[] = [];
      let match;
      while ((match = memberRegex.exec(titleRaw)) !== null) {
        assignedMembers.push(match[1]);
      }

      // Extract tags
      const tagRegex = /#(\w+(?:\/\w+)*)/g;
      const tags: string[] = [];
      while ((match = tagRegex.exec(titleRaw)) !== null) {
        tags.push(match[1]);
      }

      // Check if has "doing" tag
      const hasDoing = tags.some((tag) => tag.toLowerCase() === 'doing');

      // Debug: log tag parsing for the card we just updated
      if (blockId && (blockId.includes('srq6cdcei') || titleRaw.includes('FC M+L'))) {
        console.log('[MemberView] Parsing card after update:', {
          titleRaw,
          tags,
          hasDoing,
          checked,
          file: file.path,
          line: listItemNode.position?.start.line,
          position: listItemNode.position,
        });
      }

      // Debug: log any card that contains "Make system diagrams" or has the specific block ID
      if (titleRaw.includes('Make system diagrams') || blockId === '6oucxl') {
        console.log('[MemberView] Parsing target card during rescan:', {
          titleRaw,
          tags,
          hasDoing,
          checked,
          assignedMembers,
          selectedMember: this.selectedMember,
          willBeIncluded: assignedMembers.includes(this.selectedMember),
          file: file.path,
          line: listItemNode.position?.start.line,
        });
      }

      // Clean title for display
      let cleanTitle = titleRaw
        .replace(memberRegex, '') // Remove member assignments
        .replace(/#\w+(?:\/\w+)*/g, '') // Remove tags
        .replace(/\^[a-zA-Z0-9]+$/, '') // Remove block ID
        .trim();

      // Extract priority
      const priorityMatch = cleanTitle.match(/!(low|medium|high)/i);
      const priority = priorityMatch ? priorityMatch[1].toLowerCase() : undefined;
      if (priority) {
        cleanTitle = cleanTitle.replace(/!(low|medium|high)/gi, '').trim();
      }

      return {
        id: blockId || generateInstanceId(),
        title: cleanTitle,
        titleRaw,
        checked,
        hasDoing,
        sourceBoardPath: file.path,
        sourceBoardName: file.basename,
        sourceStartLine: listItemNode.position?.start.line,
        blockId,
        assignedMembers,
        tags,
        priority,
      };
    } catch (e) {
      console.error('[MemberView] Error parsing list item:', e);
      return null;
    }
  }

  private extractTitleFromListItem(listItemNode: any): string {
    try {
      // Convert the list item AST back to markdown text
      let text = '';

      const processNode = (node: any): void => {
        if (node.type === 'text') {
          text += node.value;
        } else if (node.type === 'link') {
          text += `[${node.children?.[0]?.value || ''}](${node.url})`;
        } else if (node.type === 'inlineCode') {
          text += `\`${node.value}\``;
        } else if (node.type === 'strong') {
          text += `**${node.children?.[0]?.value || ''}**`;
        } else if (node.type === 'emphasis') {
          text += `*${node.children?.[0]?.value || ''}*`;
        } else if (node.children) {
          node.children.forEach(processNode);
        }
      };

      if (listItemNode.children) {
        listItemNode.children.forEach(processNode);
      }

      return text.trim();
    } catch (e) {
      console.error('[MemberView] Error extracting title from list item:', e);
      return '';
    }
  }

  createMemberBoard(): Board {
    const backlogCards: Item[] = [];
    const doingCards: Item[] = [];
    const doneCards: Item[] = [];

    // Categorize cards
    this.memberCards.forEach((card) => {
      const item: Item = {
        id: card.id,
        type: 'item',
        accepts: [],
        data: {
          title: card.title,
          titleRaw: card.titleRaw,
          checked: card.checked,
          checkChar: card.checked ? 'x' : ' ',
          blockId: card.blockId,
          assignedMembers: card.assignedMembers,
          metadata: {
            tags: card.tags,
            priority: card.priority,
          },
        },
      };

      // Debug: log categorization for the card we just updated
      if (card.titleRaw.includes('FC M+L')) {
        console.log('[MemberView] Categorizing card:', {
          title: card.title,
          titleRaw: card.titleRaw,
          tags: card.tags,
          hasDoing: card.hasDoing,
          checked: card.checked,
          willGoTo: card.checked ? 'done' : card.hasDoing ? 'doing' : 'backlog',
        });
      }

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

    return {
      id: `member-board-${this.selectedMember}`,
      type: 'board',
      accepts: ['lane'],
      data: {
        settings: this.plugin.settings,
        frontmatter: {},
        archive: [],
        isSearching: false,
        errors: [],
      },
      children: [backlogLane, doingLane, doneLane],
    };
  }

  async setReactState(newState?: any) {
    // Prevent multiple simultaneous renders
    if (this._isRendering) {
      console.log('[MemberView] Render already in progress, skipping');
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
          console.log(
            '[MemberView] Content element not available, detached, or not connected to DOM'
          );
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
          console.log('[MemberView] ContentEl disconnected before render, aborting');
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
            onMemberChange: (member: string) => {
              this.selectedMember = member;
              this.scanMemberCards();
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
    console.log('[MemberView] handleDrop:', dragEntity, dropEntity);

    const dragData = dragEntity.getData();
    const dropData = dropEntity.getData();

    console.log('[MemberView] handleDrop: Full dragData:', dragData);
    console.log('[MemberView] handleDrop: Full dropData:', dropData);
    console.log('[MemberView] handleDrop: dropEntity type and methods:', {
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
      console.log('[MemberView] handleDrop: Full dropData:', dropData);

      let targetLaneId;
      if (dropData.type === 'lane') {
        targetLaneId = dropData.id;
        console.log('[MemberView] handleDrop: Drop target is LANE with ID:', targetLaneId);
      } else if (dropData.type === 'placeholder') {
        // For placeholder, we need to find the parent lane ID from the entity path
        const path = dropEntity.getPath();
        console.log('[MemberView] handleDrop: Drop entity path:', path);

        if (path && path.length > 0) {
          // The first element in the path should be the lane index
          const laneIndex = path[0];
          const lanes = ['backlog', 'doing', 'done'];
          targetLaneId = lanes[laneIndex];
          console.log(
            '[MemberView] handleDrop: Resolved lane from path - index:',
            laneIndex,
            'lane:',
            targetLaneId,
            'available lanes:',
            lanes,
            'full path:',
            path
          );
        } else {
          console.error('[MemberView] handleDrop: Invalid or empty path from dropEntity:', path);
        }
      } else if (dropData.type === 'item') {
        // Dropping onto an existing item - use the item's parent lane
        targetLaneId = dropData.parentLaneId;
        console.log(
          '[MemberView] handleDrop: Drop target is ITEM, using parentLaneId:',
          targetLaneId
        );
      } else {
        console.error(
          '[MemberView] handleDrop: Unhandled drop type:',
          dropData.type,
          'dropData:',
          dropData
        );
      }

      // Validate that we have a target lane
      if (!targetLaneId) {
        console.error(
          '[MemberView] handleDrop: Could not determine target lane. dropData:',
          dropData
        );
        return;
      }

      console.log('[MemberView] handleDrop: Final target lane determined:', targetLaneId);

      // Find the member card that was dragged
      const memberCard = this.memberCards.find((card) => card.id === itemId);
      if (!memberCard) {
        console.error('[MemberView] Could not find member card for item:', itemId);
        return;
      }

      console.log('[MemberView] handleDrop: Moving item', itemId, 'to lane', targetLaneId);

      try {
        // Use KanbanView-style approach: update via StateManager instead of manual file manipulation
        await this.updateCardViaStateManager(memberCard, targetLaneId);

        console.log('[MemberView] handleDrop: Successfully updated card via StateManager');
      } catch (error) {
        console.error('[MemberView] Error updating card via StateManager:', error);

        // Fallback to manual file update if StateManager approach fails
        console.log('[MemberView] Falling back to manual file update...');
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

          console.log('[MemberView] handleDrop: Successfully updated card via fallback method');
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
      console.log(`[MemberView] Creating on-demand StateManager for ${sourceFile.path}`);

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

      console.log(
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

    console.log('[MemberView] updateCardViaStateManager: Searching for card in board structure', {
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
      console.log(
        `[MemberView] updateCardViaStateManager: Checking lane ${laneIdx} (${lane.data?.title}) with ${lane.children.length} items`
      );

      for (let itemIdx = 0; itemIdx < lane.children.length; itemIdx++) {
        const item = lane.children[itemIdx];

        console.log(`[MemberView] updateCardViaStateManager: Checking item ${itemIdx}`, {
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
          console.log(`[MemberView] updateCardViaStateManager: Skipping item ${itemIdx} - no data`);
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
          console.log(`[MemberView] updateCardViaStateManager: FOUND MATCHING CARD!`, {
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

    console.log('[MemberView] updateCardViaStateManager: Found card in board structure', {
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
        if (!updatedCardData.metadata?.tags?.includes('doing')) {
          updatedCardData.metadata = updatedCardData.metadata || {};
          updatedCardData.metadata.tags = updatedCardData.metadata.tags || [];
          updatedCardData.metadata.tags.push('doing');

          // Update titleRaw to include the tag
          if (!updatedCardData.titleRaw.includes('#doing')) {
            // Insert #doing before any existing block ID
            const blockIdMatch = updatedCardData.titleRaw.match(/^(.*?)(\s*\^[a-zA-Z0-9]+)?$/);
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
        if (updatedCardData.metadata?.tags?.includes('doing')) {
          updatedCardData.metadata.tags = updatedCardData.metadata.tags.filter(
            (tag) => tag !== 'doing'
          );

          // Update titleRaw to remove the tag
          updatedCardData.titleRaw = updatedCardData.titleRaw.replace(/\s*#doing\b/g, '');
          updatedCardData.titleRaw = updatedCardData.titleRaw.replace(/\s+/g, ' ').trim();
        }
        break;

      case 'done':
        // Mark as done and remove "doing" tag
        updatedCardData.checked = true;
        updatedCardData.checkChar = 'x';

        if (updatedCardData.metadata?.tags?.includes('doing')) {
          updatedCardData.metadata.tags = updatedCardData.metadata.tags.filter(
            (tag) => tag !== 'doing'
          );
        }

        // Update titleRaw: change checkbox and remove doing tag
        updatedCardData.titleRaw = updatedCardData.titleRaw.replace(/^(\s*-\s*)\[[x ]\]/, '$1[x]');
        updatedCardData.titleRaw = updatedCardData.titleRaw.replace(/\s*#doing\b/g, '');
        updatedCardData.titleRaw = updatedCardData.titleRaw.replace(/\s+/g, ' ').trim();
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

    // Save via StateManager (this will automatically update the file)
    stateManager.setState(updatedBoard, true);

    // Update our local member cards to reflect the change
    const updatedMemberCard = { ...memberCard };
    this.updateCardInMemory(updatedMemberCard, targetLaneId);

    // Find and update the card in our memberCards array
    const memberCardIndex = this.memberCards.findIndex((card) => card.id === memberCard.id);
    if (memberCardIndex !== -1) {
      this.memberCards[memberCardIndex] = updatedMemberCard;
    }

    // Trigger a visual update without full rescan
    this.setReactState({ stateManagerUpdate: true });
  }

  // Helper method to optimistically update card in memory
  private updateCardInMemory(memberCard: MemberCard, targetLaneId: string) {
    switch (targetLaneId) {
      case 'doing':
        memberCard.checked = false; // Uncheck if moving from done
        memberCard.hasDoing = true;
        if (!memberCard.tags.includes('doing')) {
          memberCard.tags.push('doing');
        }
        break;
      case 'backlog':
        memberCard.checked = false; // Uncheck if moving from done
        memberCard.hasDoing = false;
        memberCard.tags = memberCard.tags.filter((tag) => tag !== 'doing');
        break;
      case 'done':
        memberCard.checked = true;
        memberCard.hasDoing = false;
        memberCard.tags = memberCard.tags.filter((tag) => tag !== 'doing');
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

    console.log('[MemberView] updateCardForLane debug:', {
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
          // Clean up any double spaces
          updatedLine = updatedLine.replace(/\s+/g, ' ').trim();
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
          // Clean up any double spaces
          updatedLine = updatedLine.replace(/\s+/g, ' ').trim();
        }
        break;

      default:
        console.warn('[MemberView] Unknown target lane:', targetLaneId);
        return;
    }

    // Only update if the line actually changed
    if (updatedLine === originalLine) {
      console.log('[MemberView] No changes needed for line');
      return;
    }

    // Update the line in the file
    lines[lineIndex] = updatedLine;
    const updatedContent = lines.join('\n');

    // Save the file
    await this.app.vault.modify(file, updatedContent);

    console.log('[MemberView] Updated line:', {
      original: originalLine,
      updated: updatedLine,
      file: memberCard.sourceBoardPath,
      line: memberCard.sourceStartLine,
      lineIndex: lineIndex,
    });

    // Wait for file system and cache to process the changes
    // Similar to how KanbanWorkspaceView handles it
    console.log(
      '[MemberView] updateCardForLane: Waiting for file system and cache to process changes...'
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}
