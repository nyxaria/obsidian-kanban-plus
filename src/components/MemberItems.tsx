import classcat from 'classcat';
import { TFile, WorkspaceLeaf, moment } from 'obsidian';
import {
  JSX,
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'preact/compat';
import { Droppable, useNestedEntityPath } from 'src/dnd/components/Droppable';
import { DndManagerContext } from 'src/dnd/components/context';
import { useDragHandle } from 'src/dnd/managers/DragManager';
import { frontmatterKey } from 'src/parsers/common';

import { MemberView } from '../MemberView';
import { debugLog } from '../helpers/debugLogger';
import { DateAndTime } from './Item/DateAndTime';
import { ItemCheckbox } from './Item/ItemCheckbox';
import { AssignedMembers, ItemContent, Tags } from './Item/ItemContent';
import { ItemMenuButton } from './Item/ItemMenuButton';
import { ItemPriority } from './Item/ItemPriority';
import { ItemMetadata } from './Item/MetadataTable';
import { getItemClassModifiers } from './Item/helpers';
import { useMemberItemMenu } from './MemberItemMenu';
import { KanbanContext, SearchContext } from './context';
import { c, useGetDateColorFn } from './helpers';
import {
  EditState,
  EditingProcessState,
  Item,
  TeamMemberColorConfig,
  isCardEditingState,
  isEditCoordinates,
  isEditingActive,
} from './types';

export interface MemberItemsProps {
  items: Item[];
  laneId: string;
  shouldMarkItemsComplete?: boolean;
  targetHighlight?: any;
  cancelEditCounter: number;
  memberCards: any[];
  view: MemberView;
  onCardUpdate: () => void;
}

export interface MemberDraggableItemProps {
  item: Item;
  itemIndex: number;
  laneId: string;
  isStatic?: boolean;
  shouldMarkItemsComplete?: boolean;
  targetHighlight?: any;
  cancelEditCounter: number;
  memberCard?: any;
  view: MemberView;
  onCardUpdate: () => void;
}

const MemberItemInner = memo(function MemberItemInner({
  item,
  itemIndex,
  laneId,
  isStatic,
  shouldMarkItemsComplete,
  targetHighlight,
  cancelEditCounter,
  memberCard,
  view,
  onCardUpdate,
}: MemberDraggableItemProps) {
  // Defensive check at the start of component
  if (!item || !item.data || !item.data.metadata) {
    console.error('[MemberItemInner] CRITICAL: Invalid item received:', {
      itemId: item?.id || 'unknown',
      hasData: !!item?.data,
      hasMetadata: !!item?.data?.metadata,
    });
    return null; // Don't render anything for invalid items
  }

  const { stateManager, boardModifiers } = useContext(KanbanContext);
  const { query: searchQuery, items: matchedItems } = useContext(SearchContext);
  const dndManager = useContext(DndManagerContext);
  const path = useNestedEntityPath();

  // Add date color function like in regular Item component
  const getDateColor = useMemo(() => {
    const dateColors = view.plugin.settings['date-colors'] || [];
    const dateDisplayFormat = view.plugin.settings['date-display-format'] || 'YYYY-MM-DD';

    // Use the same logic as the main getDateColorFn
    const orders = dateColors.map<[moment.Moment | 'today' | 'before' | 'after', any]>((c: any) => {
      if (c.isToday) {
        return ['today', c];
      }
      if (c.isBefore) {
        return ['before', c];
      }
      if (c.isAfter) {
        return ['after', c];
      }
      const modifier = c.direction === 'after' ? 1 : -1;
      const date = moment();
      date.add(c.distance * modifier, c.unit);
      return [date, c];
    });

    const now = moment();
    orders.sort((a, b) => {
      if (a[0] === 'today') {
        return typeof b[0] === 'string' ? -1 : (b[0] as moment.Moment).isSame(now, 'day') ? 1 : -1;
      }
      if (b[0] === 'today') {
        return typeof a[0] === 'string' ? 1 : (a[0] as moment.Moment).isSame(now, 'day') ? -1 : 1;
      }
      if (a[0] === 'after') return 1;
      if (a[0] === 'before') return 1;
      if (b[0] === 'after') return -1;
      if (b[0] === 'before') return -1;
      return (a[0] as moment.Moment).isBefore(b[0] as moment.Moment) ? -1 : 1;
    });

    return (date: moment.Moment) => {
      const now = moment();
      const result = orders.find((o) => {
        const key = o[1];
        if (key.isToday) return date.isSame(now, 'day');
        if (key.isAfter) return date.isAfter(now);
        if (key.isBefore) return date.isBefore(now);

        let granularity: moment.unitOfTime.StartOf = 'days';
        if (key.unit === 'hours') {
          granularity = 'hours';
        }

        if (key.direction === 'before') {
          return date.isBetween(o[0], now, granularity, '[]');
        }
        return date.isBetween(now, o[0], granularity, '[]');
      });

      return result ? result[1] : null;
    };
  }, [view.plugin.settings['date-colors'], view.plugin.settings['date-display-format']]);

  // Get team member colors from plugin settings like in regular Item component
  const teamMemberColors: Record<string, any> = view.plugin.settings.teamMemberColors || {};

  const [editState, setEditState] = useState<EditState>(false);
  const [isHovered, setIsHovered] = useState(false);

  const itemInnerRef = useRef<HTMLDivElement>(null);

  const isMatch = useMemo(() => {
    return !!searchQuery && matchedItems.has(item.id);
  }, [searchQuery, matchedItems, item.id]);

  // Use custom member item menu instead of regular item menu
  const showMemberItemMenu = useMemberItemMenu({
    memberCard,
    view,
    onCardUpdate,
  });

  const onContextMenu: JSX.MouseEventHandler<HTMLDivElement> = useCallback(
    (e) => {
      if (isEditingActive(editState)) return;
      if (
        e.targetNode.instanceOf(HTMLAnchorElement) &&
        (e.targetNode.hasClass('internal-link') || e.targetNode.hasClass('external-link'))
      ) {
        return;
      }
      showMemberItemMenu(e);
    },
    [showMemberItemMenu, editState]
  );

  const onDoubleClickCallback: JSX.MouseEventHandler<HTMLDivElement> = useCallback(
    async (e) => {
      debugLog('[MemberItemInner] onDoubleClick triggered - navigating to card', {
        cardId: memberCard?.id,
        sourceBoardPath: memberCard?.sourceBoardPath,
        blockId: memberCard?.blockId,
      });

      if (!memberCard) return;

      e.stopPropagation();

      // Use the same navigation logic as "Go to card" context menu
      const sourceFile = view.app.vault.getAbstractFileByPath(memberCard.sourceBoardPath);
      if (sourceFile instanceof TFile) {
        const navigationState = {
          file: memberCard.sourceBoardPath,
          eState: {
            filePath: memberCard.sourceBoardPath,
            blockId: memberCard.blockId || undefined,
            cardTitle: !memberCard.blockId ? memberCard.titleRaw : undefined,
            listName: undefined as string | undefined,
          },
        };

        let linkPath = memberCard.sourceBoardPath;
        if (memberCard.blockId) {
          linkPath = `${memberCard.sourceBoardPath}#^${memberCard.blockId}`;
        }

        // Check for an existing Kanban view for this file
        let existingLeaf: WorkspaceLeaf | null = null;
        view.app.workspace.getLeavesOfType('kanban').forEach((leaf) => {
          if ((leaf.view as any).file?.path === memberCard.sourceBoardPath) {
            existingLeaf = leaf;
          }
        });

        if (existingLeaf) {
          debugLog(
            `[MemberItemInner] Found existing Kanban view for ${memberCard.sourceBoardPath}. Activating and setting state.`,
            navigationState
          );
          view.app.workspace.setActiveLeaf(existingLeaf, { focus: true });
          // Set the state to highlight the card
          (existingLeaf.view as any).setState(
            { eState: navigationState.eState },
            { history: true }
          );
        } else {
          debugLog(
            `[MemberItemInner] No existing Kanban view found for ${memberCard.sourceBoardPath}. Opening link '${linkPath}' with newLeaf: 'tab' and state:`,
            navigationState
          );
          // Fallback to opening a new tab if no existing view is found
          await view.app.workspace.openLinkText(linkPath, memberCard.sourceBoardPath, 'tab', {
            state: navigationState,
          });
        }
      }
    },
    [memberCard, view]
  );

  const ignoreAttr = useMemo(() => {
    if (isEditingActive(editState)) {
      return {
        'data-ignore-drag': true,
      };
    }
    return {};
  }, [editState]);

  return (
    <div
      ref={itemInnerRef}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      onDblClick={onDoubleClickCallback}
      onContextMenu={onContextMenu}
      className={c('item-content-wrapper')}
      {...ignoreAttr}
    >
      {!isCardEditingState(editState) && !isStatic && (
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'flex-start',
            marginBottom: '6px',
          }}
        >
          <div style={{ flexGrow: 1, marginRight: '8px', minWidth: 0 }}>
            <Tags
              tags={item.data.metadata?.tags}
              searchQuery={isMatch ? searchQuery : undefined}
              alwaysShow={true}
              style={{
                marginLeft: '8px',
                marginTop: '2.5px',
              }}
            />
          </div>
          <ItemMenuButton
            editState={editState}
            setEditState={setEditState}
            showMenu={showMemberItemMenu}
            style={{ flexShrink: 0, marginRight: '8px', marginTop: '4px' }}
          />
        </div>
      )}

      <div className={c('item-title-wrapper')}>
        <ItemCheckbox
          boardModifiers={boardModifiers}
          item={item}
          path={path}
          shouldMarkItemsComplete={shouldMarkItemsComplete}
          stateManager={stateManager}
          isVisible={false}
        />
        <ItemContent
          editState={editState}
          item={item}
          setEditState={setEditState}
          showMetadata={true}
          searchQuery={isMatch ? searchQuery : undefined}
          isStatic={isStatic}
        />
      </div>

      {!isCardEditingState(editState) && (
        <div
          className={c('item-bottom-metadata')}
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'flex-end',
            width: '100%',
            marginTop: '0px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'flex-end' }}>
            <DateAndTime
              item={item}
              stateManager={stateManager}
              filePath={view.file?.path || 'member-board-virtual'}
              getDateColor={getDateColor}
              style={{
                flexGrow: 0,
                flexShrink: 0,
                marginRight: item.data.metadata?.dateStr ? '0px' : '0px',
                marginLeft: '4px',
                marginBottom: '7px',
              }}
            />
          </div>
          <div style={{ display: 'flex', alignItems: 'flex-end' }}>
            <AssignedMembers
              assignedMembers={item.data.assignedMembers}
              searchQuery={isMatch ? searchQuery : undefined}
              teamMemberColors={teamMemberColors}
              style={{ flexGrow: 0, flexShrink: 0, marginRight: '8px', marginBottom: '7px' }}
            />
            <ItemPriority
              priority={item.data.metadata?.priority}
              style={{ marginBottom: '7px' }}
              assignedMembersCount={item.data.assignedMembers?.length || 0}
            />
          </div>
        </div>
      )}
    </div>
  );
});

