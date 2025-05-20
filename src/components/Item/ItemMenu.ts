import update from 'immutability-helper';
import { Menu, Platform, TFile, TFolder } from 'obsidian';
import { Dispatch, StateUpdater, useCallback, useEffect, useState } from 'preact/hooks';
import { StateManager } from 'src/StateManager';
import { Path } from 'src/dnd/types';
import { moveEntity } from 'src/dnd/util/data';
import { t } from 'src/lang/helpers';

import { BoardModifiers } from '../../helpers/boardModifiers';
import { TagNameModal } from '../../modals/TagNameModal';
import { getAllTagsFromKanbanBoards } from '../../utils/kanbanTags';
import { applyTemplate, escapeRegExpStr, generateInstanceId } from '../helpers';
import { EditState, Item } from '../types';
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
      menuItem.setTitle(t('Assign Member') || 'Assign Member').setIcon('lucide-users');
      const subMenu = menuItem.setSubmenu();
      const cardAssignedMembers = item.data.assignedMembers || [];

      teamMembers.forEach((member) => {
        if (typeof member === 'string' && member.trim() !== '') {
          subMenu.addItem((subMenuItem) => {
            subMenuItem
              .setTitle(member)
              .setChecked(cardAssignedMembers.includes(member))
              .onClick(async () => {
                let newAssignedMembers = [...cardAssignedMembers];
                let newTitleRaw = item.data.titleRaw;
                const memberSyntax = `@@${member}`;

                if (newAssignedMembers.includes(member)) {
                  newAssignedMembers = newAssignedMembers.filter((m) => m !== member);
                  const regexMember = new RegExp(
                    `(?:^|\\s)${escapeRegExpStr(memberSyntax)}(?=\\s|$)`,
                    'gi'
                  );
                  newTitleRaw = newTitleRaw
                    .replace(regexMember, ' ')
                    .replace(/\s{2,}/g, ' ')
                    .trim();
                } else {
                  newAssignedMembers.push(member);
                  if (newTitleRaw.length > 0 && !newTitleRaw.endsWith(' ')) {
                    newTitleRaw += ' ';
                  }
                  newTitleRaw += memberSyntax;
                }

                const updatedItemData = {
                  ...item.data,
                  assignedMembers: newAssignedMembers,
                };
                boardModifiers.updateItem(
                  path,
                  stateManager.updateItemContent({ ...item, data: updatedItemData }, newTitleRaw)
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
    menu.addItem((loadItem) => {
      loadItem.setTitle('Loading tags...');
      // loadItem.setEnabled(false); // Temporarily commented out
    });
  } else {
    menu.addItem((menuItem) => {
      menuItem.setTitle(t('Assign Tag') || 'Assign Tag').setIcon('lucide-tag');
      const tagSubMenu = menuItem.setSubmenu();

      if (kanbanBoardTags.length > 0) {
        const cardMetaTagsLower = (item.data.metadata?.tags || []).map((t) =>
          t.replace(/^#/, '').toLowerCase()
        );

        kanbanBoardTags.forEach((tag) => {
          if (tag && typeof tag === 'string' && tag.trim() !== '') {
            tagSubMenu.addItem((subMenuItem) => {
              const menuTagClean = tag.trim();
              const menuTagLower = menuTagClean.toLowerCase();
              const isAssigned = cardMetaTagsLower.includes(menuTagLower);

              subMenuItem
                .setTitle(menuTagClean)
                .setChecked(isAssigned)
                .onClick(async () => {
                  const clickedTagOriginalCasing = menuTagClean;
                  const clickedTagLower = clickedTagOriginalCasing.toLowerCase();

                  let currentCardMetaTags = item.data.metadata?.tags || [];
                  let newTitleRaw = item.data.titleRaw;

                  const existingTagIndex = currentCardMetaTags.findIndex(
                    (t) => t.replace(/^#/, '').toLowerCase() === clickedTagLower
                  );

                  if (existingTagIndex !== -1) {
                    currentCardMetaTags = [
                      ...currentCardMetaTags.slice(0, existingTagIndex),
                      ...currentCardMetaTags.slice(existingTagIndex + 1),
                    ];
                    const escapedClickedTag = escapeRegExpStr(clickedTagOriginalCasing);
                    const tagRegex = new RegExp(`(?:^|\s)#${escapedClickedTag}(?=\s|$)`, 'gi');
                    newTitleRaw = newTitleRaw
                      .replace(tagRegex, ' ')
                      .replace(/\s{2,}/g, ' ')
                      .trim();
                  } else {
                    currentCardMetaTags.push(clickedTagOriginalCasing);
                    const titleLower = newTitleRaw.toLowerCase();
                    const tagWithHashLower = `#${clickedTagLower}`;
                    if (!titleLower.includes(tagWithHashLower)) {
                      if (newTitleRaw.length > 0 && !newTitleRaw.endsWith(' ')) {
                        newTitleRaw += ' ';
                      }
                      newTitleRaw += `#${clickedTagOriginalCasing}`;
                    }
                  }

                  const updatedItemData = update(item.data, {
                    metadata: { tags: { $set: currentCardMetaTags } },
                    titleRaw: { $set: newTitleRaw.trim() },
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
        tagSubMenu.addItem((subMenuItem) => {
          subMenuItem.setTitle('No tags found in Kanban boards');
          // subMenuItem.setEnabled(false); // Temporarily commented out
        });
      }

      tagSubMenu.addSeparator();
      tagSubMenu.addItem((subMenuItem) => {
        subMenuItem
          .setTitle(t('Add New Tag...') || 'Add New Tag...')
          .setIcon('lucide-plus-circle')
          .onClick(async () => {
            new TagNameModal(stateManager.app, (newTagRaw) => {
              if (newTagRaw && newTagRaw.trim() !== '') {
                let newTagClean = newTagRaw.trim().replace(/^#/, '');
                newTagClean = newTagClean.replace(/\s+/g, '-');

                if (newTagClean) {
                  const newTagToAddOriginalCasing = newTagClean;
                  const newTagToAddLower = newTagToAddOriginalCasing.toLowerCase();
                  let currentCardMetaTags = item.data.metadata?.tags || [];
                  let newTitleRaw = item.data.titleRaw;

                  const alreadyExistsIdx = currentCardMetaTags.findIndex(
                    (t) => t.replace(/^#/, '').toLowerCase() === newTagToAddLower
                  );

                  if (alreadyExistsIdx === -1) {
                    currentCardMetaTags.push(newTagToAddOriginalCasing);
                    const titleLower = newTitleRaw.toLowerCase();
                    const tagWithHashLower = `#${newTagToAddLower}`;
                    if (!titleLower.includes(tagWithHashLower)) {
                      if (newTitleRaw.length > 0 && !newTitleRaw.endsWith(' ')) {
                        newTitleRaw += ' ';
                      }
                      newTitleRaw += `#${newTagToAddOriginalCasing}`;
                    }
                  }

                  const updatedItemData = update(item.data, {
                    metadata: { tags: { $set: currentCardMetaTags } },
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
      currentMenu.addItem((menuItem) =>
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
}

export function useItemMenu({
  setEditState,
  item,
  path,
  boardModifiers,
  stateManager,
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
      const allVaultTagsObj = stateManager.app.metadataCache.getTags();
      const allVaultTags = Object.keys(allVaultTagsObj);

      const menu = new Menu();

      // --- PRIORITY ITEMS SECTION START ---
      // 1. Assign Member
      addAssignMemberOptions(menu, item, teamMembers, stateManager, boardModifiers, path);

      // 2. Assign Tag
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

      // 3. Add/Edit Date & Time (Moved here)
      menu.addItem((menuItem) => {
        menuItem
          .setIcon('lucide-calendar-check')
          .setTitle(hasDate ? t('Edit date') : t('Add date'))
          .onClick(() => {
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
              const shouldLinkDates = stateManager.getSetting('link-date-to-daily-note');
              const dateTrigger = stateManager.getSetting('date-trigger');
              const dateRegex = new RegExp(
                `(^|\\s)${escapeRegExpStr(dateTrigger)}(\\d{4}-\\d{2}-\\d{2})(\\s|$)`
              );
              const newTitleRaw = item.data.titleRaw.replace(dateRegex, ' ').trim();

              boardModifiers.updateItem(
                path,
                update(item, {
                  data: {
                    metadata: { date: { $set: undefined } },
                    titleRaw: { $set: newTitleRaw },
                    ...(shouldLinkDates && {
                      links: { $apply: (l) => l.filter((x) => x.type !== 'date') },
                    }),
                  },
                })
              );
            });
        });

        menu.addItem((menuItem) => {
          menuItem
            .setIcon('lucide-clock')
            .setTitle(hasTime ? t('Edit time') : t('Add time'))
            .onClick(() => {
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
                const timeTrigger = stateManager.getSetting('time-trigger');
                const timeRegex = new RegExp(
                  `(^|\\s)${escapeRegExpStr(timeTrigger)}(\\d{2}:\\d{2}(?::\\d{2})?)(\\s|$)`
                );
                const newTitleRaw = item.data.titleRaw.replace(timeRegex, ' ').trim();

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

      // 4. Move to List
      addMoveToOptions(menu, path, stateManager, boardModifiers);

      menu.addSeparator(); // Separator after priority items
      // --- PRIORITY ITEMS SECTION END ---

      // Original items (date items were already removed from here in previous step)
      menu.addItem((menuItem) => {
        menuItem
          .setIcon('lucide-edit')
          .setTitle(t('Edit card'))
          .onClick(() => setEditState(coordinates));
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

      const templates = stateManager.getSetting('templates');

      menu.showAtMouseEvent(e);
    },
    [setEditState, item, path, boardModifiers, stateManager, isLoadingTags, kanbanBoardTags]
  );
}
