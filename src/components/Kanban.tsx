import animateScrollTo from 'animated-scroll-to';
import classcat from 'classcat';
import EventEmitter from 'eventemitter3';
import update from 'immutability-helper';
import { App, TFile } from 'obsidian';
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { KanbanView } from 'src/KanbanView';
import { KanbanViewSettings } from 'src/Settings';
import { StateManager } from 'src/StateManager';
import { Board, Item, Lane } from 'src/components/types';
import { useIsAnythingDragging } from 'src/dnd/components/DragOverlay';
import { ScrollContainer } from 'src/dnd/components/ScrollContainer';
import { SortPlaceholder } from 'src/dnd/components/SortPlaceholder';
import { Sortable } from 'src/dnd/components/Sortable';
import { createHTMLDndHandlers } from 'src/dnd/managers/DragManager';
import { t } from 'src/lang/helpers';
import { useDebounce } from 'use-debounce';

import { DndScope } from '../dnd/components/Scope';
import { getBoardModifiers } from '../helpers/boardModifiers';
import { debugLog } from '../helpers/debugLogger';
import KanbanPlugin from '../main';
import { frontmatterKey } from '../parsers/common';
import { Icon } from './Icon/Icon';
import { Lanes } from './Lane/Lane';
import { LaneForm } from './Lane/LaneForm';
import { TableView } from './Table/Table';
import { KanbanContext, SearchContext } from './context';
import { baseClassName, c, useSearchValue } from './helpers';
import { DataTypes } from './types';

const boardScrollTiggers = [DataTypes.Item, DataTypes.Lane];
const boardAccepts = [DataTypes.Lane];

interface KanbanProps {
  stateManager: StateManager;
  view: KanbanView;
  reactState: any;
  plugin: KanbanPlugin;
  settings: KanbanViewSettings;
  board: Board | null;
  app: App;
  archivedCount: number;
  file: TFile;
  setReactState: (newState: any) => void;
  emitter: EventEmitter;
  dispatch: (...args: any[]) => void;
  onwardsNavigate: (path: string, payload: any) => void;
}

function getCSSClass(frontmatter: Record<string, any>): string[] {
  const classes = [];
  if (Array.isArray(frontmatter.cssclass)) {
    classes.push(...frontmatter.cssclass);
  } else if (typeof frontmatter.cssclass === 'string') {
    classes.push(frontmatter.cssclass);
  }
  if (Array.isArray(frontmatter.cssclasses)) {
    classes.push(...frontmatter.cssclasses);
  } else if (typeof frontmatter.cssclasses === 'string') {
    classes.push(frontmatter.cssclasses);
  }

  return classes;
}

