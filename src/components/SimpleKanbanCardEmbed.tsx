import moment from 'moment';
import { TFile } from 'obsidian';
import { createElement } from 'preact';
import { memo, useEffect, useMemo, useState } from 'preact/compat';
import { hasFrontmatterKey } from 'src/helpers';
import KanbanPlugin from 'src/main';

import { c } from './helpers';
import { getTagColorFn, getTagSymbolFn } from './helpers';
import { ItemData } from './types';

// Import the InteractiveMarkdownRenderer from LinkedCardsDisplay
function InteractiveMarkdownRenderer(props: {
  markdownText: string;
  plugin: KanbanPlugin;
  sourcePath: string;
}) {
  const { markdownText, plugin, sourcePath } = props;

  const handleClick = (event: MouseEvent) => {
    const target = event.target as HTMLElement;
    if (target && target.tagName === 'A' && target.hasAttribute('data-link-path')) {
      event.preventDefault();
      event.stopPropagation();

      const linkPath = target.getAttribute('data-link-path');
      if (linkPath) {
        const file = plugin.app.metadataCache.getFirstLinkpathDest(linkPath, '');
        if (file) {
          plugin.app.workspace.getLeaf().openFile(file);
        }
      }
    }
  };

  // Simple markdown rendering with link detection
  const processedText = markdownText.replace(
    /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g,
    (match, linkPath, displayText) => {
      const text = displayText || linkPath;
      // Resolve the file path for proper hover preview
      const resolvedFile = plugin.app.metadataCache.getFirstLinkpathDest(linkPath, sourcePath);
      const hrefValue = resolvedFile ? resolvedFile.path : linkPath;
      return `<a href="${hrefValue}" data-href="${hrefValue}" data-link-path="${linkPath}" class="internal-link">${text}</a>`;
    }
  );

  return <span dangerouslySetInnerHTML={{ __html: processedText }} onClick={handleClick} />;
}

interface SimpleKanbanCardEmbedProps {
  filePath: string;
  blockId: string;
  plugin: KanbanPlugin;
  sourcePath: string;
  displayText?: string;
}

interface CardData {
  title: string;
  titleRaw: string;
  content: string;
  tags: string[];
  metadata: any;
  laneName: string;
  laneColor?: string;
  boardName: string;
  checked: boolean;
  assignedMembers?: string[];
  priority?: 'high' | 'medium' | 'low';
  date?: string;
}

