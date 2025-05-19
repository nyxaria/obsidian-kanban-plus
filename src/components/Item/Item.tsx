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
import { EditState, EditingState, Item, isEditing } from '../types';
import { ItemCheckbox } from './ItemCheckbox';
import { ItemContent } from './ItemContent';
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
}

export interface ItemInnerProps {
  item: Item;
  isStatic?: boolean;
  shouldMarkItemsComplete?: boolean;
  isMatch?: boolean;
  searchQuery?: string;
  targetHighlight?: any;
}

const ItemInner = memo(function ItemInner({
  item,
  shouldMarkItemsComplete,
  isMatch,
  searchQuery,
  isStatic,
  targetHighlight,
}: ItemInnerProps) {
  const { stateManager, boardModifiers } = useContext(KanbanContext);
  const [editState, setEditState] = useState<EditState>(EditingState.cancel);
  const itemInnerRef = useRef<HTMLDivElement>(null);

  const dndManager = useContext(DndManagerContext);

  useEffect(() => {
    const handler = () => {
      if (isEditing(editState)) setEditState(EditingState.cancel);
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
    console.log(
      `[ItemInner] ID: ${item.id}, targetHighlight received:`,
      JSON.stringify(targetHighlight, null, 2)
    );
    let shouldHighlight = false;
    if (targetHighlight && itemInnerRef.current) {
      // Try to highlight based on blockId first
      if (targetHighlight.blockId && item.data.blockId) {
        const itemBlockId = item.data.blockId.startsWith('#^')
          ? item.data.blockId.substring(2)
          : item.data.blockId.startsWith('^')
            ? item.data.blockId.substring(1)
            : item.data.blockId;
        if (itemBlockId === targetHighlight.blockId) {
          console.log(
            `[ItemInner] Highlighting item ${item.id} by blockId: ${targetHighlight.blockId}`
          );
          shouldHighlight = true;
        }
      }
      // RESTORED: Fallback to highlighting based on text match
      else if (
        targetHighlight.match &&
        targetHighlight.match.matches &&
        targetHighlight.match.matches.length > 0 &&
        item.data.titleRaw
      ) {
        const matchedText = targetHighlight.match.content.substring(
          targetHighlight.match.matches[0][0],
          targetHighlight.match.matches[0][1]
        );
        if (item.data.titleRaw.includes(matchedText)) {
          console.log(`[ItemInner] Highlighting item ${item.id} by text content match.`);
          shouldHighlight = true; // Set true if text matches
        }
      }

      if (shouldHighlight) {
        itemInnerRef.current.classList.add('search-result-highlight');
        itemInnerRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
      } else {
        itemInnerRef.current.classList.remove('search-result-highlight');
      }
    } else if (itemInnerRef.current) {
      itemInnerRef.current.classList.remove('search-result-highlight');
      // Optional: Log if targetHighlight was present but no highlight occurred
      if (targetHighlight) {
        let reason = 'unknown';
        if (!targetHighlight.blockId && !targetHighlight.match) {
          reason = 'targetHighlight missing blockId and match structure';
        } else if (targetHighlight.blockId && !item.data.blockId) {
          reason = 'targetHighlight has blockId but item does not';
        }
        console.log(
          `[ItemInner] Item ID: ${item.id}, No highlight occurred. Reason: ${reason}. Target: `,
          JSON.stringify(targetHighlight, null, 2),
          `Item blockId: ${item.data.blockId}, Item titleRaw: ${item.data.titleRaw}`
        );
      }
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
      if (isEditing(editState)) return;
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
    (e) => setEditState({ x: e.clientX, y: e.clientY }),
    [setEditState]
  );

  const ignoreAttr = useMemo(() => {
    if (isEditing(editState)) {
      return {
        'data-ignore-drag': true,
      };
    }

    return {};
  }, [editState]);

  return (
    <div
      ref={itemInnerRef}
      // eslint-disable-next-line react/no-unknown-property
      onDblClick={onDoubleClick}
      onContextMenu={onContextMenu}
      className={c('item-content-wrapper')}
      {...ignoreAttr}
    >
      <div className={c('item-title-wrapper')} {...ignoreAttr}>
        <ItemCheckbox
          boardModifiers={boardModifiers}
          item={item}
          path={path}
          shouldMarkItemsComplete={shouldMarkItemsComplete}
          stateManager={stateManager}
        />
        <ItemContent
          item={item}
          searchQuery={isMatch ? searchQuery : undefined}
          setEditState={setEditState}
          editState={editState}
          isStatic={isStatic}
        />
        <ItemMenuButton editState={editState} setEditState={setEditState} showMenu={showItemMenu} />
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
      <div ref={elementRef} className={classcat([c('item'), ...classModifiers])}>
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
}

export const Items = memo(function Items({
  isStatic,
  items,
  shouldMarkItemsComplete,
  targetHighlight,
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
          />
        );
      })}
    </>
  );
});
