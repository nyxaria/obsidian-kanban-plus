import update from 'immutability-helper';
import { Content, List, Parent, Root } from 'mdast';
import { ListItem } from 'mdast-util-from-markdown/lib';
import { toString } from 'mdast-util-to-string';
import moment from 'moment';
import { stringifyYaml } from 'obsidian';
import { KanbanSettings } from 'src/Settings';
import { StateManager } from 'src/StateManager';
import { generateInstanceId } from 'src/components/helpers';
import {
  Board,
  BoardTemplate,
  Item,
  ItemData,
  ItemTemplate,
  Lane,
  LaneTemplate,
} from 'src/components/types';
import { laneTitleWithMaxItems } from 'src/helpers';
import { defaultSort } from 'src/helpers/util';
import { t } from 'src/lang/helpers';
import { visit } from 'unist-util-visit';

import { archiveString, completeString, settingsToCodeblock } from '../common';
import { DateNode, FileNode, TimeNode, ValueNode } from '../extensions/types';
import {
  ContentBoundary,
  getNextOfType,
  getNodeContentBoundary,
  getPrevSibling,
  getStringFromBoundary,
} from '../helpers/ast';
import { hydrateItem, preprocessTitle } from '../helpers/hydrateBoard';
import { extractInlineFields, taskFields } from '../helpers/inlineMetadata';
import {
  addBlockId,
  dedentNewLines,
  executeDeletion,
  indentNewLines,
  markRangeForDeletion,
  parseLaneTitle,
  removeBlockId,
  replaceBrs,
  replaceNewLines,
} from '../helpers/parser';
import { parseFragment } from '../parseMarkdown';

interface TaskItem extends ListItem {
  checkChar?: string;
}