const MemberDraggableItem = memo(function MemberDraggableItem(props: MemberDraggableItemProps) {
  const { item, itemIndex, laneId, isStatic, memberCard } = props;
  const { stateManager } = useContext(KanbanContext);
  const search = useContext(SearchContext);

  const elementRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);

  // Use the same drag handle pattern as regular DraggableItem
  const bindHandle = useDragHandle(measureRef, measureRef);

  // Defensive check before calling getItemClassModifiers
  const itemClassModifiers = useMemo(() => {
    if (!item || !item.data || !item.data.metadata) {
      console.error('[MemberDraggableItem] CRITICAL: Invalid item for getItemClassModifiers:', {
        itemId: item?.id || 'unknown',
        hasData: !!item?.data,
        hasMetadata: !!item?.data?.metadata,
      });
      return []; // Return empty array as fallback
    }

    try {
      return getItemClassModifiers({
        item,
        isStatic: !!isStatic,
        stateManager,
      });
    } catch (error) {
      console.error('[MemberDraggableItem] Error in getItemClassModifiers:', error, {
        itemId: item.id,
        itemData: item.data,
      });
      return []; // Return empty array as fallback
    }
  }, [item, isStatic, stateManager]);

  const isMatch = search?.query ? item.data.titleSearch.includes(search.query) : false;

  return (
    <div
      ref={(el) => {
        measureRef.current = el;
        bindHandle(el);
      }}
      className={c('item-wrapper')}
    >
      <div
        ref={elementRef}
        className={classcat([c('item'), ...itemClassModifiers])}
        data-id={item.id}
      >
        {isStatic ? (
          <MemberItemInner {...props} />
        ) : (
          <Droppable
            elementRef={elementRef}
            measureRef={measureRef}
            id={item.id}
            index={itemIndex}
            data={{
              id: item.id,
              type: 'item',
              accepts: ['item'],
              parentLaneId: laneId,
              originalIndex: itemIndex,
              memberBoardItem: true,
              memberBoardLaneId: laneId,
            }}
          >
            <MemberItemInner {...props} />
          </Droppable>
        )}
      </div>
    </div>
  );
});

