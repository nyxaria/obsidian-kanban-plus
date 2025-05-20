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
import { c } from '../helpers';
import {
  EditState,
  EditingProcessState,
  Item,
  isCardEditingState,
  isEditCoordinates,
  isEditingActive,
} from '../types';
import { ItemCheckbox } from './ItemCheckbox';
import { ItemContent, Tags } from './ItemContent';
import { useItemMenu } from './ItemMenu';
import { ItemMenuButton } from './ItemMenuButton';
import { ItemMetadata } from './MetadataTable';
import { getItemClassModifiers } from './helpers';

export interface DraggableItemProps {
  item: Item;
  itemIndex: number;
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
  const { stateManager, boardModifiers } = useContext(KanbanContext);
  const [editState, setEditState] = useState<EditState>(EditingProcessState.Cancel);
  const [isHovered, setIsHovered] = useState(false);
  const itemInnerRef = useRef<HTMLDivElement>(null);
  const prevCancelEditCounterRef = useRef<number>(cancelEditCounter);

  const dndManager = useContext(DndManagerContext);

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
    const currentEditStateAtEffectStart = editState; // Capture editState when effect runs
    if (prevCancelEditCounterRef.current !== cancelEditCounter) {
      if (isEditingActive(currentEditStateAtEffectStart)) {
        // Use captured state
        console.log(
          `[ItemInner item ${item.id}] cancelEditCounter changed to ${cancelEditCounter}. Was ${prevCancelEditCounterRef.current}. Condition isEditingActive(${JSON.stringify(currentEditStateAtEffectStart)}) is TRUE. Setting editState from`,
          currentEditStateAtEffectStart,
          '-> complete'
        );
        setEditState(EditingProcessState.Complete);
      } else {
        console.log(
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
      // Case 1: targetHighlight is from Workspace Navigation (has blockId and/or cardTitle)
      if (targetHighlight.blockId) {
        if (item.data.blockId) {
          const itemBlockId = item.data.blockId.startsWith('#^')
            ? item.data.blockId.substring(2)
            : item.data.blockId.startsWith('^')
              ? item.data.blockId.substring(1)
              : item.data.blockId;
          if (itemBlockId === targetHighlight.blockId) {
            // console.log(`[ItemInner] Yellow border for item ${item.id} by workspace nav blockId: ${targetHighlight.blockId}`);
            shouldApplyYellowBorder = true;
          }
        }
        // Fallback for workspace nav if blockId didn't match or was absent, but cardTitle is present
        if (!shouldApplyYellowBorder && targetHighlight.cardTitle && item.data.titleRaw) {
          if (item.data.titleRaw.startsWith(targetHighlight.cardTitle)) {
            // console.log(`[ItemInner] Yellow border for item ${item.id} by workspace nav cardTitle (fallback): ${targetHighlight.cardTitle}`);
            shouldApplyYellowBorder = true;
          }
        }
      }
      // Case 2: targetHighlight is from Global Search (has content and matches properties directly)
      else if (targetHighlight.matches && targetHighlight.content) {
        if (item.data.titleRaw && targetHighlight.matches.length > 0) {
          // Use the first match to determine if this card is relevant for the border
          const firstMatchOffsets = targetHighlight.matches[0]; // e.g., [startIndex, endIndex]
          const matchedTextInGlobalSearch = targetHighlight.content.substring(
            firstMatchOffsets[0],
            firstMatchOffsets[1]
          );
          // Check if the item's raw title contains the text that was matched by global search.
          if (item.data.titleRaw.includes(matchedTextInGlobalSearch)) {
            // console.log(`[ItemInner] Yellow border for item ${item.id} by global search text content match: "${matchedTextInGlobalSearch}"`);
            shouldApplyYellowBorder = true;
          }
        }
      }

      if (shouldApplyYellowBorder) {
        itemInnerRef.current.classList.add('search-result-highlight');
        // This scrollIntoView was part of the original logic.
        // It might provide more precise centering than other scrolling mechanisms.
        itemInnerRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
      } else {
        itemInnerRef.current.classList.remove('search-result-highlight');
      }
    } else if (itemInnerRef.current) {
      // Ensure highlight is removed if targetHighlight is null or itemInnerRef.current was not available initially
      itemInnerRef.current.classList.remove('search-result-highlight');
    }
  }, [targetHighlight, item.id, item.data.blockId, item.data.titleRaw]);

  const path = useNestedEntityPath();

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

  const onDoubleClick: JSX.MouseEventHandler<HTMLDivElement> = useCallback(
    (e) => {
      console.log('[ItemInner] onDoubleClick triggered', {
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
      // eslint-disable-next-line react/no-unknown-property
      onDblClick={onDoubleClick}
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
            marginBottom: '4px',
          }}
        >
          <Tags
            tags={item.data.metadata?.tags}
            searchQuery={isMatch ? searchQuery : undefined}
            alwaysShow={true}
            style={{
              flexGrow: 1,
              marginRight: '8px',
              marginLeft: '8px',
              marginTop: '4px',
              minWidth: 0,
            }}
          />
          <ItemMenuButton
            editState={editState}
            setEditState={setEditState}
            showMenu={showItemMenu}
            style={{ flexShrink: 0, marginRight: '8px', marginTop: '4px' }}
          />
        </div>
      )}

      <div
        className={c('item-title-wrapper')}
        {...ignoreAttr}
        style={{ display: 'flex', alignItems: 'flex-start' }}
      >
        <ItemCheckbox
          boardModifiers={boardModifiers}
          item={item}
          path={path}
          shouldMarkItemsComplete={shouldMarkItemsComplete}
          stateManager={stateManager}
          style={{ marginTop: '0px' }}
          isVisible={isHovered}
        />
        <ItemContent
          item={item}
          searchQuery={isMatch ? searchQuery : undefined}
          setEditState={setEditState}
          editState={editState}
          isStatic={isStatic}
          targetHighlight={targetHighlight}
          style={{
            flexGrow: 1,
            marginLeft: isHovered ? '8px' : '0px',
            transition: 'margin-left 0.2s ease-in-out',
          }}
        />
      </div>
      <ItemMetadata searchQuery={isMatch ? searchQuery : undefined} item={item} />
    </div>
  );
});

export const DraggableItem = memo(function DraggableItem(props: DraggableItemProps) {
  const elementRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const search = useContext(SearchContext);

  const { itemIndex, targetHighlight, ...innerProps } = props;

  const bindHandle = useDragHandle(measureRef, measureRef);

  const isMatch = search?.query ? innerProps.item.data.titleSearch.includes(search.query) : false;
  const classModifiers: string[] = getItemClassModifiers(innerProps.item);

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
            data={props.item}
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
  shouldMarkItemsComplete: boolean;
  targetHighlight?: any;
  cancelEditCounter: number;
}

export const Items = memo(function Items({
  isStatic,
  items,
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
