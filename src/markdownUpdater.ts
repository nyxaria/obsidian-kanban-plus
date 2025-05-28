import { App, TFile, moment } from 'obsidian';

import { KanbanSettings } from './Settings';
import { TimelineCardData } from './components/types';

// Assuming TimelineCardData is in types

// Helper to escape regex special characters
function escapeRegExp(string: string): string {
  return string.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&'); // $& means the whole matched string
}

export async function updateCardDatesInMarkdown(
  app: App,
  filePath: string,
  cardData: TimelineCardData, // Contains original title, blockId etc.
  newStartDate: moment.Moment,
  newDueDate: moment.Moment,
  settings: KanbanSettings
): Promise<void> {
  const file = app.vault.getAbstractFileByPath(filePath);
  if (!(file instanceof TFile)) {
    console.error(`[markdownUpdater] File not found: ${filePath}`);
    throw new Error(`File not found: ${filePath}`);
  }

  const dateFormat = settings['date-format'] || 'YYYY-MM-DD';
  const dateTrigger = settings.dateTrigger || '@';
  const startDateTrigger = dateTrigger + 'start'; // e.g., "@start"

  console.log(`[markdownUpdater] Using dateFormat: '${dateFormat}' from settings.`);

  // Formatted new dates
  const newDueDateStr = newDueDate.format(dateFormat);
  const newStartDateStr = newStartDate.format(dateFormat);

  // Regexes for finding and removing date triggers from strings for comparison
  const anyDateTriggerPattern = new RegExp(
    escapeRegExp(dateTrigger + '{') + '[^}]*' + escapeRegExp('}'),
    'g'
  );
  const anyStartDateTriggerPattern = new RegExp(
    escapeRegExp(startDateTrigger + '{') + '[^}]*' + escapeRegExp('}'),
    'g'
  );

  await app.vault.process(file, (content) => {
    let lines = content.split('\n');
    let itemLineIndex = -1;
    let itemLineText = '';

    // 1. Find the line
    //    Priority: Block ID, then smart title match
    if (cardData.blockId) {
      const blockIdSuffix = ` ^${cardData.blockId}`;
      itemLineIndex = lines.findIndex((line) => line.trim().endsWith(blockIdSuffix));
      if (itemLineIndex !== -1) {
        itemLineText = lines[itemLineIndex];
      } else {
        console.warn(
          `[markdownUpdater] Block ID ${cardData.blockId} not found in ${filePath}, falling back to smart title match.`
        );
      }
    }

    if (itemLineIndex === -1) {
      const rawTitleToSearch = cardData.titleRaw || cardData.title; // titleRaw is preferred as it's the full original line
      if (!rawTitleToSearch) {
        console.error(
          `[markdownUpdater] Card data for ${filePath} has no titleRaw or title to search for.`
        );
        throw new Error('Cannot find card without a title.');
      }

      // Create a "base" version of the raw title by stripping date patterns
      // This makes the search resilient to date value changes.
      const baseTitleToSearch = rawTitleToSearch
        .replace(anyDateTriggerPattern, '')
        .replace(anyStartDateTriggerPattern, '')
        .replace(/\s{2,}/g, ' ') // Normalize spaces
        .trim();

      itemLineIndex = lines.findIndex((line) => {
        if (!(line.trim().startsWith('- [ ]') || line.trim().startsWith('- [x]'))) {
          return false;
        }
        // Create a "base" version of the current line
        const baseLine = line
          .replace(anyDateTriggerPattern, '')
          .replace(anyStartDateTriggerPattern, '')
          .replace(/\s{2,}/g, ' ') // Normalize spaces
          .trim();
        // We are looking for the task content part.
        // A simple `includes` might be too broad if baseTitleToSearch is very short or common.
        // A more robust match would ensure baseTitleToSearch is a significant part of baseLine's task content.
        // For now, let's assume that if the baseLine (stripped of dates) includes the baseTitleToSearch (stripped of dates), it's a match.
        // This also implicitly handles cases where titleRaw might have contained other metadata that listItemToItemData stripped for cardData.title
        return baseLine.includes(baseTitleToSearch);
      });

      if (itemLineIndex !== -1) {
        itemLineText = lines[itemLineIndex];
        console.log(
          `[markdownUpdater] Found line by smart title match: "${itemLineText}" (Base searched: "${baseTitleToSearch}")`
        );
      }
    }

    if (itemLineIndex === -1) {
      console.error(
        `[markdownUpdater] Could not find card (raw: "${cardData.titleRaw}", title: "${cardData.title}", base search: "${cardData.titleRaw?.replace(anyDateTriggerPattern, '').replace(anyStartDateTriggerPattern, '').trim()}") in ${filePath}`
      );
      throw new Error(`Could not find card "${cardData.title}" in file for update.`);
    }

    // 2. Replace/add date strings
    let updatedLine = itemLineText;

    // Due Date: @{DATE}
    const dueDateRegex = new RegExp(
      escapeRegExp(dateTrigger + '{') + '[^}]*' + escapeRegExp('}'),
      'g'
    );
    if (updatedLine.match(dueDateRegex)) {
      updatedLine = updatedLine.replace(dueDateRegex, `${dateTrigger}{${newDueDateStr}}`);
    } else {
      // Add new due date tag - append before block ID if present, otherwise at end of logical content
      const blockIdSuffix = cardData.blockId ? ` ^${cardData.blockId}` : '';
      const tagToAdd = ` ${dateTrigger}{${newDueDateStr}}`;
      if (blockIdSuffix && updatedLine.includes(blockIdSuffix)) {
        updatedLine = updatedLine.replace(blockIdSuffix, `${tagToAdd}${blockIdSuffix}`);
      } else {
        updatedLine += tagToAdd;
      }
    }

    // Start Date: @start{DATE}
    // Only add/update if moveDates is effectively true (implied by managing these tags)
    // We'll assume if a startDateTrigger is configured, we manage it.
    // A more robust check would be to use the actual 'moveDates' setting if available here.
    const startDateRegex = new RegExp(
      escapeRegExp(startDateTrigger + '{') + '[^}]*' + escapeRegExp('}'),
      'g'
    );
    if (updatedLine.match(startDateRegex)) {
      updatedLine = updatedLine.replace(startDateRegex, `${startDateTrigger}{${newStartDateStr}}`);
    } else {
      // Add new start date tag
      const blockIdSuffix = cardData.blockId ? ` ^${cardData.blockId}` : '';
      const tagToAdd = ` ${startDateTrigger}{${newStartDateStr}}`;
      if (blockIdSuffix && updatedLine.includes(blockIdSuffix)) {
        updatedLine = updatedLine.replace(blockIdSuffix, `${tagToAdd}${blockIdSuffix}`);
      } else {
        // If adding both due and start, and due was just added, ensure space.
        // This logic can get complex depending on where tags should be placed.
        // Simplest for now: just append.
        updatedLine += tagToAdd;
      }
    }

    // Remove multiple spaces that might have been introduced
    updatedLine = updatedLine.replace(/\s{2,}/g, ' ');

    lines[itemLineIndex] = updatedLine;
    return lines.join('\n');
  });

  // The cache might be stale for this file, clear it.
  // This helps ensure that the next read of the file (e.g., by scanCards) gets the fresh data.
  // However, direct cache manipulation can be tricky.
  // A safer way is to rely on Obsidian's own file event handling or trigger a re-evaluation.
  // For now, we'll skip direct cache manipulation. Obsidian should pick up the change.
}