export function listItemToItemData(stateManager: StateManager, md: string, item: TaskItem) {
  const moveTags = stateManager.getSetting('move-tags');
  const moveDates = stateManager.getSetting('move-dates');
  const dateFormat = stateManager.getSetting('date-format');

  const startNode = item.children.first();
  const endNode = item.children.last();

  const start =
    startNode.type === 'paragraph'
      ? getNodeContentBoundary(startNode).start
      : startNode.position.start.offset;
  const end =
    endNode.type === 'paragraph'
      ? getNodeContentBoundary(endNode).end
      : endNode.position.end.offset;
  const itemBoundary: ContentBoundary = { start, end };

  let itemContent = getStringFromBoundary(md, itemBoundary);

  // Handle empty task
  if (itemContent === '[' + (item.checked ? item.checkChar : ' ') + ']') {
    itemContent = '';
  }

  let title = itemContent;
  let titleSearch = '';

  visit(
    item,
    ['text', 'wikilink', 'embedWikilink', 'image', 'inlineCode', 'code', 'hashtag'],
    (node: any, i, parent) => {
      if (node.type === 'hashtag') {
        if (!parent.children.first()?.value?.startsWith('```')) {
          titleSearch += ' #' + node.value;
        }
      } else {
        titleSearch += node.value || node.alt || '';
      }
    }
  );

  const itemData: ItemData = {
    titleRaw: removeBlockId(dedentNewLines(replaceBrs(itemContent))),
    blockId: undefined,
    title: '',
    titleSearch,
    titleSearchRaw: titleSearch,
    metadata: {
      dateStr: undefined,
      date: undefined,
      time: undefined,
      timeStr: undefined,
      tags: [],
      fileAccessor: undefined,
      file: undefined,
      fileMetadata: undefined,
      fileMetadataOrder: undefined,
    },
    assignedMembers: [],
    checked: item.checked,
    checkChar: item.checked ? item.checkChar || ' ' : ' ',
    position: {
      start: {
        line: item.position.start.line,
        column: item.position.start.column,
        offset: item.position.start.offset ?? -1,
      },
      end: {
        line: item.position.end.line,
        column: item.position.end.column,
        offset: item.position.end.offset ?? -1,
      },
    },
  };

  visit(item, (node, i, parent) => {
    const genericNode = node as ValueNode;

    if (genericNode.type === 'blockid') {
      itemData.blockId = genericNode.value;
      return true;
    }

    if (
      genericNode.type === 'hashtag' &&
      !(parent.children.first() as any)?.value?.startsWith('```')
    ) {
      if (!itemData.metadata.tags) {
        itemData.metadata.tags = [];
      }

      itemData.metadata.tags.push('#' + genericNode.value);

      if (moveTags) {
        title = markRangeForDeletion(title, {
          start: node.position.start.offset - itemBoundary.start,
          end: node.position.end.offset - itemBoundary.start,
        });
      }
      return true;
    }

    if (genericNode.type === 'date' || genericNode.type === 'dateLink') {
      itemData.metadata.dateStr = (genericNode as DateNode).date;

      if (moveDates) {
        title = markRangeForDeletion(title, {
          start: node.position.start.offset - itemBoundary.start,
          end: node.position.end.offset - itemBoundary.start,
        });
      }
      return true;
    }

    if (genericNode.type === 'time') {
      itemData.metadata.timeStr = (genericNode as TimeNode).time;
      if (moveDates) {
        title = markRangeForDeletion(title, {
          start: node.position.start.offset - itemBoundary.start,
          end: node.position.end.offset - itemBoundary.start,
        });
      }
      return true;
    }

    if (genericNode.type === 'embedWikilink') {
      itemData.metadata.fileAccessor = (genericNode as FileNode).fileAccessor;
      return true;
    }

    if (genericNode.type === 'wikilink') {
      const linkContent = (genericNode as ValueNode).value;
      if (linkContent && dateFormat) {
        const potentialDate = moment(linkContent.trim(), dateFormat, true);

        if (potentialDate.isValid()) {
          if (!itemData.metadata.dateStr) {
            itemData.metadata.dateStr = potentialDate.format(dateFormat);
          }

          if (moveDates) {
            title = markRangeForDeletion(title, {
              start: genericNode.position.start.offset - itemBoundary.start,
              end: genericNode.position.end.offset - itemBoundary.start,
            });
          }
          itemData.metadata.fileAccessor = (genericNode as FileNode).fileAccessor;
          itemData.metadata.fileMetadata = (genericNode as FileNode).fileMetadata;
          itemData.metadata.fileMetadataOrder = (genericNode as FileNode).fileMetadataOrder;
          return true;
        }
      }
      itemData.metadata.fileAccessor = (genericNode as FileNode).fileAccessor;
      itemData.metadata.fileMetadata = (genericNode as FileNode).fileMetadata;
      itemData.metadata.fileMetadataOrder = (genericNode as FileNode).fileMetadataOrder;
      return true;
    }

    if (genericNode.type === 'link' && (genericNode as FileNode).fileAccessor) {
      itemData.metadata.fileAccessor = (genericNode as FileNode).fileAccessor;
      itemData.metadata.fileMetadata = (genericNode as FileNode).fileMetadata;
      itemData.metadata.fileMetadataOrder = (genericNode as FileNode).fileMetadataOrder;
      return true;
    }

    if (genericNode.type === 'embedLink') {
      itemData.metadata.fileAccessor = (genericNode as FileNode).fileAccessor;
      return true;
    }
  });

  // Initialize assignedMembers array
  itemData.assignedMembers = [];

  // Parse @@MemberName for assigned members from the potentially modified 'title'
  const memberRegex = /(?:^|\s)(@@[a-zA-Z0-9_-]+)/g;
  let match;

  // Use the 'title' string, which may have been modified by tag/date removal
  // The regex exec method maintains state with lastIndex, so we operate on a stable string for finding matches.
  const titleForMemberParsing = title;

  while ((match = memberRegex.exec(titleForMemberParsing)) !== null) {
    const fullMatchString = match[0]; // e.g., " @@Alice" or "@@Alice"
    const memberTagString = match[1]; // e.g., "@@Alice"
    const memberName = memberTagString.substring(2); // "Alice"

    // itemData.assignedMembers is guaranteed to be an array here
    if (!itemData.assignedMembers.includes(memberName)) {
      itemData.assignedMembers.push(memberName);
    }

    // Calculate the start index of the "@@Name" part (e.g., "@@Alice")
    // match.index is the start of fullMatchString (" @@Alice")
    // memberTagString is "@@Alice"
    // The difference in their lengths gives the length of the prefix (e.g., the leading space)
    const prefixLength = fullMatchString.length - memberTagString.length;
    const memberTagStartIndex = match.index + prefixLength;

    // Mark the member tag itself (e.g., @@Alice) for deletion from title
    title = markRangeForDeletion(title, {
      start: memberTagStartIndex,
      end: memberTagStartIndex + memberTagString.length,
    });
  }

  // Parse !priority from the potentially modified 'title'
  const priorityRegex = /(?:^|\s)(!low|!medium|!high)(?=\s|$)/i; // Case-insensitive for parsing
  const priorityMatch = title.match(priorityRegex);

  if (priorityMatch) {
    const fullPriorityString = priorityMatch[0]; // e.g., " !high" or "!high"
    const priorityTag = priorityMatch[1].toLowerCase() as 'low' | 'medium' | 'high'; // e.g., "!high" -> "high"

    itemData.metadata.priority = priorityTag.substring(1) as 'low' | 'medium' | 'high';

    // Calculate start index for deletion
    const priorityTagStartIndex =
      title.indexOf(fullPriorityString) + (fullPriorityString.length - priorityMatch[1].length);

    // Mark the priority tag itself (e.g., !high) for deletion from title
    title = markRangeForDeletion(title, {
      start: priorityTagStartIndex,
      end: priorityTagStartIndex + priorityMatch[1].length,
    });
    console.log(`[listItemToItemData] Extracted priority: ${itemData.metadata.priority}`);
    console.log(
      `[listItemToItemData] Marked priority string "${priorityMatch[1]}" for deletion from title.`
    );
  }

  itemData.title = executeDeletion(title).trim();

  // Last, hydrate the date field for consistency
  if (itemData.metadata.dateStr) {
    itemData.metadata.date = moment(itemData.metadata.dateStr, dateFormat);
  }

  const firstLineEnd = itemData.title.indexOf('\n');
  const inlineFields = extractInlineFields(itemData.title, true);

  if (inlineFields?.length) {
    const inlineMetadata = (itemData.metadata.inlineMetadata = inlineFields.reduce((acc, curr) => {
      if (!taskFields.has(curr.key)) acc.push(curr);
      else if (firstLineEnd <= 0 || curr.end < firstLineEnd) acc.push(curr);

      return acc;
    }, []));

    const moveTaskData = stateManager.getSetting('move-task-metadata');
    const moveMetadata = stateManager.getSetting('inline-metadata-position') !== 'body';

    if (moveTaskData || moveMetadata) {
      let title = itemData.title;
      for (const item of [...inlineMetadata].reverse()) {
        const isTask = taskFields.has(item.key);

        if (isTask && !moveTaskData) continue;
        if (!isTask && !moveMetadata) continue;

        title = title.slice(0, item.start) + title.slice(item.end);
      }

      itemData.title = title;
    }
  }

  itemData.metadata.tags?.sort(defaultSort);

  return itemData;
}

