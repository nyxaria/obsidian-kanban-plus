import update from 'immutability-helper';
import { Menu, Platform } from 'obsidian';
import { Dispatch, StateUpdater, useContext, useEffect, useMemo, useState } from 'preact/hooks';
import { Path } from 'src/dnd/types';
import { defaultSort } from 'src/helpers/util';
import { t } from 'src/lang/helpers';
import { lableToName } from 'src/parsers/helpers/inlineMetadata';

import { anyToString } from '../Item/MetadataTable';
import { KanbanContext } from '../context';
import { c, generateInstanceId } from '../helpers';
import { EditState, Lane, LaneSort, LaneTemplate } from '../types';
import { LaneColorPickerModal } from './LaneColorPickerModal';

export type LaneAction = 'delete' | 'archive' | 'archive-items' | null;

const actionLabels = {
  delete: {
    description: t('Are you sure you want to delete this list and all its cards?'),
    confirm: t('Yes, delete list'),
  },
  archive: {
    description: t('Are you sure you want to archive this list and all its cards?'),
    confirm: t('Yes, archive list'),
  },
  'archive-items': {
    description: t('Are you sure you want to archive all cards in this list?'),
    confirm: t('Yes, archive cards'),
  },
};

export interface ConfirmActionProps {
  lane: Lane;
  action: LaneAction;
  cancel: () => void;
  onAction: () => void;
}

export function ConfirmAction({ action, cancel, onAction, lane }: ConfirmActionProps) {
  useEffect(() => {
    // Immediately execute action if lane is empty
    if (action && lane.children.length === 0) {
      onAction();
    }
  }, [action, lane.children.length]);

  if (!action || (action && lane.children.length === 0)) return null;

  return (
    <div className={c('action-confirm-wrapper')}>
      <div className={c('action-confirm-text')}>{actionLabels[action].description}</div>
      <div>
        <button onClick={onAction} className={c('confirm-action-button')}>
          {actionLabels[action].confirm}
        </button>
        <button onClick={cancel} className={c('cancel-action-button')}>
          Cancel
        </button>
      </div>
    </div>
  );
}

export interface UseSettingsMenuParams {
  setEditState: Dispatch<StateUpdater<EditState>>;
  path: Path;
  lane: Lane;
}

