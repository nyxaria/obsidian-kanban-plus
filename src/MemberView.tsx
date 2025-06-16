import EventEmitter from 'eventemitter3';
import {
  HoverParent,
  HoverPopover,
  ItemView,
  Menu,
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

  handleDrop(dragEntity: any, dropEntity: any) {
    // Handle drag and drop for member board
    console.log('[MemberView] handleDrop:', dragEntity, dropEntity);

    const dragData = dragEntity.getData();
    const dropData = dropEntity.getData();

    // For member board, we'll update the virtual board state
    // but won't save changes to files since this is a read-only view
    const board = this.createMemberBoard();

    // Apply the same drag/drop logic as KanbanView but only update local state
    // This allows visual feedback during drag operations

    if (
      dragData?.type === 'item' &&
      (dropData?.type === 'lane' || dropData?.type === 'placeholder')
    ) {
      console.log('[MemberView] handleDrop: Card moved between lanes (visual only)');
      // For member board, we could show a notice that changes aren't saved
      // or implement logic to update the original files
    }

    // Refresh the board to show current state
    this.setReactState({ forceRerender: true });
  }
}
