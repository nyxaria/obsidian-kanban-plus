import update from 'immutability-helper';
import { Menu, MenuItem, Platform, TFile, TFolder } from 'obsidian';
import { Dispatch, MutableRef, StateUpdater, useCallback, useEffect, useState } from 'preact/hooks';
import { StateManager } from 'src/StateManager';
import { Path } from 'src/dnd/types';
import { moveEntity } from 'src/dnd/util/data';
import { t } from 'src/lang/helpers';

import { BoardModifiers } from '../../helpers/boardModifiers';
import { TagNameModal } from '../../modals/TagNameModal';
import { getAllTagsFromKanbanBoards } from '../../utils/kanbanTags';
import { applyTemplate, escapeRegExpStr, generateInstanceId, getTagSymbolFn } from '../helpers';
import { EditState, Item, ItemMetadata } from '../types';
import {
  constructDatePicker,
  constructMenuDatePickerOnChange,
  constructMenuTimePickerOnChange,
  constructTimePicker,
} from './helpers';

const illegalCharsRegEx = /[^\\/:"*?<>|]+/g;
const embedRegEx = /!?\[\[([^\\]]*)\.[^\\]]+\]\]/g;
const wikilinkRegEx = /!?\[\[([^\\]]*)\]\]/g;
const mdLinkRegEx = /!?\[([^\]]*)\]\([^)]*\)/g;
const tagRegEx = /#([^\u2000-\u206F\u2E00-\u2E7F'!"#$%&()*+,.:;<=>?@^`{|}~[\]\\\\\s\n\r]+)/g;
const condenceWhiteSpaceRE = /\s+/g;

// --- HELPER FUNCTION DEFINITIONS START ---
function addAssignMemberOptions(
  menu: Menu,
  item: Item,
  teamMembers: string[],
  stateManager: StateManager,
  boardModifiers: BoardModifiers,
  path: Path
) {
  if (teamMembers.length > 0) {
    menu.addItem((menuItem) => {
      menuItem.setTitle('Assign Member').setIcon('lucide-users');
      const subMenu = (menuItem as any).setSubmenu();
      const cardAssignedMembers = item.data.assignedMembers || [];

      teamMembers.forEach((member) => {
        if (typeof member === 'string' && member.trim() !== '') {
          subMenu.addItem((subMenuItem: MenuItem) => {
            subMenuItem
              .setTitle(member)
              .setChecked(cardAssignedMembers.includes(member))
              .onClick(async () => {
                let newAssignedMembers = [...cardAssignedMembers];
                let baseTitle = item.data.titleRaw;
                const memberSyntaxPrefix = '@@'; // Use the actual prefix from settings if available

                // Capture existing priority tag BEFORE cleaning baseTitle
                const priorityRegexGlobal = /(?:^|\s)(!low|!medium|!high)(?=\s|$)/gi;
                const existingPriorityMatch = priorityRegexGlobal.exec(baseTitle);
                const existingPriorityTag = existingPriorityMatch
                  ? existingPriorityMatch[0].trim()
                  : null; // Get the full tag e.g., "!high"

                // If priority tag exists, remove it from baseTitle for now so it's not duplicated
                if (existingPriorityTag) {
                  baseTitle = baseTitle
                    .replace(priorityRegexGlobal, ' ')
                    .replace(/\s{2,}/g, ' ')
                    .trim();
                }

                // 1. Remove ALL existing member tags from baseTitle to get a clean title
                const allMembersRegex = new RegExp(
                  `\\s*${escapeRegExpStr(memberSyntaxPrefix)}[^\\s]+`,
                  'g'
                );
                baseTitle = baseTitle
                  .replace(allMembersRegex, '')
                  .replace(/\s{2,}/g, ' ')
                  .trim();

                // 2. Update the newAssignedMembers list
                if (newAssignedMembers.includes(member)) {
                  newAssignedMembers = newAssignedMembers.filter((m) => m !== member);
                } else {
                  newAssignedMembers.push(member);
                }

                // 3. Reconstruct workTitleRaw starting with the cleaned baseTitle
                let workTitleRaw = baseTitle;

                // Append members
                if (newAssignedMembers.length > 0) {
                  const membersString = newAssignedMembers
                    .map((m) => `${memberSyntaxPrefix}${m}`)
                    .join(' ');
                  if (workTitleRaw.length > 0 && !workTitleRaw.endsWith(' ')) {
                    workTitleRaw += ' ';
                  }
                  workTitleRaw += membersString;
                }

                // Re-append priority tag if it existed
                if (existingPriorityTag) {
                  if (workTitleRaw.length > 0 && !workTitleRaw.endsWith(' ')) {
                    workTitleRaw += ' ';
                  }
                  workTitleRaw += existingPriorityTag;
                }

                workTitleRaw = workTitleRaw.replace(/\s{2,}/g, ' ').trim();

                const updatedItemData = {
                  ...item.data,
                  assignedMembers: newAssignedMembers,
                };
                boardModifiers.updateItem(
                  path,
                  stateManager.updateItemContent({ ...item, data: updatedItemData }, workTitleRaw)
                );
              });
          });
        } else {
          console.warn(
            '[Kanban Plugin] ItemMenu: Invalid or empty team member found in settings and was skipped:',
            member
          );
        }
      });
    });
  }
}

