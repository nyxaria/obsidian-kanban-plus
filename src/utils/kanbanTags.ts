import { MdastList, MdastListItem, MdastRoot } from 'mdast';
import { TFile, TFolder } from 'obsidian';

import { KanbanSettings } from '../Settings';
import { StateManager } from '../StateManager';
import { ItemData } from '../components/types';
import { hasFrontmatterKey } from '../helpers';
import { listItemToItemData } from '../parsers/formats/list';
import { parseMarkdown } from '../parsers/parseMarkdown';

// Added ItemData import

export async function getAllTagsFromKanbanBoards(stateManager: StateManager): Promise<string[]> {
  const app = stateManager.app;
  const allTags = new Set<string>();
  const files = app.vault.getMarkdownFiles();

  for (const mdFile of files) {
    // Ensure hasFrontmatterKey is called correctly. It expects a TFile.
    // The original KanbanWorkspaceView uses a more complex check involving reading frontmatter.
    // For now, let's assume `hasFrontmatterKey(mdFile)` is sufficient if it checks the app's metadataCache
    // for the frontmatter key `kanban-plugin`. If not, this might need adjustment.
    // The `hasFrontmatterKey` in `src/helpers.ts` does:
    // `const fm = app.metadataCache.getFileCache(file)?.frontmatter;`
    // `return !!fm && fm['kanban-plugin'];`
    // This looks correct as it uses the file object and app context from stateManager.

    if (hasFrontmatterKey(mdFile, app)) {
      // Pass app to hasFrontmatterKey
      try {
        const fileContent = await app.vault.cachedRead(mdFile);

        const parseResult = parseMarkdown(stateManager, fileContent);
        if (!parseResult) {
          console.warn(
            '[Kanban Plugin] Skipping file ' +
              mdFile.path +
              ' as it could not be parsed or is not a Kanban board.'
          );
          continue;
        }
        const { ast } = parseResult as { ast: MdastRoot; settings: KanbanSettings };

        for (const astNode of ast.children) {
          if (astNode.type === 'list') {
            for (const listItemNode of (astNode as MdastList).children) {
              if (listItemNode.type === 'listItem') {
                const itemData: ItemData = listItemToItemData(
                  stateManager,
                  fileContent,
                  listItemNode as MdastListItem
                );
                if (itemData.metadata?.tags) {
                  itemData.metadata.tags.forEach((tag) => {
                    const cleanTag = tag.startsWith('#') ? tag.substring(1) : tag;
                    if (cleanTag.trim()) {
                      // Ensure non-empty tag after cleaning
                      allTags.add(cleanTag.trim());
                    }
                  });
                }
              }
            }
          }
        }
      } catch (e) {
        console.warn('[Kanban Plugin] Error parsing ' + mdFile.path + ' for tags:', e);
      }
    }
  }
  return Array.from(allTags).sort();
}
