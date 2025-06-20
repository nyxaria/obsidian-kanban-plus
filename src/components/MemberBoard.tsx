import classcat from 'classcat';
import { TFile } from 'obsidian';
import { Component, memo, useMemo } from 'preact/compat';
import { useCallback, useContext, useEffect, useRef, useState } from 'preact/hooks';
import { ScrollContainer } from 'src/dnd/components/ScrollContainer';

import { MemberView } from '../MemberView';
import { DEFAULT_SETTINGS } from '../Settings';
import { StateManager } from '../StateManager';
import { DndContext } from '../dnd/components/DndContext';
import { Droppable } from '../dnd/components/Droppable';
import { SortPlaceholder } from '../dnd/components/SortPlaceholder';
import { Sortable } from '../dnd/components/Sortable';
import { getBoardModifiers } from '../helpers/boardModifiers';
import KanbanPlugin from '../main';
import { Items } from './Item/Item';
import { KanbanContext, SearchContext } from './context';
import { c } from './helpers';
import { generateInstanceId } from './helpers';
import { Board, DataTypes, Item, Lane } from './types';

// Debug component to check DndManager context
function DndDebugInfo() {
  const dndManager = useContext(KanbanContext)?.boardModifiers?.dndManager;

  console.log('[MemberBoard] DndDebugInfo - DndManager context:', {
    hasDndManager: !!dndManager,
    dndManagerType: typeof dndManager,
    dragManager: dndManager?.dragManager ? 'present' : 'missing',
    dropManager: dndManager?.dropManager ? 'present' : 'missing',
  });

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

// Add interface for filtered tags - now unused but kept for potential future use
interface TagFilterOptions {
  hideLaneTagDisplay: boolean;
  hideBoardTagDisplay: boolean;
  laneNames: string[];
  boardName?: string;
}

// Add helper function to filter tags - now unused but kept for potential future use
function filterTagsForDisplay(tags: string[], options: TagFilterOptions): string[] {
  const { hideLaneTagDisplay, hideBoardTagDisplay, laneNames, boardName } = options;

  if (!hideLaneTagDisplay && !hideBoardTagDisplay) {
    return tags; // No filtering needed
  }

  return tags.filter((tag) => {
    const tagWithoutHash = tag.replace(/^#/, '').toLowerCase();

    // Check if this is a board tag (matches board name)
    if (hideBoardTagDisplay && boardName) {
      const boardTagPattern = boardName.toLowerCase().replace(/\s+/g, '-');
      if (tagWithoutHash === boardTagPattern) {
        return false; // Hide this tag
      }
    }

    // Check if this is a lane tag (matches any lane name)
    if (hideLaneTagDisplay) {
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

  console.log('[MemberBoard] Context setup:', {
    hasKanbanContext: !!useContext(KanbanContext),
    hasStateManager: !!useContext(KanbanContext)?.stateManager,
    hasBoardModifiers: !!useContext(KanbanContext)?.boardModifiers,
    hasSearchContext: !!useContext(SearchContext),
    filePath: useContext(KanbanContext)?.filePath || 'member-board-virtual',
    boardId: board?.id,
    selectedMember,
    memberCardsCount: memberCards?.length || 0,
  });

  // Get the member view lane width from settings
  const memberViewLaneWidth =
    plugin.settings['member-view-lane-width'] || DEFAULT_SETTINGS['member-view-lane-width'] || 272;

  // Create a mock StateManager that provides the necessary methods for tag functionality
  const mockStateManager = useMemo(() => {
    return {
      getSetting: (key: string) => {
        const defaults = {
          'show-checkboxes': false,
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
          'tag-colors': plugin.settings['tag-colors'] || [], // Use plugin settings for tag colors
          'tag-symbols': plugin.settings['tag-symbols'] || [], // Use plugin settings for tag symbols
          'hide-lane-tag-display': plugin.settings['hide-lane-tag-display'] || false, // Add hide lane tag setting
          'hide-board-tag-display': plugin.settings['hide-board-tag-display'] || false, // Add hide board tag setting
          hideHashForTagsWithoutSymbols: plugin.settings['hideHashForTagsWithoutSymbols'] || false, // Add hide hash setting
          'lane-width': memberViewLaneWidth,
          'full-list-lane-width': false,
          'new-card-insertion-method': 'append',
          'new-line-trigger': 'shift-enter',
          'hide-card-count': false,
          'max-archive-size': -1,
          'show-add-list': true,
          'show-archive-all': true,
          'show-board-settings': true,
          'show-search': true,
          'show-set-view': true,
          'show-view-as-markdown': true,
          'tag-action': 'kanban',
          'tag-sort': [],
          'time-trigger': '@@',
          'date-trigger': '@',
          'new-note-folder': '',
          'new-note-template': '',
          'append-archive-date': false,
          'archive-date-format': 'MMM D, YYYY h:mm a',
          'archive-date-separator': ' - ',
          'archive-with-date': false,
          'date-picker-week-start': 0,
          'date-time-display-format': 'MMM D, YYYY h:mm a',
          'table-sizing': {},
        };
        return defaults[key] || DEFAULT_SETTINGS[key];
      },
      useSetting: (key: string) => {
        // For member board, we return the same as getSetting
        // This is used by components like Tags to get dynamic settings
        return mockStateManager.getSetting(key);
      },
      file: view.file,
      state: board,
      app: plugin.app,
    };
  }, [plugin, view, board, memberViewLaneWidth]);

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

  // Calculate stats width based on member view lane width
  const statsWidth = `calc(3 * ${memberViewLaneWidth}px + 2 * 10px)`;

  return (
    <div
      className={c('member-board-container')}
      style={{ '--member-view-lane-width': `${memberViewLaneWidth}px` } as any}
    >
      {/* Header with member selector */}
      <div className={c('member-board-header')}>
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
              <div className={c('member-board-stats')} style={{ width: statsWidth }}>
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
                        <div
                          key={lane.id}
                          className={c('lane-wrapper')}
                          style={{ width: `${memberViewLaneWidth}px` }}
                        >
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
