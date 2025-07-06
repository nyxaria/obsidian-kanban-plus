import { debugLog } from '../../helpers/debugLogger';
import classcat from 'classcat';
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

import { KanbanContext, SearchContext } from '../context';
import { c, useGetDateColorFn } from '../helpers';
import {
  EditState,
  EditingProcessState,
  Item,
  TeamMemberColorConfig,
  isCardEditingState,
  isEditCoordinates,
  isEditingActive,
} from '../types';
import { DateAndTime } from './DateAndTime';
import { ItemCheckbox } from './ItemCheckbox';
import { AssignedMembers, ItemContent, Tags } from './ItemContent';
import { useItemMenu } from './ItemMenu';
import { ItemMenuButton } from './ItemMenuButton';
import { ItemPriority } from './ItemPriority';
import { ItemMetadata } from './MetadataTable';
import { getItemClassModifiers } from './helpers';

export interface DraggableItemProps {
  item: Item;
  itemIndex: number;
  laneId: string;
  isStatic?: boolean;
  shouldMarkItemsComplete?: boolean;
  targetHighlight?: any;
  cancelEditCounter: number;
}

export interface ItemInnerProps {
  item: Item;
  isStatic?: boolean;
  shouldMarkItemsComplete?: boolean;
  isMatch?: boolean;
  searchQuery?: string;
  targetHighlight?: any;
  cancelEditCounter: number;
}

const ItemInner = memo(function ItemInner({
  item,
  shouldMarkItemsComplete,
  isMatch,
  searchQuery,
  isStatic,
  targetHighlight,
  cancelEditCounter,
}: ItemInnerProps) {
  const { stateManager, boardModifiers, filePath, view } = useContext(KanbanContext);
  const [editState, setEditState] = useState<EditState>(EditingProcessState.Cancel);
  const [isHovered, setIsHovered] = useState(false);
  const itemInnerRef = useRef<HTMLDivElement>(null);
  const prevCancelEditCounterRef = useRef<number>(cancelEditCounter);

  const dndManager = useContext(DndManagerContext);
  const path = useNestedEntityPath();

  const getDateColor = useGetDateColorFn(stateManager);
  const teamMemberColors: Record<string, TeamMemberColorConfig> =
    view.plugin.settings.teamMemberColors || {};

  useEffect(() => {
    const handler = () => {
      if (isEditingActive(editState)) setEditState(EditingProcessState.Cancel);
    };

    dndManager.dragManager.emitter.on('dragStart', handler);
    return () => {
      dndManager.dragManager.emitter.off('dragStart', handler);
    };
  }, [dndManager, editState]);

  useEffect(() => {
    if (item.data.forceEditMode) {
      setEditState({ x: 0, y: 0 });
    }
  }, [item.data.forceEditMode]);

  useEffect(() => {
    const currentEditStateAtEffectStart = editState;
    if (prevCancelEditCounterRef.current !== cancelEditCounter) {
      if (isEditingActive(currentEditStateAtEffectStart)) {
        debugLog(
          `[ItemInner item ${item.id}] cancelEditCounter changed to ${cancelEditCounter}. Was ${prevCancelEditCounterRef.current}. Condition isEditingActive(${JSON.stringify(currentEditStateAtEffectStart)}) is TRUE. Setting editState from`,
          currentEditStateAtEffectStart,
          '-> complete'
        );
        setEditState(EditingProcessState.Complete);
      } else {
        debugLog(
          `[ItemInner item ${item.id}] cancelEditCounter changed to ${cancelEditCounter}. Was ${prevCancelEditCounterRef.current}. Condition isEditingActive(${JSON.stringify(currentEditStateAtEffectStart)}) is FALSE. Not setting to complete. Current editState remains:`,
          currentEditStateAtEffectStart
        );
      }
    }
    prevCancelEditCounterRef.current = cancelEditCounter;
  }, [cancelEditCounter, editState, item.id, setEditState]);

  useEffect(() => {
    let shouldApplyYellowBorder = false;
    if (targetHighlight && itemInnerRef.current) {
      if (targetHighlight.blockId) {
        if (item.data.blockId) {
          const itemBlockId = item.data.blockId.startsWith('#^')
            ? item.data.blockId.substring(2)
            : item.data.blockId.startsWith('^')
              ? item.data.blockId.substring(1)
              : item.data.blockId;
          if (itemBlockId === targetHighlight.blockId) {
            shouldApplyYellowBorder = true;
          }
        }
        if (!shouldApplyYellowBorder && targetHighlight.cardTitle && item.data.titleRaw) {
          if (item.data.titleRaw.startsWith(targetHighlight.cardTitle)) {
            shouldApplyYellowBorder = true;
          }
        }
      } else if (targetHighlight.matches && targetHighlight.content) {
        if (item.data.titleRaw && targetHighlight.matches.length > 0) {
          const firstMatchOffsets = targetHighlight.matches[0];
          const matchedTextInGlobalSearch = targetHighlight.content.substring(
            firstMatchOffsets[0],
            firstMatchOffsets[1]
          );
          if (item.data.titleRaw.includes(matchedTextInGlobalSearch)) {
            shouldApplyYellowBorder = true;
          }
        }
      }

      if (shouldApplyYellowBorder) {
        itemInnerRef.current.classList.add('search-result-highlight');
        itemInnerRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
      } else {
        itemInnerRef.current.classList.remove('search-result-highlight');
      }
    } else if (itemInnerRef.current) {
      itemInnerRef.current.classList.remove('search-result-highlight');
    }
  }, [targetHighlight, item.id, item.data.blockId, item.data.titleRaw]);

  const showItemMenu = useItemMenu({
    boardModifiers,
    item,
    setEditState: setEditState,
    stateManager,
    path,
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
      showItemMenu(e);
    },
    [showItemMenu, editState]
  );

  const onDoubleClickCallback: JSX.MouseEventHandler<HTMLDivElement> = useCallback(
    (e) => {
      debugLog('[ItemInner] onDoubleClick triggered', {
        isStatic,
        editable: stateManager.getSetting('editable'),
      });
      if (isStatic || !stateManager.getSetting('editable')) return;
      setEditState({ x: e.clientX, y: e.clientY });
      e.stopPropagation();
    },
    [setEditState, isStatic, stateManager]
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
            showMenu={showItemMenu}
            style={{ flexShrink: 0, marginRight: '8px', marginTop: '4px' }}
          />
        </div>
      )}

      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          marginBottom: '4px',
        }}
      >
        <ItemCheckbox
          isVisible={
            isHovered &&
            !isEditingActive(editState) &&
            !isStatic &&
            filePath !== 'member-board-virtual'
          }
          item={item}
          path={path}
          shouldMarkItemsComplete={shouldMarkItemsComplete ?? false}
          stateManager={stateManager}
          boardModifiers={boardModifiers}
          style={{ marginRight: '4px', marginLeft: '8px' }}
        />
        <div style={{ flexGrow: 1, minWidth: 0 }}>
          <ItemContent
            item={item}
            editState={editState}
            setEditState={setEditState}
            searchQuery={isMatch ? searchQuery : undefined}
            isStatic={!!isStatic}
            targetHighlight={targetHighlight}
            style={{ marginLeft: '-2.5px', marginRight: '0px' }}
            itemElement={itemInnerRef.current}
          />
        </div>
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
              filePath={filePath}
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

      <ItemMetadata searchQuery={isMatch ? searchQuery : undefined} item={item} />
    </div>
  );
});

