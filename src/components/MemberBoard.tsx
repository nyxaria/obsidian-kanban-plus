import classcat from 'classcat';
import { TFile } from 'obsidian';
import { Component, memo } from 'preact/compat';
import { useCallback, useContext, useEffect, useRef, useState } from 'preact/hooks';
import { ScrollContainer } from 'src/dnd/components/ScrollContainer';
import { SortPlaceholder } from 'src/dnd/components/SortPlaceholder';
import { Sortable } from 'src/dnd/components/Sortable';

import { MemberView } from '../MemberView';
import { DndContext } from '../dnd/components/DndContext';
import { Droppable } from '../dnd/components/Droppable';
import { DndManagerContext } from '../dnd/components/context';
import { getBoardModifiers } from '../helpers/boardModifiers';
import { t } from '../lang/helpers';
import KanbanPlugin from '../main';
import { Items } from './Item/Item';
import { KanbanContext, SearchContext } from './context';
import { c } from './helpers';
import { Board, DataTypes, Item, Lane } from './types';

// Debug component to check DndManager context
function DndDebugInfo() {
  const dndManager = useContext(DndManagerContext);

  useEffect(() => {
    console.log('[MemberBoard] DndDebugInfo - DndManager context:', {
      hasDndManager: !!dndManager,
      dndManagerType: typeof dndManager,
      dragManager: dndManager?.dragManager ? 'present' : 'missing',
      dropManager: dndManager?.dropManager ? 'present' : 'missing',
    });
  }, [dndManager]);

  return null;
}

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
  };

  console.log('[MemberBoard] Context setup:', {
    hasKanbanContext: !!kanbanContext,
    hasStateManager: !!kanbanContext.stateManager,
    hasBoardModifiers: !!kanbanContext.boardModifiers,
    hasSearchContext: !!searchContext,
    filePath: kanbanContext.filePath,
    boardId: board?.id,
    laneCount: board?.children?.length,
  });

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

  const laneAccepts = [DataTypes.Item];

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
                    dragData: dragEntity?.getData(),
                    dropData: dropEntity?.getData(),
                  });
                  view.handleDrop(dragEntity, dropEntity);
                }}
              >
                <div className={c('board')}>
                  <div className={c('lanes')}>
                    {board.children.map((lane, laneIndex) => {
                      const laneRef = useRef<HTMLDivElement>(null);

                      console.log('[MemberBoard] Rendering lane:', {
                        laneId: lane.id,
                        laneIndex,
                        laneTitle: lane.data.title,
                        itemCount: lane.children.length,
                        hasLaneRef: !!laneRef,
                      });

                      return (
                        <div key={lane.id} className={c('lane-wrapper')} style={{ width: '272px' }}>
                          <div ref={laneRef} className={c('lane')}>
                            <div className={c('lane-header-wrapper')}>
                              <div className={c('lane-title')}>
                                <div className={c('lane-title-text')}>{lane.data.title}</div>
                                <div className={c('lane-title-count')}>{lane.children.length}</div>
                              </div>
                            </div>
                            <div className={c('lane-items-wrapper')}>
                              <Droppable
                                elementRef={laneRef}
                                measureRef={laneRef}
                                id={lane.id}
                                index={laneIndex}
                                data={lane}
                              >
                                <KanbanContext.Provider value={kanbanContext}>
                                  <SearchContext.Provider value={searchContext}>
                                    <DndDebugInfo />
                                    <ScrollContainer
                                      className="member-board-lane-content"
                                      id={lane.id}
                                      index={laneIndex}
                                      triggerTypes={laneAccepts}
                                    >
                                      <Sortable onSortChange={() => {}} axis="vertical">
                                        <Items
                                          items={lane.children}
                                          laneId={lane.id}
                                          shouldMarkItemsComplete={lane.id === 'done'}
                                          targetHighlight={null}
                                          cancelEditCounter={0}
                                        />
                                        <SortPlaceholder
                                          accepts={laneAccepts}
                                          index={lane.children.length}
                                        />
                                      </Sortable>
                                    </ScrollContainer>
                                  </SearchContext.Provider>
                                </KanbanContext.Provider>
                              </Droppable>
                            </div>
                          </div>
                        </div>
                      );
                    })}
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
