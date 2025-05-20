import { EditorView } from '@codemirror/view';
import { JSX, memo } from 'preact/compat';
import {
  Dispatch,
  StateUpdater,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'preact/hooks';
import useOnclickOutside from 'react-cool-onclickoutside';
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
import {
  c,
  escapeRegExpStr,
  useGetDateColorFn,
  useGetTagColorFn,
  useGetTagSymbolFn,
} from '../helpers';
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
  style?: JSX.CSSProperties;
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

interface TagsProps {
  tags?: string[];
  searchQuery?: string;
  alwaysShow?: boolean;
  style?: JSX.CSSProperties;
}

export function Tags(props: TagsProps) {
  const { tags, searchQuery, alwaysShow, style } = props;
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
    <div className={c('item-tags')} style={style}>
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
    <div
      className={c('item-assigned-members')}
      style={{
        marginTop: '4px',
        display: 'flex',
        justifyContent: 'flex-end',
        flexWrap: 'wrap',
        gap: '0px',
        paddingRight: '0px',
        marginRight: '0px',
        position: 'relative',
        left: '2px',
      }}
    >
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
  style,
}: ItemContentProps) {
  const { stateManager, view, boardModifiers, filePath } = useContext(KanbanContext);
  const { onEditDate, onEditTime } = useDatePickers(item);
  const getDateColor = useGetDateColorFn(stateManager);
  const teamMemberColors: Record<string, TeamMemberColorConfig> =
    view.plugin.settings.teamMemberColors || {};

  const titleRef = useRef<string | null>(null);
  const path = useNestedEntityPath();

  const [titleForEditor, setTitleForEditor] = useState<string>('');
  const extractedPartsRef = useRef<{ tags: string[]; members: string[] } | null>(null);

  const editorWrapperRef = useOnclickOutside(
    () => {
      if (showCardTitleEditor && stateManager.getSetting('clickOutsideCardToSaveEdit')) {
        setEditState(EditingProcessState.complete);
      }
    },
    {
      // Options for useOnclickOutside
    }
  );

  const editCoordinates = isEditCoordinates(editState) ? editState : undefined;
  const showCardTitleEditor = !!editCoordinates;

  useEffect(() => {
    if (showCardTitleEditor) {
      const rawTitle = item.data.titleRaw;
      console.log('[ItemContent] Editing starts. Raw title:', JSON.stringify(rawTitle));

      const originalTagsFromMetadata = item.data.metadata?.tags || [];
      const originalMembersFromMetadata = item.data.assignedMembers || [];

      const tagStringsForRemoval = originalTagsFromMetadata.map((t) => `#${t.replace(/^#/, '')}`);
      const memberStringsForRemoval = originalMembersFromMetadata.map(
        (m) => `@@${m.replace(/^@@/, '')}`
      );

      let cleanTitle = rawTitle;

      for (const memberSyntax of memberStringsForRemoval) {
        const memberRegex = new RegExp(
          `(?:^|\\s)(${escapeRegExpStr(memberSyntax)})(?=\\s|$)`,
          'gi'
        );
        cleanTitle = cleanTitle.replace(memberRegex, ' ');
      }

      for (const tagSyntax of tagStringsForRemoval) {
        const tagRegex = new RegExp(`(?:^|\\s)(${escapeRegExpStr(tagSyntax)})(?=\\s|$)`, 'gi');
        cleanTitle = cleanTitle.replace(tagRegex, ' ');
      }

      cleanTitle = cleanTitle.replace(/ {2,}/g, ' ');
      cleanTitle = cleanTitle.trim();

      console.log('[ItemContent] Cleaned title for editor:', JSON.stringify(cleanTitle));

      setTitleForEditor(cleanTitle);
      extractedPartsRef.current = { tags: tagStringsForRemoval, members: memberStringsForRemoval };
      titleRef.current = cleanTitle;
    }
  }, [
    showCardTitleEditor,
    item.data.titleRaw,
    item.data.metadata?.tags,
    item.data.assignedMembers,
  ]);

  useEffect(() => {
    if (editState === EditingProcessState.complete) {
      if (titleRef.current !== null) {
        const userEditedCleanText = titleRef.current;

        const currentTags = item.data.metadata?.tags || [];
        const currentMembers = item.data.assignedMembers || [];

        let reconstructedTitle = userEditedCleanText;

        const tagStrings = currentTags.map((t) => `#${t.replace(/^#/, '')}`);
        const memberStrings = currentMembers.map((m) => `@@${m.replace(/^@@/, '')}`);

        const partsToAppend: string[] = [];
        if (tagStrings.length > 0) {
          partsToAppend.push(tagStrings.join(' '));
        }
        if (memberStrings.length > 0) {
          partsToAppend.push(memberStrings.join(' '));
        }

        if (partsToAppend.length > 0) {
          if (reconstructedTitle.length > 0 && !/\s$/.test(reconstructedTitle)) {
            reconstructedTitle += ' ';
          }
          reconstructedTitle += partsToAppend.join(' ');
        }

        reconstructedTitle = reconstructedTitle.trim();
        reconstructedTitle = reconstructedTitle.replace(/ {2,}/g, ' ');

        console.log('[ItemContent] Saving final title:', JSON.stringify(reconstructedTitle));
        boardModifiers.updateItem(path, stateManager.updateItemContent(item, reconstructedTitle));
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

  if (showCardTitleEditor) {
    return (
      <div
        ref={editorWrapperRef}
        className={c('item-content-editor-wrapper')}
        style={{ width: '100%' }}
      >
        <div className={c('item-content-wrapper')} style={isStatic ? { cursor: 'default' } : {}}>
          <MarkdownEditor
            editState={editCoordinates}
            className={c('item-input')}
            value={titleForEditor}
            onChange={(update) => {
              if (update.docChanged) {
                titleRef.current = update.state.doc.toString();
              }
            }}
            onEnter={onEnter}
            onEscape={onEscape}
            onSubmit={onSubmit}
          />
        </div>
      </div>
    );
  }

  return (
    <div
      ref={editorWrapperRef}
      className={c('item-content-wrapper')}
      style={{ ...(isStatic ? { cursor: 'default' } : {}), width: '100%', ...style }}
    >
      <div
        onPointerUp={onCheckboxContainerClick}
        className={c('item-text-wrapper')}
        style={{ width: '100%' }}
      >
        <MarkdownRenderer
          entityId={item.id}
          className={c('item-markdown')}
          markdownString={item.data.title}
          searchQuery={searchQuery}
        />
      </div>
      {!showCardTitleEditor && showMetadata && (
        <div className={c('item-metadata')} style={{ width: '100%' }}>
          <InlineMetadata item={item} stateManager={stateManager} />
          <DateAndTime
            item={item}
            stateManager={stateManager}
            filePath={filePath}
            getDateColor={getDateColor}
          />
          <RelativeDate item={item} stateManager={stateManager} />
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
