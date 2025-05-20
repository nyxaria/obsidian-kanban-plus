import { EditorView } from '@codemirror/view';
import { memo } from 'preact/compat';
import {
  Dispatch,
  StateUpdater,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
} from 'preact/hooks';
import { StateManager } from 'src/StateManager';
import { useNestedEntityPath } from 'src/dnd/components/Droppable';
import { Path } from 'src/dnd/types';
import { getTaskStatusDone, toggleTaskString } from 'src/parsers/helpers/inlineMetadata';

import { MarkdownEditor, allowNewLine } from '../Editor/MarkdownEditor';
import {
  MarkdownClonedPreviewRenderer,
  MarkdownRenderer,
} from '../MarkdownRenderer/MarkdownRenderer';
import { KanbanContext, SearchContext } from '../context';
import { c, useGetDateColorFn, useGetTagColorFn, useGetTagSymbolFn } from '../helpers';
import {
  EditState,
  EditingProcessState,
  Item,
  TeamMemberColorConfig,
  isCardEditingState,
  isEditCoordinates,
  isEditingActive,
} from '../types';
import { DateAndTime, RelativeDate } from './DateAndTime';
import { InlineMetadata } from './InlineMetadata';
import {
  constructDatePicker,
  constructMenuDatePickerOnChange,
  constructMenuTimePickerOnChange,
  constructTimePicker,
} from './helpers';

export function useDatePickers(item: Item, explicitPath?: Path) {
  const { stateManager, boardModifiers } = useContext(KanbanContext);
  const path = explicitPath || useNestedEntityPath();

  return useMemo(() => {
    const onEditDate = (e: MouseEvent) => {
      constructDatePicker(
        e.view,
        stateManager,
        { x: e.clientX, y: e.clientY },
        constructMenuDatePickerOnChange({
          stateManager,
          boardModifiers,
          item,
          hasDate: true,
          path,
        }),
        item.data.metadata.date?.toDate()
      );
    };

    const onEditTime = (e: MouseEvent) => {
      constructTimePicker(
        e.view, // Preact uses real events, so this is safe
        stateManager,
        { x: e.clientX, y: e.clientY },
        constructMenuTimePickerOnChange({
          stateManager,
          boardModifiers,
          item,
          hasTime: true,
          path,
        }),
        item.data.metadata.time
      );
    };

    return {
      onEditDate,
      onEditTime,
    };
  }, [boardModifiers, path, item, stateManager]);
}

export interface ItemContentProps {
  item: Item;
  setEditState: Dispatch<StateUpdater<EditState>>;
  searchQuery?: string;
  showMetadata?: boolean;
  editState: EditState;
  isStatic: boolean;
  targetHighlight?: any;
}

function checkCheckbox(stateManager: StateManager, title: string, checkboxIndex: number) {
  let count = 0;

  const lines = title.split(/\n\r?/g);
  const results: string[] = [];

  lines.forEach((line) => {
    if (count > checkboxIndex) {
      results.push(line);
      return;
    }

    const match = line.match(/^(\s*>)*(\s*[-+*]\s+?\[)([^\]])(\]\s+)/);

    if (match) {
      if (count === checkboxIndex) {
        const updates = toggleTaskString(line, stateManager.file);
        if (updates) {
          results.push(updates);
        } else {
          const check = match[3] === ' ' ? getTaskStatusDone() : ' ';
          const m1 = match[1] ?? '';
          const m2 = match[2] ?? '';
          const m4 = match[4] ?? '';
          results.push(m1 + m2 + check + m4 + line.slice(match[0].length));
        }
      } else {
        results.push(line);
      }
      count++;
      return;
    }

    results.push(line);
  });

  return results.join('\n');
}