function addAssignPriorityOptions(
  menu: Menu,
  item: Item,
  stateManager: StateManager,
  boardModifiers: BoardModifiers,
  path: Path
) {
  const priorities: Array<ItemMetadata['priority']> = ['high', 'medium', 'low'];
  const priorityToIcon: Record<string, string> = {
    high: 'lucide-flame',
    medium: 'lucide-bar-chart-2',
    low: 'lucide-arrow-down',
  };
  const priorityToLabel: Record<string, string> = {
    high: 'High',
    medium: 'Medium',
    low: 'Low',
  };

  menu.addItem((menuItem) => {
    menuItem.setTitle('Assign Priority').setIcon('lucide-star');
    const subMenu = (menuItem as any).setSubmenu();
    const currentPriority = item.data.metadata?.priority;

    priorities.forEach((priority) => {
      subMenu.addItem((subMenuItem: MenuItem) => {
        subMenuItem
          .setTitle(priorityToLabel[priority])
          .setIcon(priorityToIcon[priority])
          .setChecked(priority === currentPriority)
          .onClick(async () => {
            let newTitleRaw = item.data.titleRaw;
            let newPriorityToSet: ItemMetadata['priority'] | undefined;

            if (currentPriority === priority) {
              // Clicked on the currently set priority, so clear it
              newPriorityToSet = undefined;
            } else {
              // Clicked on a new priority or no priority was set
              newPriorityToSet = priority;
            }

            // Remove any existing priority tag
            const priorityRegex = /(?:^|\s)(!low|!medium|!high)(?=\s|$)/gi;
            newTitleRaw = newTitleRaw
              .replace(priorityRegex, ' ')
              .replace(/\s{2,}/g, ' ')
              .trim();

            // Add new priority tag if one is set
            if (newPriorityToSet) {
              if (newTitleRaw.length > 0 && !newTitleRaw.endsWith(' ')) {
                newTitleRaw += ' ';
              }
              newTitleRaw += `!${newPriorityToSet}`;
            }

            const updatedItemData = update(item.data, {
              metadata: { priority: { $set: newPriorityToSet } },
              titleRaw: { $set: newTitleRaw.trim() },
            });
            const updatedItem = { ...item, data: updatedItemData };

            boardModifiers.updateItem(
              path,
              stateManager.updateItemContent(updatedItem, updatedItem.data.titleRaw)
            );
          });
      });
    });
  });
}

