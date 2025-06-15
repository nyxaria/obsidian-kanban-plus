import { TFile } from 'obsidian';
import { memo, useEffect, useState } from 'preact/compat';
import { hasFrontmatterKey } from 'src/helpers';
import KanbanPlugin from 'src/main';

import { c } from './helpers';
import { ItemData } from './types';

interface SimpleKanbanCardEmbedProps {
  filePath: string;
  blockId: string;
  plugin: KanbanPlugin;
  sourcePath: string;
  displayText?: string;
}

interface CardData {
  title: string;
  content: string;
  tags: string[];
  metadata: any;
  laneName: string;
  laneColor?: string;
  boardName: string;
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
      .map((line) => line.replace(/^  /, '')) // Remove indentation
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

    return {
      title,
      content,
      tags,
      metadata,
      laneName,
      laneColor,
      boardName,
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
      <div className="kanban-plugin__item kanban-plugin__card-embed-loading">
        <div className="kanban-plugin__item-content-wrapper">
          <div className="kanban-plugin__item-title-wrapper">
            <div className="kanban-plugin__item-title">
              <div className="kanban-plugin__markdown-preview-wrapper">
                <div className="kanban-plugin__markdown-preview-view">Loading card...</div>
              </div>
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
      <div className="kanban-plugin__item kanban-plugin__card-embed-not-found">
        <div className="kanban-plugin__item-content-wrapper">
          <div className="kanban-plugin__item-title-wrapper">
            <div className="kanban-plugin__item-title">
              <div className="kanban-plugin__markdown-preview-wrapper">
                <div className="kanban-plugin__markdown-preview-view">🔗 Card not found</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Check if lane colors should be used
  const useLaneColors = plugin.settings['use-kanban-board-background-colors'];
  const cardStyle = {
    cursor: 'pointer',
    margin: 'var(--size-4-2) 0',
    ...(useLaneColors && cardData.laneColor ? { backgroundColor: cardData.laneColor } : {}),
  };

  return (
    <div
      className="kanban-plugin__item kanban-plugin__card-embed-item"
      onClick={handleCardClick}
      style={cardStyle}
    >
      <div className="kanban-plugin__item-content-wrapper">
        <div className="kanban-plugin__item-title-wrapper">
          <div className="kanban-plugin__item-title">
            <div className="kanban-plugin__markdown-preview-wrapper">
              <div className="kanban-plugin__markdown-preview-view">
                <div className="kanban-plugin__card-embed-header-info">
                  🔗 {cardData.boardName} → {cardData.laneName}
                </div>
                <div className="kanban-plugin__card-embed-title-content">{cardData.title}</div>
              </div>
            </div>
          </div>
        </div>

        {cardData.content && (
          <div className="kanban-plugin__item-content-wrapper" style={{ paddingTop: 0 }}>
            <div className="kanban-plugin__markdown-preview-wrapper">
              <div className="kanban-plugin__markdown-preview-view">
                <div
                  style={{
                    paddingInline: '8px',
                    paddingBlock: '6px',
                    color: 'var(--text-muted)',
                    fontSize: '0.875rem',
                    lineHeight: 'var(--line-height-tight)',
                    whiteSpace: 'pre-wrap',
                  }}
                >
                  {cardData.content}
                </div>
              </div>
            </div>
          </div>
        )}

        {(cardData.tags.length > 0 || cardData.metadata.date || cardData.metadata.priority) && (
          <div className="kanban-plugin__item-metadata-wrapper">
            <div className="kanban-plugin__item-metadata">
              {cardData.tags.length > 0 && (
                <div className="kanban-plugin__item-tags">
                  {cardData.tags.map((tag) => (
                    <span key={tag} className="kanban-plugin__item-tag">
                      #{tag}
                    </span>
                  ))}
                </div>
              )}
              {cardData.metadata.date && (
                <span className="kanban-plugin__item-metadata-date-wrapper">
                  📅 {cardData.metadata.date}
                </span>
              )}
              {cardData.metadata.priority && (
                <span>
                  {cardData.metadata.priority === 'high'
                    ? '🔴'
                    : cardData.metadata.priority === 'medium'
                      ? '🟡'
                      : '🟢'}
                  {cardData.metadata.priority}
                </span>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
});
