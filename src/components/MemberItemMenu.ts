import update from 'immutability-helper';
import { Menu, MenuItem, Notice, TFile } from 'obsidian';
import { useCallback, useEffect, useState } from 'preact/hooks';

import { KanbanView } from '../KanbanView';
import { MemberView } from '../MemberView';
import { debugLog } from '../helpers/debugLogger';
import { t } from '../lang/helpers';
import { TagNameModal } from '../modals/TagNameModal';
import { getAllTagsFromKanbanBoards } from '../utils/kanbanTags';
import {
  constructDatePicker,
  constructMenuDatePickerOnChange,
  constructMenuTimePickerOnChange,
  constructTimePicker,
} from './Item/helpers';
import { escapeRegExpStr, generateInstanceId, getTagSymbolFn } from './helpers';

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
  depth?: number;
}

export interface UseMemberItemMenuParams {
  memberCard: MemberCard;
  view: MemberView;
  onCardUpdate: () => void;
}

export function useMemberItemMenu({ memberCard, view, onCardUpdate }: UseMemberItemMenuParams) {
  const [kanbanBoardTags, setKanbanBoardTags] = useState<string[]>([]);
  const [isLoadingTags, setIsLoadingTags] = useState<boolean>(true);

  useEffect(() => {
    setIsLoadingTags(true);
    // Create a mock StateManager for getAllTagsFromKanbanBoards
    const mockStateManager = {
      app: view.app,
      file: {
        path: 'mock-file-for-tag-scanning',
        name: 'Mock File',
        basename: 'Mock File',
        extension: 'md',
      } as any,
      getSetting: (key: string) => (view.plugin.settings as any)[key],
      getSettingRaw: (key: string) => (view.plugin.settings as any)[key],
      getGlobalSetting: (key: string) => (view.plugin.settings as any)[key],
      compiledSettings: {},
      compileSettings: (settings?: any) => {
        // Mock implementation that sets basic compiled settings
        mockStateManager.compiledSettings = {
          'date-format': 'YYYY-MM-DD',
          'date-display-format': 'YYYY-MM-DD',
          'date-time-display-format': 'YYYY-MM-DD HH:mm',
          'date-trigger': '@',
          'time-trigger': '%',
          'time-format': 'HH:mm',
          'metadata-keys': [],
          'tag-colors': (view.plugin.settings as any)['tag-colors'] || [],
          'tag-sort': (view.plugin.settings as any)['tag-sort'] || [],
          'tag-symbols': (view.plugin.settings as any)['tag-symbols'] || [],
          'tag-action': 'obsidian',
          'kanban-plugin': 'board',
          'inline-metadata-position': 'top',
          'link-date-to-daily-note': false,
          'move-dates': false,
          'move-tags': false,
          'move-task-metadata': false,
          'archive-date-separator': '',
          'archive-date-format': 'YYYY-MM-DD HH:mm',
          'show-add-list': true,
          'show-archive-all': true,
          'show-board-settings': true,
          'show-checkboxes': true,
          'show-relative-date': true,
          'show-search': true,
          'show-set-view': true,
          'show-view-as-markdown': true,
          'date-picker-week-start': 0,
          'date-colors': [],
          ...settings,
        };
      },
    } as any;

    getAllTagsFromKanbanBoards(mockStateManager)
      .then((tags) => {
        setKanbanBoardTags(tags.sort());
        setIsLoadingTags(false);
      })
      .catch((err) => {
        console.error('[MemberItemMenu] Error fetching kanban board tags:', err);
        setKanbanBoardTags([]);
        setIsLoadingTags(false);
      });
  }, [view]);

  return useCallback(
    (e: MouseEvent) => {
      const coordinates = { x: e.clientX, y: e.clientY };
      const hasDate = !!memberCard.date;
      const hasTime = false; // Member cards don't currently track time separately
      const teamMembers: string[] = view.plugin.settings.teamMembers || [];

      const menu = new Menu();

      // 1. Go to card (opens board view)
      menu.addItem((menuItem) => {
        menuItem
          .setTitle('Go to card')
          .setIcon('lucide-external-link')
          .onClick(async () => {
            const sourceFile = view.app.vault.getAbstractFileByPath(memberCard.sourceBoardPath);
            if (sourceFile instanceof TFile) {
              // Check if there's already a KanbanView open for this file
              const existingKanbanLeaves = view.app.workspace
                .getLeavesOfType('kanban')
                .filter((leaf) => (leaf.view as any).file?.path === sourceFile.path);

              let targetLeaf;
              let kanbanView;

              if (existingKanbanLeaves.length > 0) {
                // Use existing KanbanView
                targetLeaf = existingKanbanLeaves[0];
                kanbanView = targetLeaf.view;

                // Activate the existing leaf
                view.app.workspace.setActiveLeaf(targetLeaf, { focus: true });
              } else {
                // Create new leaf and open file in KanbanView
                targetLeaf = view.app.workspace.splitActiveLeaf();
                await targetLeaf.openFile(sourceFile);

                // Ensure it opens as Kanban view (not markdown)
                if (targetLeaf.view.getViewType() !== 'kanban') {
                  view.plugin.kanbanFileModes[(targetLeaf as any).id || sourceFile.path] = 'kanban';
                  await view.plugin.setKanbanView(targetLeaf);
                }

                kanbanView = targetLeaf.view;
              }

              // Now highlight the card in the KanbanView using the same approach as TimelineView
              if (kanbanView && kanbanView.getViewType() === 'kanban') {
                // Clean the title to match what's displayed in KanbanView (remove metadata)
                let cleanTitle = memberCard.titleRaw;

                // Remove block ID
                cleanTitle = cleanTitle.replace(/\s*\^[a-zA-Z0-9]+/g, '');
                // Remove member assignments
                cleanTitle = cleanTitle.replace(/\s*@@\w+/g, '');
                // Remove tags
                cleanTitle = cleanTitle.replace(/\s*#\w+/g, '');
                // Remove dates
                cleanTitle = cleanTitle.replace(/\s*@\{[^}]+\}/g, '');
                cleanTitle = cleanTitle.replace(/\s*@start\{[^}]+\}/g, '');
                // Remove priorities
                cleanTitle = cleanTitle.replace(/\s*![a-zA-Z]+/g, '');
                // Clean up extra whitespace and newlines
                cleanTitle = cleanTitle.replace(/\s+/g, ' ').trim();

                // Debug: Log what titles are actually in the KanbanView
                const board = (kanbanView as KanbanView).getBoard();
                if (board) {
                  debugLog('[MemberItemMenu] Available cards in KanbanView board:');
                  for (const lane of board.children) {
                    debugLog(`  Lane '${lane.data.title}':`);
                    for (const item of lane.children) {
                      debugLog(`    - Card title: "${item.data.title}"`);
                      debugLog(`    - Card titleRaw: "${item.data.titleRaw}"`);
                      debugLog(`    - Card blockId: "${item.data.blockId}"`);
                      debugLog(`    - Card id: "${item.id}"`);
                    }
                  }
                } else {
                  debugLog('[MemberItemMenu] No board data available in KanbanView');
                }

                // Prepare navigation state similar to TimelineView
                // Use blockId if available (most reliable), otherwise use cleaned cardTitle
                const navigationState = {
                  file: memberCard.sourceBoardPath,
                  eState: {
                    filePath: memberCard.sourceBoardPath,
                    blockId: memberCard.blockId || undefined,
                    cardTitle: !memberCard.blockId ? cleanTitle : undefined, // Use cleaned title for better matching
                    listName: undefined as string | undefined, // Let KanbanView figure this out
                    preventSetViewData: true, // Prevent reloading the view data
                  },
                };

                debugLog('[MemberItemMenu] Navigation state for highlighting:', {
                  blockId: navigationState.eState.blockId,
                  cardTitle: navigationState.eState.cardTitle,
                  cleanedTitle: cleanTitle,
                  memberCardTitle: memberCard.title,
                  memberCardTitleRaw: memberCard.titleRaw,
                  memberCardBlockId: memberCard.blockId,
                  usingBlockId: !!memberCard.blockId,
                  blockIdType: typeof memberCard.blockId,
                  blockIdLength: memberCard.blockId?.length,
                });

                // PROMINENT DEBUG: Show what we're using for highlighting
                if (memberCard.blockId) {
                  debugLog(
                    `🎯 [MemberItemMenu] USING BLOCK ID for highlighting: "${memberCard.blockId}"`
                  );
                } else {
                  debugLog(`🎯 [MemberItemMenu] USING TITLE for highlighting: "${cleanTitle}"`);
                }

                // Use setState to properly integrate with the highlighting system
                (kanbanView as any).setState(navigationState, { history: true });

                // Add a slight delay to ensure setState has processed and the view is ready
                setTimeout(() => {
                  if (kanbanView && (kanbanView as any).applyHighlight) {
                    debugLog(
                      '[MemberItemMenu] Directly calling applyHighlight on KanbanView instance for:',
                      memberCard.sourceBoardPath,
                      'with target:',
                      navigationState.eState
                    );
                    (kanbanView as any).applyHighlight();
                  }
                }, 150);
              }
            } else {
              new Notice(`Could not find source file: ${memberCard.sourceBoardPath}`);
            }
          });
      });

      menu.addSeparator();

      // 2. Move to... (Backlog/Doing/Done)
      menu.addItem((menuItem) => {
        menuItem.setTitle('Move to...').setIcon('lucide-move');
        const moveSubMenu = (menuItem as any).setSubmenu();

        const lanes = [
          { id: 'backlog', title: 'Backlog' },
          { id: 'doing', title: 'Doing' },
          { id: 'done', title: 'Done' },
        ];

        lanes.forEach((lane) => {
          moveSubMenu.addItem((subMenuItem: MenuItem) => {
            // Determine if this is the current lane
            let isCurrentLane = false;
            if (lane.id === 'backlog') {
              isCurrentLane = !memberCard.checked && !memberCard.hasDoing;
            } else if (lane.id === 'doing') {
              isCurrentLane = !memberCard.checked && memberCard.hasDoing;
            } else if (lane.id === 'done') {
              isCurrentLane = memberCard.checked;
            }

            subMenuItem
              .setTitle(lane.title)
              .setChecked(isCurrentLane)
              .onClick(async () => {
                try {
                  await view.handleDrop(
                    { getData: () => ({ type: 'item', id: memberCard.id }) },
                    { getData: () => ({ type: 'lane', id: lane.id }) }
                  );
                  onCardUpdate();
                } catch (error) {
                  console.error('[MemberItemMenu] Error moving card:', error);
                  new Notice(`Failed to move card: ${error.message}`);
                }
              });
          });
        });
      });

      // 3. Change priority
      menu.addItem((menuItem) => {
        menuItem.setTitle('Change priority').setIcon('lucide-flag');
        const prioritySubMenu = (menuItem as any).setSubmenu();

        const priorities = [
          { value: 'high', label: 'High', icon: '🔴' },
          { value: 'medium', label: 'Medium', icon: '🟡' },
          { value: 'low', label: 'Low', icon: '🟢' },
          { value: null, label: 'None', icon: '' },
        ];

        priorities.forEach((priority) => {
          prioritySubMenu.addItem((subMenuItem: MenuItem) => {
            const isCurrentPriority = memberCard.priority === priority.value;
            const displayTitle = priority.icon
              ? `${priority.icon} ${priority.label}`
              : priority.label;

            subMenuItem
              .setTitle(displayTitle)
              .setChecked(isCurrentPriority)
              .onClick(async () => {
                try {
                  await updateCardPriority(memberCard, priority.value, view);
                  onCardUpdate();
                } catch (error) {
                  console.error('[MemberItemMenu] Error updating priority:', error);
                  new Notice(`Failed to update priority: ${error.message}`);
                }
              });
          });
        });
      });

      // 4. Assign members
      if (teamMembers.length > 0) {
        menu.addItem((menuItem) => {
          menuItem.setTitle('Assign Member').setIcon('lucide-users');
          const memberSubMenu = (menuItem as any).setSubmenu();
          const cardAssignedMembers = memberCard.assignedMembers || [];

          teamMembers.forEach((member) => {
            if (typeof member === 'string' && member.trim() !== '') {
              memberSubMenu.addItem((subMenuItem: MenuItem) => {
                subMenuItem
                  .setTitle(member)
                  .setChecked(cardAssignedMembers.includes(member))
                  .onClick(async () => {
                    try {
                      const isCurrentlyAssigned = cardAssignedMembers.includes(member);
                      await view.updateMemberAssignment(
                        memberCard.id,
                        member,
                        !isCurrentlyAssigned
                      );
                      onCardUpdate();
                    } catch (error) {
                      console.error('[MemberItemMenu] Error updating members:', error);
                      new Notice(`Failed to update member assignment: ${error.message}`);
                    }
                  });
              });
            }
          });
        });
      }

      // 5. Change tags
      menu.addItem((menuItem) => {
        menuItem.setTitle('Assign Tag').setIcon('lucide-tag');
        const tagSubMenu = (menuItem as any).setSubmenu();

        if (isLoadingTags) {
          tagSubMenu.addItem((loadItem: MenuItem) => {
            loadItem.setTitle('Loading tags...');
          });
        } else {
          if (kanbanBoardTags.length > 0) {
            const cardMetaTagsLower = (memberCard.tags || []).map((t) =>
              t.replace(/^#/, '').toLowerCase()
            );

            // Get tag symbol function
            const tagSymbols = view.plugin.settings['tag-symbols'] || [];
            const getTagSymbol = getTagSymbolFn(tagSymbols);

            kanbanBoardTags.forEach((tag) => {
              if (tag && typeof tag === 'string' && tag.trim() !== '') {
                tagSubMenu.addItem((subMenuItem: MenuItem) => {
                  const menuTagClean = tag.trim();
                  const menuTagLower = menuTagClean.toLowerCase();
                  const isAssigned = cardMetaTagsLower.includes(menuTagLower);

                  // Get tag symbol for display
                  const tagWithHash = menuTagClean.startsWith('#')
                    ? menuTagClean
                    : `#${menuTagClean}`;
                  const symbolInfo = getTagSymbol(tagWithHash);

                  let displayTitle = menuTagClean;
                  if (symbolInfo) {
                    const tagNameWithoutHash = menuTagClean.replace(/^#/, '');
                    if (symbolInfo.hideTag) {
                      displayTitle = symbolInfo.symbol;
                    } else {
                      displayTitle = `${symbolInfo.symbol} ${tagNameWithoutHash}`;
                    }
                  }

                  subMenuItem
                    .setTitle(displayTitle)
                    .setChecked(isAssigned)
                    .onClick(async () => {
                      try {
                        await updateCardTags(memberCard, menuTagClean, view);
                        onCardUpdate();
                      } catch (error) {
                        console.error('[MemberItemMenu] Error updating tags:', error);
                        new Notice(`Failed to update tag: ${error.message}`);
                      }
                    });
                });
              }
            });
          } else {
            tagSubMenu.addItem((subMenuItem: MenuItem) => {
              subMenuItem.setTitle('No tags found in Kanban boards');
            });
          }

          tagSubMenu.addSeparator();
          tagSubMenu.addItem((subMenuItem: MenuItem) => {
            subMenuItem
              .setTitle('Add New Tag...')
              .setIcon('lucide-plus-circle')
              .onClick(async () => {
                new TagNameModal(view.app, async (newTagRaw) => {
                  if (newTagRaw && newTagRaw.trim() !== '') {
                    let newTagClean = newTagRaw.trim().replace(/^#/, '');
                    newTagClean = newTagClean.replace(/\s+/g, '-');

                    if (newTagClean) {
                      try {
                        await updateCardTags(memberCard, newTagClean, view);
                        // Optimistic update for kanbanBoardTags
                        if (!kanbanBoardTags.includes(newTagClean)) {
                          setKanbanBoardTags((prevTags) => [...prevTags, newTagClean].sort());
                        }
                        onCardUpdate();
                      } catch (error) {
                        console.error('[MemberItemMenu] Error adding new tag:', error);
                        new Notice(`Failed to add tag: ${error.message}`);
                      }
                    }
                  }
                }).open();
              });
          });
        }
      });

      // 6. Add/change/remove date
      menu.addItem((menuItem) => {
        menuItem
          .setIcon('lucide-calendar-check')
          .setTitle(hasDate ? t('Edit date') : t('Add date'))
          .onClick(() => {
            // Create a mock StateManager for date picker
            const mockStateManager = {
              getSetting: (key: string) =>
                (view.plugin.settings as any)[key] ||
                {
                  'date-format': 'YYYY-MM-DD',
                  'date-display-format': 'YYYY-MM-DD',
                  'link-date-to-daily-note': false,
                  'date-trigger': '@',
                  'time-trigger': '@@',
                  'date-picker-week-start': 0,
                }[key],
              app: view.app,
            } as any;

            // Create mock boardModifiers
            const mockBoardModifiers = {
              updateItem: async (path: any, item: any) => {
                // Update the card directly via file modification
                await updateCardDate(memberCard, item.data.titleRaw, view);
                onCardUpdate();
              },
            } as any;

            // Create mock item
            const mockItem = {
              data: {
                titleRaw: memberCard.titleRaw,
                metadata: {
                  date: memberCard.date,
                },
              },
            } as any;

            constructDatePicker(
              e.view,
              mockStateManager,
              coordinates,
              constructMenuDatePickerOnChange({
                stateManager: mockStateManager,
                boardModifiers: mockBoardModifiers,
                item: mockItem,
                hasDate,
                path: [] as any,
              }),
              memberCard.date?.toDate?.()
            );
          });
      });

      if (hasDate) {
        menu.addItem((menuItem) => {
          menuItem
            .setIcon('lucide-calendar-x')
            .setTitle(t('Remove date'))
            .onClick(async () => {
              try {
                await removeCardDate(memberCard, view);
                onCardUpdate();
              } catch (error) {
                console.error('[MemberItemMenu] Error removing date:', error);
                new Notice(`Failed to remove date: ${error.message}`);
              }
            });
        });
      }

      menu.addSeparator();

      // 7. Get card link
      menu.addItem((menuItem) => {
        menuItem
          .setTitle('Copy link to card')
          .setIcon('lucide-link')
          .onClick(async () => {
            try {
              const sourceFile = view.app.vault.getAbstractFileByPath(memberCard.sourceBoardPath);
              if (sourceFile instanceof TFile) {
                let blockId = memberCard.blockId;

                if (!blockId) {
                  // Generate a new block ID and add it to the card
                  blockId = generateInstanceId(6);
                  await addBlockIdToCard(memberCard, blockId, view);
                }

                const link = view.app.fileManager.generateMarkdownLink(
                  sourceFile,
                  '',
                  '#^' + blockId
                );

                await navigator.clipboard.writeText(link);
                new Notice('Card link copied to clipboard');
              } else {
                new Notice(`Could not find source file: ${memberCard.sourceBoardPath}`);
              }
            } catch (error) {
              console.error('[MemberItemMenu] Error copying card link:', error);
              new Notice(`Failed to copy card link: ${error.message}`);
            }
          });
      });

      menu.showAtMouseEvent(e);
    },
    [memberCard, view, onCardUpdate, isLoadingTags, kanbanBoardTags]
  );
}

// Helper functions for updating cards

async function updateCardPriority(
  memberCard: MemberCard,
  newPriority: string | null,
  view: MemberView
) {
  const file = view.app.vault.getAbstractFileByPath(memberCard.sourceBoardPath);
  if (!file || !(file instanceof TFile)) {
    throw new Error(`Could not find source file: ${memberCard.sourceBoardPath}`);
  }

  const content = await view.app.vault.read(file);
  const lines = content.split('\n');
  const lineIndex = (memberCard.sourceStartLine || 1) - 1;

  if (lineIndex < 0 || lineIndex >= lines.length) {
    throw new Error(`Invalid source line number: ${memberCard.sourceStartLine}`);
  }

  let updatedLine = lines[lineIndex];

  // Remove existing priority
  updatedLine = updatedLine.replace(/\s*!(low|medium|high)\b/gi, '');

  // Add new priority if specified
  if (newPriority) {
    // Insert priority before any existing tags or block ID
    const tagMatch = updatedLine.match(/^(\s*-\s*\[[x ]\]\s*)(.*?)(\s*#.*)?(\s*\^[a-zA-Z0-9]+)?$/);
    if (tagMatch) {
      const prefix = tagMatch[1]; // "- [ ] " or "- [x] "
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

  // Clean up multiple spaces
  updatedLine = updatedLine.replace(/\s+/g, ' ').trim();

  lines[lineIndex] = updatedLine;
  const updatedContent = lines.join('\n');
  await view.app.vault.modify(file, updatedContent);
}

async function updateCardTags(memberCard: MemberCard, tag: string, view: MemberView) {
  const file = view.app.vault.getAbstractFileByPath(memberCard.sourceBoardPath);
  if (!file || !(file instanceof TFile)) {
    throw new Error(`Could not find source file: ${memberCard.sourceBoardPath}`);
  }

  const content = await view.app.vault.read(file);
  const lines = content.split('\n');
  const lineIndex = (memberCard.sourceStartLine || 1) - 1;

  if (lineIndex < 0 || lineIndex >= lines.length) {
    throw new Error(`Invalid source line number: ${memberCard.sourceStartLine}`);
  }

  let updatedLine = lines[lineIndex];
  const tagClean = tag.replace(/^#/, '');
  const tagWithHash = `#${tagClean}`;

  const cardMetaTagsLower = (memberCard.tags || []).map((t) => t.replace(/^#/, '').toLowerCase());
  const isAssigned = cardMetaTagsLower.includes(tagClean.toLowerCase());

  if (isAssigned) {
    // Remove tag
    const tagPattern = new RegExp(`\\s*#?${escapeRegExpStr(tagClean)}\\b`, 'gi');
    updatedLine = updatedLine.replace(tagPattern, '');
  } else {
    // Add tag
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

  // Clean up multiple spaces
  updatedLine = updatedLine.replace(/\s+/g, ' ').trim();

  lines[lineIndex] = updatedLine;
  const updatedContent = lines.join('\n');
  await view.app.vault.modify(file, updatedContent);
}

async function updateCardDate(memberCard: MemberCard, newTitleRaw: string, view: MemberView) {
  const file = view.app.vault.getAbstractFileByPath(memberCard.sourceBoardPath);
  if (!file || !(file instanceof TFile)) {
    throw new Error(`Could not find source file: ${memberCard.sourceBoardPath}`);
  }

  const content = await view.app.vault.read(file);
  const lines = content.split('\n');
  const lineIndex = (memberCard.sourceStartLine || 1) - 1;

  if (lineIndex < 0 || lineIndex >= lines.length) {
    throw new Error(`Invalid source line number: ${memberCard.sourceStartLine}`);
  }

  lines[lineIndex] = newTitleRaw;
  const updatedContent = lines.join('\n');
  await view.app.vault.modify(file, updatedContent);
}

async function removeCardDate(memberCard: MemberCard, view: MemberView) {
  const file = view.app.vault.getAbstractFileByPath(memberCard.sourceBoardPath);
  if (!file || !(file instanceof TFile)) {
    throw new Error(`Could not find source file: ${memberCard.sourceBoardPath}`);
  }

  const content = await view.app.vault.read(file);
  const lines = content.split('\n');
  const lineIndex = (memberCard.sourceStartLine || 1) - 1;

  if (lineIndex < 0 || lineIndex >= lines.length) {
    throw new Error(`Invalid source line number: ${memberCard.sourceStartLine}`);
  }

  let updatedLine = lines[lineIndex];

  // Remove date patterns: @{date}, @[[date]], 📅date
  const dateTrigger = view.plugin.settings['date-trigger'] || '@';
  const timeTrigger = view.plugin.settings['time-trigger'] || '@@';
  const escapedDateTrigger = escapeRegExpStr(dateTrigger);
  const escapedTimeTrigger = escapeRegExpStr(timeTrigger);

  const removeDatePatternPart = `(?:${escapedDateTrigger}(?:{[^}]+}|\\[\\[[^\\]]+\\]\\])|📅\\d{4}-\\d{2}-\\d{2})`;
  const removeTimePatternPart = `(?:\\s*(?:${escapedDateTrigger}|${escapedTimeTrigger}){[^}]+})?`;
  const robustDateTimeRemoveRegex = new RegExp(
    `\\s*(?:${removeDatePatternPart}${removeTimePatternPart})`,
    'gi'
  );

  updatedLine = updatedLine.replace(robustDateTimeRemoveRegex, '').trim();

  // Clean up multiple spaces
  updatedLine = updatedLine.replace(/\s+/g, ' ').trim();

  lines[lineIndex] = updatedLine;
  const updatedContent = lines.join('\n');
  await view.app.vault.modify(file, updatedContent);
}

async function addBlockIdToCard(memberCard: MemberCard, blockId: string, view: MemberView) {
  const file = view.app.vault.getAbstractFileByPath(memberCard.sourceBoardPath);
  if (!file || !(file instanceof TFile)) {
    throw new Error(`Could not find source file: ${memberCard.sourceBoardPath}`);
  }

  const content = await view.app.vault.read(file);
  const lines = content.split('\n');
  const lineIndex = (memberCard.sourceStartLine || 1) - 1;

  if (lineIndex < 0 || lineIndex >= lines.length) {
    throw new Error(`Invalid source line number: ${memberCard.sourceStartLine}`);
  }

  let updatedLine = lines[lineIndex];

  // Add block ID at the end if not already present
  if (!updatedLine.includes(`^${blockId}`)) {
    updatedLine = updatedLine.trim() + ` ^${blockId}`;
  }

  lines[lineIndex] = updatedLine;
  const updatedContent = lines.join('\n');
  await view.app.vault.modify(file, updatedContent);

  // Update the memberCard object
  memberCard.blockId = blockId;
}