export function useSettingsMenu({ setEditState, path, lane }: UseSettingsMenuParams) {
  const { stateManager, boardModifiers } = useContext(KanbanContext);
  const [confirmAction, setConfirmAction] = useState<LaneAction>(null);

  const settingsMenu = useMemo(() => {
    if (!lane || !lane.data) {
      console.error(
        '[LaneMenu] CRITICAL: lane or lane.data is undefined during menu construction. Lane ID:',
        lane?.id,
        'Lane object:',
        lane
      );
      return new Menu().addItem((item) =>
        item.setTitle(t('Error: Lane data missing') || 'Error: Lane data missing').setDisabled(true)
      );
    }
    console.log(
      '[LaneMenu] useMemo: Building menu for lane ID:',
      lane.id,
      'Title:',
      lane.data.title,
      'Sorted:',
      lane.data.sorted,
      'Children count:',
      lane.children.length
    );

    const metadataSortOptions = new Set<string>();
    let canSortDate = false;
    let canSortTags = false;

    lane.children.forEach((item, index) => {
      if (!item) {
        console.error(`[LaneMenu] Item at index ${index} is undefined. Lane ID: ${lane.id}`);
        return;
      }
      if (!item.data) {
        console.error(
          `[LaneMenu] item.data is undefined for item ID ${item.id} (index ${index}). Lane ID: ${lane.id}`
        );
        return;
      }
      // item.data.metadata can be legitimately undefined if no metadata exists.
      // Access to its properties will use optional chaining.

      const taskData = item.data.metadata?.inlineMetadata;
      if (taskData) {
        taskData.forEach((m) => {
          if (m.key === 'repeat') return;
          if (!metadataSortOptions.has(m.key)) metadataSortOptions.add(m.key);
        });
      }

      if (!canSortDate && item.data.metadata?.date) canSortDate = true;
      if (!canSortTags && item.data.metadata?.tags?.length) canSortTags = true;
    });

    const menu = new Menu()
      .addItem((item) => {
        console.log('[LaneMenu] AddItem: "Edit list" - MenuItem created:', item);
        const titleString = t('Edit list') || 'Edit list';
        console.log(
          '[LaneMenu] AddItem: "Edit list" - Title string for setTitle:',
          titleString,
          typeof titleString
        );
        if (typeof titleString === 'undefined') {
          console.error('[LaneMenu] CRITICAL: t("Edit list") returned undefined!');
        }
        item.setTitle(titleString);
        console.log('[LaneMenu] AddItem: "Edit list" - After setTitle:', item);
        item.setIcon('lucide-edit-3').onClick(() => {
          console.log(
            '[LaneMenu] "Edit list" onClick triggered. Scheduling setEditState via setTimeout.'
          );
          setTimeout(() => {
            console.log('[LaneMenu] setEditState called via setTimeout for Edit list.');
            setEditState({ x: 0, y: 0 });
          }, 0);
        });
        console.log('[LaneMenu] AddItem: "Edit list" - After onClick:', item);
      })
      .addItem((item) => {
        console.log('[LaneMenu] AddItem: "Archive cards" - MenuItem created:', item);
        const titleString = t('Archive cards') || 'Archive cards';
        console.log(
          '[LaneMenu] AddItem: "Archive cards" - Title string for setTitle:',
          titleString,
          typeof titleString
        );
        item.setTitle(titleString);
        console.log('[LaneMenu] AddItem: "Archive cards" - After setTitle:', item);
        item.setIcon('lucide-archive').onClick(() => {
          console.log('[LaneMenu] "Archive cards" onClick. Scheduling setConfirmAction.');
          setTimeout(() => {
            console.log('[LaneMenu] setConfirmAction called via setTimeout for "Archive cards".');
            setConfirmAction('archive-items');
          }, 0);
        });
        console.log('[LaneMenu] AddItem: "Archive cards" - After onClick:', item);
      })
      .addItem((item) => {
        const titleString = t('Set background color') || 'Set background color';
        item.setTitle(titleString);
        item.setIcon('lucide-palette');
        item.onClick(() => {
          console.log('[LaneMenu] "Set background color" onClick. Opening LaneColorPickerModal.');
          item.menu.hide();
          new LaneColorPickerModal(
            stateManager.app,
            lane.id,
            stateManager,
            lane.data?.backgroundColor
          ).open();
        });
      })
      .addSeparator()
      .addItem((i) => {
        console.log('[LaneMenu] AddItem: "Insert list before" - MenuItem created:', i);
        const titleString = t('Insert list before') || 'Insert list before';
        console.log(
          '[LaneMenu] AddItem: "Insert list before" - Title string for setTitle:',
          titleString,
          typeof titleString
        );
        i.setTitle(titleString);
        console.log('[LaneMenu] AddItem: "Insert list before" - After setTitle:', i);
        i.setIcon('arrow-left-to-line').onClick(() => {
          console.log('[LaneMenu] "Insert list before" onClick. Scheduling insertLane.');
          i.menu.hide();
          setTimeout(() => {
            console.log('[LaneMenu] insertLane called via setTimeout for "Insert list before".');
            boardModifiers.insertLane(path, {
              ...LaneTemplate,
              id: generateInstanceId(),
              children: [],
              data: {
                title: '',
                shouldMarkItemsComplete: false,
                forceEditMode: true,
              },
            });
          }, 0);
        });
        console.log('[LaneMenu] AddItem: "Insert list before" - After onClick:', i);
      })
      .addItem((i) => {
        console.log('[LaneMenu] AddItem: "Insert list after" - MenuItem created:', i);
        const titleString = t('Insert list after') || 'Insert list after';
        console.log(
          '[LaneMenu] AddItem: "Insert list after" - Title string for setTitle:',
          titleString,
          typeof titleString
        );
        i.setTitle(titleString);
        console.log('[LaneMenu] AddItem: "Insert list after" - After setTitle:', i);
        i.setIcon('arrow-right-to-line').onClick(() => {
          console.log('[LaneMenu] "Insert list after" onClick. Scheduling insertLane.');
          i.menu.hide();
          setTimeout(() => {
            console.log('[LaneMenu] insertLane called via setTimeout for "Insert list after".');
            const newPath = [...path];
            newPath[newPath.length - 1] = newPath[newPath.length - 1] + 1;
            boardModifiers.insertLane(newPath, {
              ...LaneTemplate,
              id: generateInstanceId(),
              children: [],
              data: {
                title: '',
                shouldMarkItemsComplete: false,
                forceEditMode: true,
              },
            });
          }, 0);
        });
        console.log('[LaneMenu] AddItem: "Insert list after" - After onClick:', i);
      })
      .addSeparator()
      .addItem((item) => {
        console.log('[LaneMenu] AddItem: "Archive list" - MenuItem created:', item);
        const titleString = t('Archive list') || 'Archive list';
        console.log(
          '[LaneMenu] AddItem: "Archive list" - Title string for setTitle:',
          titleString,
          typeof titleString
        );
        item.setTitle(titleString);
        console.log('[LaneMenu] AddItem: "Archive list" - After setTitle:', item);
        item.setIcon('lucide-archive').onClick(() => {
          console.log('[LaneMenu] "Archive list" onClick. Scheduling setConfirmAction.');
          setTimeout(() => {
            console.log('[LaneMenu] setConfirmAction called via setTimeout for "Archive list".');
            setConfirmAction('archive');
          }, 0);
        });
        console.log('[LaneMenu] AddItem: "Archive list" - After onClick:', item);
      })
      .addItem((item) => {
        console.log('[LaneMenu] AddItem: "Delete list" - MenuItem created:', item);
        const titleString = t('Delete list') || 'Delete list';
        console.log(
          '[LaneMenu] AddItem: "Delete list" - Title string for setTitle:',
          titleString,
          typeof titleString
        );
        item.setTitle(titleString);
        console.log('[LaneMenu] AddItem: "Delete list" - After setTitle:', item);
        item.setIcon('lucide-trash-2').onClick(() => {
          console.log('[LaneMenu] "Delete list" onClick. Scheduling setConfirmAction.');
          setTimeout(() => {
            console.log('[LaneMenu] setConfirmAction called via setTimeout for "Delete list".');
            setConfirmAction('delete');
          }, 0);
        });
        console.log('[LaneMenu] AddItem: "Delete list" - After onClick:', item);
      })
      .addSeparator();

    const addSortOptions = (menuInstance: Menu, isSubmenu: boolean) => {
      menuInstance.addItem((item) => {
        console.log(
          '[LaneMenu] AddSortOptions: "Sort by card text" - MenuItem created:',
          item,
          'Is Submenu:',
          isSubmenu
        );
        const titleString = t('Sort by card text') || 'Sort by card text';
        console.log(
          '[LaneMenu] AddSortOptions: "Sort by card text" - Title string for setTitle:',
          titleString,
          typeof titleString
        );
        item.setTitle(titleString);
        console.log('[LaneMenu] AddSortOptions: "Sort by card text" - After setTitle:', item);
        item.setIcon('arrow-down-up').onClick(() => {
          console.log('[LaneMenu] "Sort by card text" onClick. Scheduling sort.');
          item.menu.hide();
          setTimeout(() => {
            console.log('[LaneMenu] Performing sort for "Sort by card text".');
            const children = lane.children.slice().filter((child) => child && child.data);
            const isAsc = lane.data.sorted === LaneSort.TitleAsc;

            children.sort((a, b) => {
              const titleA = a.data.title || '';
              const titleB = b.data.title || '';
              if (isAsc) {
                return titleB.localeCompare(titleA);
              }
              return titleA.localeCompare(titleB);
            });

            boardModifiers.updateLane(
              path,
              update(lane, {
                children: {
                  $set: children,
                },
                data: {
                  sorted: {
                    $set:
                      lane.data.sorted === LaneSort.TitleAsc
                        ? LaneSort.TitleDsc
                        : LaneSort.TitleAsc,
                  },
                },
              })
            );
          }, 0);
        });
      });

      if (canSortDate) {
        menuInstance.addItem((item) => {
          console.log(
            '[LaneMenu] AddSortOptions: "Sort by date" - MenuItem created:',
            item,
            'Is Submenu:',
            isSubmenu
          );
          const titleString = t('Sort by date') || 'Sort by date';
          console.log(
            '[LaneMenu] AddSortOptions: "Sort by date" - Title string for setTitle:',
            titleString,
            typeof titleString
          );
          item.setTitle(titleString);
          console.log('[LaneMenu] AddSortOptions: "Sort by date" - After setTitle:', item);
          item.setIcon('arrow-down-up').onClick(() => {
            console.log('[LaneMenu] "Sort by date" onClick. Scheduling sort.');
            item.menu.hide();
            setTimeout(() => {
              console.log('[LaneMenu] Performing sort for "Sort by date".');
              const children = lane.children
                .slice()
                .filter((child) => child && child.data && child.data.metadata);
              const mod = lane.data.sorted === LaneSort.DateAsc ? -1 : 1;

              children.sort((a, b) => {
                const aDate: moment.Moment | undefined =
                  a.data.metadata?.time || a.data.metadata?.date;
                const bDate: moment.Moment | undefined =
                  b.data.metadata?.time || b.data.metadata?.date;

                if (aDate && !bDate) return -1 * mod;
                if (bDate && !aDate) return 1 * mod;
                if (!aDate && !bDate) return 0;
                if (!aDate || !bDate) return 0; // Should be covered by above, but for type safety

                return (aDate.isBefore(bDate) ? -1 : 1) * mod;
              });

              boardModifiers.updateLane(
                path,
                update(lane, {
                  children: {
                    $set: children,
                  },
                  data: {
                    sorted: {
                      $set:
                        lane.data.sorted === LaneSort.DateAsc ? LaneSort.DateDsc : LaneSort.DateAsc,
                    },
                  },
                })
              );
            }, 0);
          });
        });
      }

      if (canSortTags) {
        menuInstance.addItem((item) => {
          console.log(
            '[LaneMenu] AddSortOptions: "Sort by tags" - MenuItem created:',
            item,
            'Is Submenu:',
            isSubmenu
          );
          const titleString = t('Sort by tags') || 'Sort by tags';
          console.log(
            '[LaneMenu] AddSortOptions: "Sort by tags" - Title string for setTitle:',
            titleString,
            typeof titleString
          );
          item.setTitle(titleString);
          console.log('[LaneMenu] AddSortOptions: "Sort by tags" - After setTitle:', item);
          item.setIcon('arrow-down-up').onClick(() => {
            console.log('[LaneMenu] "Sort by tags" onClick. Scheduling sort.');
            item.menu.hide();
            setTimeout(() => {
              console.log('[LaneMenu] Performing sort for "Sort by tags".');
              const tagSortOrder = stateManager.getSetting('tag-sort');
              const children = lane.children
                .slice()
                .filter((child) => child && child.data && child.data.metadata);
              const desc = lane.data.sorted === LaneSort.TagsAsc ? true : false;

              children.sort((a, b) => {
                const tagsA = a.data.metadata?.tags;
                const tagsB = b.data.metadata?.tags;

                if (!tagsA?.length && !tagsB?.length) return 0;
                if (!tagsA?.length) return 1;
                if (!tagsB?.length) return -1;

                const aSortOrder =
                  tagSortOrder?.findIndex((sort) => tagsA.includes(sort.tag)) ?? -1;
                const bSortOrder =
                  tagSortOrder?.findIndex((sort) => tagsB.includes(sort.tag)) ?? -1;

                if (aSortOrder > -1 && bSortOrder < 0) return desc ? 1 : -1;
                if (bSortOrder > -1 && aSortOrder < 0) return desc ? -1 : 1;
                if (aSortOrder > -1 && bSortOrder > -1) {
                  return desc ? bSortOrder - aSortOrder : aSortOrder - bSortOrder;
                }

                if (desc) return defaultSort(tagsB.join(''), tagsA.join(''));
                return defaultSort(tagsA.join(''), tagsB.join(''));
              });

              boardModifiers.updateLane(
                path,
                update(lane, {
                  children: {
                    $set: children,
                  },
                  data: {
                    sorted: {
                      $set:
                        lane.data.sorted === LaneSort.TagsAsc ? LaneSort.TagsDsc : LaneSort.TagsAsc,
                    },
                  },
                })
              );
            }, 0);
          });
        });
      }

      if (metadataSortOptions.size) {
        metadataSortOptions.forEach((k) => {
          menuInstance.addItem((i) => {
            const sortByKeyTitle =
              (t('Sort by') || 'Sort by') + ' ' + lableToName(k).toLocaleLowerCase();
            console.log(
              '[LaneMenu] AddSortOptions: "Sort by ' + k + '" - MenuItem created:',
              i,
              'Is Submenu:',
              isSubmenu
            );
            console.log(
              '[LaneMenu] AddSortOptions: "Sort by ' + k + '" - Title string for setTitle:',
              sortByKeyTitle,
              typeof sortByKeyTitle
            );
            i.setTitle(sortByKeyTitle);
            console.log('[LaneMenu] AddSortOptions: "Sort by ' + k + '" - After setTitle:', i);
            i.setIcon('arrow-down-up').onClick(() => {
              console.log('[LaneMenu] "Sort by ' + k + '" onClick. Scheduling sort.');
              i.menu.hide();
              setTimeout(() => {
                console.log('[LaneMenu] Performing sort for "Sort by ' + k + '".');
                const children = lane.children
                  .slice()
                  .filter((child) => child && child.data && child.data.metadata);
                const desc = lane.data.sorted === k + '-asc' ? true : false;

                children.sort((a, b) => {
                  const valA = a.data.metadata?.inlineMetadata?.find((m) => m.key === k);
                  const valB = b.data.metadata?.inlineMetadata?.find((m) => m.key === k);

                  if (valA === undefined && valB === undefined) return 0;
                  if (valA === undefined) return 1;
                  if (valB === undefined) return -1;

                  // Ensure valA.value and valB.value exist before passing to anyToString
                  const strA =
                    valA.value !== undefined ? anyToString(valA.value, stateManager) : '';
                  const strB =
                    valB.value !== undefined ? anyToString(valB.value, stateManager) : '';

                  if (desc) {
                    return defaultSort(strB, strA);
                  }
                  return defaultSort(strA, strB);
                });

                boardModifiers.updateLane(
                  path,
                  update(lane, {
                    children: {
                      $set: children,
                    },
                    data: {
                      sorted: {
                        $set: lane.data.sorted === k + '-asc' ? k + '-desc' : k + '-asc',
                      },
                    },
                  })
                );
              }, 0);
            });
          });
        });
      }
    };

    if (Platform.isPhone) {
      addSortOptions(menu, false);
    } else {
      menu.addItem((item) => {
        const submenuTitle = t('Sort by') || 'Sort by';
        console.log('[LaneMenu] MainMenu: "Sort by" (for submenu) - MenuItem created:', item);
        console.log(
          '[LaneMenu] MainMenu: "Sort by" (for submenu) - Title string for setTitle:',
          submenuTitle,
          typeof submenuTitle
        );
        item.setTitle(submenuTitle);
        console.log('[LaneMenu] MainMenu: "Sort by" (for submenu) - After setTitle:', item);
        const submenu = (item as any).setIcon('arrow-down-up').setSubmenu();
        console.log('[LaneMenu] MainMenu: "Sort by" (for submenu) - Submenu created:', submenu);
        addSortOptions(submenu, true);
        console.log(
          '[LaneMenu] MainMenu: "Sort by" (for submenu) - After addSortOptions to submenu. Parent item:',
          item
        );
      });
    }

    console.log(
      '[LaneMenu] useMemo: Finished building menu for lane ID:',
      lane.id,
      'Menu object:',
      menu
    );
    return menu;
  }, [stateManager, boardModifiers, setConfirmAction, path, lane]);

  return {
    settingsMenu,
    confirmAction,
    setConfirmAction,
  };
}
