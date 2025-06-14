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

// Helper function to get initials from a name string
function getInitials(name: string): string {
  if (!name || typeof name !== 'string') return '';
  const parts = name.trim().split(/\s+/);
  if (parts.length > 0 && parts[0].length > 0) {
    return parts[0].charAt(0).toUpperCase();
  }
  return '';
}

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

  // Get the hide tag settings
  const hideLaneTagDisplay = stateManager.useSetting('hide-lane-tag-display');
  const hideBoardTagDisplay = stateManager.useSetting('hide-board-tag-display');

  if (!tags || !tags.length || !shouldShow) {
    return null;
  }

  // Filter out lane and board tags if the settings are enabled
  let filteredTags = tags;
  if (hideLaneTagDisplay || hideBoardTagDisplay) {
    const board = stateManager.state;
    const boardName = stateManager.file?.basename;

    filteredTags = tags.filter((tag) => {
      const tagWithoutHash = tag.replace(/^#/, '').toLowerCase();

      // Check if this is a board tag (matches board name)
      if (hideBoardTagDisplay && boardName) {
        const boardTagPattern = boardName.toLowerCase().replace(/\s+/g, '-');
        if (tagWithoutHash === boardTagPattern) {
          return false; // Hide this tag
        }
      }

      // Check if this is a lane tag
      if (hideLaneTagDisplay && board) {
        for (const lane of board.children) {
          const laneTagPattern = lane.data.title.toLowerCase().replace(/\s+/g, '-');
          if (tagWithoutHash === laneTagPattern) {
            return false; // Hide this tag
          }
        }
      }

      return true; // Show this tag
    });
  }

  return (
    <div className={c('item-tags')} style={style}>
      {filteredTags.map((originalTag, i) => {
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
        marginTop: '0px',
        display: 'flex',
        justifyContent: 'flex-end',
        flexWrap: 'wrap',
        gap: '0px',
        paddingRight: '0px',
        marginRight: '0px',
        // marginLeft: '4px',
        ...style,
      }}
    >
      {assignedMembers.map((member, i) => {
        const memberConfig = teamMemberColors?.[member];
        const backgroundColor = memberConfig?.background || 'var(--background-modifier-hover)';
        const textColor =
          memberConfig?.text ||
          (memberConfig?.background ? 'var(--text-on-accent)' : 'var(--text-normal)');
        const initials = getInitials(member);

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
          <div
            key={i}
            className={c('item-assigned-member-initials')}
            onClick={handleMemberClick}
            title={member}
            style={{
              backgroundColor,
              color: textColor,
              borderRadius: '50%',
              width: '18px',
              height: '18px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              marginLeft: '4px',
              fontSize: '12px',
              // fontWeight: 'bold',
              cursor: 'pointer',
              userSelect: 'none',
            }}
          >
            {initials}
          </div>
        );
      })}
    </div>
  );
}

