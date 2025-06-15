import update from 'immutability-helper';
import moment from 'moment';
import { Notice, TFile } from 'obsidian';
import { createElement } from 'preact';
import { memo, useEffect, useMemo, useRef, useState } from 'preact/compat';
import { DEFAULT_SETTINGS } from 'src/Settings';
import { StateManager } from 'src/StateManager';
import { generateInstanceId } from 'src/components/helpers';
import { Lane } from 'src/components/types';
import { hasFrontmatterKey } from 'src/helpers';
import KanbanPlugin from 'src/main';
import { ListFormat } from 'src/parsers/List';

import { getTagColorFn, getTagSymbolFn, useGetDateColorFn } from './helpers';

// Interactive Markdown Renderer Component for handling both internal and external links
function InteractiveMarkdownRenderer(props: {
  markdownText: string;
  plugin: KanbanPlugin;
  sourcePath: string;
}) {
  const { markdownText, plugin, sourcePath } = props;
  const contentRef = useRef<HTMLSpanElement>(null);

  // Regex for external links: [text](url)
  const externalLinkRegex = /\[([^\][]*)\]\((https?:\/\/[^)]+)\)/g;
  // Regex for internal links: [[file]] or [[file|alias]]
  const internalLinkRegex = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;

  // Combined regex to find either type of link
  const combinedRegex = new RegExp(`${externalLinkRegex.source}|${internalLinkRegex.source}`, 'g');

  const parts = [];
  let lastIndex = 0;
  let match;

  while ((match = combinedRegex.exec(markdownText)) !== null) {
    // Text before the link
    if (match.index > lastIndex) {
      parts.push(markdownText.substring(lastIndex, match.index));
    }

    const externalText = match[1];
    const externalUrl = match[2];
    const internalFile = match[3];
    const internalAlias = match[4];

    if (externalUrl) {
      // External link
      parts.push(
        createElement(
          'a',
          {
            href: externalUrl,
            target: '_blank',
            rel: 'noopener noreferrer',
            class: 'external-link',
            style: { color: 'var(--link-color)', textDecoration: 'underline' },
          },
          externalText || externalUrl
        )
      );
    } else if (internalFile) {
      // Internal link
      const displayText = internalAlias || internalFile;
      const linkText = internalFile + (internalAlias ? `|${internalAlias}` : ''); // Original [[content]]

      // Resolve the file path for proper hover preview
      const resolvedFile = plugin.app.metadataCache.getFirstLinkpathDest(internalFile, sourcePath);
      const resolvedPath = resolvedFile ? resolvedFile.path : internalFile;

      parts.push(
        createElement(
          'a',
          {
            href: resolvedPath, // Use resolved path for hover preview
            'data-href': resolvedPath, // Obsidian also uses data-href
            class: 'internal-link',
            'data-link-text': linkText, // Store original link for click handling
            'aria-label': displayText, // For accessibility
            style: { color: 'var(--link-color)', textDecoration: 'underline', cursor: 'pointer' },
          },
          displayText
        )
      );
    }
    lastIndex = combinedRegex.lastIndex;
  }

  // Text after the last link
  if (lastIndex < markdownText.length) {
    parts.push(markdownText.substring(lastIndex));
  }

  // Click handler for internal links
  useEffect(() => {
    const currentContentRef = contentRef.current;
    if (!currentContentRef) return;

    const handleClick = (event: MouseEvent) => {
      let target = event.target as HTMLElement | null;
      // Traverse up to find the link if the click was on a child element
      for (let i = 0; i < 3 && target && target !== currentContentRef; i++) {
        if (target.tagName === 'A' && target.classList.contains('internal-link')) {
          event.preventDefault();
          event.stopPropagation();
          const link = target.getAttribute('data-link-text');
          if (link) {
            plugin.app.workspace.openLinkText(
              link,
              sourcePath,
              event.ctrlKey || event.metaKey || event.button === 1 // Open in new tab/split on Ctrl/Cmd click or middle mouse click
            );
          }
          return;
        }
        target = target.parentElement;
      }
    };

    currentContentRef.addEventListener('click', handleClick);
    return () => {
      currentContentRef.removeEventListener('click', handleClick);
    };
  }, [plugin, sourcePath]); // Dependencies for the click handler

  // Render the parts into a span
  return createElement('span', { ref: contentRef }, ...parts);
}