export const DraggableItem = memo(function DraggableItem(props: DraggableItemProps) {
  const elementRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const search = useContext(SearchContext);

  const { itemIndex, targetHighlight, laneId, ...innerProps } = props;

  const bindHandle = useDragHandle(measureRef, measureRef);

  const isMatch = search?.query ? innerProps.item.data.titleSearch.includes(search.query) : false;
  const classModifiers: string[] = getItemClassModifiers({
    item: innerProps.item,
    isStatic: innerProps.isStatic,
    stateManager: undefined, // Not available in this context
  });

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
        className={classcat([c('item'), ...classModifiers])}
        data-id={props.item.id}
      >
        {props.isStatic ? (
          <ItemInner
            {...innerProps}
            isMatch={isMatch}
            searchQuery={search?.query}
            isStatic={true}
            targetHighlight={targetHighlight}
          />
        ) : (
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
            <ItemInner
              {...innerProps}
              isMatch={isMatch}
              searchQuery={search?.query}
              targetHighlight={targetHighlight}
            />
          </Droppable>
        )}
      </div>
    </div>
  );
});

interface ItemsProps {
  isStatic?: boolean;
  items: Item[];
  laneId: string;
  shouldMarkItemsComplete: boolean;
  targetHighlight?: any;
  cancelEditCounter: number;
}

export const Items = memo(function Items({
  isStatic,
  items,
  laneId,
  shouldMarkItemsComplete,
  targetHighlight,
  cancelEditCounter,
}: ItemsProps) {
  const search = useContext(SearchContext);
  const { view } = useContext(KanbanContext);
  const boardView = view.useViewState(frontmatterKey);

  return (
    <>
      {items.map((item, i) => {
        return search?.query && !search.items.has(item) ? null : (
          <DraggableItem
            key={boardView + item.id}
            item={item}
            itemIndex={i}
            laneId={laneId}
            shouldMarkItemsComplete={shouldMarkItemsComplete}
            isStatic={isStatic}
            targetHighlight={targetHighlight}
            cancelEditCounter={cancelEditCounter}
          />
        );
      })}
    </>
  );
});
