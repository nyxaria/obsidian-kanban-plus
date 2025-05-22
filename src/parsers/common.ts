import { App, TFile, moment } from 'obsidian';
import { KanbanSettings } from 'src/Settings';
import { StateManager } from 'src/StateManager';
import { anyToString } from 'src/components/Item/MetadataTable';
import { Board, FileMetadata, Item, ItemMetadata } from 'src/components/types';
import { defaultSort } from 'src/helpers/util';
import { t } from 'src/lang/helpers';

import { escapeRegExpStr } from '../components/helpers';

export const frontmatterKey = 'kanban-plugin';

export enum ParserFormats {
  List,
}

export interface BaseFormat {
  newItem(content: string, checkChar: string, forceEdit?: boolean): Item;
  updateItemContent(item: Item, content: string): Item;
  boardToMd(board: Board): string;
  mdToBoard(md: string): Board;
  reparseBoard(): Board;
}

export const completeString = `**${t('Complete')}**`;
export const archiveString = '***';
export const basicFrontmatter = ['---', '', `${frontmatterKey}: board`, '', '---', '', ''].join(
  '\n'
);

export function settingsToCodeblock(board: Board): string {
  return [
    '',
    '',
    '%% kanban:settings',
    '```',
    JSON.stringify(board.data.settings),
    '```',
    '%%',
  ].join('\n');
}

export function getSearchValue(item: Item, stateManager: StateManager) {
  const fileMetadata = item.data.metadata.fileMetadata;
  const { titleSearchRaw } = item.data;

  const searchValue = [titleSearchRaw];

  if (fileMetadata) {
    const presentKeys = Object.keys(fileMetadata).filter((k) => {
      return item.data.metadata.fileMetadataOrder?.includes(k);
    });
    if (presentKeys.length) {
      const keys = anyToString(presentKeys, stateManager);
      const values = anyToString(
        presentKeys.map((k) => fileMetadata[k]),
        stateManager
      );

      if (keys) searchValue.push(keys);
      if (values) searchValue.push(values);
    }
  }

  if (item.data.metadata.time) {
    searchValue.push(item.data.metadata.time.format('LLLL'));
    searchValue.push(anyToString(item.data.metadata.time, stateManager));
  } else if (item.data.metadata.date) {
    searchValue.push(item.data.metadata.date.format('LLLL'));
    searchValue.push(anyToString(item.data.metadata.date, stateManager));
  }

  return searchValue.join(' ').toLocaleLowerCase();
}

export function getDataViewCache(app: App, linkedFile: TFile, sourceFile: TFile) {
  if (
    (app as any).plugins.enabledPlugins.has('dataview') &&
    (app as any).plugins?.plugins?.dataview?.api
  ) {
    return (app as any).plugins.plugins.dataview.api.page(linkedFile.path, sourceFile.path);
  }
}

function getPageData(obj: any, path: string) {
  if (!obj) return null;
  if (obj[path]) return obj[path];

  const split = path.split('.');
  let ctx = obj;

  for (const p of split) {
    if (typeof ctx === 'object' && p in ctx) {
      ctx = ctx[p];
    } else {
      ctx = null;
      break;
    }
  }

  return ctx;
}