function isArchiveLane(child: Content, children: Content[], currentIndex: number) {
  if (child.type !== 'heading' || toString(child, { includeImageAlt: false }) !== t('Archive')) {
    return false;
  }

  const prev = getPrevSibling(children, currentIndex);

  return prev && prev.type === 'thematicBreak';
}

export function astToUnhydratedBoard(
  stateManager: StateManager,
  settings: KanbanSettings,
  frontmatter: Record<string, any>,
  root: Root,
  md: string
): Board {
  const lanes: Lane[] = [];
  const archive: Item[] = [];
  root.children.forEach((child, index) => {
    if (child.type === 'heading') {
      const isArchive = isArchiveLane(child, root.children, index);
      const headingBoundary = getNodeContentBoundary(child as Parent);
      const title = getStringFromBoundary(md, headingBoundary);

      let shouldMarkItemsComplete = false;
      let parsedLaneId: string | null = null;
      let parsedLaneBackgroundColor: string | null = null;

      let idNodeIndex = -1;

      for (let i = index + 1; i < root.children.length; i++) {
        const currentNode = root.children[i];

        if (currentNode.type === 'heading' || currentNode.type === 'list') {
          break;
        }

        if (currentNode.type === 'html') {
          if (parsedLaneId === null) {
            const idCommentRegex = /<!--\s*kanban-lane-id:\s*(.*?)\s*-->/;
            const idMatch = idCommentRegex.exec(currentNode.value as string);
            if (idMatch && idMatch[1]) {
              parsedLaneId = idMatch[1].trim();
              console.log(`[list.ts] Parsed lane ID: ${parsedLaneId} for lane titled: ${title}`);
              idNodeIndex = i;
            }
          }

          if (parsedLaneBackgroundColor === null) {
            const colorCommentRegex = /<!--\s*kanban-lane-background-color:\s*(.*?)\s*-->/;
            const colorMatch = colorCommentRegex.exec(currentNode.value as string);
            if (colorMatch && colorMatch[1]) {
              parsedLaneBackgroundColor = colorMatch[1].trim();
              console.log(
                `[list.ts] Parsed background color: ${parsedLaneBackgroundColor} for lane titled: ${title}`
              );
            }
          }
        }

        if ((parsedLaneId && parsedLaneBackgroundColor) || i >= index + 2) {
          break;
        }

        if (currentNode.type !== 'paragraph' && currentNode.type !== 'html') {
          break;
        }
      }

      const list = getNextOfType(root.children, index, 'list', (nodeAfterHeading) => {
        if (nodeAfterHeading.type === 'heading') return false;

        if (nodeAfterHeading.type === 'paragraph') {
          const childStr = toString(nodeAfterHeading);

          if (childStr.startsWith('%% kanban:settings')) {
            return false;
          }

          if (childStr === t('Complete')) {
            shouldMarkItemsComplete = true;
            return true;
          }
        }

        return true;
      });

      if (isArchive && list) {
        archive.push(
          ...(list as List).children.map((listItem) => {
            return {
              ...ItemTemplate,
              id: generateInstanceId(),
              data: listItemToItemData(stateManager, md, listItem),
            };
          })
        );

        return;
      }

      if (!list) {
        lanes.push({
          ...LaneTemplate,
          children: [],
          id: parsedLaneId || generateInstanceId(),
          data: {
            ...parseLaneTitle(title),
            shouldMarkItemsComplete,
            backgroundColor: parsedLaneBackgroundColor,
          },
        });
      } else {
        lanes.push({
          ...LaneTemplate,
          children: (list as List).children.map((listItem) => {
            const data = listItemToItemData(stateManager, md, listItem);
            return {
              ...ItemTemplate,
              id: generateInstanceId(),
              data,
            };
          }),
          id: parsedLaneId || generateInstanceId(),
          data: {
            ...parseLaneTitle(title),
            shouldMarkItemsComplete,
            backgroundColor: parsedLaneBackgroundColor,
          },
        });
      }
    }
  });

  return {
    ...BoardTemplate,
    id: stateManager.file.path,
    children: lanes,
    data: {
      settings,
      frontmatter,
      archive,
      isSearching: false,
      errors: [],
    },
  };
}