function addAssignTagOptions(
  menu: Menu,
  item: Item,
  kanbanBoardTags: string[],
  isLoadingTags: boolean,
  stateManager: StateManager,
  boardModifiers: BoardModifiers,
  path: Path,
  onTagAddedCallback: (newTag: string) => void
) {
  if (isLoadingTags) {
    menu.addItem((menuItem: MenuItem) => {
      menuItem.setTitle('Assign Tag').setIcon('lucide-tag');
      const tagSubMenu = (menuItem as any).setSubmenu();
      tagSubMenu.addItem((loadItem: MenuItem) => {
        loadItem.setTitle('Loading tags...');
      });
    });
  } else {
    menu.addItem((menuItem: MenuItem) => {
      menuItem.setTitle('Assign Tag').setIcon('lucide-tag');
      const tagSubMenu = (menuItem as any).setSubmenu();

      if (kanbanBoardTags.length > 0) {
        const cardMetaTagsLower = (item.data.metadata?.tags || []).map((t) =>
          t.replace(/^#/, '').toLowerCase()
        );

        // Get tag symbol function
        const tagSymbols = stateManager.getSetting('tag-symbols') || [];
        const getTagSymbol = getTagSymbolFn(tagSymbols);

        kanbanBoardTags.forEach((tag) => {
          if (tag && typeof tag === 'string' && tag.trim() !== '') {
            tagSubMenu.addItem((subMenuItem: MenuItem) => {
              const menuTagClean = tag.trim();
              const menuTagLower = menuTagClean.toLowerCase();
              const isAssigned = cardMetaTagsLower.includes(menuTagLower);

              // Get tag symbol for display
              const tagWithHash = menuTagClean.startsWith('#') ? menuTagClean : `#${menuTagClean}`;
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
                  const clickedTagOriginalCasing = menuTagClean;
                  const clickedTagLower = clickedTagOriginalCasing.toLowerCase();

                  const currentCardMetaTags = [...(item.data.metadata?.tags || [])];
                  let newTitleRaw = item.data.titleRaw;

                  const existingTagIndex = currentCardMetaTags.findIndex(
                    (t) => t.replace(/^#/, '').toLowerCase() === clickedTagLower
                  );

                  if (existingTagIndex !== -1) {
                    currentCardMetaTags.splice(existingTagIndex, 1);

                    const tagNameToRemove = clickedTagOriginalCasing.replace(/^#/, '');
                    const tagPattern = `(?:^|\\s)(?:#?${escapeRegExpStr(tagNameToRemove)})(?=\\s|$)`;
                    const tagRegexToRemove = new RegExp(tagPattern, 'gi');

                    newTitleRaw = newTitleRaw.replace(tagRegexToRemove, ' ').trim();
                    newTitleRaw = newTitleRaw.replace(/\s{2,}/g, ' ').trim();
                  } else {
                    // Tag is not assigned, so add it
                    // Ensure tagToAdd always starts with # for consistency in titleRaw
                    const tagToAddInTitle = clickedTagOriginalCasing.startsWith('#')
                      ? clickedTagOriginalCasing
                      : `#${clickedTagOriginalCasing}`;

                    currentCardMetaTags.push(
                      clickedTagOriginalCasing.startsWith('#')
                        ? clickedTagOriginalCasing
                        : `#${clickedTagOriginalCasing.replace(/^#/, '')}`
                    ); // Store with # in metadata

                    // Check if the tag (with #) is already in the titleRaw to avoid duplicates
                    const escapedTagForCheck = escapeRegExpStr(tagToAddInTitle);
                    const existingTagInTitleRegex = new RegExp(
                      `(?:^|\\s)${escapedTagForCheck}(?=\\s|$)`,
                      'i'
                    );
                    if (!existingTagInTitleRegex.test(newTitleRaw)) {
                      if (newTitleRaw.length > 0 && !newTitleRaw.endsWith(' ')) {
                        newTitleRaw += ' ';
                      }
                      newTitleRaw += tagToAddInTitle;
                    }
                    newTitleRaw = newTitleRaw.replace(/\s{2,}/g, ' ').trim();
                  }

                  const updatedItemData = update(item.data, {
                    metadata: { tags: { $set: currentCardMetaTags } },
                    titleRaw: { $set: newTitleRaw },
                  });
                  const updatedItem = { ...item, data: updatedItemData };

                  boardModifiers.updateItem(
                    path,
                    stateManager.updateItemContent(updatedItem, updatedItem.data.titleRaw)
                  );
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
            new TagNameModal(stateManager.app, (newTagRaw) => {
              if (newTagRaw && newTagRaw.trim() !== '') {
                let newTagClean = newTagRaw.trim().replace(/^#/, '');
                newTagClean = newTagClean.replace(/\s+/g, '-');

                if (newTagClean) {
                  const newTagToAddOriginalCasing = newTagClean;
                  const newTagToAddLower = newTagToAddOriginalCasing.toLowerCase();
                  const initialTagsForNew = [...(item.data.metadata?.tags || [])];
                  let newTitleRaw = item.data.titleRaw;

                  const alreadyExistsIdx = initialTagsForNew.findIndex(
                    (t) => t.replace(/^#/, '').toLowerCase() === newTagToAddLower
                  );

                  if (alreadyExistsIdx === -1) {
                    const finalTagsForNew = [...initialTagsForNew, newTagToAddOriginalCasing];
                    const titleLower = newTitleRaw.toLowerCase();
                    const tagWithHashLower = `#${newTagToAddLower}`;
                    if (!titleLower.includes(tagWithHashLower)) {
                      if (newTitleRaw.length > 0 && !newTitleRaw.endsWith(' ')) {
                        newTitleRaw += ' ';
                      }
                      newTitleRaw += `#${newTagToAddOriginalCasing}`;
                    }
                    const updatedItemData = update(item.data, {
                      metadata: { tags: { $set: finalTagsForNew } },
                      titleRaw: { $set: newTitleRaw.trim() },
                    });
                    const updatedItem = { ...item, data: updatedItemData };

                    boardModifiers.updateItem(
                      path,
                      stateManager.updateItemContent(updatedItem, updatedItem.data.titleRaw)
                    );
                    onTagAddedCallback(newTagToAddOriginalCasing);
                  }
                }
              }
            }).open();
          });
      });
    });
  }
}

function addMoveToOptions(
  menu: Menu,
  path: Path,
  stateManager: StateManager,
  boardModifiers: BoardModifiers
) {
  const addMoveToOptionsInner = (currentMenu: Menu) => {
    const lanes = stateManager.state.children;
    if (lanes.length <= 1) return;
    for (let i = 0, len = lanes.length; i < len; i++) {
      const laneTitle =
        typeof lanes[i].data.title === 'string' ? lanes[i].data.title : 'Unnamed Lane';
      currentMenu.addItem((menuItem: MenuItem) =>
        menuItem
          .setIcon('lucide-square-kanban')
          .setChecked(path[0] === i)
          .setTitle(laneTitle)
          .onClick(() => {
            if (path[0] === i) return;
            stateManager.setState((boardData) => {
              return moveEntity(boardData, path, [i, 0]);
            });
          })
      );
    }
  };

  if (Platform.isPhone) {
    addMoveToOptionsInner(menu); // Direct add for phone
  } else {
    menu.addItem((menuItem) => {
      const submenu = (menuItem as any) // Cast to any for setSubmenu, or ensure Menu type supports it.
        .setTitle(t('Move to list') || 'Move to list')
        .setIcon('lucide-square-kanban')
        .setSubmenu();
      addMoveToOptionsInner(submenu);
    });
  }
}
// --- HELPER FUNCTION DEFINITIONS END ---

interface UseItemMenuParams {
  setEditState: Dispatch<StateUpdater<EditState>>;
  item: Item;
  path: Path;
  boardModifiers: BoardModifiers;
  stateManager: StateManager;
  onItemStartEdit?: () => void;
  isInitiatingEditRef?: MutableRef<boolean>;
}

export function useItemMenu({
  setEditState,
  item,
  path,
  boardModifiers,
  stateManager,
  onItemStartEdit,
  isInitiatingEditRef,
}: UseItemMenuParams) {
  const [kanbanBoardTags, setKanbanBoardTags] = useState<string[]>([]);
  const [isLoadingTags, setIsLoadingTags] = useState<boolean>(true);

  useEffect(() => {
    setIsLoadingTags(true);
    getAllTagsFromKanbanBoards(stateManager)
      .then((tags) => {
        setKanbanBoardTags(tags.sort());
        setIsLoadingTags(false);
      })
      .catch((err) => {
        console.error('[Kanban Plugin] Error fetching kanban board tags for menu:', err);
        setKanbanBoardTags([]);
        setIsLoadingTags(false);
      });
  }, [stateManager]);

  return useCallback(
    (e: MouseEvent) => {
      const coordinates = { x: e.clientX, y: e.clientY };
      const hasDate = !!item.data.metadata.date;
      const hasTime = !!item.data.metadata.time;
      const teamMembers: string[] = stateManager.getSetting('teamMembers') || [];

      const menu = new Menu();

      // --- PRIORITY ITEMS SECTION START ---
      // 1. Assign Priority
      addAssignPriorityOptions(menu, item, stateManager, boardModifiers, path);

      // 2. Assign Member
      addAssignMemberOptions(menu, item, teamMembers, stateManager, boardModifiers, path);

      // 3. Assign Tag
      addAssignTagOptions(
        menu,
        item,
        kanbanBoardTags,
        isLoadingTags,
        stateManager,
        boardModifiers,
        path,
        (newTag) => {
          // Optimistic update for kanbanBoardTags
          if (!kanbanBoardTags.includes(newTag)) {
            setKanbanBoardTags((prevTags) => [...prevTags, newTag].sort());
          }
        }
      );

      // 4. Add/Edit Date & Time (Moved here)
      menu.addItem((menuItem) => {
        menuItem
          .setIcon('lucide-calendar-check')
          .setTitle(hasDate ? t('Edit date') : t('Add date'))
          .onClick(() => {
            // Priority preservation logic will be handled by constructMenuDatePickerOnChange
            // as it's responsible for the final titleRaw update.
            constructDatePicker(
              e.view,
              stateManager,
              coordinates,
              constructMenuDatePickerOnChange({
                stateManager,
                boardModifiers,
                item,
                hasDate,
                path,
              }),
              item.data.metadata.date?.toDate()
            );
          });
      });

      if (hasDate) {
        menu.addItem((menuItem) => {
          menuItem
            .setIcon('lucide-x')
            .setTitle(t('Remove date'))
            .onClick(() => {
              const originalTitleRaw = item.data.titleRaw;
              const priorityRegexGlobal = /(?:^|\s)(!low|!medium|!high)(?=\s|$)/gi;
              const existingPriorityMatch = priorityRegexGlobal.exec(originalTitleRaw);
              const existingPriorityTag = existingPriorityMatch ? existingPriorityMatch[1] : null;

              let newTitleRaw = originalTitleRaw;
              if (existingPriorityTag) {
                newTitleRaw = newTitleRaw
                  .replace(priorityRegexGlobal, ' ')
                  .replace(/\s{2,}/g, ' ')
                  .trim();
              }

              const shouldLinkDates = stateManager.getSetting('link-date-to-daily-note');
              const dateTrigger = stateManager.getSetting('date-trigger');
              // More robust regex to remove date and associated time if present
              const dateTimeRegexPattern =
                `s*${escapeRegExpStr(dateTrigger)}{[^}]+}(s*${escapeRegExpStr(stateManager.getSetting('time-trigger'))}{[^}]+})?` +
                `|s*${escapeRegExpStr(dateTrigger)}[[^]]+](s*${escapeRegExpStr(stateManager.getSetting('time-trigger'))}{[^}]+})?` +
                `|s*📅s*d{4}-d{2}-d{2}(s*${escapeRegExpStr(stateManager.getSetting('time-trigger'))}{[^}]+})?`;

              const dateTimeRegex = new RegExp(dateTimeRegexPattern, 'gi');
              newTitleRaw = newTitleRaw
                .replace(dateTimeRegex, ' ')
                .replace(/\s{2,}/g, ' ')
                .trim();

              if (existingPriorityTag && !newTitleRaw.includes(existingPriorityTag)) {
                if (newTitleRaw.length > 0 && !newTitleRaw.endsWith(' ')) {
                  newTitleRaw += ' ';
                }
                newTitleRaw += existingPriorityTag;
              }
              newTitleRaw = newTitleRaw.replace(/\s{2,}/g, ' ').trim();

              const updates: any = {
                // Use 'any' for now to bypass complex type issue with immutability-helper
                data: {
                  metadata: { date: { $set: undefined }, time: { $set: undefined } }, // Also clear time
                  titleRaw: { $set: newTitleRaw },
                  ...(shouldLinkDates && {
                    links: { $apply: (l: any[]) => l.filter((x: any) => x.type !== 'date') },
                  }),
                },
              };

              boardModifiers.updateItem(path, update(item, updates));
            });
        });

        menu.addItem((menuItem) => {
          menuItem
            .setIcon('lucide-clock')
            .setTitle(hasTime ? t('Edit time') : t('Add time'))
            .onClick(() => {
              // Priority preservation will be handled by constructMenuTimePickerOnChange
              constructTimePicker(
                e.view,
                stateManager,
                coordinates,
                constructMenuTimePickerOnChange({
                  stateManager,
                  boardModifiers,
                  item,
                  hasTime,
                  path,
                }),
                item.data.metadata.time
              );
            });
        });

        if (hasTime) {
          menu.addItem((menuItem) => {
            menuItem
              .setIcon('lucide-x')
              .setTitle(t('Remove time'))
              .onClick(() => {
                const originalTitleRaw = item.data.titleRaw;
                const priorityRegexGlobal = /(?:^|\s)(!low|!medium|!high)(?=\s|$)/gi;
                const existingPriorityMatch = priorityRegexGlobal.exec(originalTitleRaw);
                const existingPriorityTag = existingPriorityMatch ? existingPriorityMatch[1] : null;

                let newTitleRaw = originalTitleRaw;
                if (existingPriorityTag) {
                  newTitleRaw = newTitleRaw
                    .replace(priorityRegexGlobal, ' ')
                    .replace(/\s{2,}/g, ' ')
                    .trim();
                }

                const timeTrigger = stateManager.getSetting('time-trigger');
                const timeRegex = new RegExp(
                  `(?:^|s)${escapeRegExpStr(timeTrigger)}{[^}]+}(?=s|$)`,
                  'gi'
                );
                newTitleRaw = newTitleRaw
                  .replace(timeRegex, ' ')
                  .replace(/\s{2,}/g, ' ')
                  .trim();

                if (existingPriorityTag && !newTitleRaw.includes(existingPriorityTag)) {
                  if (newTitleRaw.length > 0 && !newTitleRaw.endsWith(' ')) {
                    newTitleRaw += ' ';
                  }
                  newTitleRaw += existingPriorityTag;
                }
                newTitleRaw = newTitleRaw.replace(/\s{2,}/g, ' ').trim();

                boardModifiers.updateItem(
                  path,
                  update(item, {
                    data: {
                      metadata: { time: { $set: undefined } },
                      titleRaw: { $set: newTitleRaw },
                    },
                  })
                );
              });
          });
        }
      }

      // 5. Move to List
      addMoveToOptions(menu, path, stateManager, boardModifiers);

      menu.addSeparator(); // Separator after priority items
      // --- PRIORITY ITEMS SECTION END ---

      // Original items (date items were already removed from here in previous step)
      menu.addItem((menuItem) => {
        menuItem
          .setIcon('lucide-edit')
          .setTitle(t('Edit card'))
          .onClick(() => {
            if (isInitiatingEditRef) {
              isInitiatingEditRef.current = true;
            }
            setEditState(coordinates);
            onItemStartEdit?.();
          });
      });

      menu
        .addItem((menuItem) => {
          menuItem
            .setIcon('lucide-file-plus-2')
            .setTitle(t('New note from card'))
            .onClick(async () => {
              const prevTitle = item.data.titleRaw.split('\n')[0].trim();
              const sanitizedTitle = prevTitle
                .replace(embedRegEx, '$1')
                .replace(wikilinkRegEx, '$1')
                .replace(mdLinkRegEx, '$1')
                .replace(tagRegEx, '$1')
                .replace(illegalCharsRegEx, ' ')
                .trim()
                .replace(condenceWhiteSpaceRE, ' ');

              const newNoteFolder = stateManager.getSetting('new-note-folder');
              const newNoteTemplatePath = stateManager.getSetting('new-note-template');

              const targetFolder = newNoteFolder
                ? (stateManager.app.vault.getAbstractFileByPath(newNoteFolder as string) as TFolder)
                : stateManager.app.fileManager.getNewFileParent(stateManager.file.path);

              const newFile = (await (stateManager.app.fileManager as any).createNewMarkdownFile(
                targetFolder,
                sanitizedTitle
              )) as TFile;

              const newLeaf = stateManager.app.workspace.splitActiveLeaf();

              await newLeaf.openFile(newFile);

              stateManager.app.workspace.setActiveLeaf(newLeaf, false, true);

              await applyTemplate(stateManager, newNoteTemplatePath as string | undefined);

              const newTitleRaw = item.data.titleRaw.replace(
                prevTitle,
                stateManager.app.fileManager.generateMarkdownLink(newFile, stateManager.file.path)
              );

              boardModifiers.updateItem(path, stateManager.updateItemContent(item, newTitleRaw));
            });
        })
        .addItem((menuItem) => {
          menuItem
            .setIcon('lucide-link')
            .setTitle(t('Copy link to card'))
            .onClick(() => {
              if (item.data.blockId) {
                navigator.clipboard.writeText(
                  `${this.app.fileManager.generateMarkdownLink(
                    stateManager.file,
                    '',
                    '#^' + item.data.blockId
                  )}`
                );
              } else {
                const id = generateInstanceId(6);

                navigator.clipboard.writeText(
                  `${this.app.fileManager.generateMarkdownLink(stateManager.file, '', '#^' + id)}`
                );

                boardModifiers.updateItem(
                  path,
                  stateManager.updateItemContent(
                    update(item, { data: { blockId: { $set: id } } }),
                    item.data.titleRaw
                  )
                );
              }
            });
        })
        .addSeparator();

      if (/\n/.test(item.data.titleRaw)) {
        menu.addItem((menuItem) => {
          menuItem
            .setIcon('lucide-wrap-text')
            .setTitle(t('Split card'))
            .onClick(async () => {
              const titles = item.data.titleRaw.split(/[\r\n]+/g).map((t) => t.trim());
              const newItems = await Promise.all(
                titles.map((title) => {
                  return stateManager.getNewItem(title, ' ');
                })
              );

              boardModifiers.splitItem(path, newItems);
            });
        });
      }

      menu
        .addItem((menuItem) => {
          menuItem
            .setIcon('lucide-copy')
            .setTitle(t('Duplicate card'))
            .onClick(() => boardModifiers.duplicateEntity(path));
        })
        .addItem((menuItem) => {
          menuItem
            .setIcon('lucide-list-start')
            .setTitle(t('Insert card before'))
            .onClick(() =>
              boardModifiers.insertItems(path, [stateManager.getNewItem('', ' ', true)])
            );
        })
        .addItem((menuItem) => {
          menuItem
            .setIcon('lucide-list-end')
            .setTitle(t('Insert card after'))
            .onClick(() => {
              const newPath = [...path];

              newPath[newPath.length - 1] = newPath[newPath.length - 1] + 1;

              boardModifiers.insertItems(newPath, [stateManager.getNewItem('', ' ', true)]);
            });
        })
        .addItem((menuItem) => {
          menuItem
            .setIcon('lucide-arrow-up')
            .setTitle(t('Move to top'))
            .onClick(() => boardModifiers.moveItemToTop(path));
        })
        .addItem((menuItem) => {
          menuItem
            .setIcon('lucide-arrow-down')
            .setTitle(t('Move to bottom'))
            .onClick(() => boardModifiers.moveItemToBottom(path));
        })
        .addItem((menuItem) => {
          menuItem
            .setIcon('lucide-archive')
            .setTitle(t('Archive card'))
            .onClick(() => boardModifiers.archiveItem(path));
        })
        .addItem((menuItem) => {
          menuItem
            .setIcon('lucide-trash-2')
            .setTitle(t('Delete card'))
            .onClick(() => boardModifiers.deleteEntity(path));
        })
        .addSeparator();

      menu.showAtMouseEvent(e);
    },
    [
      setEditState,
      item,
      path,
      boardModifiers,
      stateManager,
      isLoadingTags,
      kanbanBoardTags,
      onItemStartEdit,
      isInitiatingEditRef,
    ]
  );
}