export function getLinkedPageMetadata(
  stateManager: StateManager,
  linkedFile: TFile | null | undefined
): { fileMetadata?: FileMetadata; fileMetadataOrder?: string[] } {
  const metaKeys = stateManager.getSetting('metadata-keys');

  if (!metaKeys.length) {
    return {};
  }

  if (!linkedFile) {
    return {};
  }

  const cache = stateManager.app.metadataCache.getFileCache(linkedFile);
  const dataviewCache = getDataViewCache(stateManager.app, linkedFile, stateManager.file);

  if (!cache && !dataviewCache) {
    return {};
  }

  const metadata: FileMetadata = {};
  const seenTags: { [k: string]: boolean } = {};
  const seenKey: { [k: string]: boolean } = {};
  const order: string[] = [];

  let haveData = false;

  metaKeys.forEach((k) => {
    if (seenKey[k.metadataKey]) return;

    seenKey[k.metadataKey] = true;

    if (k.metadataKey === 'tags') {
      let tags = cache?.tags || [];

      if (Array.isArray(cache?.frontmatter?.tags)) {
        tags = [].concat(
          tags,
          cache.frontmatter.tags.map((tag: string) => ({ tag: `#${tag}` }))
        );
      }

      if (tags?.length === 0) return;

      order.push(k.metadataKey);
      metadata.tags = {
        ...k,
        value: tags
          .map((t) => t.tag)
          .filter((t) => {
            if (seenTags[t]) {
              return false;
            }

            seenTags[t] = true;
            return true;
          })
          .sort(defaultSort),
      };

      haveData = true;
      return;
    }

    const dataviewVal = getPageData(dataviewCache, k.metadataKey);
    let cacheVal = getPageData(cache?.frontmatter, k.metadataKey);
    if (
      cacheVal !== null &&
      cacheVal !== undefined &&
      cacheVal !== '' &&
      !(Array.isArray(cacheVal) && cacheVal.length === 0)
    ) {
      if (typeof cacheVal === 'string') {
        if (/^\d{4}-\d{2}-\d{2}/.test(cacheVal)) {
          cacheVal = moment(cacheVal);
        } else if (/^\[\[[^\]]+\]\]$/.test(cacheVal)) {
          const link = (cache.frontmatterLinks || []).find((l) => l.key === k.metadataKey);
          if (link) {
            const file = stateManager.app.metadataCache.getFirstLinkpathDest(
              link.link,
              stateManager.file.path
            );
            if (file) {
              cacheVal = file;
            }
          }
        }
      } else if (Array.isArray(cacheVal)) {
        cacheVal = cacheVal.map<any>((v, i) => {
          if (typeof v === 'string' && /^\[\[[^\]]+\]\]$/.test(v)) {
            const link = (cache.frontmatterLinks || []).find(
              (l) => l.key === k.metadataKey + '.' + i.toString()
            );
            if (link) {
              const file = stateManager.app.metadataCache.getFirstLinkpathDest(
                link.link,
                stateManager.file.path
              );
              if (file) {
                return file;
              }
            }
          }
          return v;
        });
      }

      order.push(k.metadataKey);
      metadata[k.metadataKey] = {
        ...k,
        value: cacheVal,
      };
      haveData = true;
    } else if (
      dataviewVal !== undefined &&
      dataviewVal !== null &&
      dataviewVal !== '' &&
      !(Array.isArray(dataviewVal) && dataviewVal.length === 0)
    ) {
      const cachedValue = dataviewCache[k.metadataKey];

      order.push(k.metadataKey);
      metadata[k.metadataKey] = {
        ...k,
        value: cachedValue,
      };
      haveData = true;
    }
  });

  return {
    fileMetadata: haveData ? metadata : undefined,
    fileMetadataOrder: order,
  };
}

export function shouldRefreshBoard(oldSettings: KanbanSettings, newSettings: KanbanSettings) {
  if (!oldSettings && newSettings) {
    return true;
  }

  const toCompare: Array<keyof KanbanSettings> = [
    'metadata-keys',
    'date-trigger',
    'time-trigger',
    'link-date-to-daily-note',
    'date-format',
    'time-format',
    'move-dates',
    'move-tags',
    'inline-metadata-position',
    'move-task-metadata',
    'hide-card-count',
    'tag-colors',
    'date-colors',
  ];

  return !toCompare.every((k) => {
    return oldSettings[k] === newSettings[k];
  });
}

export const inlineFieldsRegEx = /(\S+?)::/g;
// export const inlineFieldsOrDatesRegEx = new RegExp(
//   `(${inlineFieldsRegEx.source})|(${dateRegEx.source})`,
//   'g'
// ); // Commented out to fix ReferenceError, dateRegEx is not top-level
export const priorityRegEx = /(?:^|\s)(!low|!medium|!high)(?=\s|$)/gi;
export const assignedMemberRegEx = /(?:^|\s)(@@([a-zA-Z0-9_/-]+))(?=\s|$)/g;

