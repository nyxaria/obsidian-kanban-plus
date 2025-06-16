import classcat from 'classcat';
import { TFile } from 'obsidian';
import { Component, memo } from 'preact/compat';
import { useCallback, useContext, useEffect, useRef, useState } from 'preact/hooks';

import { MemberView } from '../MemberView';
import { DndContext } from '../dnd/components/DndContext';
import { Droppable } from '../dnd/components/Droppable';
import { DndManagerContext } from '../dnd/components/context';
import { useDragHandle } from '../dnd/managers/DragManager';
import { getBoardModifiers } from '../helpers/boardModifiers';
import { t } from '../lang/helpers';
import KanbanPlugin from '../main';
import { DateAndTime, RelativeDate } from './Item/DateAndTime';
import { Items } from './Item/Item';
import { ItemCheckbox } from './Item/ItemCheckbox';
import { AssignedMembers, ItemContent, Tags } from './Item/ItemContent';
import { ItemPriority } from './Item/ItemPriority';
import { ItemMetadata } from './Item/MetadataTable';
import { getItemClassModifiers } from './Item/helpers';
import { KanbanContext, SearchContext } from './context';
import { c, useGetDateColorFn } from './helpers';
import {
  Board,
  EditState,
  EditingProcessState,
  Item,
  Lane,
  TeamMemberColorConfig,
  isEditingActive,
} from './types';

// Custom DraggableItem that properly handles the isStatic prop for drag binding
interface CustomDraggableItemProps {
  item: Item;
  itemIndex: number;
  laneId: string;
  shouldMarkItemsComplete: boolean;
  cancelEditCounter: number;
  isStatic?: boolean;
}

const CustomDraggableItem = memo(function CustomDraggableItem(props: CustomDraggableItemProps) {
  const elementRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const search = useContext(SearchContext);
  const { stateManager, boardModifiers, filePath, view } = useContext(KanbanContext);
  const dndManager = useContext(DndManagerContext);
  const [editState, setEditState] = useState<EditState>(EditingProcessState.Cancel);
  const [isHovered, setIsHovered] = useState(false);

  const { itemIndex, laneId, isStatic, ...innerProps } = props;

  console.log('[CustomDraggableItem] Rendering item:', {
    itemId: props.item.id,
    itemTitle: props.item.data.title,
    isStatic,
    laneId,
    itemIndex,
    hasDndManager: !!dndManager,
    dndManagerType: typeof dndManager,
  });

  // Import drag handle hook but only use it when not static
  const bindHandle = isStatic ? () => {} : useDragHandle(measureRef, measureRef);

  console.log('[CustomDraggableItem] bindHandle created:', {
    itemId: props.item.id,
    isStatic,
    bindHandleType: typeof bindHandle,
  });

  const getDateColor = useGetDateColorFn(stateManager);
  const teamMemberColors: Record<string, TeamMemberColorConfig> =
    view.plugin.settings.teamMemberColors || {};

  const isMatch = search?.query ? innerProps.item.data.titleSearch.includes(search.query) : false;
  const classModifiers: string[] = getItemClassModifiers(innerProps.item);

  // Static items are read-only, no editing allowed
  const onDoubleClickCallback = useCallback(() => {
    if (isStatic) return; // No editing for static items
    setEditState({ x: 0, y: 0 });
  }, [isStatic]);

  const onContextMenu = useCallback(() => {
    if (isStatic) return; // No context menu for static items
  }, [isStatic]);

  return (
    <div
      ref={(el) => {
        console.log('[CustomDraggableItem] Setting ref for item:', {
          itemId: props.item.id,
          element: el,
          isStatic,
          willBindHandle: !isStatic,
        });
        measureRef.current = el;
        if (!isStatic) {
          console.log('[CustomDraggableItem] Calling bindHandle for item:', props.item.id);
          bindHandle(el);
        } else {
          console.log(
            '[CustomDraggableItem] Skipping bindHandle (static) for item:',
            props.item.id
          );
        }
      }}
      className={c('item-wrapper')}
    >
      <div
        ref={elementRef}
        className={classcat([c('item'), ...classModifiers])}
        data-id={props.item.id}
        onMouseEnter={() => {
          console.log('[CustomDraggableItem] Mouse enter:', props.item.id);
          setIsHovered(true);
        }}
        onMouseLeave={() => {
          console.log('[CustomDraggableItem] Mouse leave:', props.item.id);
          setIsHovered(false);
        }}
        onDoubleClick={onDoubleClickCallback}
        onContextMenu={onContextMenu}
        onPointerDown={(e) => {
          console.log('[CustomDraggableItem] Pointer down on item:', {
            itemId: props.item.id,
            isStatic,
            target: e.target,
            currentTarget: e.currentTarget,
          });
        }}
        onDragStart={(e) => {
          console.log('[CustomDraggableItem] Drag start on item:', {
            itemId: props.item.id,
            isStatic,
            event: e,
          });
        }}
      >
        {isStatic ? (
          // Static version - no Droppable wrapper
          <div
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              marginBottom: '4px',
            }}
          >
            <ItemCheckbox
              isVisible={false} // Never show checkbox for static items
              item={innerProps.item}
              path={[itemIndex]}
              shouldMarkItemsComplete={innerProps.shouldMarkItemsComplete}
              stateManager={stateManager}
              boardModifiers={boardModifiers}
              style={{ marginRight: '4px', marginLeft: '8px' }}
            />
            <div style={{ flexGrow: 1, minWidth: 0 }}>
              <ItemContent
                item={innerProps.item}
                editState={editState}
                setEditState={setEditState}
                searchQuery={isMatch ? search?.query : undefined}
                isStatic={true}
                style={{ marginLeft: '-2.5px', marginRight: '0px' }}
              />
            </div>
          </div>
        ) : (
          // Dynamic version - with Droppable wrapper for drag-and-drop
          <Droppable
            elementRef={elementRef}
            measureRef={measureRef}
            id={props.item.id}
            index={itemIndex}
            data={{
              id: props.item.id,
              type: 'item',
              accepts: ['item'],
              parentLaneId: laneId,
              originalIndex: itemIndex,
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                marginBottom: '4px',
              }}
            >
              <ItemCheckbox
                isVisible={isHovered && !isEditingActive(editState)}
                item={innerProps.item}
                path={[itemIndex]}
                shouldMarkItemsComplete={innerProps.shouldMarkItemsComplete}
                stateManager={stateManager}
                boardModifiers={boardModifiers}
                style={{ marginRight: '4px', marginLeft: '8px' }}
              />
              <div style={{ flexGrow: 1, minWidth: 0 }}>
                <ItemContent
                  item={innerProps.item}
                  editState={editState}
                  setEditState={setEditState}
                  searchQuery={isMatch ? search?.query : undefined}
                  isStatic={false}
                  style={{ marginLeft: '-2.5px', marginRight: '0px' }}
                />
              </div>
            </div>
          </Droppable>
        )}

        {/* Item metadata and other components */}
        <div style={{ marginLeft: '8px', marginRight: '8px' }}>
          <Tags item={innerProps.item} />
          <AssignedMembers item={innerProps.item} teamMemberColors={teamMemberColors} />
          <ItemPriority item={innerProps.item} />

          {innerProps.item.data.metadata.date && (
            <DateAndTime
              item={innerProps.item}
              stateManager={stateManager}
              getDateColor={getDateColor}
            />
          )}

          <ItemMetadata item={innerProps.item} />
        </div>
      </div>
    </div>
  );
});