export const Kanban = ({
  view,
  stateManager,
  reactState,
  plugin,
  settings,
  board,
  app,
  archivedCount,
  file,
  setReactState,
  emitter,
  dispatch,
  onwardsNavigate,
}: KanbanProps) => {
  if (!stateManager) {
    console.warn('[Kanban Component] StateManager is not available. Aborting render.');
    return null;
  }

  const dateColorsFromHook = stateManager.useSetting('date-colors');
  const tagColorsFromHook = stateManager.useSetting('tag-colors');

  const [boardData, setBoardData] = useState<Board | null>(board);
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState('');
  const [isSearching, setIsSearching] = useState(false);
  const [isLaneFormVisible, setIsLaneFormVisible] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [cancelEditCounter, setCancelEditCounter] = useState(0);

  const filePath = file.path;
  const dateColors = dateColorsFromHook || [];
  const tagColors = tagColorsFromHook || [];
  const boardModifiers = useMemo(() => getBoardModifiers(view, stateManager), [view, stateManager]);
  const boardView = view.useViewState(frontmatterKey) || 'board';

  useEffect(() => {
    if (isSearching && searchRef.current) {
      searchRef.current.focus();
    }
  }, [isSearching]);

  useDebounce(
    () => {
      setDebouncedSearchQuery(searchQuery);
    },
    200,
    [searchQuery]
  );

  const isAnythingDragging = useIsAnythingDragging();

  const showLaneForm = useCallback(() => {
    setIsLaneFormVisible(true);
  }, []);

  const closeLaneForm = useCallback(() => {
    setIsLaneFormVisible(false);
  }, []);

  const onNewLane = useCallback(() => {
    closeLaneForm();
  }, [closeLaneForm]);

  useEffect(() => {
    const handler = (newState: Board) => {
      setBoardData(newState);
    };

    stateManager.stateReceivers.push(handler);
    return () => {
      stateManager.stateReceivers.remove(handler);
    };
  }, [stateManager]);

  useEffect(() => {
    if (boardData && (view.pendingHighlightScroll || view.currentSearchMatch)) {
      let reason = '';
      if (view.pendingHighlightScroll) reason = 'pendingHighlightScroll is true';
      if (view.currentSearchMatch)
        reason += (reason ? ' and ' : '') + 'currentSearchMatch is present';
      debugLog(
        `[Kanban Component] useEffect: Relevant condition met (${reason}). Calling view.setReactState({}).`
      );
      setReactState({});
    }
  }, [boardData, view, view.pendingHighlightScroll, view.currentSearchMatch, setReactState]);

  useEffect(() => {
    const handleCancelEdits = () => {
      debugLog('[Kanban Component] Received "cancelAllCardEdits" event. Incrementing counter.');
      setCancelEditCounter((c) => c + 1);
    };
    emitter.on('cancelAllCardEdits', handleCancelEdits);
    return () => {
      emitter.off('cancelAllCardEdits', handleCancelEdits);
    };
  }, [emitter]);

  useEffect(() => {
    emitter.on('showLaneForm', showLaneForm);
    emitter.on('hotkey', ({ commandId, data }) => {
      switch (commandId) {
        case 'editor:open-search':
          setIsSearching(true);
          if (data) {
            setSearchQuery(data);
            setDebouncedSearchQuery(data);
          }
          break;
        case 'editor:clear-search':
          setSearchQuery('');
          setDebouncedSearchQuery('');
          setIsSearching(false);
          break;
      }
    });
    return () => {
      emitter.off('showLaneForm', showLaneForm);
      emitter.off('hotkey');
    };
  }, [emitter, showLaneForm]);

  const kanbanContext = useMemo(() => {
    return {
      view,
      stateManager,
      boardModifiers,
      filePath,
    };
  }, [view, stateManager, boardModifiers, filePath]);

  const html5DragHandlers = createHTMLDndHandlers(stateManager);

  if (boardData === null || boardData === undefined)
    return (
      <div className={c('loading')}>
        <div className="sk-pulse"></div>
      </div>
    );

  if (boardData.data.errors.length > 0) {
    return (
      <div>
        <div>Error:</div>
        {boardData.data.errors.map((e, i) => {
          return (
            <div key={i}>
              <div>{e.description}</div>
              <pre>{e.stack}</pre>
            </div>
          );
        })}
      </div>
    );
  }

  const axis = boardView === 'list' ? 'vertical' : 'horizontal';
  const searchValue = useSearchValue(
    boardData,
    debouncedSearchQuery,
    setSearchQuery,
    setDebouncedSearchQuery,
    setIsSearching
  );

  // Check if Done lane should be hidden (used in Lanes component for conditional rendering)
  const hideDoneLane = stateManager.getSetting('hideDoneLane');

  useEffect(() => {
    debugLog(
      '[Kanban Component] useEffect for initialSearch: view.initialSearchQuery is:',
      view.initialSearchQuery
    );
    if (view.initialSearchQuery) {
      debugLog('[Kanban Component] Applying initial search:', view.initialSearchQuery);
      searchValue.search(view.initialSearchQuery, true);
      view.initialSearchQuery = undefined;
    }
  }, [view, searchValue.search]);

  return (
    <DndScope id={view.id}>
      <KanbanContext.Provider value={kanbanContext}>
        <SearchContext.Provider value={searchValue}>
          <div
            ref={rootRef}
            className={classcat([
              baseClassName,
              {
                'something-is-dragging': isAnythingDragging,
              },
              ...getCSSClass(boardData.data.frontmatter),
            ])}
            {...html5DragHandlers}
          >
            {(isLaneFormVisible || boardData.children.length === 0) && (
              <LaneForm onNewLane={onNewLane} closeLaneForm={closeLaneForm} />
            )}
            {isSearching && (
              <div className={c('search-wrapper')}>
                <input
                  ref={searchRef}
                  value={searchQuery}
                  onChange={(e) => {
                    setSearchQuery((e.target as HTMLInputElement).value);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') {
                      setSearchQuery('');
                      setDebouncedSearchQuery('');
                      (e.target as HTMLInputElement).blur();
                      setIsSearching(false);
                    }
                  }}
                  type="text"
                  className={c('filter-input')}
                  placeholder={t('Search...')}
                />
                <a
                  className={`${c('search-cancel-button')} clickable-icon`}
                  onClick={() => {
                    setSearchQuery('');
                    setDebouncedSearchQuery('');
                    setIsSearching(false);
                  }}
                  aria-label={t('Cancel')}
                >
                  <Icon name="lucide-x" />
                </a>
              </div>
            )}
            {boardView === 'table' ? (
              <TableView boardData={boardData} stateManager={stateManager} />
            ) : (
              <ScrollContainer
                id={view.id}
                className={classcat([
                  c('board'),
                  {
                    [c('horizontal')]: boardView !== 'list',
                    [c('vertical')]: boardView === 'list',
                    'is-adding-lane': isLaneFormVisible,
                  },
                ])}
                triggerTypes={boardScrollTiggers}
              >
                <div>
                  <Sortable axis={axis}>
                    <Lanes
                      lanes={boardData.children}
                      hideDoneLane={hideDoneLane}
                      collapseDir={axis}
                      targetHighlight={reactState?.targetHighlight ?? null}
                      cancelEditCounter={cancelEditCounter}
                    />
                    <SortPlaceholder
                      accepts={boardAccepts}
                      className={c('lane-placeholder')}
                      index={boardData.children.length}
                    />
                  </Sortable>
                </div>
              </ScrollContainer>
            )}
          </div>
        </SearchContext.Provider>
      </KanbanContext.Provider>
    </DndScope>
  );
};
