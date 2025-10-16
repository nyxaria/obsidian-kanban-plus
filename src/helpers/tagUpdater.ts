import { StateManager } from '../StateManager';
import { Board, Item } from '../components/types';

/**
 * Helper function to replace a tag in item content
 */
export function replaceTagInContent(content: string, oldTag: string, newTag: string): string {
  if (!content) return content;

  // Normalize tags (ensure they start with #)
  const normalizedOldTag = oldTag.startsWith('#') ? oldTag : `#${oldTag}`;
  const normalizedNewTag = newTag.startsWith('#') ? newTag : `#${newTag}`;

  // Create regex to match the old tag with word boundaries
  // This ensures we match the tag as a whole word, not as part of another tag
  const tagRegex = new RegExp(
    `(?:^|\\s)(${normalizedOldTag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})(?=\\s|$)`,
    'gi'
  );

  // Replace the old tag with the new tag, preserving the surrounding whitespace
  return content.replace(tagRegex, ` ${normalizedNewTag}`);
}

/**
 * Create a tag string from a name (convert to lowercase and replace spaces with dashes)
 */
export function createTagFromName(name: string): string {
  return `#${name.toLowerCase().replace(/\s+/g, '-')}`;
}

/**
 * Update all items in a board that contain a specific tag
 */
export function updateBoardTags(
  board: Board,
  oldTag: string,
  newTag: string,
  stateManager: StateManager
): Board {
  const updatedBoard = { ...board };

  updatedBoard.children = board.children.map((lane) => ({
    ...lane,
    children: lane.children.map((item) => {
      // Check if the item's titleRaw contains the old tag
      if (item.data.titleRaw && item.data.titleRaw.includes(oldTag)) {
        const updatedTitleRaw = replaceTagInContent(item.data.titleRaw, oldTag, newTag);

        // Use updateItemContent to properly re-parse and re-hydrate the item
        return stateManager.updateItemContent(item, updatedTitleRaw);
      }

      return item;
    }),
  }));

  return updatedBoard;
}

/**
 * Update all items in a specific lane that contain a specific tag
 */
export function updateLaneTags(
  board: Board,
  laneIndex: number,
  oldTag: string,
  newTag: string,
  stateManager: StateManager
): Board {
  if (laneIndex < 0 || laneIndex >= board.children.length) {
    console.log('[tagUpdater] Invalid lane index:', laneIndex);
    return board;
  }

  const lane = board.children[laneIndex];
  console.log(
    '[tagUpdater] Processing lane:',
    lane.data?.title,
    'with',
    lane.children.length,
    'items'
  );
  console.log('[tagUpdater] Looking for old tag:', oldTag, 'to replace with:', newTag);

  // Create a new children array with updated items
  const updatedChildren = lane.children.map((item, idx) => {
    console.log('[tagUpdater] Item', idx, 'titleRaw:', item.data.titleRaw);

    // Check if the item's titleRaw contains the old tag (case-insensitive check)
    const normalizedOldTag = oldTag.startsWith('#') ? oldTag : `#${oldTag}`;
    const lowerTitleRaw = item.data.titleRaw?.toLowerCase() || '';
    const lowerOldTag = normalizedOldTag.toLowerCase();

    if (item.data.titleRaw && lowerTitleRaw.includes(lowerOldTag)) {
      console.log('[tagUpdater] Found old tag in item', idx, '- replacing...');
      const updatedTitleRaw = replaceTagInContent(item.data.titleRaw, oldTag, newTag);
      console.log('[tagUpdater] Updated titleRaw:', updatedTitleRaw);

      // Use updateItemContent to properly re-parse and re-hydrate the item
      const updatedItem = stateManager.updateItemContent(item, updatedTitleRaw);
      console.log('[tagUpdater] Updated item metadata tags:', updatedItem.data.metadata?.tags);

      return updatedItem;
    }

    return item;
  });

  // Create a new lanes array with the updated lane
  const updatedLanes = [...board.children];
  updatedLanes[laneIndex] = {
    ...lane,
    children: updatedChildren,
  };

  // Return a new board object
  return {
    ...board,
    children: updatedLanes,
  };
}