interface MemberBoardProps {
  plugin: KanbanPlugin;
  view: MemberView;
  board: Board;
  selectedMember: string;
  teamMembers: string[];
  memberCards: any[];
  isLoading: boolean;
  error: string | null;
  onMemberChange: (member: string) => void;
  onRefresh: () => void;
  reactState: any;
  setReactState: (state: any) => void;
  emitter: any;
}

export function MemberBoard(props: MemberBoardProps) {
  const {
    plugin,
    view,
    board,
    selectedMember,
    teamMembers,
    memberCards,
    isLoading,
    error,
    onMemberChange,
    onRefresh,
    reactState,
    setReactState,
    emitter,
  } = props;

  // Create a comprehensive mock StateManager for the Items component
  const mockFile = {
    path: 'member-board-virtual',
    name: 'Member Board',
    basename: 'Member Board',
    extension: 'md',
    stat: { mtime: Date.now(), ctime: Date.now(), size: 0 },
    vault: view.app.vault,
  };

  const mockStateManager = {
    // Core properties that components expect
    file: mockFile,
    app: view.app,
    state: board,
    viewSet: new Set([view]),
    emitter: view.emitter,

    // Settings methods
    useSetting: (key: string) => {
      const defaults = {
        'show-checkboxes': true,
        'show-relative-date': false,
        'move-dates': true,
        'move-tags': true,
        'inline-metadata-position': 'footer',
        'move-task-metadata': true,
        'metadata-keys': [],
        'date-format': 'YYYY-MM-DD',
        'time-format': 'HH:mm',
        'date-display-format': 'YYYY-MM-DD',
        'link-date-to-daily-note': false,
        'date-colors': [],
        'tag-colors': [],
        'lane-width': 272,
        'full-list-lane-width': false,
        'new-card-insertion-method': 'prepend',
        hideHashForTagsWithoutSymbols: false,
        'hide-lane-tag-display': false,
        'hide-board-tag-display': false,
        editable: false, // Make member board read-only
      };
      return defaults[key] ?? plugin.settings[key] ?? null;
    },
    getSetting: (key: string) => {
      const defaults = {
        'show-checkboxes': true,
        'show-relative-date': false,
        'move-dates': true,
        'move-tags': true,
        'inline-metadata-position': 'footer',
        'move-task-metadata': true,
        'metadata-keys': [],
        'date-format': 'YYYY-MM-DD',
        'time-format': 'HH:mm',
        'date-display-format': 'YYYY-MM-DD',
        'link-date-to-daily-note': false,
        'date-colors': [],
        'tag-colors': [],
        'lane-width': 272,
        'full-list-lane-width': false,
        'new-card-insertion-method': 'prepend',
        hideHashForTagsWithoutSymbols: false,
        'hide-lane-tag-display': false,
        'hide-board-tag-display': false,
        editable: false,
      };
      return defaults[key] ?? plugin.settings[key] ?? null;
    },
    getSettingRaw: (key: string) => {
      return mockStateManager.getSetting(key);
    },
    getGlobalSetting: (key: string) => {
      return plugin.settings[key] ?? null;
    },

    // State management methods
    setState: () => {}, // No-op for member board
    softRefresh: () => {},
    saveToDisk: () => {},
    setError: (error: any) => {
      console.error('[MockStateManager] Error:', error);
    },

    // Item management methods
    updateItemContent: (item: any, content: string) => item, // No-op
    getNewItem: (content: string, checkChar: string, forceEdit?: boolean, laneName?: string) => {
      const id = 'mock-' + Math.random().toString(36).substr(2, 9);
      return {
        id,
        type: 'item',
        accepts: [],
        data: {
          title: content.trim(),
          titleRaw: content,
          titleSearch: content,
          titleSearchRaw: content,
          blockId: id,
          metadata: {
            dateStr: undefined,
            date: undefined,
            startDateStr: undefined,
            startDate: undefined,
            time: undefined,
            timeStr: undefined,
            tags: [],
            fileAccessor: undefined,
            file: undefined,
            fileMetadata: undefined,
            fileMetadataOrder: undefined,
          },
          line: 0,
          assignedMembers: [],
          checked: checkChar !== ' ',
          checkChar: checkChar || ' ',
          position: {
            start: { line: 1, column: 1, offset: 0 },
            end: { line: 1, column: content.length + 1, offset: content.length },
          },
          forceEditMode: forceEdit || false,
        },
        children: [],
      };
    },

    // Parser methods
    parser: {
      newItem: (content: string, checkChar: string, forceEdit?: boolean, laneName?: string) => {
        return mockStateManager.getNewItem(content, checkChar, forceEdit, laneName);
      },
      updateItemContent: (item: any, content: string) => item,
      boardToMd: () => '',
      mdToBoard: () => board,
      reparseBoard: () => board,
    },

    // Compilation methods
    compileSettings: () => {},
    compiledSettings: {},

    // Event handling
    stateReceivers: [],
    settingsNotifiers: new Map(),

    // Utility methods
    getAView: () => view,
    hasError: () => false,
    onEmpty: () => {},
    getGlobalSettings: () => plugin.settings,

    // Build methods
    buildSettingRetrievers: () => ({
      getGlobalSettings: () => plugin.settings,
      getGlobalSetting: (key: string) => plugin.settings[key] ?? null,
      getSetting: (key: string) => mockStateManager.getSetting(key),
    }),
  };

  const boardModifiers = getBoardModifiers(view, mockStateManager);

  const kanbanContext = {
    stateManager: mockStateManager,
    boardModifiers,
    view,
    filePath: mockStateManager.file.path,
  };

  const searchContext = {
    query: '',
    items: new Set(),
    lanes: new Set(),
    search: () => {},
  };

  // Safety check for required props
  if (!plugin || !view || !board) {
    console.error('[MemberBoard] Missing required props:', {
      plugin: !!plugin,
      view: !!view,
      board: !!board,
    });
    return (
      <div className={c('member-board-error')}>
        <span className="lucide-alert-circle" />
        Component initialization error - missing required props
      </div>
    );
  }

  // Initialize member scanning when component mounts
  useEffect(() => {
    let isMounted = true;

    if (selectedMember && memberCards.length === 0 && !isLoading && isMounted) {
      onRefresh();
    }

    return () => {
      isMounted = false;
    };
  }, [selectedMember]);

  const handleMemberSelect = useCallback(
    (event: Event) => {
      const target = event.target as HTMLSelectElement;
      const newMember = target.value;
      if (newMember !== selectedMember) {
        onMemberChange(newMember);
      }
    },
    [selectedMember, onMemberChange]
  );

  return (
    <div className={c('member-board-container')}>
      {/* Header with member selector */}
      <div className={c('member-board-header')}>
        <div className={c('member-board-title')}>
          <h2>Member Board</h2>
        </div>

        <div className={c('member-board-controls')}>
          <div className={c('member-selector')}>
            <label htmlFor="member-select">Team Member:</label>
            <select
              id="member-select"
              value={selectedMember}
              onChange={handleMemberSelect}
              className={c('member-select-dropdown')}
            >
              <option value="">Select a member...</option>
              {teamMembers.map((member) => (
                <option key={member} value={member}>
                  {member}
                </option>
              ))}
            </select>
          </div>

          <button
            className={c('refresh-button')}
            onClick={onRefresh}
            disabled={isLoading}
            title="Refresh member board"
          >
            <span className="lucide-refresh-cw" />
            {isLoading ? 'Loading...' : 'Refresh'}
          </button>
        </div>
      </div>

      {/* Status messages */}
      {error && (
        <div className={c('member-board-error')}>
          <span className="lucide-alert-circle" />
          {error}
        </div>
      )}

      {!selectedMember && !error && (
        <div className={c('member-board-empty')}>
          <span className="lucide-user" />
          <p>Please select a team member to view their board.</p>
        </div>
      )}

      {selectedMember && !error && (
        <>
          {isLoading && (
            <div className={c('member-board-loading')}>
              <span className="lucide-loader" />
              <p>Loading cards for {selectedMember}...</p>
            </div>
          )}

          {!isLoading && (
            <>
              {/* Stats */}
              <div className={c('member-board-stats')}>
                <div className={c('stat-item')}>
                  <span className={c('stat-label')}>Total Cards:</span>
                  <span className={c('stat-value')}>{memberCards.length}</span>
                </div>
                <div className={c('stat-item')}>
                  <span className={c('stat-label')}>Backlog:</span>
                  <span className={c('stat-value')}>{board.children[0]?.children.length || 0}</span>
                </div>
                <div className={c('stat-item')}>
                  <span className={c('stat-label')}>Doing:</span>
                  <span className={c('stat-value')}>{board.children[1]?.children.length || 0}</span>
                </div>
                <div className={c('stat-item')}>
                  <span className={c('stat-label')}>Done:</span>
                  <span className={c('stat-value')}>{board.children[2]?.children.length || 0}</span>
                </div>
              </div>

              {/* Board with same appearance as regular Kanban - With drag-and-drop */}
              <DndContext
                win={view.getWindow()}
                onDrop={(dragEntity, dropEntity) => {
                  console.log('[MemberBoard] DndContext onDrop called:', {
                    dragEntity,
                    dropEntity,
                  });
                  view.handleDrop(dragEntity, dropEntity);
                }}
              >
                <div className={c('board')}>
                  <div className={c('lanes')}>
                    {board.children.map((lane, laneIndex) => (
                      <div
                        key={lane.id}
                        className={c('lane-wrapper')}
                        style={{ width: '272px' }}
                        onDragOver={(e) => e.preventDefault()}
                        onDrop={(e) => {
                          e.preventDefault();
                          try {
                            const dragData = JSON.parse(e.dataTransfer.getData('text/plain'));
                            if (dragData.type === 'item') {
                              // Create mock drop entity for handleDrop
                              const dropEntity = {
                                getData: () => ({
                                  type: 'lane',
                                  id: lane.id,
                                  index: lane.children.length,
                                }),
                                getPath: () => [laneIndex, lane.children.length],
                              };
                              const dragEntity = {
                                getData: () => dragData,
                              };
                              view.handleDrop(dragEntity, dropEntity);
                            }
                          } catch (error) {
                            console.warn('[MemberBoard] Drop error:', error);
                          }
                        }}
                      >
                        <div className={c('lane')}>
                          <div className={c('lane-header-wrapper')}>
                            <div className={c('lane-title')}>
                              <div className={c('lane-title-text')}>{lane.data.title}</div>
                              <div className={c('lane-title-count')}>{lane.children.length}</div>
                            </div>
                          </div>
                          <div className={c('lane-items-wrapper')}>
                            <KanbanContext.Provider value={kanbanContext}>
                              <SearchContext.Provider value={searchContext}>
                                {/* Custom draggable items with proper static handling */}
                                {lane.children.map((item, i) => (
                                  <CustomDraggableItem
                                    key={item.id}
                                    item={item}
                                    itemIndex={i}
                                    laneId={lane.id}
                                    shouldMarkItemsComplete={false}
                                    cancelEditCounter={0}
                                    isStatic={false}
                                  />
                                ))}
                              </SearchContext.Provider>
                            </KanbanContext.Provider>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </DndContext>

              {memberCards.length === 0 && (
                <div className={c('member-board-empty-cards')}>
                  <span className="lucide-inbox" />
                  <p>No cards found for {selectedMember}.</p>
                  <p>Cards are assigned using the @@ prefix (e.g., @@{selectedMember}).</p>
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}
