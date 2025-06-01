// May need to move/share this
// import { MdastHeading, MdastList, MdastListItem, MdastRoot } from 'mdast'; // Removed due to import errors
import moment from 'moment';
import { App, TFile, TFolder, WorkspaceLeaf } from 'obsidian';
import { Fragment, createElement } from 'preact';
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { KanbanView, kanbanViewType } from 'src/KanbanView';
// Assuming this is the correct type for props.view
import { DEFAULT_SETTINGS, KanbanSettings } from 'src/Settings';
import { updateCardDatesInMarkdown } from 'src/markdownUpdater';

import { getHeadingText } from '../../KanbanWorkspaceView';
import { InteractiveMarkdownCell } from '../../KanbanWorkspaceView';
import { StateManager } from '../../StateManager';
import { hasFrontmatterKey } from '../../helpers';
import KanbanPlugin from '../../main';
// Assuming this path and file are correct
import { listItemToItemData } from '../../parsers/formats/list';
// Assuming ItemMetadata will have startDate
import { parseMarkdown } from '../../parsers/parseMarkdown';
// Import helper functions for tags and members - CORRECTED PATH
import { getTagColorFn, getTagSymbolFn } from '../helpers';
import { TimelineCardData as ImportedTimelineCardData, ItemData, ItemMetadata } from '../types';

// Renamed imported TimelineCardData

// Local TimelineCardData definition
export interface TimelineCardData {
  id: string;
  title: string;
  titleRaw: string;
  sourceBoardName: string;
  sourceBoardPath: string;
  blockId?: string;
  startDate?: moment.Moment;
  dueDate?: moment.Moment;
  checked?: boolean;
  laneColor?: string;
  sourceLaneTitle?: string;
  tags?: string[];
  assignedMembers?: string[];
}

interface TimelineViewComponentProps {
  plugin: KanbanPlugin;
  app: App; // Added app
  view: KanbanView; // Added view (adjust type if KanbanView is not correct for TimelineView context)
  // Add other props like viewEvents, refreshViewHeader, view instance if needed
}

// const DAY_WIDTH_PX = 50; // Width of one day column - REMOVED
const ROW_GAP_PX = 5;
const TIMELINE_HEADER_HEIGHT_PX = 50; // Increased for better date display

// Helper function to escape string for regex
function escapeRegExp(string: string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // $& means the whole matched string
}

