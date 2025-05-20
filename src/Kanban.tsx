import { KanbanContextType, SearchContextType } from './components/context';
import { c } from './components/helpers';
import { KanbanEmpty } from './components/KanbanEmpty';
import { LaneComponent } from './components/Lane/Lane';
import { DraggableLane } from './components/dnd/DraggableLane';
import { Board, KanbanSettings, Lane, ViewType } from './types';

export interface KanbanProps {
  board: Board | null;
  boardModifiers: BoardModifiers;
  stateManager: StateManager;
  filePath?: string;
  view: KanbanView;
  settings: KanbanSettings;
  showFilterControls: boolean;
  setShowFilterControls: (show: boolean) => void;
  filterDue: { unit: 'days' | 'weeks' | 'months'; value: number } | null;
  setFilterDue: (filter: { unit: 'days' | 'weeks' | 'months'; value: number } | null) => void;
  viewType: ViewType;
}

export function Kanban({
  board,
  boardModifiers,
  stateManager,
  filePath,
  view,
  settings,
  showFilterControls,
  setShowFilterControls,
  filterDue,
  setFilterDue,
  viewType,
}: KanbanProps) {
  // ADD DEFENSIVE CHECKS HERE
  if (!view) {
    console.error('[Kanban.tsx] CRITICAL: The \'view\' prop is undefined. Cannot render Kanban board.');
    return (
      <div className={c('kanban-plugin', 'kanban-plugin-error')}>
        Critical Error: Kanban view context is missing.
      </div>
    );
  }

  if (!board) {
    console.log('[Kanban.tsx] Board prop is null. Rendering empty board state or loading indicator.');
    // Depending on desired behavior, could show a loading state or specific message.
    // For now, delegating to KanbanEmpty or similar logic if applicable, or just a simple message.
    return (
      <div className={c('kanban-plugin', 'kanban-plugin-empty')}>
        Board data is not available.
      </div>
    );
  }

  if (!board.data) {
    console.error(
      `[Kanban.tsx] CRITICAL: board.data is undefined for board ID: ${board.id}. Cannot render lanes.`
    );
    return (
      <div className={c('kanban-plugin', 'kanban-plugin-error')}>
        Critical Error: Board data structure is missing. (Board ID: ${board.id})
      </div>
    );
  }

  // Log details of each lane BEFORE rendering them
  console.log(`[Kanban.tsx] Preparing to render lanes for board ID: ${board.id}. Number of lanes: ${board.data.lanes?.length}`);
  if (board.data.lanes && Array.isArray(board.data.lanes)) {
    board.data.lanes.forEach((lane, index) => {
      if (!lane) {
        console.error(`[Kanban.tsx] CRITICAL: Lane at index ${index} is undefined.`);
        return; // Skip to next lane
      }
      if (!lane.data) {
        console.error(`[Kanban.tsx] CRITICAL: lane.data is undefined for lane ID: ${lane.id} at index ${index}.`);
        return; // Skip to next lane
      }
      if (typeof lane.data.title !== 'string') {
        console.error(
          `[Kanban.tsx] CRITICAL: lane.data.title is not a string for lane ID: ${lane.id} at index ${index}. Type: ${typeof lane.data.title}, Value:`, lane.data.title
        );
        // Potentially render a fallback or skip this lane in actual rendering logic if needed
      }
      // console.log(`[Kanban.tsx] Lane ${index} (ID: ${lane.id}): Title is '${lane.data.title}' (Type: ${typeof lane.data.title})`);
    });
  } else {
    console.warn(`[Kanban.tsx] board.data.lanes is not an array or is undefined for board ID: ${board.id}. Lanes:`, board.data.lanes);
  }
  // END ADDED CHECKS

  const { app, currentSearch, search, প্রবাসী } = useContext(KanbanContext); // TODO: Remove প্রবাসী
// ... existing code ... 