export const MemberItems = memo(function MemberItems({
  items,
  laneId,
  shouldMarkItemsComplete,
  targetHighlight,
  cancelEditCounter,
  memberCards,
  view,
  onCardUpdate,
}: MemberItemsProps) {
  return (
    <>
      {items.map((item, itemIndex) => {
        // Defensive check: Ensure item has proper structure
        if (!item || !item.data || !item.data.metadata) {
          console.error('[MemberItems] CRITICAL: Invalid item detected during render:', {
            itemId: item?.id || 'unknown',
            hasData: !!item?.data,
            hasMetadata: !!item?.data?.metadata,
            item: item,
          });
          return null; // Skip rendering this item
        }

        // Ensure tags is always an array
        if (!Array.isArray(item.data.metadata.tags)) {
          console.warn('[MemberItems] Fixing invalid tags for item:', item.id);
          item.data.metadata.tags = [];
        }

        // Find the corresponding member card for this item
        const memberCard = memberCards.find((card) => card.id === item.id);

        return (
          <MemberDraggableItem
            key={item.id}
            item={item}
            itemIndex={itemIndex}
            laneId={laneId}
            shouldMarkItemsComplete={shouldMarkItemsComplete}
            targetHighlight={targetHighlight}
            cancelEditCounter={cancelEditCounter}
            memberCard={memberCard}
            view={view}
            onCardUpdate={onCardUpdate}
          />
        );
      })}
    </>
  );
});