// Helper function to move a card to the "Done" lane in markdown
async function moveCardToDoneLane(
  plugin: KanbanPlugin,
  markdownContent: string,
  targetFile: TFile,
  cardToMove: LinkedCard
): Promise<string> {
  const DONE_LANE_NAME = 'Done';

  // Create a temporary StateManager to parse the board
  const tempStateManager = new StateManager(
    plugin.app,
    { file: targetFile } as any,
    () => {},
    () => plugin.settings
  );

  const parser = new ListFormat(tempStateManager);

  try {
    const board = parser.mdToBoard(markdownContent);

    if (!board || !board.children) return markdownContent;

    // Find the card to move
    let sourceLaneIndex = -1;
    let itemIndexInSourceLane = -1;

    for (let i = 0; i < board.children.length; i++) {
      const lane = board.children[i];
      // Try to match by blockId first, then by title and original lane if blockId is not present/matched
      const itemIdx = cardToMove.blockId
        ? lane.children.findIndex((item) => item.data.blockId === cardToMove.blockId)
        : lane.children.findIndex(
            (item) =>
              item.data.title === cardToMove.title && lane.data.title === cardToMove.laneName
          );

      if (itemIdx !== -1) {
        sourceLaneIndex = i;
        itemIndexInSourceLane = itemIdx;
        break;
      }
    }

    if (sourceLaneIndex === -1) {
      console.warn('Card not found in parsed board for moving to Done lane.');
      return markdownContent; // Card not found, return original content
    }

    // Find or create "Done" lane
    let doneLaneIndex = board.children.findIndex((lane) => lane.data.title === DONE_LANE_NAME);
    let boardForUpdate = board;

    if (doneLaneIndex === -1) {
      const newLaneId = generateInstanceId();
      const newLane: Lane = {
        id: newLaneId,
        type: 'lane',
        accepts: ['item'],
        data: {
          title: DONE_LANE_NAME,
        },
        children: [],
      };
      boardForUpdate = update(board, { children: { $push: [newLane] } });
      doneLaneIndex = boardForUpdate.children.length - 1;
    }

    if (sourceLaneIndex === doneLaneIndex) {
      // Card is already in the Done lane
      return markdownContent;
    }

    // Perform the move using immutability-helper on the board structure
    const itemToMoveFromBoard =
      boardForUpdate.children[sourceLaneIndex].children[itemIndexInSourceLane];

    const movedBoard = update(boardForUpdate, {
      children: {
        [sourceLaneIndex]: {
          children: { $splice: [[itemIndexInSourceLane, 1]] },
        },
        [doneLaneIndex]: {
          children: { $push: [itemToMoveFromBoard] },
        },
      },
    });

    // Convert the modified board structure back to markdown
    return parser.boardToMd(movedBoard);
  } catch (e) {
    console.error('Error in moveCardToDoneLane:', e);
    return markdownContent; // Return original content on error
  }
}

interface LinkedCard {
  title: string;
  titleRaw: string;
  content: string;
  boardName: string;
  boardPath: string;
  laneName: string;
  laneColor?: string;
  blockId?: string;
  tags?: string[];
  metadata?: any;
  checked: boolean;
  assignedMembers?: string[];
  priority?: 'high' | 'medium' | 'low';
  date?: string;
}

interface LinkedCardsDisplayProps {
  plugin: KanbanPlugin;
  currentFilePath: string;
}

