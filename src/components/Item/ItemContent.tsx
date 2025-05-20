import { EditorView } from '@codemirror/view';
import moment from 'moment';
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
  ItemData,
  KanbanSettings,
  TeamMemberColorConfig,
  isCardEditingState,
  isEditCoordinates,
  isEditingActive,
} from '../types';
import { DateAndTime, RelativeDate } from './DateAndTime';
import { InlineMetadata } from './InlineMetadata';
import { MetadataTable } from './MetadataTable';
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
  style?: JSX.CSSProperties;
}

export function AssignedMembers({
  assignedMembers,
  searchQuery,
  teamMemberColors,
  style,
}: AssignedMembersProps) {
  const { stateManager } = useContext(KanbanContext);
  const search = useContext(SearchContext);
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
        ...style,
      }}
    >
      {assignedMembers.map((member, i) => {
        const memberConfig = teamMemberColors?.[member];
        const backgroundColor = memberConfig?.background || 'var(--background-modifier-hover)';
        const textColor =
          memberConfig?.text ||
          (memberConfig?.background ? 'var(--text-on-accent)' : 'var(--text-normal)');

        const handleMemberClick = (e: MouseEvent) => {
          e.preventDefault();
          const memberAction = stateManager.getSetting('tag-action');
          const searchQueryTerm = `@@${member}`;

          if (search && memberAction === 'kanban') {
            search.search(searchQueryTerm, true);
            return;
          }

          (stateManager.app as any).internalPlugins
            .getPluginById('global-search')
            .instance.openGlobalSearch(searchQueryTerm);
        };

        return (
          <span
            onClick={handleMemberClick}
            key={i}
            className={`${c('item-assigned-member')} ${
              searchQuery && member.toLocaleLowerCase().contains(searchQuery)
                ? 'is-search-match'
                : ''
            }`}
            style={{
              cursor: 'pointer',
              backgroundColor: backgroundColor,
              color: textColor,
              padding: '1px 5px',
              marginLeft: '0.2em',
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

const ItemContentComponent = function ItemContent({
  item,
  editState,
  setEditState,
  searchQuery,
  showMetadata = true,
  isStatic,
  targetHighlight,
  style,
}: ItemContentProps) {
  const path = useNestedEntityPath();

  // Critical check for item and item.data at the very beginning
  if (!item || !item.data) {
    const itemId = item?.id || 'unknown';
    console.error(
      `[ItemContent] CRITICAL: item or item.data is undefined for item ID: ${itemId}. Path:`,
      path,
      'Item object:',
      item
    );
    // Render nothing or a minimal error placeholder to prevent crashes
    return null;
  }

  // Additional checks for item.data.title and item.data.titleRaw
  let safeTitle = item.data.title;
  let safeTitleRaw = item.data.titleRaw;

  if (typeof item.data.title !== 'string') {
    console.error(
      `[ItemContent] CRITICAL: item.data.title is not a string for item ID: ${item.id}. Type: ${typeof item.data.title}. Value:`,
      item.data.title,
      '. Using empty string fallback.'
    );
    safeTitle = '';
  }
  if (typeof item.data.titleRaw !== 'string') {
    console.error(
      `[ItemContent] CRITICAL: item.data.titleRaw is not a string for item ID: ${item.id}. Type: ${typeof item.data.titleRaw}. Value:`,
      item.data.titleRaw,
      '. Using empty string fallback.'
    );
    safeTitleRaw = '';
  }

  // USEITEMCONTENT LOG
  console.log(
    `[ItemContent ${item.id}] Render START. EditState: ${editState}, TitleRaw (safe): ${JSON.stringify(safeTitleRaw?.slice(0, 20))}`
  );

  const { stateManager, view, boardModifiers, filePath } = useContext(KanbanContext);
  const { onEditDate, onEditTime } = useDatePickers(item);
  const getDateColor = useGetDateColorFn(stateManager);
  const teamMemberColors: Record<string, TeamMemberColorConfig> =
    view.plugin.settings.teamMemberColors || {};

  const titleRef = useRef<string | null>(null);

  const [titleForEditor, setTitleForEditor] = useState<string>('');
  const extractedPartsRef = useRef<{
    tags: string[];
    members: string[];
    dateStr?: string;
    timeStr?: string;
  } | null>(null);

  const editorWrapperRef = useOnclickOutside(
    () => {
      if (showCardTitleEditor && stateManager.getSetting('clickOutsideCardToSaveEdit')) {
        setEditState(EditingProcessState.Complete);
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
      console.log(
        `[ItemContent ${item.id}] EditorSetupEffect RUN. showCardTitleEditor: ${showCardTitleEditor}, Current titleForEditor: "${titleForEditor}"`
      );
      const rawTitle = safeTitleRaw;
      console.log('[ItemContent] Editing starts. Raw title (safe):', JSON.stringify(rawTitle));

      const originalTagsFromMetadata = item.data.metadata?.tags || [];
      const originalMembersFromMetadata = item.data.assignedMembers || [];
      const originalDateStr = item.data.metadata?.dateStr;
      const originalTimeStr = item.data.metadata?.timeStr;

      extractedPartsRef.current = {
        tags: [...originalTagsFromMetadata],
        members: [...originalMembersFromMetadata],
        dateStr: originalDateStr,
        timeStr: originalTimeStr,
      };

      const tagStringsForRemoval = originalTagsFromMetadata.map((t) => `#${t.replace(/^#/, '')}`);
      const memberStringsForRemoval = originalMembersFromMetadata.map(
        (m) => `@@${m.replace(/^@@/, '')}`
      );

      let cleanTitle = rawTitle;

      for (const memberSyntax of memberStringsForRemoval) {
        const memberRegex = new RegExp(escapeRegExpStr(memberSyntax), 'gi');
        cleanTitle = cleanTitle.replace(memberRegex, ' ');
      }

      for (const tagSyntax of tagStringsForRemoval) {
        const tagRegex = new RegExp(escapeRegExpStr(tagSyntax), 'gi');
        cleanTitle = cleanTitle.replace(tagRegex, ' ');
      }

      const dateTrigger = stateManager.getSetting('date-trigger');
      const dateFormat = stateManager.getSetting('date-format');

      if (dateTrigger) {
        const dateBraceRegex = new RegExp(
          `(?:^|\\s)${escapeRegExpStr(dateTrigger)}{([^}]+)}`,
          'gi'
        );
        cleanTitle = cleanTitle.replace(dateBraceRegex, ' ');

        const dateBracketRegex = new RegExp(
          `(?:^|\\s)${escapeRegExpStr(dateTrigger)}\\[\\[([^]]+)\\]\\]`,
          'gi'
        );
        cleanTitle = cleanTitle.replace(dateBracketRegex, ' ');
      }

      const wikilinkDateRegex = /\[\[([^\]]+)\]\]/g;
      let match;
      const tempTitleForWikilinkStripping = cleanTitle;
      const rangesToReplace: { start: number; end: number }[] = [];

      while ((match = wikilinkDateRegex.exec(tempTitleForWikilinkStripping)) !== null) {
        const potentialDateStr = match[1].trim();
        if (dateFormat && moment(potentialDateStr, dateFormat, true).isValid()) {
          rangesToReplace.push({ start: match.index, end: wikilinkDateRegex.lastIndex });
        }
      }

      for (let i = rangesToReplace.length - 1; i >= 0; i--) {
        const range = rangesToReplace[i];
        cleanTitle = cleanTitle.substring(0, range.start) + ' ' + cleanTitle.substring(range.end);
      }

      cleanTitle = cleanTitle.replace(/\\s{2,}/g, ' ').trim();
      console.log('[ItemContent] Clean title for editor:', JSON.stringify(cleanTitle));
      setTitleForEditor(cleanTitle);
      titleRef.current = cleanTitle;
      console.log(
        `[ItemContent ${item.id}] EditorSetupEffect END. titleForEditor set to: "${cleanTitle}", titleRef.current set to: "${titleRef.current}"`
      );
    }
  }, [
    showCardTitleEditor,
    item.data.titleRaw,
    item.data.metadata,
    item.data.assignedMembers,
    stateManager,
  ]);

  useEffect(() => {
    const currentEditStateProp = editState; // Capture prop value at effect run time
    console.log(
      `[ItemContent ${item.id}] SaveEffect TRIGGERED. Captured editStateProp: ${JSON.stringify(currentEditStateProp)} (type: ${typeof currentEditStateProp})` +
        `, Compared against Complete: 1, Cancel: 2`
    );

    if (currentEditStateProp === 1) {
      // Explicitly use 1 for EditingProcessState.Complete
      console.log(
        `[ItemContent ${item.id}] SaveEffect RUN COMPLETE. Matched editState: ${JSON.stringify(currentEditStateProp)}, titleRef.current: ${JSON.stringify(titleRef.current)}, extractedPartsRef.current: ${JSON.stringify(extractedPartsRef.current)}`
      );
      const workTitle = titleRef.current; // Capture current title for processing
      titleRef.current = null; // Clear ref immediately to prevent re-entry for this specific edit cycle
      extractedPartsRef.current = null; // Also clear other extracted parts

      if (workTitle !== null) {
        console.log('[ItemContent] Submission: User edited clean text:', JSON.stringify(workTitle));

        let finalTitle = workTitle;

        // Re-accessing original parts from item.data for reconstruction
        // This assumes that item.data (passed as prop) reflects the state *before* this current edit's title change.
        const originalTagsFromMetadata = item.data.metadata?.tags || [];
        const originalMembersFromMetadata = item.data.assignedMembers || [];
        const originalDateStr = item.data.metadata?.dateStr;
        const originalTimeStr = item.data.metadata?.timeStr;

        console.log(
          '[ItemContent] Reconstructing from item.data.metadata. Extracted Parts estimate:',
          JSON.stringify({
            tags: originalTagsFromMetadata,
            members: originalMembersFromMetadata,
            dateStr: originalDateStr,
            timeStr: originalTimeStr,
          })
        );

        const dateTrigger = stateManager.getSetting('date-trigger');
        const timeTrigger = stateManager.getSetting('time-trigger');
        const shouldLinkDateToDailyNote = stateManager.getSetting('link-date-to-daily-note');

        let addedSomething = false;

        if (originalDateStr) {
          console.log('[ItemContent] Reconstructing: Adding date', originalDateStr);
          const datePart = shouldLinkDateToDailyNote
            ? `[[${originalDateStr}]]`
            : `{${originalDateStr}}`;
          if (finalTitle.length > 0 && !/\s$/.test(finalTitle) && !addedSomething)
            finalTitle += ' ';
          else if (addedSomething) finalTitle += ' ';
          finalTitle += `${dateTrigger}${datePart}`;
          addedSomething = true;
        }

        if (originalTimeStr && originalDateStr) {
          console.log('[ItemContent] Reconstructing: Adding time (with date)', originalTimeStr);
          if (finalTitle.length > 0 && !/\s$/.test(finalTitle) && !addedSomething)
            finalTitle += ' ';
          else if (addedSomething) finalTitle += ' ';
          finalTitle += `${timeTrigger}{${originalTimeStr}}`;
          addedSomething = true;
        } else if (originalTimeStr && !originalDateStr) {
          console.log('[ItemContent] Reconstructing: Adding time (standalone)', originalTimeStr);
          if (finalTitle.length > 0 && !/\s$/.test(finalTitle) && !addedSomething)
            finalTitle += ' ';
          else if (addedSomething) finalTitle += ' ';
          finalTitle += `${timeTrigger}{${originalTimeStr}}`;
          addedSomething = true;
        }

        if (originalMembersFromMetadata && originalMembersFromMetadata.length > 0) {
          console.log('[ItemContent] Reconstructing: Adding members', originalMembersFromMetadata);
          const membersString = originalMembersFromMetadata
            .map((m) => `@@${m.replace(/^@@/, '')}`)
            .join(' ');
          if (finalTitle.length > 0 && !/\s$/.test(finalTitle) && !addedSomething)
            finalTitle += ' ';
          else if (addedSomething) finalTitle += ' ';
          finalTitle += membersString;
          addedSomething = true;
        }

        if (originalTagsFromMetadata && originalTagsFromMetadata.length > 0) {
          console.log('[ItemContent] Reconstructing: Adding tags', originalTagsFromMetadata);
          const tagsString = originalTagsFromMetadata.join(' ');
          if (finalTitle.length > 0 && !/\s$/.test(finalTitle) && !addedSomething)
            finalTitle += ' ';
          else if (addedSomething) finalTitle += ' ';
          finalTitle += tagsString;
          addedSomething = true;
        }

        finalTitle = finalTitle.replace(/\s{2,}/g, ' ').trim();

        console.log(
          `[ItemContent ${item.id}] SaveEffect: About to call updateItem. Current item.data.titleRaw (safe): "${safeTitleRaw}", New finalTitle: "${finalTitle}"`
        );

        if (finalTitle !== safeTitleRaw) {
          console.log(
            `[ItemContent ${item.id}] SaveEffect: Calling boardModifiers.updateItem. Path: ${JSON.stringify(path)}`
          );
          boardModifiers.updateItem(path, stateManager.updateItemContent(item, finalTitle));
        } else {
          console.log(
            `[ItemContent ${item.id}] SaveEffect: finalTitle is same as item.data.titleRaw, skipping updateItem.`
          );
        }
      } else {
        console.log(
          `[ItemContent ${item.id}] SaveEffect: workTitle is null, skipping update logic.`
        );
      }
      // Always transition out of edit mode if state was 'complete'
      setEditState(false);
      console.log(`[ItemContent ${item.id}] SaveEffect COMPLETE END. Set editState to false.`);
    } else if (currentEditStateProp === 2) {
      // Explicitly use 2 for EditingProcessState.Cancel
      console.log(
        `[ItemContent ${item.id}] SaveEffect RUN CANCEL. Matched editState: ${JSON.stringify(currentEditStateProp)}`
      );
      setEditState(false);
      titleRef.current = null;
      extractedPartsRef.current = null;
      console.log(`[ItemContent ${item.id}] SaveEffect CANCEL END. Set editState to false.`);
    }
  }, [editState, boardModifiers, item, path, stateManager, setEditState]);

  const onEnter = useCallback(
    (cm: EditorView, mod: boolean, shift: boolean) => {
      if (!allowNewLine(stateManager, mod, shift)) {
        setEditState(EditingProcessState.Complete);
        return true;
      }
      return false;
    },
    [stateManager, setEditState]
  );

  const onEscape = useCallback(() => {
    setEditState(EditingProcessState.Cancel);
    return true;
  }, [setEditState]);

  const onSubmit = useCallback(() => {
    setEditState(EditingProcessState.Complete);
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
        style={{ width: '100%', display: 'block' }}
      >
        <MarkdownRenderer
          entityId={item.id}
          className={c('item-markdown')}
          markdownString={safeTitle}
          searchQuery={searchQuery}
        />
      </div>
      {!showCardTitleEditor && showMetadata && (
        <div className={c('item-metadata')} style={{ width: '100%', display: 'block' }}>
          <InlineMetadata item={item} stateManager={stateManager} />
        </div>
      )}
    </div>
  );
};

function areItemPropsEqual(prevProps: ItemContentProps, nextProps: ItemContentProps): boolean {
  // USEITEMCONTENTMEMO LOG
  console.log(
    `[ItemContentMemo] Comparing props for item ${nextProps.item.id}. Prev titleRaw (safe): "${prevProps.item.data.titleRaw && typeof prevProps.item.data.titleRaw === 'string' ? prevProps.item.data.titleRaw.slice(0, 25) : '[INVALID_PREV_RAW_TITLE]'}", Next titleRaw (safe): "${nextProps.item.data.titleRaw && typeof nextProps.item.data.titleRaw === 'string' ? nextProps.item.data.titleRaw.slice(0, 25) : '[INVALID_NEXT_RAW_TITLE]'}"`
  );

  const prevItemData = prevProps.item.data;
  const nextItemData = nextProps.item.data;

  const idSame = prevProps.item.id === nextProps.item.id;
  const titleRawSame = prevItemData.titleRaw === nextItemData.titleRaw;
  const metadataRefSame = prevItemData.metadata === nextItemData.metadata;
  const assignedMembersRefSame = prevItemData.assignedMembers === nextItemData.assignedMembers;
  const itemInstanceSame = prevProps.item === nextProps.item;

  // If the item object instance itself is the same, we consider its data basically the same
  // for the purpose of this shallow-ish comparison. Deeper changes within item.data
  // (if item instance is same) should ideally be handled by memoization of child components
  // or specific checks if necessary.
  // If the item instance has changed, we must verify key data points.
  const itemDataBasicallySame =
    itemInstanceSame || (idSame && titleRawSame && metadataRefSame && assignedMembersRefSame);

  const editStateSame = prevProps.editState === nextProps.editState;
  const searchQuerySame = prevProps.searchQuery === nextProps.searchQuery;
  const showMetadataSame = prevProps.showMetadata === nextProps.showMetadata;
  const isStaticSame = prevProps.isStatic === nextProps.isStatic;
  const targetHighlightSame = prevProps.targetHighlight === nextProps.targetHighlight;

  const criticalPropsSame =
    itemDataBasicallySame &&
    editStateSame &&
    searchQuerySame &&
    showMetadataSame &&
    isStaticSame &&
    targetHighlightSame;

  if (!criticalPropsSame) {
    console.log(`[ItemContentMemo] সিদ্ধান্ত Re-rendering item ${nextProps.item.id}. Reason:`);
    if (!itemDataBasicallySame) {
      console.log('  - itemDataBasicallySame: false');
      if (itemInstanceSame) {
        // This case implies item instance is same, but some other check made itemDataBasicallySame false (should not happen with current logic)
        console.log(
          '    - item prop instance IS THE SAME, but itemDataBasicallySame is false (logical error in checks?).'
        );
      } else {
        console.log('    - item prop instance changed.');
      }
      if (!idSame) console.log('    - item.id changed.');
      if (!titleRawSame) {
        console.log('    - item.data.titleRaw changed.');
        // console.log(`      Prev: "${prevItemData.titleRaw}"`);
        // console.log(`      Next: "${nextItemData.titleRaw}"`);
      }
      if (!metadataRefSame) console.log('    - item.data.metadata reference changed.');
      if (!assignedMembersRefSame)
        console.log('    - item.data.assignedMembers reference changed.');
    }
    if (!editStateSame)
      console.log(
        `  - editState changed (prev: ${prevProps.editState}, next: ${nextProps.editState})`
      );
    if (!searchQuerySame)
      console.log(
        `  - searchQuery changed (prev: ${prevProps.searchQuery}, next: ${nextProps.searchQuery})`
      );
    if (!showMetadataSame)
      console.log(
        `  - showMetadata changed (prev: ${prevProps.showMetadata}, next: ${nextProps.showMetadata})`
      );
    if (!isStaticSame)
      console.log(
        `  - isStatic changed (prev: ${prevProps.isStatic}, next: ${nextProps.isStatic})`
      );
    if (!targetHighlightSame)
      console.log(
        `  - targetHighlight changed (prev: ${JSON.stringify(prevProps.targetHighlight)}, next: ${JSON.stringify(nextProps.targetHighlight)})`
      );
    return false; // Props are not equal, re-render
  } else {
    // console.log(`[ItemContentMemo] Skipping re-render for item ${nextProps.item.id}`);
    return true; // Props are equal, skip re-render
  }
}

export const ItemContent = memo(ItemContentComponent, areItemPropsEqual);