function getCleanTitleForDisplay(titleRaw: string, stateManager: StateManager): string {
  if (!titleRaw) return '';

  let cleanTitle = titleRaw;

  // Remove priority tags
  const priorityRegex = /(?:^|\s)(!low|!medium|!high)(?=\s|$)/gi;
  cleanTitle = cleanTitle.replace(priorityRegex, ' ');

  // Remove member assignments
  const memberRegex = /(?:^|\s)(@@\w+)(?=\s|$)/gi;
  cleanTitle = cleanTitle.replace(memberRegex, ' ');

  // Remove tags
  const tagRegex = /(?:^|\s)(#\w+(?:\/\w+)*)(?=\s|$)/gi;
  cleanTitle = cleanTitle.replace(tagRegex, ' ');

  // Remove date triggers
  const dateTrigger = stateManager.getSetting('date-trigger');
  if (dateTrigger) {
    // Handle basic date trigger format: @{date}
    const dateBraceRegex = new RegExp(`(?:^|\\s)${escapeRegExpStr(dateTrigger)}{([^}]+)}`, 'gi');
    cleanTitle = cleanTitle.replace(dateBraceRegex, ' ');

    // Handle date trigger with wikilinks: @[[date]]
    const dateBracketRegex = new RegExp(
      `(?:^|\\s)${escapeRegExpStr(dateTrigger)}\\[\\[([^]]+)\\]\\]`,
      'gi'
    );
    cleanTitle = cleanTitle.replace(dateBracketRegex, ' ');

    // Handle date trigger with prefixes like @start{date}, @end{date}, etc.
    const dateWithPrefixBraceRegex = new RegExp(
      `(?:^|\\s)${escapeRegExpStr(dateTrigger)}\\w*{([^}]+)}`,
      'gi'
    );
    cleanTitle = cleanTitle.replace(dateWithPrefixBraceRegex, ' ');

    // Handle date trigger with prefixes and wikilinks like @start[[date]], @end[[date]], etc.
    const dateWithPrefixBracketRegex = new RegExp(
      `(?:^|\\s)${escapeRegExpStr(dateTrigger)}\\w*\\[\\[([^]]+)\\]\\]`,
      'gi'
    );
    cleanTitle = cleanTitle.replace(dateWithPrefixBracketRegex, ' ');
  }

  // Remove time triggers
  const timeTrigger = stateManager.getSetting('time-trigger');
  if (timeTrigger) {
    const timeRegex = new RegExp(`(?:^|\\s)${escapeRegExpStr(timeTrigger)}{([^}]+)}`, 'gi');
    cleanTitle = cleanTitle.replace(timeRegex, ' ');
  }

  // Clean up multiple spaces but preserve newlines
  cleanTitle = cleanTitle.replace(/[ \t]{2,}/g, ' ').trim();

  return cleanTitle;
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

  // Render start

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
    startDateStr?: string;
    priorityTag?: string | null;
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
      const rawTitle = safeTitleRaw;

      const originalTagsFromMetadata = item.data.metadata?.tags || [];
      const originalMembersFromMetadata = item.data.assignedMembers || [];
      const originalDateStr = item.data.metadata?.dateStr;
      const originalTimeStr = item.data.metadata?.timeStr;
      const originalStartDateStr = item.data.metadata?.startDateStr;

      // Capture and store priority tag
      const priorityRegexGlobal = /(?:^|\s)(!low|!medium|!high)(?=\s|$)/gi;
      const existingPriorityMatch = priorityRegexGlobal.exec(rawTitle);
      const capturedPriorityTag = existingPriorityMatch ? existingPriorityMatch[0].trim() : null;

      extractedPartsRef.current = {
        tags: [...originalTagsFromMetadata],
        members: [...originalMembersFromMetadata],
        dateStr: originalDateStr,
        timeStr: originalTimeStr,
        startDateStr: originalStartDateStr,
        priorityTag: capturedPriorityTag,
      };

      const tagStringsForRemoval = originalTagsFromMetadata.map((t) => `#${t.replace(/^#/, '')}`);
      const memberStringsForRemoval = originalMembersFromMetadata.map(
        (m) => `@@${m.replace(/^@@/, '')}`
      );

      let cleanTitle = rawTitle;

      // Remove priority tag first for cleaning
      if (capturedPriorityTag) {
        cleanTitle = cleanTitle.replace(priorityRegexGlobal, ' ').trim();
      }

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
        // Handle basic date trigger format: @{date}
        const dateBraceRegex = new RegExp(
          `(?:^|\\s)${escapeRegExpStr(dateTrigger)}{([^}]+)}`,
          'gi'
        );
        cleanTitle = cleanTitle.replace(dateBraceRegex, ' ');

        // Handle date trigger with wikilinks: @[[date]]
        const dateBracketRegex = new RegExp(
          `(?:^|\\s)${escapeRegExpStr(dateTrigger)}\\[\\[([^]]+)\\]\\]`,
          'gi'
        );
        cleanTitle = cleanTitle.replace(dateBracketRegex, ' ');

        // Handle date trigger with prefixes like @start{date}, @end{date}, etc.
        const dateWithPrefixBraceRegex = new RegExp(
          `(?:^|\\s)${escapeRegExpStr(dateTrigger)}\\w*{([^}]+)}`,
          'gi'
        );
        cleanTitle = cleanTitle.replace(dateWithPrefixBraceRegex, ' ');

        // Handle date trigger with prefixes and wikilinks like @start[[date]], @end[[date]], etc.
        const dateWithPrefixBracketRegex = new RegExp(
          `(?:^|\\s)${escapeRegExpStr(dateTrigger)}\\w*\\[\\[([^]]+)\\]\\]`,
          'gi'
        );
        cleanTitle = cleanTitle.replace(dateWithPrefixBracketRegex, ' ');
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
      setTitleForEditor(cleanTitle);
      titleRef.current = cleanTitle;
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

    if (currentEditStateProp === 1) {
      // Explicitly use 1 for EditingProcessState.Complete
      const workTitle = titleRef.current; // Capture current title for processing
      const capturedPriorityTagFromRef = extractedPartsRef.current?.priorityTag; // Capture priority tag BEFORE clearing refs

      titleRef.current = null; // Clear ref
      extractedPartsRef.current = null; // Also clear other extracted parts

      if (workTitle !== null) {
        let finalTitle = workTitle;

        // Re-accessing original parts from item.data for reconstruction
        const originalTagsFromMetadata = item.data.metadata?.tags || [];
        const originalMembersFromMetadata = item.data.assignedMembers || [];
        const originalDateStr = item.data.metadata?.dateStr;
        const originalTimeStr = item.data.metadata?.timeStr;
        const originalStartDateStr = item.data.metadata?.startDateStr;
        // capturedPriorityTagFromRef is already defined above

        const dateTrigger = stateManager.getSetting('date-trigger');
        const timeTrigger = stateManager.getSetting('time-trigger');
        const shouldLinkDateToDailyNote = stateManager.getSetting('link-date-to-daily-note');

        let addedSomething = false;

        // Helper function to add metadata while preserving newlines
        const addMetadata = (metadataString: string) => {
          if (finalTitle.length > 0) {
            // Check if the title ends with a newline or whitespace
            if (!/[\s\n]$/.test(finalTitle)) {
              finalTitle += ' ';
            }
          }
          finalTitle += metadataString;
          addedSomething = true;
        };

        // Add start date first if it exists
        if (originalStartDateStr) {
          const startDatePart = shouldLinkDateToDailyNote
            ? `[[${originalStartDateStr}]]`
            : `{${originalStartDateStr}}`;
          addMetadata(`${dateTrigger}start${startDatePart}`);
        }

        if (originalDateStr) {
          const datePart = shouldLinkDateToDailyNote
            ? `[[${originalDateStr}]]`
            : `{${originalDateStr}}`;
          addMetadata(`${dateTrigger}${datePart}`);
        }

        if (originalTimeStr && originalDateStr) {
          addMetadata(`${timeTrigger}{${originalTimeStr}}`);
        } else if (originalTimeStr && !originalDateStr) {
          addMetadata(`${timeTrigger}{${originalTimeStr}}`);
        }

        if (originalMembersFromMetadata && originalMembersFromMetadata.length > 0) {
          const membersString = originalMembersFromMetadata
            .map((m) => `@@${m.replace(/^@@/, '')}`)
            .join(' ');
          addMetadata(membersString);
        }

        if (originalTagsFromMetadata && originalTagsFromMetadata.length > 0) {
          const tagsString = originalTagsFromMetadata.join(' ');
          addMetadata(tagsString);
        }

        // Re-append priority tag if it was captured
        if (capturedPriorityTagFromRef) {
          addMetadata(capturedPriorityTagFromRef);
        }

        // Clean up multiple spaces but preserve newlines
        finalTitle = finalTitle.replace(/[ \t]{2,}/g, ' ').trim();

        if (finalTitle !== safeTitleRaw || !item.data.blockId) {
          boardModifiers.updateItem(path, stateManager.updateItemContent(item, finalTitle));
        }
      }
      // Always transition out of edit mode if state was 'complete'
      setEditState(false);
    } else if (currentEditStateProp === 2) {
      // Explicitly use 2 for EditingProcessState.Cancel
      setEditState(false);
      titleRef.current = null;
      extractedPartsRef.current = null;
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
          markdownString={getCleanTitleForDisplay(safeTitleRaw, stateManager)}
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

  return criticalPropsSame;
}

export const ItemContent = memo(ItemContentComponent, areItemPropsEqual);