export function extractInlineMetadata(line: string, settings: KanbanSettings) {
  const metadata: ItemMetadata = {};
  let newString = line;

  // Date & Time Regex (dependent on settings)
  const dateTrigger = settings['date-trigger'] ? escapeRegExpStr(settings['date-trigger']) : '@';
  const timeTrigger = settings['time-trigger'] ? escapeRegExpStr(settings['time-trigger']) : '%';
  const dateFormat = settings['date-format'] || 'YYYY-MM-DD';
  // Regex to capture dates in curly braces {} or double brackets [[]]
  // It also captures an optional time part following the date, also in {}
  const dateRegExText = `(?:^|\\\\s)${dateTrigger}(?:\\\{([^\\}]+?)\\\}|\\[\\[([^\\]]+?)\\]\\])(?:\\\\s+${timeTrigger}\\\\{([^\\}]+?)\\\})?`;
  const dateRegEx = new RegExp(dateRegExText, 'gi');

  // Tag Regex (static)
  const tagRegEx = /(?:^|\\s)(#([a-zA-Z0-9_/-]+))\\b/g;

  // --- Extraction order matters: Dates, Times, Priority, Tags, Members, then general inline fields ---

  // 1. Extract Date and Time (if present together or date separately)
  let dateMatch;
  while ((dateMatch = dateRegEx.exec(newString)) !== null) {
    const datePart = dateMatch[1] || dateMatch[2]; // datePart is from {} or [[]]
    const timePart = dateMatch[3]; // timePart is from the optional time trigger part
    if (datePart) {
      const parsedDate = moment(datePart.trim(), dateFormat, true);
      if (parsedDate.isValid()) {
        metadata.date = parsedDate;
        metadata.dateStr = datePart.trim();
        newString = newString.replace(dateMatch[0], ' ').trim();
        console.log(`[extractInlineMetadata] Extracted date: ${metadata.dateStr}`);
        if (timePart) {
          // Basic time parsing, assuming HH:mm or similar, let moment handle it
          const parsedTime = moment(timePart.trim(), ['HH:mm', 'H:mm', 'HHmm', 'Hmm'], true);
          if (parsedTime.isValid()) {
            metadata.time = parsedTime;
            metadata.timeStr = timePart.trim();
            // The time part was already removed with dateMatch[0]
            console.log(`[extractInlineMetadata] Extracted time (with date): ${metadata.timeStr}`);
          }
        }
      }
    }
  }
  // Attempt to extract standalone time if not already captured with date
  if (!metadata.timeStr) {
    const standaloneTimeRegExText = `(?:^|\\\\s)${timeTrigger}\\\\{([^\\}]+?)\\\}`;
    const standaloneTimeRegEx = new RegExp(standaloneTimeRegExText, 'gi');
    let timeOnlyMatch;
    while ((timeOnlyMatch = standaloneTimeRegEx.exec(newString)) !== null) {
      const timeOnlyPart = timeOnlyMatch[1];
      if (timeOnlyPart) {
        const parsedTime = moment(timeOnlyPart.trim(), ['HH:mm', 'H:mm', 'HHmm', 'Hmm'], true);
        if (parsedTime.isValid()) {
          metadata.time = parsedTime;
          metadata.timeStr = timeOnlyPart.trim();
          newString = newString.replace(timeOnlyMatch[0], ' ').trim();
          console.log(`[extractInlineMetadata] Extracted standalone time: ${metadata.timeStr}`);
          break; // Assume only one standalone time specifier per card for now
        }
      }
    }
  }

  // 2. Extract Priority
  const priorityMatch = newString.match(priorityRegEx);
  if (priorityMatch && priorityMatch[0]) {
    const priorityValue = priorityMatch[0].trim().substring(1).toLowerCase() as
      | 'high'
      | 'medium'
      | 'low';
    if (['high', 'medium', 'low'].includes(priorityValue)) {
      metadata.priority = priorityValue;
      newString = newString.replace(priorityRegEx, ' ').trim();
      console.log(`[extractInlineMetadata] Extracted priority: ${metadata.priority}`);
    }
  }

  // 3. Extract Tags
  const tagMatches = Array.from(newString.matchAll(tagRegEx));
  if (tagMatches.length > 0) {
    metadata.tags = metadata.tags || [];
    tagMatches.forEach((match) => {
      metadata.tags?.push(match[1]); // match[1] is the full tag e.g. #tagname
    });
    newString = newString.replace(tagRegEx, ' ').trim();
    console.log(`[extractInlineMetadata] Extracted tags: ${JSON.stringify(metadata.tags)}`);
  }

  // 4. Extract Assigned Members
  const memberMatches = Array.from(newString.matchAll(assignedMemberRegEx));
  if (memberMatches.length > 0) {
    metadata.assignedMembers = metadata.assignedMembers || []; // Initialize if not already
    memberMatches.forEach((match) => {
      metadata.assignedMembers?.push(match[2]); // match[2] is the member name without @@
    });
    newString = newString.replace(assignedMemberRegEx, ' ').trim();
    console.log(
      `[extractInlineMetadata] Extracted members: ${JSON.stringify(metadata.assignedMembers)}`
    );
  }

  // 5. Extract Inline Fields (key::value)
  // (Assuming inlineFieldsRegEx is already defined globally)
  const inlineFieldsMatches = Array.from(newString.matchAll(inlineFieldsRegEx));
  if (inlineFieldsMatches.length > 0) {
    metadata.inlineMetadata = metadata.inlineMetadata || [];
    let tempStringForFieldRemoval = newString;
    const fieldsToRemove: string[] = [];

    inlineFieldsMatches.forEach((match) => {
      const key = match[1];
      const valueStartIndex = match.index! + match[0].length;

      // Find end of value: next inline field or end of string
      let valueEndIndex = tempStringForFieldRemoval.length;
      const remainingString = tempStringForFieldRemoval.substring(valueStartIndex);
      const nextFieldMatch = remainingString.match(inlineFieldsRegEx);
      if (nextFieldMatch) {
        valueEndIndex = valueStartIndex + nextFieldMatch.index!;
      }

      const value = tempStringForFieldRemoval.substring(valueStartIndex, valueEndIndex).trim();
      metadata.inlineMetadata?.push({ key, value });
      fieldsToRemove.push(tempStringForFieldRemoval.substring(match.index!, valueEndIndex)); // Store the full field part for removal
    });

    // Remove fields from newString one by one to avoid messing up subsequent field content
    // This is a bit crude; a more robust parser would handle nested structures or quoted values better.
    fieldsToRemove.forEach((fieldStr) => {
      newString = newString.replace(fieldStr, ' ');
    });
    newString = newString.trim();
    console.log(
      `[extractInlineMetadata] Extracted inline fields: ${JSON.stringify(metadata.inlineMetadata)}`
    );
  }

  // Final cleanup of multiple spaces that might have been introduced
  newString = newString.replace(/s{2,}/g, ' ').trim();

  return { metadata, newString };
}