export const SimpleKanbanCardEmbed = memo(function SimpleKanbanCardEmbed({
  filePath,
  blockId,
  plugin,
  sourcePath,
  displayText,
}: SimpleKanbanCardEmbedProps) {
  const [cardData, setCardData] = useState<CardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [forceRenderKey, setForceRenderKey] = useState(0);

  // Helper functions copied from LinkedCardsDisplay
  const getTagColor = useMemo(
    () => getTagColorFn(plugin.settings['tag-colors'] || []),
    [plugin.settings['tag-colors']]
  );

  const getTagSymbol = useMemo(
    () => getTagSymbolFn(plugin.settings['tag-symbols'] || []),
    [plugin.settings['tag-symbols']]
  );

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

  const cleanCardTitle = (titleRaw: string): string => {
    if (!titleRaw) return '';

    let cleanContent = titleRaw;

    // Remove blockId references from anywhere in the content
    cleanContent = cleanContent.replace(/\s*\^[a-zA-Z0-9]+/g, '');

    // Remove tags from the content (they'll be shown in the tags section)
    cleanContent = cleanContent.replace(/\s*#[\w-]+(?:\/[\w-]+)*/g, '');

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
    return createElement(InteractiveMarkdownRenderer, {
      markdownText: content,
      plugin: plugin,
      sourcePath: sourcePath,
    });
  };

  useEffect(() => {
    loadCardData();
  }, [filePath, blockId]);

  // Listen for settings changes to trigger re-render
  useEffect(() => {
    const handleSettingsChange = (value: any) => {
      setForceRenderKey((prev) => prev + 1);
    };

    plugin.onSettingChange('use-kanban-board-background-colors', handleSettingsChange);

    return () => {
      plugin.offSettingChange('use-kanban-board-background-colors', handleSettingsChange);
    };
  }, [plugin]);

  const loadCardData = async () => {
    try {
      setLoading(true);
      setError(null);

      // Get the target file
      const file = plugin.app.vault.getAbstractFileByPath(filePath) as TFile;
      if (!file) {
        throw new Error(`File not found: ${filePath}`);
      }

      // Verify it's a Kanban board
      if (!hasFrontmatterKey(file)) {
        throw new Error(`File is not a Kanban board: ${filePath}`);
      }

      // Read the file content
      const content = await plugin.app.vault.cachedRead(file);

      // Parse the content to find the card
      const card = await findCardInContent(content, blockId, file.basename);

      if (!card) {
        throw new Error(`Card with block ID ${blockId} not found in ${file.basename}`);
      }

      setCardData(card);
    } catch (err) {
      console.error('[SimpleKanbanCardEmbed] Error loading card data:', err);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const findCardInContent = async (
    content: string,
    targetBlockId: string,
    boardName: string
  ): Promise<CardData | null> => {
    // Simple parsing to find the card with the target block ID
    const lines = content.split('\n');
    let currentLane = '';
    let currentLaneColor: string | undefined = undefined;
    let inCard = false;
    let cardLines: string[] = [];
    let cardTitle = '';

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Check for lane headers (## Lane Name)
      if (line.startsWith('## ') && !line.startsWith('### ')) {
        currentLane = line.substring(3).trim();
        currentLaneColor = undefined; // Reset color for new lane

        // Look ahead for lane color comment
        for (let j = i + 1; j < lines.length && j < i + 5; j++) {
          const nextLine = lines[j];
          if (nextLine.trim().startsWith('<!-- kanban-lane-background-color:')) {
            const colorMatch = nextLine.match(
              /<!-- kanban-lane-background-color:\s*(#[0-9a-fA-F]{6}|[a-zA-Z]+)\s*-->/
            );
            if (colorMatch && colorMatch[1]) {
              currentLaneColor = colorMatch[1].trim();
              break;
            }
          } else if (nextLine.startsWith('## ') || nextLine.startsWith('- [')) {
            // Stop looking if we hit another lane or a card
            break;
          }
        }
        continue;
      }

      // Check for card start (- [ ] or - [x])
      if (line.match(/^- \[[x ]\]/)) {
        // If we were already in a card, process the previous one
        if (inCard && cardLines.length > 0) {
          const result = processCard(
            cardLines,
            currentLane,
            currentLaneColor,
            boardName,
            targetBlockId
          );
          if (result) return result;
        }

        // Start new card
        inCard = true;
        cardLines = [line];
        cardTitle = line.replace(/^- \[[x ]\]\s*/, '').trim();
      } else if (inCard) {
        // Check if this line belongs to the current card (indented or continuation)
        if (line.startsWith('  ') || line.trim() === '' || line.startsWith('\t')) {
          cardLines.push(line);
        } else if (line.startsWith('- ')) {
          // New card starting, process the previous one
          const result = processCard(
            cardLines,
            currentLane,
            currentLaneColor,
            boardName,
            targetBlockId
          );
          if (result) return result;

          // Start new card
          cardLines = [line];
          cardTitle = line.replace(/^- \[[x ]\]\s*/, '').trim();
        } else {
          // End of card section
          const result = processCard(
            cardLines,
            currentLane,
            currentLaneColor,
            boardName,
            targetBlockId
          );
          if (result) return result;
          inCard = false;
          cardLines = [];
        }
      }
    }

    // Process the last card if we ended while in one
    if (inCard && cardLines.length > 0) {
      return processCard(cardLines, currentLane, currentLaneColor, boardName, targetBlockId);
    }

    return null;
  };

  const processCard = (
    cardLines: string[],
    laneName: string,
    laneColor: string | undefined,
    boardName: string,
    targetBlockId: string
  ): CardData | null => {
    const fullCardText = cardLines.join('\n');

    // Check if this card contains the target block ID
    if (!fullCardText.includes(`^${targetBlockId}`)) {
      return null;
    }

    // Extract title from first line
    const firstLine = cardLines[0] || '';
    let title = firstLine.replace(/^- \[[x ]\]\s*/, '').trim();

    // Remove the block ID from title if it's there
    title = title.replace(/\s*\^[a-zA-Z0-9]+\s*$/, '').trim();

    // Extract content (everything after the first line, cleaned up)
    const contentLines = cardLines
      .slice(1)
      .map((line) => line.replace(/^ {2}/, '')) // Remove indentation
      .filter((line) => line.trim() !== ''); // Remove empty lines

    const content = contentLines.join('\n').trim();

    // Extract tags (simple regex for #tag)
    const tagMatches = fullCardText.match(/#[\w-]+/g) || [];
    const tags = tagMatches.map((tag) => tag.substring(1)); // Remove #

    // Extract basic metadata (dates, priorities, etc.)
    const metadata: any = {};

    // Look for date patterns
    const dateMatch = fullCardText.match(/@\{([^}]+)\}/);
    if (dateMatch) {
      metadata.date = dateMatch[1];
    }

    // Look for priority
    const priorityMatch = fullCardText.match(/!(high|medium|low)/i);
    if (priorityMatch) {
      metadata.priority = priorityMatch[1].toLowerCase();
    }

    // Look for assigned members (@@member syntax)
    const memberMatches = fullCardText.match(/@@(\w+)/g) || [];
    const assignedMembers = memberMatches.map((match) => match.substring(2)); // Remove @@

    return {
      title,
      titleRaw: title, // Use the cleaned title as titleRaw
      content,
      tags,
      metadata,
      laneName,
      laneColor,
      boardName,
      checked: false,
      assignedMembers,
      priority: metadata.priority as 'high' | 'medium' | 'low' | undefined,
      date: metadata.date,
    };
  };

  const handleCardClick = () => {
    // Create obsidian:// URL to open the card
    const vaultName = plugin.app.vault.getName();
    const encodedPath = encodeURIComponent(filePath);
    const url = `obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodedPath}#^${blockId}`;

    // Open the URL
    window.open(url, '_self');
  };

  if (loading) {
    return (
      <div
        className="kanban-plugin__card-embed-item"
        style={{ minHeight: '200px', minWidth: '200px' }}
      >
        <div className="kanban-plugin__card-embed-header-info">
          <span style={{ opacity: 0.3 }}>Board Name → Lane Name</span>
        </div>

        <div className="kanban-plugin__card-embed-title-content">
          <div style={{ opacity: 0.3, marginBottom: '8px' }}>Loading card title...</div>
          <div style={{ opacity: 0.2, fontSize: '0.9em' }}>Additional content line</div>
        </div>

        {/* Placeholder for tags */}
        <div className="kanban-plugin__linked-card-tags" style={{ marginTop: 'var(--size-4-2)' }}>
          <span className="kanban-plugin__linked-card-tag" style={{ opacity: 0.2 }}>
            tag1
          </span>
          <span className="kanban-plugin__linked-card-tag" style={{ opacity: 0.2 }}>
            tag2
          </span>
        </div>

        {/* Placeholder for metadata */}
        <div className="kanban-plugin__linked-card-metadata" style={{ marginTop: '4px' }}>
          <div className="kanban-plugin__linked-card-metadata-left">
            <span style={{ opacity: 0.2, fontSize: '1.1em' }}>📅 2024-01-01</span>
          </div>
          <div className="kanban-plugin__linked-card-metadata-right">
            <div
              style={{
                opacity: 0.2,
                width: '20px',
                height: '20px',
                borderRadius: '50%',
                backgroundColor: 'var(--background-modifier-hover)',
                display: 'inline-block',
              }}
            ></div>
            <div
              style={{
                opacity: 0.2,
                padding: '2px 6px',
                borderRadius: '4px',
                backgroundColor: 'var(--background-modifier-hover)',
                display: 'inline-block',
                marginLeft: '4px',
                fontSize: 'var(--font-ui-smaller)',
              }}
            >
              High
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div
        className="kanban-plugin__item kanban-plugin__card-embed-error"
        style={{ borderColor: 'var(--text-error)' }}
      >
        <div className="kanban-plugin__item-content-wrapper">
          <div className="kanban-plugin__item-title-wrapper">
            <div className="kanban-plugin__item-title">
              <div className="kanban-plugin__markdown-preview-wrapper">
                <div className="kanban-plugin__markdown-preview-view">⚠️ Error loading card</div>
              </div>
            </div>
          </div>
          {(error || displayText) && (
            <div className="kanban-plugin__item-metadata-wrapper">
              <div className="kanban-plugin__item-metadata">
                {error && (
                  <span style={{ color: 'var(--text-error)', fontSize: 'var(--font-ui-smaller)' }}>
                    {error}
                  </span>
                )}
                {displayText && (
                  <span style={{ fontStyle: 'italic' }}>Original link: {displayText}</span>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  if (!cardData) {
    return (
      <div className="kanban-plugin__card-embed-edit-mode-container">
        <div className="kanban-plugin__card-embed-item">
          <div className="kanban-plugin__card-embed-title-content">🔗 Card not found</div>
        </div>
      </div>
    );
  }

  // Check if lane colors should be used
  const useLaneColors = plugin.settings['use-kanban-board-background-colors'];
  const cardStyle =
    useLaneColors && cardData.laneColor ? { backgroundColor: cardData.laneColor } : {};
  const hideHashForTagsWithoutSymbols = plugin.settings.hideHashForTagsWithoutSymbols;

  // Convert CardData to LinkedCard format for consistent rendering
  const card = {
    title: cardData.title,
    titleRaw: cardData.titleRaw,
    content: cardData.content,
    boardName: cardData.boardName,
    boardPath: filePath,
    laneName: cardData.laneName,
    laneColor: cardData.laneColor,
    blockId: blockId,
    tags: cardData.tags.map((tag) => (tag.startsWith('#') ? tag : `#${tag}`)),
    metadata: cardData.metadata,
    checked: cardData.checked,
    assignedMembers: cardData.assignedMembers,
    priority: cardData.priority,
    date: cardData.date,
  };

  return (
    <div className="kanban-plugin__card-embed-edit-mode-container">
      <div
        className="kanban-plugin__card-embed-item"
        style={cardStyle}
        onClick={(e) => {
          e.stopPropagation();
          e.preventDefault();
          handleCardClick();
        }}
        onMouseDown={(e) => {
          e.stopPropagation();
          e.preventDefault();
        }}
        onPointerDown={(e) => {
          e.stopPropagation();
          e.preventDefault();
        }}
      >
        <div className="kanban-plugin__card-embed-header-info">
          <span className="kanban-plugin__linked-card-board-name">{card.boardName}</span>
          <span className="kanban-plugin__linked-card-separator">→</span>
          <span className="kanban-plugin__linked-card-lane-name">{card.laneName}</span>
        </div>

        <div className="kanban-plugin__card-embed-title-content">
          {renderMarkdownLists(cleanCardTitle(card.titleRaw || card.title), plugin, sourcePath)}
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
              <div
                className="kanban-plugin__linked-card-tags"
                style={{ marginTop: 'var(--size-4-2)' }}
              >
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
                      tagContent = tagWithHash.length > 1 ? tagWithHash.slice(1) : tagWithHash;
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
          <div className="kanban-plugin__linked-card-metadata" style={{ marginTop: '4px' }}>
            <div className="kanban-plugin__linked-card-metadata-left">
              {card.date && (
                <span className="kanban-plugin__linked-card-date">
                  {' '}
                  <span
                    style={(() => {
                      // Try to parse the date using the configured date format first, then fallback to common formats
                      const configuredDateFormat = plugin.settings['date-format'] || 'YYYY-MM-DD';
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

                      const dateColor = dateMoment.isValid() ? getDateColor(dateMoment) : null;

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
                        marginTop: '-4px',
                        marginLeft: '-4px',
                        fontSize: '1.1em',
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
                      (memberConfig?.background ? 'var(--text-on-accent)' : 'var(--text-normal)');
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
                          fontSize: '12px',
                          // cursor: 'pointer',
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
    </div>
  );
});
