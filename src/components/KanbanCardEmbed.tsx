import { TFile } from 'obsidian';
import { memo, useContext, useEffect, useState } from 'preact/compat';
import { KanbanView } from 'src/KanbanView';
import { hasFrontmatterKey } from 'src/helpers';
import KanbanPlugin from 'src/main';

import { MarkdownRenderer } from './MarkdownRenderer/MarkdownRenderer';
import { KanbanContext } from './context';
import { c } from './helpers';
import { Board, Item } from './types';

interface KanbanCardEmbedProps {
  filePath: string;
  blockId: string;
  plugin: KanbanPlugin;
  sourcePath: string;
  displayText?: string;
}

export const KanbanCardEmbed = memo(function KanbanCardEmbed({
  filePath,
  blockId,
  plugin,
  sourcePath,
  displayText,
}: KanbanCardEmbedProps) {
  const [cardData, setCardData] = useState<{
    item: Item;
    boardName: string;
    laneName: string;
  } | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function loadCardData() {
      try {
        setIsLoading(true);
        setError(null);

        // Get the target file
        const file = plugin.app.vault.getAbstractFileByPath(filePath);
        if (!file || !(file instanceof TFile)) {
          setError('File not found');
          return;
        }

        // Check if it's a Kanban board
        if (!hasFrontmatterKey(file)) {
          setError('Not a Kanban board');
          return;
        }

        // Get the StateManager for this file
        let stateManager = plugin.getStateManager(file);

        // If no StateManager exists, we need to create one temporarily
        if (!stateManager) {
          const fileContent = await plugin.app.vault.cachedRead(file);

          // Create a temporary view-like object for StateManager
          const tempView = { file } as KanbanView;

          // Create StateManager
          stateManager = new (await import('../StateManager')).StateManager(
            plugin.app,
            tempView,
            () => {}, // onDbChange
            () => plugin.settings // getSettings
          );

          // Parse the board data
          await stateManager.registerView(tempView, fileContent, true);
        }

        const board = stateManager.state as Board;
        if (!board) {
          setError('Could not load board data');
          return;
        }

        // Find the card with the matching blockId
        let foundCard: Item | null = null;
        let foundLaneName = '';

        for (const lane of board.children) {
          for (const item of lane.children) {
            if (item.data.blockId === blockId || item.data.blockId === `^${blockId}`) {
              foundCard = item;
              foundLaneName = lane.data.title;
              break;
            }
            // Also check if the blockId appears in the card's raw content
            if (item.data.titleRaw && item.data.titleRaw.includes(`^${blockId}`)) {
              foundCard = item;
              foundLaneName = lane.data.title;
              break;
            }
          }
          if (foundCard) break;
        }

        if (foundCard) {
          setCardData({
            item: foundCard,
            boardName: file.basename,
            laneName: foundLaneName,
          });
        } else {
          setError(`Card with block ID ^${blockId} not found`);
        }
      } catch (err) {
        console.error('Error loading Kanban card data:', err);
        setError('Error loading card data');
      } finally {
        setIsLoading(false);
      }
    }

    loadCardData();
  }, [filePath, blockId, plugin]);

  if (isLoading) {
    return (
      <div className={c('card-embed-loading')}>
        <div className={c('card-embed-spinner')}>Loading card...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className={c('card-embed-error')}>
        <span className={c('card-embed-error-icon')}>⚠️</span>
        <span>{error}</span>
        {displayText && (
          <span className={c('card-embed-fallback')}> (Original: {displayText})</span>
        )}
      </div>
    );
  }

  if (!cardData) {
    return (
      <div className={c('card-embed-not-found')}>
        <span>Card not found: ^{blockId}</span>
        {displayText && (
          <span className={c('card-embed-fallback')}> (Original: {displayText})</span>
        )}
      </div>
    );
  }

  const { item, boardName, laneName } = cardData;

  // Create a clickable link that will navigate to the card
  const handleCardClick = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    // Navigate to the board and highlight the card
    const linkText = `${filePath}#^${blockId}`;
    plugin.app.workspace.openLinkText(
      linkText,
      sourcePath,
      e.ctrlKey || e.metaKey || e.button === 1
    );
  };

  return (
    <div className={c('card-embed')} onClick={handleCardClick} style={{ cursor: 'pointer' }}>
      <div className={c('card-embed-header')}>
        <span className={c('card-embed-board-name')}>{boardName}</span>
        <span className={c('card-embed-separator')}>›</span>
        <span className={c('card-embed-lane-name')}>{laneName}</span>
        <span className={c('card-embed-link-icon')}>🔗</span>
      </div>

      <div className={c('card-embed-content')}>
        <div className={c('card-embed-checkbox')}>
          <input
            type="checkbox"
            checked={item.data.checked}
            disabled
            className={c('task-list-item-checkbox')}
          />
        </div>

        <div className={c('card-embed-text')}>
          <MarkdownRenderer
            markdownString={item.data.titleRaw || item.data.title}
            entityId={`embed-${item.id}`}
            className={c('card-embed-markdown')}
          />
        </div>
      </div>

      {item.data.metadata?.tags && item.data.metadata.tags.length > 0 && (
        <div className={c('card-embed-tags')}>
          {item.data.metadata.tags.map((tag, index) => (
            <span key={index} className={c('card-embed-tag')}>
              {tag}
            </span>
          ))}
        </div>
      )}

      {item.data.metadata?.date && (
        <div className={c('card-embed-date')}>📅 {item.data.metadata.date}</div>
      )}
    </div>
  );
});