export const LinkedCardsDisplay = memo(function LinkedCardsDisplay({
  plugin,
  currentFilePath,
}: LinkedCardsDisplayProps) {
  const [showDone, setShowDone] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [linkedCards, setLinkedCards] = useState<LinkedCard[]>([]);
  const [forceRenderKey, setForceRenderKey] = useState(0); // Add force render key

  // Get tag color and symbol functions
  const getTagColor = useMemo(
    () => getTagColorFn(plugin.settings['tag-colors'] || []),
    [plugin.settings['tag-colors']]
  );

  const getTagSymbol = useMemo(
    () => getTagSymbolFn(plugin.settings['tag-symbols'] || []),
    [plugin.settings['tag-symbols']]
  );

  // Get date color function - we need a StateManager for this
  // For now, we'll create a minimal implementation since we don't have a StateManager context
  const getDateColor = useMemo(() => {
    const dateColors = plugin.settings['date-colors'] || [];
    const dateDisplayFormat = plugin.settings['date-display-format'] || 'YYYY-MM-DD';

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
  }, [plugin.settings['date-colors'], plugin.settings['date-display-format']]);

  const hideHashForTagsWithoutSymbols =
    plugin.settings.hideHashForTagsWithoutSymbols ?? DEFAULT_SETTINGS.hideHashForTagsWithoutSymbols;

  useEffect(() => {
    loadLinkedCards();
  }, [currentFilePath]);

  // Re-render when settings change (specifically the hide settings)
  const [hideWhenNoneExistSetting, setHideWhenNoneExistSetting] = useState(() => {
    const setting = plugin.settings['hide-linked-cards-when-none-exist'];
    const defaultValue = DEFAULT_SETTINGS['hide-linked-cards-when-none-exist'];
    return setting !== undefined ? setting : defaultValue;
  });
  const [hideWhenOnlyDoneSetting, setHideWhenOnlyDoneSetting] = useState(() => {
    const setting = plugin.settings['hide-linked-cards-when-only-done'];
    const defaultValue = DEFAULT_SETTINGS['hide-linked-cards-when-only-done'];
    return setting !== undefined ? setting : defaultValue;
  });

  useEffect(() => {
    // Poll for settings changes every 500ms
    const interval = setInterval(() => {
      const noneExistSetting = plugin.settings['hide-linked-cards-when-none-exist'];
      const onlyDoneSetting = plugin.settings['hide-linked-cards-when-only-done'];

      const currentNoneExistSetting =
        noneExistSetting !== undefined
          ? noneExistSetting
          : DEFAULT_SETTINGS['hide-linked-cards-when-none-exist'];
      const currentOnlyDoneSetting =
        onlyDoneSetting !== undefined
          ? onlyDoneSetting
          : DEFAULT_SETTINGS['hide-linked-cards-when-only-done'];

      if (currentNoneExistSetting !== hideWhenNoneExistSetting) {
        setHideWhenNoneExistSetting(currentNoneExistSetting);
      }
      if (currentOnlyDoneSetting !== hideWhenOnlyDoneSetting) {
        setHideWhenOnlyDoneSetting(currentOnlyDoneSetting);
      }
    }, 500);

    // Cleanup interval on unmount
    return () => {
      clearInterval(interval);
    };
  }, [hideWhenNoneExistSetting, hideWhenOnlyDoneSetting, plugin]);

  // Listen for settings changes to trigger re-render
  useEffect(() => {
    const handleSettingsChange = (value: any) => {
      setForceRenderKey((prev) => prev + 1); // Force re-render by changing key
    };

    plugin.onSettingChange('use-kanban-board-background-colors', handleSettingsChange);

    return () => {
      plugin.offSettingChange('use-kanban-board-background-colors', handleSettingsChange);
    };
  }, [plugin]);

  const loadLinkedCards = async () => {
    try {
      setLoading(true);
      setError(null);

      const currentFile = plugin.app.vault.getAbstractFileByPath(currentFilePath) as TFile;
      if (!currentFile) {
        setError('Current file not found');
        return;
      }

      const cards: LinkedCard[] = [];
      const allMarkdownFiles = plugin.app.vault.getMarkdownFiles();
      const kanbanBoards: TFile[] = [];

      // Find all Kanban boards
      for (const file of allMarkdownFiles) {
        if (hasFrontmatterKey(file)) {
          kanbanBoards.push(file);
        }
      }

      // Search each board for cards that link to the current file
      for (const boardFile of kanbanBoards) {
        try {
          const fileContent = await plugin.app.vault.cachedRead(boardFile);
          const boardCards = await findLinkedCardsInBoard(
            fileContent,
            boardFile,
            currentFile,
            plugin
          );
          cards.push(...boardCards);
        } catch (e) {
          console.warn(`Error searching board ${boardFile.path} for linked cards:`, e);
        }
      }

      // Sort cards by board name, then lane name, then title
      cards.sort((a, b) => {
        const boardCompare = a.boardName.localeCompare(b.boardName);
        if (boardCompare !== 0) return boardCompare;

        const laneCompare = a.laneName.localeCompare(b.laneName);
        if (laneCompare !== 0) return laneCompare;

        return a.title.localeCompare(b.title);
      });

      setLinkedCards(cards);
    } catch (err) {
      console.error('Error loading linked cards:', err);
      setError(err.message || 'Failed to load linked cards');
    } finally {
      setLoading(false);
    }
  };

  const findLinkedCardsInBoard = async (
    boardContent: string,
    boardFile: TFile,
    targetFile: TFile,
    plugin: KanbanPlugin
  ): Promise<LinkedCard[]> => {
    const cards: LinkedCard[] = [];

    try {
      // Create a temporary StateManager to parse the board
      const tempView = { file: boardFile } as any;
      const tempStateManager = new StateManager(
        plugin.app,
        tempView,
        () => {},
        () => plugin.settings
      );

      const parser = new ListFormat(tempStateManager);
      const board = parser.mdToBoard(boardContent);

      if (!board || !board.children) return cards;

      // Get the target file name and path for matching
      const targetFileName = targetFile.basename;
      const targetFilePath = targetFile.path;

      for (const lane of board.children) {
        if (!lane.children) continue;

        for (const item of lane.children) {
          const itemData = item.data;
          const titleRaw = itemData.titleRaw || itemData.title;

          // Check if this card contains a link to the target file
          const containsLink = checkForFileLink(titleRaw, targetFileName, targetFilePath);

          if (containsLink) {
            const extractedMetadata = extractMetadata(titleRaw);
            cards.push({
              title: itemData.title,
              titleRaw: titleRaw,
              content: extractCardContent(titleRaw),
              boardName: boardFile.basename,
              boardPath: boardFile.path,
              laneName: lane.data.title,
              laneColor: lane.data.backgroundColor,
              blockId: itemData.blockId,
              tags: itemData.metadata?.tags || [],
              metadata: itemData.metadata,
              checked: itemData.checked || false,
              assignedMembers: extractedMetadata.assignedMembers,
              priority: extractedMetadata.priority,
              date: extractedMetadata.date,
            });
          }
        }
      }
    } catch (e) {
      console.warn(`Error parsing board ${boardFile.path}:`, e);
    }

    return cards;
  };

  const checkForFileLink = (content: string, fileName: string, filePath: string): boolean => {
    if (!content) return false;

    // Check for wikilinks with the file name
    const wikilinkPatterns = [
      `[[${fileName}]]`,
      `[[${fileName}|`,
      `[[${filePath}]]`,
      `[[${filePath}|`,
    ];

    return wikilinkPatterns.some((pattern) => content.includes(pattern));
  };

  const cleanCardTitle = (titleRaw: string): string => {
    if (!titleRaw) return '';

    let cleanContent = titleRaw;

    // Remove blockId references from anywhere in the content
    cleanContent = cleanContent.replace(/\s*\^[a-zA-Z0-9]+/g, '');

    // Remove tags from the content (they'll be shown in the tags section)
    cleanContent = cleanContent.replace(/\s*#\w+(?:\/\w+)*/g, '');

    // Remove member assignments (@@member)
    cleanContent = cleanContent.replace(/\s*@@\w+/g, '');

    // Remove priority tags (!low, !medium, !high)
    cleanContent = cleanContent.replace(/\s*!(?:low|medium|high)/gi, '');

    // Remove date triggers (@{date}, @start{date}, @end{date}, etc.)
    cleanContent = cleanContent.replace(/\s*@\w*\{[^}]+\}/g, '');

    // Remove date triggers with wikilinks (@[[date]], @start[[date]], etc.)
    cleanContent = cleanContent.replace(/\s*@\w*\[\[[^\]]+\]\]/g, '');

    // Clean up multiple spaces but preserve newlines and markdown formatting
    cleanContent = cleanContent
      .split('\n')
      .map((line) => {
        const trimmedLine = line.trim();

        // Preserve markdown list formatting (-, *, +, 1., etc.)
        const listMatch = trimmedLine.match(/^(\s*)([-*+]|\d+\.)\s+(.*)$/);
        if (listMatch) {
          const [, indent, marker, content] = listMatch;
          return `${indent}${marker} ${content.replace(/[ \t]+/g, ' ')}`;
        }

        // Preserve task list formatting (- [ ], - [x])
        const taskMatch = trimmedLine.match(/^(\s*)-\s+\[([ x])\]\s+(.*)$/);
        if (taskMatch) {
          const [, indent, checked, content] = taskMatch;
          return `${indent}- [${checked}] ${content.replace(/[ \t]+/g, ' ')}`;
        }

        // For regular lines, just clean up spaces
        return line.replace(/[ \t]+/g, ' ').trim();
      })
      .join('\n')
      .replace(/\n{3,}/g, '\n\n') // Limit to max 2 consecutive newlines
      .trim();

    return cleanContent;
  };

  const extractMetadata = (titleRaw: string) => {
    if (!titleRaw) return { assignedMembers: [], priority: undefined, date: undefined };

    // Extract assigned members (@@member)
    const memberMatches = titleRaw.match(/@@(\w+)/g);
    const assignedMembers = memberMatches ? memberMatches.map((m) => m.substring(2)) : [];

    // Extract priority (!low, !medium, !high)
    const priorityMatch = titleRaw.match(/!(?:low|medium|high)/i);
    const priority = priorityMatch
      ? (priorityMatch[0].substring(1).toLowerCase() as 'low' | 'medium' | 'high')
      : undefined;

    // Extract date (@{date} or @[[date]])
    const dateMatch = titleRaw.match(/@(?:\w*\{([^}]+)\}|\w*\[\[([^\]]+)\]\])/);
    const date = dateMatch ? dateMatch[1] || dateMatch[2] : undefined;

    return { assignedMembers, priority, date };
  };

  const getInitials = (name: string): string => {
    return name
      .split(' ')
      .map((word) => word.charAt(0).toUpperCase())
      .join('')
      .substring(0, 2);
  };

  const getPriorityStyle = (priority: 'high' | 'medium' | 'low') => {
    switch (priority) {
      case 'high':
        return {
          backgroundColor: '#cd1e00',
          color: '#eeeeee',
        };
      case 'medium':
        return {
          backgroundColor: '#ff9600',
          color: '#ffffff',
        };
      case 'low':
        return {
          backgroundColor: '#008bff',
          color: '#eeeeee',
        };
      default:
        return {};
    }
  };

  const renderMarkdownLists = (content: string, plugin: KanbanPlugin, sourcePath: string) => {
    if (!content) return null;

    // Split content into lines for processing
    const lines = content.split('\n');
    const processedElements: any[] = [];
    let inList = false;
    let listType: 'ul' | 'ol' | null = null;
    let currentListItems: any[] = [];

    const flushList = () => {
      if (currentListItems.length > 0) {
        const listElement = createElement(
          listType === 'ol' ? 'ol' : 'ul',
          { className: listType === 'ul' ? 'kanban-mixed-list' : undefined },
          ...currentListItems
        );
        processedElements.push(listElement);
        currentListItems = [];
      }
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmedLine = line.trim();

      // Check for task list items FIRST (- [ ], - [x])
      // More flexible regex to handle various spacing
      const taskMatch = trimmedLine.match(/^(\s*)-\s*\[\s*([ x])\s*\]\s*(.*)$/);
      // Check for unordered list items (-, *, +) but exclude task lists
      const unorderedMatch = !taskMatch ? trimmedLine.match(/^(\s*)([-*+])\s+(.*)$/) : null;
      // Check for ordered list items (1., 2., etc.)
      const orderedMatch = trimmedLine.match(/^(\s*)(\d+\.)\s+(.*)$/);

      if (taskMatch) {
        // Task list item - convert to mixed list if we're already in a regular ul
        if (!inList) {
          inList = true;
          listType = 'ul';
        } else if (listType === 'ol') {
          flushList();
          listType = 'ul';
        }
        const isChecked = taskMatch[2].trim() === 'x';
        const content = taskMatch[3];
        const checkbox = createElement('input', {
          type: 'checkbox',
          checked: isChecked,
          disabled: true,
          style: { marginRight: '6px' },
        });
        currentListItems.push(
          createElement(
            'li',
            { className: 'task-item' },
            checkbox,
            createElement(InteractiveMarkdownRenderer, {
              markdownText: content,
              plugin,
              sourcePath,
            })
          )
        );
      } else if (unorderedMatch) {
        // Regular unordered list item
        if (!inList) {
          inList = true;
          listType = 'ul';
        } else if (listType === 'ol') {
          flushList();
          listType = 'ul';
        }
        currentListItems.push(
          createElement(
            'li',
            { className: 'bullet-item' },
            createElement(InteractiveMarkdownRenderer, {
              markdownText: unorderedMatch[3],
              plugin,
              sourcePath,
            })
          )
        );
      } else if (orderedMatch) {
        // Ordered list item
        if (!inList || listType !== 'ol') {
          if (inList) flushList();
          inList = true;
          listType = 'ol';
        }
        currentListItems.push(
          createElement(
            'li',
            {},
            createElement(InteractiveMarkdownRenderer, {
              markdownText: orderedMatch[3],
              plugin,
              sourcePath,
            })
          )
        );
      } else {
        // Not a list item
        if (inList) {
          flushList();
          inList = false;
          listType = null;
        }
        // Handle non-list content
        if (trimmedLine === '') {
          processedElements.push(createElement('br', {}));
        } else {
          processedElements.push(
            createElement(InteractiveMarkdownRenderer, {
              markdownText: line,
              plugin,
              sourcePath,
            })
          );
          // Add line break only if this isn't the last line and the next line isn't empty
          const isLastLine = i === lines.length - 1;
          if (!isLastLine) {
            processedElements.push(createElement('br', {}));
          }
        }
      }
    }

    // Close any open list
    if (inList) {
      flushList();
    }

    return createElement('div', {}, ...processedElements);
  };

  const extractCardContent = (titleRaw: string): string => {
    if (!titleRaw) return '';

    // Split by lines and remove the first line (which is the title)
    const lines = titleRaw.split('\n');
    if (lines.length <= 1) return '';

    // Remove empty lines and filter out tag-only lines and blockId references
    const contentLines = lines
      .slice(1)
      .filter((line) => {
        const trimmedLine = line.trim();
        if (trimmedLine === '') return false;

        // Check if this line contains only tags (hashtags)
        // This matches lines that are just tags like "#tag1 #tag2" but not lines with actual content plus tags
        const tagOnlyPattern = /^(#\w+(?:\/\w+)*\s*)+$/;
        if (tagOnlyPattern.test(trimmedLine)) return false;

        // Check if this line contains only a blockId reference (^blockId)
        const blockIdOnlyPattern = /^\^[a-zA-Z0-9]+\s*$/;
        if (blockIdOnlyPattern.test(trimmedLine)) return false;

        return true;
      })
      .map((line) => {
        // Remove blockId references from the end of lines
        return line.replace(/\s*\^[a-zA-Z0-9]+\s*$/, '').trim();
      })
      .filter((line) => line !== ''); // Remove any lines that became empty after blockId removal

    return contentLines.join('\n').trim();
  };

  const handleCardClick = (card: LinkedCard) => {
    console.log('[LinkedCardsDisplay] handleCardClick called:', {
      cardTitle: card.title,
      boardPath: card.boardPath,
      blockId: card.blockId,
      currentFilePath,
    });

    let linkText = card.boardPath;
    if (card.blockId) {
      linkText += `#^${card.blockId.replace(/^\^/, '')}`;
    }

    console.log('[LinkedCardsDisplay] Opening link:', linkText);
    plugin.app.workspace.openLinkText(linkText, currentFilePath, false);
  };

  const handleToggleCardDoneStatus = async (card: LinkedCard, newCheckedStatus: boolean) => {
    const originalCheckedStatus = card.checked || false;

    // 1. Optimistically update local state for immediate UI feedback
    setLinkedCards((prevCards) =>
      prevCards.map((c) =>
        c.boardPath === card.boardPath && c.blockId === card.blockId
          ? { ...c, checked: newCheckedStatus }
          : c
      )
    );

    // 2. Update source file
    const targetFile = plugin.app.vault.getAbstractFileByPath(card.boardPath) as TFile;

    if (!targetFile || !(targetFile instanceof TFile)) {
      new Notice(
        `Error: Could not find file ${card.boardPath} or it is a folder to update done status.`
      );
      // Revert local state if file not found
      setLinkedCards((prevCards) =>
        prevCards.map((c) =>
          c.boardPath === card.boardPath && c.blockId === card.blockId
            ? { ...c, checked: originalCheckedStatus }
            : c
        )
      );
      return;
    }

    try {
      let fileContent = await plugin.app.vault.cachedRead(targetFile);
      const lines = fileContent.split('\n');
      let foundAndReplaced = false;
      const taskRegex = /^(\s*)- \[(\s*|x|X|-|\/|>)\](.*)/; // Matches task prefix

      const updateLineCheckedStatus = (line: string): string => {
        const match = line.match(taskRegex);
        if (match) {
          const prefix = match[1];
          const restOfLine = match[3];
          const newMarker = newCheckedStatus ? 'x' : ' ';
          return `${prefix}- [${newMarker}]${restOfLine.startsWith(' ') ? restOfLine : ` ${restOfLine.trimStart()}`}`.trimEnd();
        }
        return line;
      };

      if (card.blockId) {
        const blockIdSuffix = `^${card.blockId}`;
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].endsWith(blockIdSuffix)) {
            if (taskRegex.test(lines[i])) {
              lines[i] = updateLineCheckedStatus(lines[i]);
              foundAndReplaced = true;
            } else {
              new Notice(
                `Line with block ID ${card.blockId} is not a task. Cannot mark as done/undone.`
              );
            }
            break;
          }
        }
      } else {
        // Fallback: try to find by title match if no blockId
        const titleSnippet = card.title.length > 20 ? card.title.substring(0, 20) : card.title;
        for (let i = 0; i < lines.length; i++) {
          if (
            lines[i].toLowerCase().includes(titleSnippet.toLowerCase()) &&
            taskRegex.test(lines[i])
          ) {
            lines[i] = updateLineCheckedStatus(lines[i]);
            foundAndReplaced = true;
            break;
          }
        }
      }

      if (foundAndReplaced) {
        fileContent = lines.join('\n');
        await plugin.app.vault.modify(targetFile, fileContent);
        new Notice(
          `"${card.title}" marked as ${newCheckedStatus ? 'Done' : 'Undone'} in ${targetFile.basename}.`
        );

        // If card was marked as Done and auto-move setting is enabled, move it to Done lane
        if (newCheckedStatus && plugin.settings['auto-move-done-to-lane']) {
          try {
            const updatedMarkdown = await moveCardToDoneLane(plugin, fileContent, targetFile, card);
            if (updatedMarkdown !== fileContent) {
              await plugin.app.vault.modify(targetFile, updatedMarkdown);
              new Notice(`Moved "${card.title}" to Done lane in ${targetFile.basename}.`);
            }
          } catch (e) {
            console.error('Error moving card to Done lane:', e);
            new Notice(
              'Card marked as done, but failed to move to Done lane. See console for details.'
            );
          }
        }

        // Refresh the linked cards display
        loadLinkedCards();
      } else if (!card.blockId) {
        new Notice(
          `Cannot update done status for "${card.title}": No block ID found. Updated in view only.`
        );
      } else if (card.blockId && !foundAndReplaced) {
        if (!lines.find((line) => line.endsWith(`^${card.blockId}`))) {
          new Notice(
            `Could not find block ID ${card.blockId} for "${card.title}" to update done status. Updated in view only.`
          );
        }
      } else {
        new Notice(
          `Could not update done status for "${card.title}" in source file. Updated in view only.`
        );
      }
    } catch (e) {
      console.error('Error updating card done status in source file:', e);
      new Notice('Error updating done status. See console.');
      // Revert local state on error
      setLinkedCards((prevCards) =>
        prevCards.map((c) =>
          c.boardPath === card.boardPath && c.blockId === card.blockId
            ? { ...c, checked: originalCheckedStatus }
            : c
        )
      );
    }
  };

  if (loading) {
    return (
      <div className="kanban-plugin__linked-cards-container">
        <div className="kanban-plugin__linked-cards-loading">
          <div className="kanban-plugin__linked-cards-spinner">Loading linked cards...</div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="kanban-plugin__linked-cards-container">
        <div className="kanban-plugin__linked-cards-error">
          <span>⚠️ Error: {error}</span>
        </div>
      </div>
    );
  }

  // Filter cards based on showDone setting
  const filteredCards = useMemo(() => {
    return showDone ? linkedCards : linkedCards.filter((card) => !card.checked);
  }, [linkedCards, showDone]);

  // Check if we should hide the component based on settings
  const hideWhenNoneExist = hideWhenNoneExistSetting;
  const hideWhenOnlyDone = hideWhenOnlyDoneSetting;
  const allCardsAreDone = linkedCards.length > 0 && linkedCards.every((card) => card.checked);

  // Debug logging
  console.log('LinkedCardsDisplay Debug:', {
    linkedCardsCount: linkedCards.length,
    filteredCardsCount: filteredCards.length,
    hideWhenNoneExistSetting: hideWhenNoneExistSetting,
    hideWhenOnlyDoneSetting: hideWhenOnlyDoneSetting,
    hideWhenNoneExist: hideWhenNoneExist,
    hideWhenOnlyDone: hideWhenOnlyDone,
    allCardsAreDone: allCardsAreDone,
    showDone: showDone,
    linkedCards: linkedCards.map((c) => ({ title: c.title, checked: c.checked })),
    // Debug the settings values
    rawSettingNoneExist: plugin.settings['hide-linked-cards-when-none-exist'],
    rawSettingOnlyDone: plugin.settings['hide-linked-cards-when-only-done'],
    defaultNoneExist: DEFAULT_SETTINGS['hide-linked-cards-when-none-exist'],
    defaultOnlyDone: DEFAULT_SETTINGS['hide-linked-cards-when-only-done'],
  });

  // Hide if no cards at all and setting is enabled
  if (linkedCards.length === 0 && hideWhenNoneExist) {
    console.log('LinkedCardsDisplay: Hiding due to no cards and setting enabled');
    // Return a hidden marker instead of null to help with CSS targeting
    return (
      <div className="kanban-plugin__linked-cards-hidden-marker" style={{ display: 'none' }} />
    );
  }

  // Hide if setting is enabled and all cards are done
  if (hideWhenOnlyDone && allCardsAreDone) {
    console.log('LinkedCardsDisplay: Hiding due to setting enabled with all done');
    return null;
  }

  // Hide if cards exist but none match the current filter AND we have mixed done/undone cards
  // (Don't hide if all cards are done - let the user use "Show Done" checkbox)
  // (Don't hide if no cards exist at all - that's handled by the first condition)
  if (linkedCards.length > 0 && filteredCards.length === 0 && !allCardsAreDone) {
    console.log('LinkedCardsDisplay: Hiding due to no filtered cards (mixed done/undone)');
    return null;
  }

  console.log('LinkedCardsDisplay: Rendering component with', filteredCards.length, 'cards');

  return (
    <div className="kanban-plugin__linked-cards-container">
      <div className="kanban-plugin__linked-cards-header">
        <h4>Linked Kanban Cards ({filteredCards.length})</h4>
        <div className="kanban-plugin__linked-cards-controls">
          <label className="kanban-plugin__linked-cards-show-done">
            <input
              type="checkbox"
              checked={showDone}
              onChange={(e) => setShowDone((e.target as HTMLInputElement).checked)}
            />
            <span>Show Done</span>
          </label>
        </div>
      </div>

      <div className="kanban-plugin__linked-cards-grid">
        {filteredCards.map((card, index) => {
          // Check if lane colors should be used
          const useLaneColors = plugin.settings['use-kanban-board-background-colors'];
          const cardStyle =
            useLaneColors && card.laneColor ? { backgroundColor: card.laneColor } : {};

          return (
            <div
              key={`${card.boardPath}-${card.blockId || index}`}
              className="kanban-plugin__linked-card-item"
              style={cardStyle}
              onClick={(e) => {
                console.log('[LinkedCardsDisplay] Card div clicked:', {
                  target: e.target,
                  currentTarget: e.currentTarget,
                  cardTitle: card.title,
                });
                // Prevent the click from bubbling up and causing cursor movement
                e.stopPropagation();
                e.preventDefault();
                handleCardClick(card);
              }}
              onMouseDown={(e) => {
                // Prevent mousedown from causing cursor movement
                e.stopPropagation();
                e.preventDefault();
              }}
              onPointerDown={(e) => {
                // Prevent pointerdown from causing cursor movement
                e.stopPropagation();
                e.preventDefault();
              }}
            >
              <div className="kanban-plugin__linked-card-header">
                <div className="kanban-plugin__linked-card-board-info" style={{ marginTop: '4px' }}>
                  <span className="kanban-plugin__linked-card-board-name">{card.boardName}</span>
                  <span className="kanban-plugin__linked-card-separator">→</span>
                  <span className="kanban-plugin__linked-card-lane-name">{card.laneName}</span>
                </div>
                <div
                  className="kanban-plugin__linked-card-status"
                  style={{ marginRight: '-4px' }}
                  onClick={(e) => e.stopPropagation()} // Prevent card click when clicking checkbox
                >
                  <input
                    type="checkbox"
                    checked={card.checked}
                    onChange={async (e) => {
                      e.stopPropagation();
                      await handleToggleCardDoneStatus(
                        card,
                        (e.target as HTMLInputElement).checked
                      );
                    }}
                    className="kanban-plugin__linked-card-checkbox"
                    style={{ cursor: 'pointer' }}
                  />
                </div>
              </div>

              <div className="kanban-plugin__linked-card-content">
                <div className="kanban-plugin__linked-card-title">
                  {renderMarkdownLists(
                    cleanCardTitle(card.titleRaw || card.title),
                    plugin,
                    currentFilePath
                  )}
                </div>
              </div>

              {card.tags &&
                card.tags.length > 0 &&
                (() => {
                  // Get the hide tag settings
                  const hideLaneTagDisplay = plugin.settings['hide-lane-tag-display'];
                  const hideBoardTagDisplay = plugin.settings['hide-board-tag-display'];

                  // Filter out lane and board tags if the settings are enabled
                  let filteredTags = card.tags;
                  if (hideLaneTagDisplay || hideBoardTagDisplay) {
                    const boardName = card.boardName;

                    filteredTags = card.tags.filter((tag) => {
                      const tagWithoutHash = tag.replace(/^#/, '').toLowerCase();

                      // Check if this is a board tag (matches board name)
                      if (hideBoardTagDisplay && boardName) {
                        const boardTagPattern = boardName.toLowerCase().replace(/\s+/g, '-');
                        if (tagWithoutHash === boardTagPattern) {
                          return false; // Hide this tag
                        }
                      }

                      // Check if this is a lane tag (matches lane name)
                      if (hideLaneTagDisplay) {
                        const laneTagPattern = card.laneName.toLowerCase().replace(/\s+/g, '-');
                        if (tagWithoutHash === laneTagPattern) {
                          return false; // Hide this tag
                        }
                      }

                      return true; // Show this tag
                    });
                  }

                  // Only render the tags section if there are tags to show after filtering
                  return filteredTags.length > 0 ? (
                    <div className="kanban-plugin__linked-card-tags">
                      {filteredTags.map((tag, tagIndex) => {
                        // Ensure tag has # prefix for lookups
                        const tagWithHash = tag.startsWith('#') ? tag : `#${tag}`;
                        const tagColor = getTagColor(tagWithHash);
                        const symbolInfo = getTagSymbol(tagWithHash);

                        let tagContent;
                        if (symbolInfo) {
                          tagContent = (
                            <>
                              <span>{symbolInfo.symbol}</span>
                              {!symbolInfo.hideTag && tagWithHash.length > 1 && (
                                <span style={{ marginLeft: '0.2em' }}>{tagWithHash.slice(1)}</span>
                              )}
                            </>
                          );
                        } else {
                          if (hideHashForTagsWithoutSymbols) {
                            tagContent =
                              tagWithHash.length > 1 ? tagWithHash.slice(1) : tagWithHash;
                          } else {
                            tagContent = tagWithHash;
                          }
                        }

                        return (
                          <span
                            key={tagIndex}
                            className="kanban-plugin__linked-card-tag"
                            style={{
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
                  ) : null;
                })()}

              {(card.date ||
                (card.assignedMembers && card.assignedMembers.length > 0) ||
                card.priority) && (
                <div className="kanban-plugin__linked-card-metadata">
                  <div className="kanban-plugin__linked-card-metadata-left">
                    {card.date && (
                      <span className="kanban-plugin__linked-card-date">
                        📅{' '}
                        <span
                          style={(() => {
                            // Try to parse the date using the configured date format first, then fallback to common formats
                            const configuredDateFormat =
                              plugin.settings['date-format'] || 'YYYY-MM-DD';
                            let dateMoment = moment(card.date, configuredDateFormat, true); // Try configured format first

                            // If the configured format fails, try default parsing
                            if (!dateMoment.isValid()) {
                              dateMoment = moment(card.date);
                            }

                            // If default parsing also fails, try common formats
                            if (!dateMoment.isValid()) {
                              const formats = [
                                'DD-MM-YYYY',
                                'MM-DD-YYYY',
                                'YYYY-MM-DD',
                                'DD/MM/YYYY',
                                'MM/DD/YYYY',
                                'YYYY/MM/DD',
                                'DD.MM.YYYY',
                                'MM.DD.YYYY',
                                'YYYY.MM.DD',
                              ];

                              for (const format of formats) {
                                dateMoment = moment(card.date, format, true); // strict parsing
                                if (dateMoment.isValid()) {
                                  break;
                                }
                              }
                            }

                            const dateColor = dateMoment.isValid()
                              ? getDateColor(dateMoment)
                              : null;

                            // Fallback coloring if no date colors are configured
                            let fallbackColor = 'var(--text-muted)';
                            const fallbackBackground = 'transparent';

                            if (!dateColor && dateMoment.isValid()) {
                              const now = moment();
                              if (dateMoment.isSame(now, 'day')) {
                                // Today - blue
                                fallbackColor = 'var(--color-blue)';
                              } else if (dateMoment.isBefore(now, 'day')) {
                                // Past - red
                                fallbackColor = 'var(--color-red)';
                              } else {
                                // Future - green
                                fallbackColor = 'var(--color-green)';
                              }
                            }

                            return {
                              color: dateColor?.color || fallbackColor,
                              backgroundColor: dateColor?.backgroundColor || fallbackBackground,
                              padding: dateColor?.backgroundColor ? '2px 4px' : '0',
                              borderRadius: dateColor?.backgroundColor ? '3px' : '0',
                            };
                          })()}
                        >
                          {card.date}
                        </span>
                      </span>
                    )}
                  </div>
                  <div className="kanban-plugin__linked-card-metadata-right">
                    {card.assignedMembers && card.assignedMembers.length > 0 && (
                      <div className="kanban-plugin__linked-card-members">
                        {card.assignedMembers.map((member, memberIndex) => {
                          const memberConfig = plugin.settings.teamMemberColors?.[member];
                          const backgroundColor =
                            memberConfig?.background || 'var(--background-modifier-hover)';
                          const textColor =
                            memberConfig?.text ||
                            (memberConfig?.background
                              ? 'var(--text-on-accent)'
                              : 'var(--text-normal)');
                          const initials = getInitials(member);

                          return (
                            <div
                              key={memberIndex}
                              className="kanban-plugin__linked-card-member"
                              title={member}
                              style={{
                                backgroundColor,
                                color: textColor,
                                borderRadius: '50%',
                                width: '20px',
                                height: '20px',
                                marginTop: '-8px',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                marginLeft: '4px',
                                // marginRight: '-4px',
                                fontSize: '12px',
                                cursor: 'pointer',
                                userSelect: 'none',
                              }}
                            >
                              {initials}
                            </div>
                          );
                        })}
                      </div>
                    )}
                    {card.priority && (
                      <div
                        className="kanban-plugin__linked-card-priority"
                        style={{
                          ...getPriorityStyle(card.priority),
                          padding: '2px 6px',
                          borderRadius: '4px',
                          fontSize: '1em',
                          fontWeight: '500',
                          marginLeft:
                            card.assignedMembers && card.assignedMembers.length > 0 ? '4px' : '0',
                          marginRight: '-2px',
                          textTransform: 'capitalize',
                          minHeight: '20px',
                          height: 'fit-content',
                          lineHeight: 'normal',
                          marginTop: '-8px',
                          display: 'inline-flex',
                          alignItems: 'center',
                          whiteSpace: 'nowrap',
                        }}
                        title={`Priority: ${card.priority.charAt(0).toUpperCase() + card.priority.slice(1)}`}
                      >
                        {card.priority === 'medium' &&
                        card.assignedMembers &&
                        card.assignedMembers.length >= 2
                          ? 'Med'
                          : card.priority.charAt(0).toUpperCase() + card.priority.slice(1)}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
});