export function TimelineViewComponent(props: TimelineViewComponentProps) {
  const [cards, setCards] = useState<TimelineCardData[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isMounted = useRef(true);

  // Access DAY_WIDTH_PX from settings
  const DAY_WIDTH_PX =
    props.plugin.settings.timelineDayWidth || DEFAULT_SETTINGS.timelineDayWidth || 50;
  // Access CARD_HEIGHT_PX from settings
  const CARD_HEIGHT_PX =
    props.plugin.settings.timelineCardHeight || DEFAULT_SETTINGS.timelineCardHeight || 40;

  const [timelineStartDate, setTimelineStartDate] = useState<moment.Moment | null>(null);
  const [timelineEndDate, setTimelineEndDate] = useState<moment.Moment | null>(null);
  const timelineGridRef = useRef<HTMLDivElement>(null); // Ref for the timeline grid
  const cardElementRefs = useRef<(HTMLDivElement | null)[]>([]); // Refs for individual card elements
  const [actualTotalTimelineHeight, setActualTotalTimelineHeight] = useState(
    TIMELINE_HEADER_HEIGHT_PX + ROW_GAP_PX * 2
  );

  // Get tag and member display settings
  const getTagColor = useMemo(
    () => getTagColorFn(props.plugin.settings['tag-colors'] || []),
    [props.plugin.settings]
  );
  const getTagSymbol = useMemo(
    () => getTagSymbolFn(props.plugin.settings['tag-symbols'] || []),
    [props.plugin.settings]
  );
  const teamMemberColors = useMemo(
    () => props.plugin.settings.teamMemberColors || {},
    [props.plugin.settings]
  );
  const hideHashForTagsWithoutSymbols =
    props.plugin.settings.hideHashForTagsWithoutSymbols ??
    DEFAULT_SETTINGS.hideHashForTagsWithoutSymbols;

  // Moved scanCards definition before useEffect hooks that use it
  const scanCards = useCallback(async () => {
    console.log('[TimelineView] Starting scanCards...');
    if (!isMounted.current) return;
    setIsLoading(true);
    setError(null);

    // Defensive check for props.view and props.app (props.view.file is not relevant for a global timeline)
    if (!props.view || !props.app) {
      // Removed props.view.file check
      console.warn(
        '[TimelineView] View or App not available in scanCards. props.view:',
        props.view,
        'props.app:',
        props.app
      );
      setCards([]);
      setIsLoading(false);
      setError('Timeline data cannot be loaded: view or app context is missing.');
      return;
    }
    // Removed the check for props.app.vault.getAbstractFileByPath(props.view.file.path)
    // as props.view.file is not used and not relevant for a global timeline.

    const app = props.plugin.app; // or directly props.app, ensure consistency
    const allFetchedCards: TimelineCardData[] = [];
    let minDate: moment.Moment | null = null;
    let maxDate: moment.Moment | null = null;

    try {
      const targetFolder = app.vault.getRoot();
      const allMdFiles = await recursivelyGetAllMdFilesInFolder(targetFolder);
      console.log(`[TimelineView] Found ${allMdFiles.length} MD files to scan.`);

      for (const mdFile of allMdFiles) {
        try {
          const fileContent = await props.plugin.app.vault.cachedRead(mdFile);
          const tempStateManager = new StateManager(
            props.plugin.app,
            { file: mdFile } as any,
            () => {},
            () => props.plugin.settings
          );
          // Capture the full result from parseMarkdown
          const parsedResult = parseMarkdown(tempStateManager, fileContent) as {
            ast: any; // Adjust 'any' to a more specific mdast type if available/known
            settings: any; // Adjust 'any' to KanbanSettings if appropriate
          };
          console.log(
            `[TimelineView] DEBUG: After parseMarkdown for ${mdFile.path}. parsedResult exists: ${!!parsedResult}, settings exists: ${!!parsedResult?.settings}`
          );

          // Log the value being checked for board identification
          const kanbanPluginSetting = parsedResult?.settings?.['kanban-plugin'];
          console.log(
            `[TimelineView] File: ${mdFile.path}, kanban-plugin setting: "${kanbanPluginSetting}" (Type: ${typeof kanbanPluginSetting})`
          );

          // Check if the parsed file is a Kanban board based on its settings
          if (parsedResult && parsedResult.settings && kanbanPluginSetting === 'board') {
            console.log(
              `[TimelineView] File ${mdFile.path} identified as a Kanban board. Processing for timeline cards.`
            );
            const ast = parsedResult.ast; // Use the AST from the parsed result

            // Existing logic for processing ast.children (headings, colors, lists) starts here
            console.log(
              `[TimelineView] Processing AST for ${mdFile.path}. Number of root children: ${ast.children.length}`
            );
            let currentLaneColor: string | undefined = undefined;
            let currentLaneTitle: string | undefined = undefined;

            for (const astNode of ast.children) {
              console.log(`[TimelineView] AST Node: type=${astNode.type}`);
              if (astNode.type === 'heading') {
                currentLaneColor = undefined;
                currentLaneTitle = getHeadingText(astNode as any);
                console.log(
                  `[TimelineView] Encountered heading: "${currentLaneTitle}". Reset color. Searching for color comment...`
                );
                const headingIndex = ast.children.indexOf(astNode);
                for (let i = headingIndex + 1; i < ast.children.length; i++) {
                  const nextNode = ast.children[i];
                  console.log(
                    `[TimelineView]  Sub-check for color: nextNode type=${nextNode.type}, index=${i}`
                  );
                  if (nextNode.type === 'html') {
                    const htmlContent = nextNode.value as string;
                    console.log(`[TimelineView]    HTML node content: "${htmlContent}"`);
                    const colorCommentRegex =
                      /<!--\s*kanban-lane-background-color:\s*(#[0-9a-fA-F]{6}|[a-zA-Z]+)\s*-->/i;
                    const colorMatch = colorCommentRegex.exec(htmlContent);
                    if (colorMatch && colorMatch[1]) {
                      currentLaneColor = colorMatch[1].trim();
                      console.log(
                        `[TimelineView]    Found and set lane color: ${currentLaneColor}`
                      );
                      break;
                    } else {
                      console.log(`[TimelineView]    HTML node did not match color regex.`);
                    }
                  } else if (nextNode.type === 'list' || nextNode.type === 'heading') {
                    console.log(
                      `[TimelineView]  Stopping color search for current heading; encountered ${nextNode.type}.`
                    );
                    break;
                  }
                }
                if (!currentLaneColor) {
                  console.log(`[TimelineView] No color comment found for the preceding heading.`);
                }
              }
              if (astNode.type === 'list') {
                console.log(
                  `[TimelineView] Processing list. Active lane color for this list: ${currentLaneColor}`
                );
                for (const listItemNode of (astNode as any).children) {
                  if (listItemNode.type === 'listItem') {
                    const itemData: ItemData = listItemToItemData(
                      tempStateManager,
                      fileContent,
                      listItemNode as any
                    );
                    if (itemData.checked) {
                      continue;
                    }
                    let cardStartDate: moment.Moment | null = null;
                    let cardDueDate: moment.Moment | null = null;
                    const globalDateFormat = tempStateManager.getSetting('date-format');
                    const startDateUserFormat =
                      (props.plugin.settings as any)['start-date-format'] || globalDateFormat;
                    const startDateTriggerSetting =
                      (props.plugin.settings as any)['start-date-trigger'] || '@start{';
                    const startDatePrefix = startDateTriggerSetting.substring(
                      0,
                      startDateTriggerSetting.indexOf('{') > -1
                        ? startDateTriggerSetting.indexOf('{')
                        : startDateTriggerSetting.length
                    );
                    const metadata = itemData.metadata;
                    if (metadata?.startDateStr) {
                      const d = moment(metadata.startDateStr, startDateUserFormat);
                      if (d.isValid()) cardStartDate = d;
                    }
                    if (
                      !cardStartDate &&
                      moment.isMoment(metadata?.startDate) &&
                      metadata.startDate.isValid()
                    ) {
                      cardStartDate = metadata.startDate.clone();
                    }
                    if (metadata?.dateStr) {
                      const d = moment(metadata.dateStr, globalDateFormat);
                      if (d.isValid()) cardDueDate = d;
                    }
                    if (
                      !cardDueDate &&
                      moment.isMoment(metadata?.date) &&
                      metadata.date.isValid()
                    ) {
                      if (!itemData.titleRaw.includes(startDatePrefix)) {
                        cardDueDate = metadata.date.clone();
                      }
                    }
                    if (itemData.titleRaw.includes(startDatePrefix)) {
                      let potentialStartDateFromHeuristic: moment.Moment | null = null;
                      let potentialDueDateFromHeuristic: moment.Moment | null = null;
                      if (moment.isMoment(metadata?.date) && metadata.date.isValid()) {
                        potentialStartDateFromHeuristic = metadata.date.clone();
                      }
                      if (metadata?.dateStr) {
                        const d = moment(metadata.dateStr, globalDateFormat);
                        if (d.isValid()) {
                          potentialDueDateFromHeuristic = d;
                        }
                      }
                      const regexString = escapeRegExp(startDatePrefix) + '\\{' + '([^}]+)' + '\\}';
                      const correctStartDateRegexPattern = new RegExp(regexString);
                      const titleMatch = itemData.titleRaw.match(correctStartDateRegexPattern);
                      if (titleMatch && titleMatch[1]) {
                        const originalStartDateString = titleMatch[1];
                        const reparsedStartDateFromTitle = moment(
                          originalStartDateString,
                          startDateUserFormat
                        );
                        if (reparsedStartDateFromTitle.isValid()) {
                          if (
                            potentialStartDateFromHeuristic &&
                            potentialStartDateFromHeuristic.date() !==
                              reparsedStartDateFromTitle.date()
                          ) {
                            potentialStartDateFromHeuristic = reparsedStartDateFromTitle;
                          } else if (!potentialStartDateFromHeuristic) {
                            potentialStartDateFromHeuristic = reparsedStartDateFromTitle;
                          }
                        }
                      }
                      if (potentialStartDateFromHeuristic) {
                        if (!cardStartDate) {
                          cardStartDate = potentialStartDateFromHeuristic;
                          if (potentialDueDateFromHeuristic && !cardDueDate) {
                            cardDueDate = potentialDueDateFromHeuristic;
                          }
                        } else {
                          // cardStartDate already exists, so we only potentially set cardDueDate
                          if (potentialDueDateFromHeuristic && !cardDueDate) {
                            cardDueDate = potentialDueDateFromHeuristic;
                          }
                        }
                      }
                    }
                    if (cardDueDate && cardDueDate.isValid()) {
                      if (!cardStartDate || !cardStartDate.isValid()) {
                        cardStartDate = cardDueDate.clone().startOf('day');
                      } else {
                        // Ensure startDate is not after dueDate if both are valid
                        if (cardStartDate.isAfter(cardDueDate)) {
                          cardStartDate = cardDueDate.clone().startOf('day');
                        }
                      }
                    } else {
                      // If cardDueDate is not valid, this card will be skipped anyway.
                      // cardStartDate will be whatever it was parsed as (or null).
                      // No further defaulting of cardStartDate is needed here for skipping purposes.
                    }

                    if (
                      cardDueDate &&
                      cardStartDate &&
                      cardStartDate.isValid() &&
                      cardDueDate.isValid()
                    ) {
                      const cardToPush: TimelineCardData = {
                        id:
                          itemData.blockId ||
                          `${mdFile.path}-${itemData.titleRaw.slice(0, 10)}-${Math.random()}`,
                        title: itemData.title,
                        titleRaw: itemData.titleRaw,
                        sourceBoardName: mdFile.basename,
                        sourceBoardPath: mdFile.path,
                        blockId: itemData.blockId,
                        startDate: cardStartDate.clone().startOf('day'),
                        dueDate: cardDueDate.clone().endOf('day'),
                        checked: itemData.checked,
                        laneColor: currentLaneColor,
                        sourceLaneTitle: currentLaneTitle,
                        tags: itemData.metadata?.tags,
                        assignedMembers: itemData.assignedMembers,
                      };
                      console.log(
                        `[TimelineView] Adding card: "${cardToPush.titleRaw.substring(0, 30)}...", assigned laneColor: ${cardToPush.laneColor}, File: ${mdFile.path}`
                      );
                      allFetchedCards.push(cardToPush);

                      if (!minDate || cardStartDate.isBefore(minDate)) {
                        minDate = cardStartDate.clone().startOf('day');
                      }
                      if (!maxDate || cardDueDate.isAfter(maxDate)) {
                        maxDate = cardDueDate.clone().endOf('day');
                      }
                    } else {
                      console.log(
                        `[TimelineView] Card SKIPPED due to invalid/missing dates: "${itemData.titleRaw.substring(0, 30)}...", File: ${mdFile.path}`
                      );
                    }
                  }
                }
              }
            }
            // End of existing logic for processing ast.children
          } else {
            // Optional: Log if a file was parsed but not identified as a Kanban board.
            // This might be noisy if there are many non-Kanban files.
            // console.log(`[TimelineView] File ${mdFile.path} is not a Kanban board or has no 'kanban-plugin: board' setting. Skipping for timeline.`);
          }
        } catch (parseError: any) {
          const errorMessage = parseError && parseError.message ? String(parseError.message) : '';
          if (
            parseError instanceof TypeError &&
            errorMessage.includes('Cannot convert undefined or null to object')
          ) {
            console.debug(
              `[TimelineView] Skipping file ${mdFile.path} due to TypeError during parsing (likely not a Kanban board or has minimal/no frontmatter).`
            );
          } else if (errorMessage.includes('Error parsing frontmatter')) {
            console.debug(
              `[TimelineView] Skipping file ${mdFile.path} due to frontmatter parsing issue (likely not a Kanban board).`
            );
          } else {
            console.error(
              `[TimelineView] Error processing file ${mdFile.path} (unexpected structure or issue):`,
              parseError
            );
          }
        }
      }
      if (isMounted.current) {
        allFetchedCards.sort((a, b) => {
          if (a.startDate && b.startDate) {
            return a.startDate.diff(b.startDate);
          }
          return 0;
        });
        setCards(allFetchedCards);
        if (allFetchedCards.length > 0 && minDate && maxDate) {
          setTimelineStartDate(minDate.clone().subtract(1, 'days'));
          setTimelineEndDate(maxDate.clone().add(1, 'days'));
        } else {
          setTimelineStartDate(moment().startOf('week'));
          setTimelineEndDate(moment().endOf('week'));
        }
      }
    } catch (e) {
      console.error('[TimelineView] Error scanning directory:', e);
      if (isMounted.current) setError(`Error scanning directory: ${(e as Error).message}`);
    }
    if (isMounted.current) setIsLoading(false);
    console.log('[TimelineView] Finished scanCards.');
  }, [props.plugin, props.app, props.view]); // Added props.app and props.view to dependencies

  // Corrected useEffect for initial scanCards call
  useEffect(() => {
    // Check if view and app are available before calling scanCards
    if (props.view && props.app) {
      scanCards();
    } else {
      console.warn('[TimelineView] Initial scanCards call skipped: view or app not yet available.');
      // Optionally set an error or loading state here if preferred
      setError('Timeline view not fully initialized. Cannot load card data yet.');
      setIsLoading(false);
    }
  }, [scanCards, props.view, props.app]); // Depend on scanCards, and also props.view/props.app to retry if they become available

  useEffect(() => {
    // Effect for setting up and tearing down the wheel event listener
    const handleWheelZoom = async (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        // metaKey for macOS
        e.preventDefault();

        let currentDayWidth =
          props.plugin.settings.timelineDayWidth || DEFAULT_SETTINGS.timelineDayWidth || 50;
        const zoomSensitivity = 5; // Adjust for faster/slower zoom

        if (e.deltaY < 0) {
          // Zooming in (scrolling up or pinching out)
          currentDayWidth += zoomSensitivity;
        } else {
          // Zooming out (scrolling down or pinching in)
          currentDayWidth -= zoomSensitivity;
        }

        const minDayWidth = 10;
        const maxDayWidth = 300;
        currentDayWidth = Math.max(minDayWidth, Math.min(maxDayWidth, currentDayWidth));

        if (props.plugin.settings.timelineDayWidth !== currentDayWidth) {
          props.plugin.settings.timelineDayWidth = currentDayWidth;
          await props.plugin.saveSettings();
          // The component will re-render because props.plugin.settings.timelineDayWidth changes,
          // which will update the DAY_WIDTH_PX constant at the top of the component.
        }
      }
    };

    const gridEl = timelineGridRef.current;
    if (gridEl) {
      gridEl.addEventListener('wheel', handleWheelZoom, { passive: false });
    }

    return () => {
      if (gridEl) {
        gridEl.removeEventListener('wheel', handleWheelZoom);
      }
    };
  }, [props.plugin, timelineGridRef]); // Rerun if plugin instance or grid ref changes

  useEffect(() => {
    isMounted.current = true;
    return () => {
      isMounted.current = false;
    };
  }, []);

  // useEffect to adjust card positions and total height dynamically
  useEffect(() => {
    if (
      isLoading ||
      !timelineGridRef.current ||
      cards.length === 0 ||
      !timelineStartDate ||
      !timelineEndDate
    ) {
      // If still loading, or no cards/grid, or timeline range not set, do nothing or reset height
      if (!isLoading && cards.length === 0) {
        setActualTotalTimelineHeight(TIMELINE_HEADER_HEIGHT_PX + ROW_GAP_PX * 2); // Minimal height
      }
      return;
    }

    let currentCumulativeTop = TIMELINE_HEADER_HEIGHT_PX + ROW_GAP_PX;
    let maxRowBottom = currentCumulativeTop;

    for (let i = 0; i < cards.length; i++) {
      const cardElement = cardElementRefs.current[i];
      if (cardElement) {
        // Ensure cardElement's display is not none, and it's part of the layout
        // This is important as offsetHeight would be 0 for hidden elements.
        // The cards are absolutely positioned, so this check is mainly about visibility.
        if (cardElement.style.display !== 'none') {
          cardElement.style.top = `${currentCumulativeTop}px`;
          currentCumulativeTop += cardElement.offsetHeight + ROW_GAP_PX;
          maxRowBottom = Math.max(maxRowBottom, currentCumulativeTop);
        }
      } else {
        // Fallback if ref is not yet available, use min height (CARD_HEIGHT_PX)
        // This scenario should be less common if refs are populated correctly during render.
        currentCumulativeTop += CARD_HEIGHT_PX + ROW_GAP_PX;
        maxRowBottom = Math.max(maxRowBottom, currentCumulativeTop);
      }
    }
    // Ensure the total height is at least the header height plus some padding
    setActualTotalTimelineHeight(
      Math.max(maxRowBottom, TIMELINE_HEADER_HEIGHT_PX + ROW_GAP_PX * 2)
    );
  }, [cards, isLoading, timelineStartDate, timelineEndDate, CARD_HEIGHT_PX, ROW_GAP_PX]); // Rerun if cards, loading state, or layout params change

  useEffect(() => {
    console.log(
      '[TimelineView] Timeline range updated: StartDate:',
      timelineStartDate?.format('YYYY-MM-DD'),
      'EndDate:',
      timelineEndDate?.format('YYYY-MM-DD')
    );
  }, [timelineStartDate, timelineEndDate]);

  // Drag and Drop Handlers
  const draggedItemData = useRef<{
    cardId: string;
    originalStartDate?: moment.Moment;
    originalDueDate?: moment.Moment;
    isResizingLeft?: boolean;
    isResizingRight?: boolean;
  } | null>(null);

  const handleDragStart = (
    e: DragEvent,
    cardId: string,
    isResizingLeft: boolean,
    isResizingRight: boolean
  ) => {
    if (!e.dataTransfer) return;
    e.dataTransfer.setData('text/plain', cardId);
    e.dataTransfer.effectAllowed = 'move';
    const card = cards.find((c) => c.id === cardId);
    if (card) {
      draggedItemData.current = {
        cardId,
        originalStartDate: card.startDate?.clone(),
        originalDueDate: card.dueDate?.clone(),
        isResizingLeft,
        isResizingRight,
      };
    }
    // console.log('[TimelineView] handleDragStart:', cardId, 'isResizingLeft:', isResizingLeft, 'isResizingRight:', isResizingRight, 'originalStart:', card?.startDate?.format('YYYY-MM-DD'), 'originalDue:', card?.dueDate?.format('YYYY-MM-DD'));
  };

  const handleDragOver = (e: DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = 'move';
    }
  };

  const handleDragEnd = () => {
    // console.log('[TimelineView] handleDragEnd, clearing draggedItemData');
    draggedItemData.current = null;
  };

  const handleDrop = async (e: DragEvent) => {
    e.preventDefault();
    if (
      !timelineStartDate ||
      !timelineGridRef.current ||
      !e.dataTransfer ||
      !draggedItemData.current
    )
      return;

    const { cardId, originalStartDate, originalDueDate, isResizingLeft, isResizingRight } =
      draggedItemData.current;
    const draggedCard = cards.find((c) => c.id === cardId);

    if (!draggedCard) {
      console.error('[TimelineView] Dragged card not found in state after drop.');
      draggedItemData.current = null; // Clear dragged item data
      return;
    }

    // Ensure original dates from draggedItemData are used if available, otherwise from card state (though they should match)
    const currentCardStartDate = originalStartDate || draggedCard.startDate;
    const currentCardDueDate = originalDueDate || draggedCard.dueDate;

    if (!currentCardStartDate || !currentCardDueDate) {
      console.error('[TimelineView] Dragged card is missing start or due date for drop handling.');
      draggedItemData.current = null; // Clear dragged item data
      return;
    }

    const timelineRect = timelineGridRef.current.getBoundingClientRect();
    const dropX = e.clientX - timelineRect.left;
    const dayIndexDroppedOn = Math.max(0, Math.floor(dropX / DAY_WIDTH_PX)); // Ensure non-negative index

    let newStartDate: moment.Moment;
    let newDueDate: moment.Moment;

    if (isResizingLeft) {
      // console.log('[TimelineView] Drop detected for RESIZING LEFT');
      newStartDate = timelineStartDate.clone().add(dayIndexDroppedOn, 'days').startOf('day');
      newDueDate = currentCardDueDate.clone(); // Due date does not change when resizing left

      // Ensure new start date is before the new due date
      if (newStartDate.isSameOrAfter(newDueDate)) {
        newStartDate = newDueDate.clone().subtract(1, 'day').startOf('day');
        // Additional check if newStartDate is still problematic (e.g., if due date was very early)
        if (newStartDate.isSameOrAfter(newDueDate)) {
          console.warn(
            '[TimelineView] Resize Left: Corrected start date is still problematic relative to due date. Due date might be too early or card duration too short.'
          );
          // Fallback: maintain original due date and set start date one day before, if possible
          // Or, revert to original dates if correction is impossible
          newStartDate = currentCardDueDate.clone().subtract(1, 'days').startOf('day');
          if (newStartDate.isSameOrAfter(currentCardDueDate)) {
            // If due date is today, start is yesterday.
            // If this still fails, it implies an issue with original due date or a 0-day duration attempt.
            // For now, this will proceed, but might need more robust handling.
            console.error(
              '[TimelineView] Resize Left: Cannot ensure start is before due after corrections.'
            );
          }
        }
      }
      // console.log(`[TimelineView] Resizing Left: Card '${draggedCard.title}' New Start: ${newStartDate.format('YYYY-MM-DD')}, Due (unchanged): ${newDueDate.format('YYYY-MM-DD')}`);
    } else if (isResizingRight) {
      // console.log('[TimelineView] Drop detected for RESIZING RIGHT');
      newStartDate = currentCardStartDate.clone(); // Start date does not change
      newDueDate = timelineStartDate.clone().add(dayIndexDroppedOn, 'days').endOf('day');

      // Ensure new due date is after the new start date
      if (newDueDate.isSameOrBefore(newStartDate)) {
        newDueDate = newStartDate.clone().add(1, 'day').endOf('day');
        // Additional check if newDueDate is still problematic
        if (newDueDate.isSameOrBefore(newStartDate)) {
          console.warn(
            '[TimelineView] Resize Right: Corrected due date is still problematic relative to start date. Start date might be too late or card duration too short.'
          );
          newDueDate = currentCardStartDate.clone().add(1, 'days').endOf('day');
          if (newDueDate.isSameOrBefore(currentCardStartDate)) {
            console.error(
              '[TimelineView] Resize Right: Cannot ensure due is after start after corrections.'
            );
          }
        }
      }
      // console.log(`[TimelineView] Resizing Right: Card '${draggedCard.title}' New Due: ${newDueDate.format('YYYY-MM-DD')}, Start (unchanged): ${newStartDate.format('YYYY-MM-DD')}`);
    } else {
      // Moving the whole card
      // console.log('[TimelineView] Drop detected for MOVING card');
      newStartDate = timelineStartDate.clone().add(dayIndexDroppedOn, 'days').startOf('day');
      const durationDays = currentCardDueDate.diff(currentCardStartDate, 'days');
      newDueDate = newStartDate.clone().add(Math.max(0, durationDays), 'days').endOf('day'); // Ensure duration is not negative
      // console.log(`[TimelineView] Moving Card: '${draggedCard.title}' New Start: ${newStartDate.format('YYYY-MM-DD')}, New Due: ${newDueDate.format('YYYY-MM-DD')}`);
    }

    // console.log(`[TimelineView] Card '${draggedCard.title}' (ID: ${draggedCard.id}) dropped. isResizingLeft: ${isResizingLeft}, isResizingRight: ${isResizingRight}. New Start: ${newStartDate.format(props.plugin.settings['date-format'])}, New Due: ${newDueDate.format(props.plugin.settings['date-format'])}`);

    try {
      await updateCardDatesInMarkdown(
        props.plugin.app,
        draggedCard.sourceBoardPath,
        draggedCard, // Pass the whole card data for now
        newStartDate,
        newDueDate,
        props.plugin.settings
      );
      console.log(
        `[TimelineView] Successfully updated dates in Markdown for card: ${draggedCard.title}`
      );
      // OPTIMISTIC UI UPDATE: Update the card in the local state
      setCards((prevCards) =>
        prevCards.map((c) =>
          c.id === draggedCard.id
            ? {
                ...c,
                startDate: newStartDate.clone(), // Ensure we use the calculated newStartDate
                dueDate: newDueDate.clone(), // Ensure we use the calculated newDueDate
              }
            : c
        )
      );
      // Optionally, re-scan or refresh data if needed, though optimistic update might be enough
      // scanCards();
    } catch (error) {
      console.error(
        `[TimelineView] Error updating dates in Markdown for card: ${draggedCard.title}`,
        error
      );
      // TODO: Revert optimistic UI update or notify user
      // For now, we'll log and the UI will be out of sync with the file
      setError(`Failed to save changes for ${draggedCard.title}. Please check console.`);
      // Potentially revert the change in local state
      // scanCards(); // Re-scan to get actual state from files
    }
    draggedItemData.current = null; // Clear dragged item data regardless of success/failure of Markdown update
  };

  const handleTimelineCardClick = useCallback(
    async (cardData: TimelineCardData) => {
      const app = props.app;

      const navigationState = {
        file: cardData.sourceBoardPath,
        eState: {
          filePath: cardData.sourceBoardPath,
          blockId: cardData.blockId,
          cardTitle: !cardData.blockId ? cardData.title : undefined,
          listName: !cardData.blockId ? cardData.sourceLaneTitle : undefined,
        },
      };

      let linkPath = cardData.sourceBoardPath;
      if (cardData.blockId) {
        linkPath = `${cardData.sourceBoardPath}#^${cardData.blockId}`;
      }

      let existingLeaf: WorkspaceLeaf | null = null;
      app.workspace.getLeavesOfType(kanbanViewType).forEach((leaf) => {
        if (leaf.view instanceof KanbanView && leaf.view.file?.path === cardData.sourceBoardPath) {
          existingLeaf = leaf;
        }
      });

      if (existingLeaf) {
        app.workspace.setActiveLeaf(existingLeaf, { focus: true });
        const kanbanView = existingLeaf.view as KanbanView;
        kanbanView.setState({ eState: navigationState.eState }, { history: true });
        // Add a slight delay to ensure setState has processed and the view is ready
        setTimeout(() => {
          if (kanbanView && kanbanView.applyHighlight) {
            console.log(
              '[TimelineView] Directly calling applyHighlight on KanbanView instance for:',
              cardData.sourceBoardPath
            );
            kanbanView.applyHighlight();
          }
        }, 150); // Increased delay slightly to see if it helps
      } else {
        // Fallback to opening a new tab if no existing view is found or suitable
        await app.workspace.openLinkText(linkPath, cardData.sourceBoardPath, 'tab', {
          state: navigationState,
        });
      }
    },
    [props.app]
  );

  const renderDateHeaders = () => {
    if (!timelineStartDate || !timelineEndDate) return null;

    const headers = [];
    const currentDate = timelineStartDate.clone();
    while (currentDate.isSameOrBefore(timelineEndDate, 'day')) {
      headers.push(
        <div
          key={currentDate.format('YYYY-MM-DD')}
          style={{
            minWidth: `${DAY_WIDTH_PX}px`,
            textAlign: 'center',
            borderRight: '1px solid var(--background-modifier-border)',
            padding: '5px 0',
            fontSize: '0.8em',
            boxSizing: 'border-box',
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'flex-end',
            // ADDED: Highlight for current day
            backgroundColor: currentDate.isSame(moment(), 'day')
              ? 'var(--text-highlight-bg)'
              : undefined,
          }}
        >
          <div style={{ fontSize: '0.9em', fontWeight: '500' }}>{currentDate.format('MMM')}</div>
          <div style={{ fontSize: '1.1em', fontWeight: 'bold' }}>{currentDate.format('D')}</div>
          <div style={{ fontSize: '0.75em' }}>{currentDate.format('ddd')}</div>
        </div>
      );
      currentDate.add(1, 'day');
    }
    return (
      <div
        style={{
          display: 'flex',
          position: 'sticky',
          top: 0,
          background: 'var(--background-secondary)',
          zIndex: 10,
          height: `${TIMELINE_HEADER_HEIGHT_PX}px`,
          borderBottom: '1px solid var(--background-modifier-border)',
        }}
      >
        {headers}
      </div>
    );
  };

  const renderTimelineCards = () => {
    if (!timelineStartDate || !timelineEndDate || cards.length === 0) {
      // console.log('[TimelineView] renderTimelineCards: No cards or timeline range to render.');
      return null;
    }
    // console.log('[TimelineView] renderTimelineCards: Rendering cards. Count:', cards.length);

    return cards.map((card, index) => {
      if (!card.startDate || !card.dueDate) {
        // console.log(`[TimelineView] Card ${card.id} skipped (missing start/due date in render):`, card);
        return null;
      }

      const cardStartDate = moment(card.startDate).startOf('day');
      const cardDueDate = moment(card.dueDate).endOf('day');

      // console.log(`[TimelineView] Rendering card ${card.id}: ${card.title}, Start: ${cardStartDate.format('YYYY-MM-DD')}, Due: ${cardDueDate.format('YYYY-MM-DD')}`);

      if (cardDueDate.isBefore(timelineStartDate) || cardStartDate.isAfter(timelineEndDate)) {
        // console.log(`[TimelineView] Card ${card.id} is outside current timeline range. Start: ${timelineStartDate.format('YYYY-MM-DD')}, End: ${timelineEndDate.format('YYYY-MM-DD')}`);
        return null;
      }

      let startOffsetDays = cardStartDate.diff(timelineStartDate, 'days');
      let durationDays = cardDueDate.diff(cardStartDate, 'days') + 1;

      if (cardStartDate.isBefore(timelineStartDate)) {
        durationDays = cardDueDate.diff(timelineStartDate, 'days') + 1;
        startOffsetDays = 0;
      }
      if (cardDueDate.isAfter(timelineEndDate)) {
        durationDays =
          timelineEndDate.diff(
            cardStartDate.isBefore(timelineStartDate) ? timelineStartDate : cardStartDate,
            'days'
          ) + 1;
      }
      if (durationDays <= 0) durationDays = 1;

      const left = startOffsetDays * DAY_WIDTH_PX;
      const width = durationDays * DAY_WIDTH_PX - 2;
      const top = TIMELINE_HEADER_HEIGHT_PX + index * (CARD_HEIGHT_PX + ROW_GAP_PX) + ROW_GAP_PX;

      //   console.log(`[TimelineView] Card ${card.id} position: left=${left}, top=${top}, width=${width}, durationDays=${durationDays}, startOffsetDays=${startOffsetDays}`);

      return (
        <div
          key={card.id}
          ref={(el) => (cardElementRefs.current[index] = el)}
          draggable={true}
          onDragStart={(e) => handleDragStart(e, card.id, false, false)}
          onDragEnd={handleDragEnd}
          onClick={() => handleTimelineCardClick(card)}
          className="timeline-card"
          style={{
            position: 'absolute',
            left: `${left}px`,
            top: `${top}px`,
            width: `${width}px`,
            minHeight: `${CARD_HEIGHT_PX}px`,
            height: 'auto',
            backgroundColor: card.laneColor || (card.blockId ? '#e0e0e0' : '#f0f0f0'),
            // border: '1px solid #ccc',
            borderRadius: '8px',
            padding: '5px',
            boxSizing: 'border-box',
            cursor: 'grab',
            overflow: 'hidden',
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'center',
            zIndex: 2,
          }}
          title={`${card.titleRaw}\nSource: ${card.sourceBoardName}\nStart: ${cardStartDate.format(props.plugin.settings['date-format'])}\nDue: ${cardDueDate.format(props.plugin.settings['date-format'])}`}
        >
          {/* Left Resize Handle */}
          <div
            draggable={true}
            onDragStart={(e) => {
              e.stopPropagation();
              handleDragStart(e, card.id, true, false);
            }}
            style={{
              position: 'absolute',
              left: '0px',
              top: '0px',
              width: '8px',
              height: '100%',
              cursor: 'ew-resize',
            }}
            title="Resize start date"
          ></div>
          {/* Card Content: Title, Tags, Members */}
          <div
            style={{
              flexGrow: 1, // Allow this container to take available space
              display: 'flex',
              flexDirection: 'column',
              justifyContent: 'center', // Center content vertically if space allows
              marginLeft: '3px', // Space from left resize handle
              marginRight: '3px', // Space for right resize handle
              overflow: 'hidden', // Prevent content from spilling out
            }}
          >
            {/* Title */}
            <div
              style={{
                marginBottom:
                  (card.tags?.length || 0) > 0 || (card.assignedMembers?.length || 0) > 0
                    ? '4px'
                    : '0px',
              }}
            >
              <InteractiveMarkdownCell
                markdownText={card.title}
                app={props.app}
                sourcePath={card.sourceBoardPath}
              />
            </div>

            {/* Tags and Members Container */}
            {((card.tags && card.tags.length > 0) ||
              (card.assignedMembers && card.assignedMembers.length > 0)) && (
              <div
                style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  gap: '4px',
                  alignItems: 'center',
                  // justifyContent: 'flex-end',
                  // marginTop: 'auto', // Push to bottom if there's extra space in the card
                }}
              >
                {/* Render Tags */}
                {card.tags?.map((tagWithHash) => {
                  const colorSetting = getTagColor(tagWithHash);
                  const symbolInfo = getTagSymbol(tagWithHash);
                  const colorValue = colorSetting?.color;
                  const bgColor = colorSetting?.backgroundColor;
                  const tagNameForDisplay = tagWithHash.substring(1);

                  let displayContent = null;
                  if (symbolInfo) {
                    displayContent = (
                      <Fragment>
                        {symbolInfo.symbol}
                        {!symbolInfo.hideTag && (
                          <span style={{ marginLeft: '0.2em' }}>{tagNameForDisplay}</span>
                        )}
                      </Fragment>
                    );
                  } else {
                    displayContent = hideHashForTagsWithoutSymbols
                      ? tagNameForDisplay
                      : tagWithHash;
                  }

                  return (
                    <span
                      key={`tag-${tagWithHash}`}
                      style={{
                        backgroundColor: bgColor || 'var(--background-modifier-hover)',
                        color: colorValue || 'var(--text-normal)',
                        padding: '1px 6px',
                        borderRadius: '5px', // Lozenge shape
                        fontSize: '0.75em',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {displayContent}
                    </span>
                  );
                })}

                {/* Render Members */}
                {card.assignedMembers?.map((member) => {
                  const memberConfig = teamMemberColors[member];
                  const memberBgColor =
                    memberConfig?.background || 'var(--background-modifier-accent)';
                  const memberTextColor = memberConfig?.text || 'var(--text-on-accent)';
                  const initial = member.charAt(0).toUpperCase();

                  return (
                    <div
                      key={`member-${member}`}
                      style={{
                        backgroundColor: memberBgColor,
                        color: memberTextColor,
                        borderRadius: '50%',
                        width: '18px',
                        height: '18px',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontSize: '0.7em',
                        fontWeight: 'bold',
                        // marginLeft: '4px', // Spacing between members or tags
                      }}
                      title={member}
                    >
                      {initial}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          {/* Right Resize Handle */}
          <div
            draggable={true}
            onDragStart={(e) => {
              e.stopPropagation();
              handleDragStart(e, card.id, false, true);
            }}
            style={{
              position: 'absolute',
              right: '0px',
              top: '0px',
              width: '8px',
              height: '100%',
              cursor: 'ew-resize',
            }}
            title="Resize due date"
          ></div>
        </div>
      );
    });
  };

  // NEW function to render vertical day divider lines
  const renderDayBackgroundLines = () => {
    if (!timelineStartDate || !timelineEndDate || !timelineGridRef.current) return null;

    const lines = [];
    const numDays = timelineEndDate.diff(timelineStartDate, 'days') + 1;

    for (let i = 0; i < numDays - 1; i++) {
      // numDays - 1 because we don't need a line after the last day
      lines.push(
        <div
          key={`day-line-${i}`}
          style={{
            position: 'absolute',
            left: `${(i + 1) * DAY_WIDTH_PX - 1}px`, // Align with header borderRight
            top: `${TIMELINE_HEADER_HEIGHT_PX}px`, // Start below header
            width: '1px',
            height: `${actualTotalTimelineHeight - TIMELINE_HEADER_HEIGHT_PX}px`,
            backgroundColor: 'var(--background-modifier-border)',
            zIndex: 1, // Behind cards
          }}
        />
      );
    }
    return <Fragment>{lines}</Fragment>; // Use Fragment to return multiple elements
  };

  const totalTimelineWidth =
    timelineStartDate && timelineEndDate
      ? (timelineEndDate.diff(timelineStartDate, 'days') + 1) * DAY_WIDTH_PX
      : 0;

  return (
    <div style={{ padding: '10px', height: '100%', display: 'flex', flexDirection: 'column' }}>
      <h2 style={{ flexShrink: 0 }}>Timeline View</h2>
      {isLoading && (
        <p style={{ flexShrink: 0 }}>
          <i>Loading cards...</i>
        </p>
      )}
      {error && <p style={{ color: 'red', flexShrink: 0 }}>Error: {error}</p>}
      {!isLoading && !error && cards.length === 0 && (
        <p style={{ flexShrink: 0 }}>
          <i>No cards to display on the timeline.</i>
        </p>
      )}
      {!isLoading && !error && timelineStartDate && timelineEndDate && (
        // console.log('[TimelineView] Rendering main timeline grid. Width:', totalTimelineWidth, 'Height:', totalTimelineHeight),
        <div
          style={{
            flexGrow: 1,
            overflow: 'auto',
            border: '1px solid var(--background-modifier-border)',
          }}
        >
          <div
            ref={timelineGridRef}
            style={{
              width: `${totalTimelineWidth}px`,
              minHeight: `${actualTotalTimelineHeight}px`,
              position: 'relative',
            }}
            onDragOver={handleDragOver}
            onDrop={handleDrop}
          >
            {renderDateHeaders()}
            {renderDayBackgroundLines()}
            {renderTimelineCards()}
          </div>
        </div>
      )}
    </div>
  );
}

// Placeholder for recursivelyGetAllMdFilesInFolder if not moved to a shared location
async function recursivelyGetAllMdFilesInFolder(folder: TFolder): Promise<TFile[]> {
  const mdFiles: TFile[] = [];
  for (const child of folder.children) {
    if (child instanceof TFile && child.extension === 'md') {
      mdFiles.push(child);
    } else if (child instanceof TFolder) {
      mdFiles.push(...(await recursivelyGetAllMdFilesInFolder(child)));
    }
  }
  return mdFiles;
}