export function Tags({
  tags,
  searchQuery,
  alwaysShow,
}: {
  tags?: string[];
  searchQuery?: string;
  alwaysShow?: boolean;
}) {
  const { stateManager } = useContext(KanbanContext);
  const getTagColor = useGetTagColorFn(stateManager);
  const getTagSymbol = useGetTagSymbolFn(stateManager);
  const search = useContext(SearchContext);
  const shouldShow = stateManager.useSetting('move-tags') || alwaysShow;
  const hideHashForTagsWithoutSymbols = stateManager.useSetting('hideHashForTagsWithoutSymbols');

  if (!tags || !tags.length || !shouldShow) {
    return null;
  }

  return (
    <div className={c('item-tags')}>
      {tags.map((originalTag, i) => {
        const tagColor = getTagColor(originalTag);
        const symbolInfo = getTagSymbol(originalTag);

        let tagContent;
        if (symbolInfo) {
          tagContent = (
            <>
              <span>{symbolInfo.symbol}</span>
              {!symbolInfo.hideTag && originalTag.length > 1 && (
                <span style={{ marginLeft: '0.2em' }}>{originalTag.slice(1)}</span>
              )}
            </>
          );
        } else {
          if (hideHashForTagsWithoutSymbols) {
            tagContent = originalTag.length > 1 ? originalTag.slice(1) : originalTag;
          } else {
            tagContent = originalTag;
          }
        }

        return (
          <span
            onClick={(e) => {
              e.preventDefault();

              const tagAction = stateManager.getSetting('tag-action');
              if (search && tagAction === 'kanban') {
                search.search(originalTag, true);
                return;
              }

              (stateManager.app as any).internalPlugins
                .getPluginById('global-search')
                .instance.openGlobalSearch(`tag:${originalTag}`);
            }}
            key={i}
            className={`tag ${c('item-tag')} ${
              searchQuery && originalTag.toLocaleLowerCase().contains(searchQuery)
                ? 'is-search-match'
                : ''
            }`}
            style={{
              cursor: 'pointer',
              ...(tagColor && {
                '--tag-color': tagColor.color,
                '--tag-background': tagColor.backgroundColor,
              }),
            }}
          >
            {tagContent}
          </span>
        );
      })}
    </div>
  );
}

export interface AssignedMembersProps {
  assignedMembers?: string[];
  searchQuery?: string;
  teamMemberColors?: Record<string, TeamMemberColorConfig>;
}

export function AssignedMembers({
  assignedMembers,
  searchQuery,
  teamMemberColors,
}: AssignedMembersProps) {
  const { stateManager } = useContext(KanbanContext);
  const shouldShow = stateManager.useSetting('move-tags');

  if (!assignedMembers || !assignedMembers.length || !shouldShow) {
    return null;
  }

  return (
    <div className={c('item-assigned-members')} style={{ marginTop: '4px' }}>
      {assignedMembers.map((member, i) => {
        const memberConfig = teamMemberColors?.[member];
        const backgroundColor = memberConfig?.background || 'var(--background-modifier-hover)';
        const textColor =
          memberConfig?.text ||
          (memberConfig?.background ? 'var(--text-on-accent)' : 'var(--text-normal)');

        return (
          <span
            key={i}
            className={`${c('item-assigned-member')} ${
              searchQuery && member.toLocaleLowerCase().contains(searchQuery)
                ? 'is-search-match'
                : ''
            }`}
            style={{
              cursor: 'default',
              backgroundColor: backgroundColor,
              color: textColor,
              padding: '1px 5px',
              borderRadius: '3px',
              marginRight: '4px',
              fontSize: '0.9em',
              display: 'inline-flex',
              alignItems: 'center',
            }}
          >
            {member}
          </span>
        );
      })}
    </div>
  );
}

