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
import { DndManagerContext } from '../dnd/components/context';
import { getBoardModifiers } from '../helpers/boardModifiers';
import { debugLog } from '../helpers/debugLogger';
import KanbanPlugin from '../main';
import { Items } from './Item/Item';
import { MemberItems } from './MemberItems';
import { KanbanContext, SearchContext } from './context';
import { c } from './helpers';
import { generateInstanceId } from './helpers';
import { Board, DataTypes, Item, Lane } from './types';

// Debug component to check DndManager context
function DndDebugInfo() {
  const dndManager = useContext(DndManagerContext);

  debugLog('[MemberBoard] DndDebugInfo - DndManager context:', {
    hasDndManager: !!dndManager,
    dndManagerType: typeof dndManager,
    dragManager: dndManager?.dragManager ? 'present' : 'missing',
    onDrop: dndManager?.onDrop ? 'present' : 'missing',
  });

  return null;
}

// Extract lane component to fix hooks violation
interface MemberLaneProps {
  lane: Lane;
  laneIndex: number;
  laneAccepts: string[];
  memberViewLaneWidth: number;
  memberCards: any[];
  view: MemberView;
  onRefresh: () => void;
}

function MemberLane({
  lane,
  laneIndex,
  laneAccepts,
  memberViewLaneWidth,
  memberCards,
  view,
  onRefresh,
}: MemberLaneProps) {
  const laneRef = useRef<HTMLDivElement>(null);

  return (
    <div className={c('lane-wrapper')} style={{ width: `${memberViewLaneWidth}px` }}>
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
            <ScrollContainer
              className="member-board-lane-content"
              id={lane.id}
              index={laneIndex}
              triggerTypes={laneAccepts}
            >
              <Sortable onSortChange={() => {}} axis="vertical">
                {lane.children.length > 0 && (
                  <MemberItems
                    items={lane.children}
                    laneId={lane.id}
                    shouldMarkItemsComplete={lane.id === 'done'}
                    targetHighlight={null}
                    cancelEditCounter={0}
                    memberCards={memberCards}
                    view={view}
                    onCardUpdate={() => {
                      // Only trigger refresh if no member updates are pending
                      if (!view.hasPendingUpdates()) {
                        onRefresh();
                      }
                    }}
                  />
                )}
                {lane.children.length === 0 ? (
                  <div
                    className="member-board-empty-placeholder-wrapper"
                    data-lane-id={lane.id}
                    onMouseEnter={(e) => {
                      debugLog('[MemberBoard] Empty placeholder hover enter:', lane.id);
                      e.currentTarget.classList.add('hover');
                    }}
                    onMouseLeave={(e) => {
                      debugLog('[MemberBoard] Empty placeholder hover leave:', lane.id);
                      e.currentTarget.classList.remove('hover');
                    }}
                  >
                    <SortPlaceholder accepts={laneAccepts} index={lane.children.length} />
                  </div>
                ) : (
                  <div data-lane-id={lane.id} style={{ display: 'none' }}>
                    <SortPlaceholder accepts={laneAccepts} index={lane.children.length} />
                  </div>
                )}
              </Sortable>
            </ScrollContainer>
          </Droppable>
        </div>
      </div>
    </div>
  );
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
  scanRootPath: string;
  availableDirectories: string[];
  onMemberChange: (member: string) => void;
  onScanRootChange: (path: string) => void;
  onRefresh: () => void;
  onSortChange: (sortBy: 'dueDate' | 'priority', sortOrder: 'asc' | 'desc') => void;
  sortBy: 'dueDate' | 'priority';
  sortOrder: 'asc' | 'desc';
  updateMemberAssignment: (cardId: string, member: string, isAssigning: boolean) => Promise<void>;
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
    scanRootPath,
    availableDirectories,
    onMemberChange,
    onScanRootChange,
    onRefresh,
    onSortChange,
    sortBy,
    sortOrder,
    reactState,
    setReactState,
    emitter,
  } = props;

  debugLog('[MemberBoard] Context setup:', {
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
          'show-relative-date': plugin.settings['show-relative-date'] ?? false,
          'move-dates': true,
          'move-tags': true,
          'inline-metadata-position': 'footer',
          'move-task-metadata': true,
          'metadata-keys': [],
          'date-format': plugin.settings['date-format'] || 'YYYY-MM-DD',
          'time-format': plugin.settings['time-format'] || 'HH:mm',
          'date-display-format': plugin.settings['date-display-format'] || 'YYYY-MM-DD',
          'link-date-to-daily-note': plugin.settings['link-date-to-daily-note'] ?? false,
          'date-colors': plugin.settings['date-colors'] || [],
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
          'time-trigger': plugin.settings['time-trigger'] || '@@',
          'date-trigger': plugin.settings['date-trigger'] || '@',
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

  debugLog('[MemberBoard] Context setup:', {
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

    // Only trigger initial scan if we haven't scanned yet and have a selected member
    // Don't trigger if we already did the initial scan (even if it resulted in 0 cards)
    if (
      selectedMember &&
      memberCards.length === 0 &&
      !isLoading &&
      isMounted &&
      !view.hasInitialScan
    ) {
      debugLog('[MemberBoard] Triggering initial scan for member:', selectedMember);
      view.debouncedRefresh();
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

  const handleScanRootSelect = useCallback(
    (event: Event) => {
      const target = event.target as HTMLSelectElement;
      const newPath = target.value;
      if (newPath !== scanRootPath) {
        onScanRootChange(newPath);
      }
    },
    [scanRootPath, onScanRootChange]
  );

  const laneAccepts = [DataTypes.Item];

  // Calculate stats width based on member view lane width
  const statsWidth = `calc(3 * ${memberViewLaneWidth}px + 2 * 10px)`;

  // Show "Sort by..." only when no explicit sort has been set yet, otherwise show the actual sort
  const sortDisplayValue = sortBy;

  return (
    <div
      className={c('member-board-container')}
      style={{ '--member-view-lane-width': `${memberViewLaneWidth}px` } as any}
    >
      {/* Header with member selector and scan root */}
      <div className={c('member-board-header')}>
        <div className={c('member-board-controls')}>
          <div className={c('member-selector')}>
            {/* <label htmlFor="member-select">Team Member:</label> */}
            <select
              id="member-select"
              value={selectedMember}
              onChange={handleMemberSelect}
              className={c('member-select-dropdown')}
              style={{ width: '90%', marginLeft: '30px', marginRight: '10px' }}
            >
              <option value="">Select a member...</option>
              {teamMembers.map((member) => (
                <option key={member} value={member}>
                  {member}
                </option>
              ))}
            </select>
          </div>

          <div className={c('scan-root-selector')}>
            <label htmlFor="scan-root-select">Scan Directory:</label>
            <select
              id="scan-root-select"
              value={scanRootPath}
              onChange={handleScanRootSelect}
              className={c('scan-root-select-dropdown')}
            >
              <option value="">All Boards</option>
              {availableDirectories
                .filter((dir) => dir !== '') // Remove empty string since it's already shown as "Vault Root"
                .map((directory) => (
                  <option key={directory} value={directory}>
                    {directory}
                  </option>
                ))}
            </select>
          </div>

          <div className={c('sort-controls')}>
            <label htmlFor="sort-select">Sort by:</label>
            <select
              id="sort-select"
              value={sortDisplayValue}
              onChange={(e) => {
                const selectedValue = (e.target as HTMLSelectElement).value;
                // If "Sort by..." is selected (empty string), default to 'dueDate'
                const sortType =
                  selectedValue === '' ? 'dueDate' : (selectedValue as 'dueDate' | 'priority');
                onSortChange(sortType, sortOrder);
              }}
              className={c('sort-select-dropdown')}
            >
              <option value="">Sort by...</option>
              <option value="dueDate">Due Date</option>
              <option value="priority">Priority</option>
            </select>
            {/* <button
              className={c('sort-order-button')}
              onClick={() => onSortChange(sortBy, sortOrder === 'asc' ? 'desc' : 'asc')}
              title={`Sort order: ${sortOrder === 'asc' ? 'Ascending' : 'Descending'}`}
            >
              <span className={`lucide-arrow-${sortOrder === 'asc' ? 'up' : 'down'}`} />
            </button> */}
          </div>

          <button
            className={c('refresh-button')}
            onClick={onRefresh}
            disabled={isLoading}
            title="Refresh member board"
          >
            {/* <span className="lucide-refresh-cw" /> */}
            {'Refresh'}
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
              <KanbanContext.Provider value={kanbanContext}>
                <SearchContext.Provider value={searchContext}>
                  <DndContext
                    win={view.getWindow()}
                    onDrop={(dragEntity, dropEntity) => {
                      debugLog('[MemberBoard] DndContext onDrop called:', {
                        dragEntity,
                        dropEntity,
                        dragData: dragEntity?.getData(),
                        dropData: dropEntity?.getData(),
                        memberBoardScope: `member-board-${selectedMember}`,
                      });
                      view.handleDrop(dragEntity, dropEntity);
                    }}
                  >
                    <DndDebugInfo />
                    <div className={c('board')}>
                      <div className={c('lanes')}>
                        {board.children.map((lane, laneIndex) => {
                          debugLog('[MemberBoard] Rendering lane:', {
                            laneId: lane.id,
                            laneIndex,
                            laneTitle: lane.data.title,
                            itemCount: lane.children.length,
                          });

                          return (
                            <MemberLane
                              key={lane.id}
                              lane={lane}
                              laneIndex={laneIndex}
                              laneAccepts={laneAccepts}
                              memberViewLaneWidth={memberViewLaneWidth}
                              memberCards={memberCards}
                              view={view}
                              onRefresh={onRefresh}
                            />
                          );
                        })}
                      </div>
                    </div>
                  </DndContext>
                </SearchContext.Provider>
              </KanbanContext.Provider>

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