export function updateItemContent(stateManager: StateManager, oldItem: Item, newContent: string) {
  const md = `- [${oldItem.data.checkChar}] ${addBlockId(indentNewLines(newContent), oldItem)}`;

  const ast = parseFragment(stateManager, md);
  const itemData = listItemToItemData(stateManager, md, (ast.children[0] as List).children[0]);
  const newItem = update(oldItem, {
    data: {
      $set: itemData,
    },
  });

  try {
    hydrateItem(stateManager, newItem);
  } catch (e) {
    console.error(e);
  }

  return newItem;
}

export function newItem(
  stateManager: StateManager,
  newContent: string,
  checkChar: string,
  forceEdit?: boolean,
  laneName?: string
) {
  const trimmedContent = newContent.trim();
  const tagsArray = [];

  if (laneName) {
    const listNameTag = `#${laneName.toLowerCase().replace(/\s+/g, '-')}`;
    tagsArray.push(listNameTag);
  }

  const fileNameBase = stateManager.file.basename;
  const fileNameTag = `#${fileNameBase.toLowerCase().replace(/\s+/g, '-')}`;
  tagsArray.push(fileNameTag);

  let tagsString = '';
  if (tagsArray.length > 0) {
    tagsString = `\n\n${tagsArray.join(' ')}`;
  }

  const contentWithTags = `${trimmedContent}${tagsString}`;

  const md = `- [${checkChar}] ${indentNewLines(contentWithTags)}`;
  const ast = parseFragment(stateManager, md);
  const itemData = listItemToItemData(stateManager, md, (ast.children[0] as List).children[0]);

  itemData.forceEditMode = !!forceEdit;

  const newItem: Item = {
    ...ItemTemplate,
    id: generateInstanceId(),
    data: itemData,
  };

  try {
    hydrateItem(stateManager, newItem);
  } catch (e) {
    console.error(e);
  }

  return newItem;
}

export function reparseBoard(stateManager: StateManager, board: Board) {
  try {
    return update(board, {
      children: {
        $set: board.children.map((lane) => {
          return update(lane, {
            children: {
              $set: lane.children.map((item) => {
                return updateItemContent(stateManager, item, item.data.titleRaw);
              }),
            },
          });
        }),
      },
    });
  } catch (e) {
    stateManager.setError(e);
    throw e;
  }
}

function itemToMd(item: Item) {
  return `- [${item.data.checkChar}] ${addBlockId(indentNewLines(item.data.titleRaw), item)}`;
}

function laneToMd(lane: Lane) {
  const lines: string[] = [];

  lines.push(`## ${laneTitleWithMaxItems(lane.data.title, lane.data.maxItems)}`);
  lines.push(`<!-- kanban-lane-id: ${lane.id} -->`);
  if (lane.data?.backgroundColor) {
    lines.push(`<!-- kanban-lane-background-color: ${lane.data.backgroundColor} -->`);
  }
  lines.push('');

  if (lane.data.shouldMarkItemsComplete) {
    lines.push(completeString);
  }

  lane.children.forEach((item) => {
    lines.push(itemToMd(item));
  });

  lines.push('');
  lines.push('');
  lines.push('');

  return lines.join('\n');
}

function archiveToMd(archive: Item[]) {
  if (archive.length) {
    const lines: string[] = [archiveString, '', `## ${t('Archive')}`, ''];

    archive.forEach((item) => {
      lines.push(itemToMd(item));
    });

    return lines.join('\n');
  }

  return '';
}

export function boardToMd(board: Board) {
  const lanes = board.children.reduce((md, lane) => {
    return md + laneToMd(lane);
  }, '');

  const frontmatter = ['---', '', stringifyYaml(board.data.frontmatter), '---', '', ''].join('\n');

  return frontmatter + lanes + archiveToMd(board.data.archive) + settingsToCodeblock(board);
}