export const ItemContent = memo(function ItemContent({
  item,
  editState,
  setEditState,
  searchQuery,
  showMetadata = true,
  isStatic,
  targetHighlight,
}: ItemContentProps) {
  const { stateManager, view, boardModifiers, filePath } = useContext(KanbanContext);
  const { onEditDate, onEditTime } = useDatePickers(item);
  const getDateColor = useGetDateColorFn(stateManager);
  const getTagColor = useGetTagColorFn(stateManager);
  const getTagSymbol = useGetTagSymbolFn(stateManager);
  const search = useContext(SearchContext);
  const shouldShowTags = stateManager.useSetting('move-tags');
  const hideHashForTagsWithoutSymbols = stateManager.useSetting('hideHashForTagsWithoutSymbols');
  const teamMemberColors: Record<string, TeamMemberColorConfig> =
    view.plugin.settings.teamMemberColors || {};

  const isEditingCard = isCardEditingState(editState) && editState.id === item.id;

  const titleRef = useRef<string | null>(null);
  const path = useNestedEntityPath();

  useEffect(() => {
    if (editState === EditingProcessState.complete) {
      if (titleRef.current !== null) {
        const newContent = titleRef.current.trim();
        boardModifiers.updateItem(path, stateManager.updateItemContent(item, newContent));
      }
      titleRef.current = null;
    } else if (editState === EditingProcessState.cancel) {
      titleRef.current = null;
    }
  }, [editState, stateManager, item, boardModifiers, path]);

  const onEnter = useCallback(
    (cm: EditorView, mod: boolean, shift: boolean) => {
      if (!allowNewLine(stateManager, mod, shift)) {
        setEditState(EditingProcessState.complete);
        return true;
      }
      return false;
    },
    [stateManager, setEditState]
  );

  const onEscape = useCallback(() => {
    setEditState(EditingProcessState.cancel);
    return true;
  }, [setEditState]);

  const onSubmit = useCallback(() => {
    setEditState(EditingProcessState.complete);
  }, [setEditState]);

  const onWrapperClick = useCallback(
    (e: MouseEvent) => {
      if (e.target instanceof HTMLElement) {
        if (e.target.classList.contains(c('item-metadata-date'))) {
          onEditDate(e);
        } else if (e.target.classList.contains(c('item-metadata-time'))) {
          onEditTime(e);
        } else if (e.target.closest('.tag')) {
          e.stopPropagation();
        }
      }
    },
    [onEditDate, onEditTime]
  );

  const onCheckboxContainerClick = useCallback(
    (e: any) => {
      if (e.targetNode.instanceOf(HTMLInputElement)) {
        if (isStatic) return;
        const checkboxIndex = parseInt(e.targetNode.dataset.checkboxIndex);
        const newTitle = checkCheckbox(stateManager, item.data.titleRaw, checkboxIndex);
        boardModifiers.updateItem(path, stateManager.updateItemContent(item, newTitle));
      }
    },
    [stateManager, item, boardModifiers, path, isStatic]
  );

  const onBlur = useCallback(() => {
    if (stateManager.getSetting('clickOutsideCardToSaveEdit')) {
      if (isCardEditingState(editState) && editState.id === item.id) {
        setEditState(EditingProcessState.complete);
      }
    }
  }, [stateManager, editState, item.id, setEditState]);

  const editCoordinates = isEditCoordinates(editState) ? editState : undefined;

  const showCardTitleEditor = isCardEditingState(editState) && editState.id === item.id;

  if (showCardTitleEditor) {
    return (
      <div className={c('item-content-wrapper')} style={isStatic ? { cursor: 'default' } : {}}>
        <MarkdownEditor
          editState={editCoordinates}
          className={c('item-input')}
          value={item.data.titleRaw}
          onChange={(update) => {
            if (update.docChanged) {
              titleRef.current = update.state.doc.toString();
            }
          }}
          onBlur={onBlur}
          onEnter={onEnter}
          onEscape={onEscape}
          onSubmit={onSubmit}
          autoFocus
          compact={false}
        />
      </div>
    );
  }

  return (
    <div onClick={onWrapperClick} className={c('item-title')}>
      {isStatic ? (
        <MarkdownClonedPreviewRenderer
          entityId={item.id}
          className={c('item-markdown')}
          markdownString={item.data.title}
          searchQuery={searchQuery}
          onPointerUp={onCheckboxContainerClick}
        />
      ) : (
        <MarkdownRenderer
          entityId={item.id}
          className={c('item-markdown')}
          markdownString={item.data.title}
          searchQuery={searchQuery}
          onPointerUp={onCheckboxContainerClick}
        />
      )}
      {showMetadata && (
        <div className={c('item-metadata')}>
          <RelativeDate item={item} stateManager={stateManager} />
          <DateAndTime
            item={item}
            stateManager={stateManager}
            filePath={filePath}
            getDateColor={getDateColor}
          />
          <InlineMetadata item={item} stateManager={stateManager} />
          <Tags tags={item.data.metadata.tags} searchQuery={searchQuery} />
          <AssignedMembers
            assignedMembers={item.data.assignedMembers}
            searchQuery={searchQuery}
            teamMemberColors={teamMemberColors}
          />
        </div>
      )}
    </div>
  );
});
