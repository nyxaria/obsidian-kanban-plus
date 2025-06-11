import { TFile } from 'obsidian';
import { KanbanSettings } from 'src/Settings';
import { Nestable } from 'src/dnd/types';
import { InlineField } from 'src/parsers/helpers/inlineMetadata';
import { FileAccessor } from 'src/parsers/helpers/parser';

export enum LaneSort {
  TitleAsc,
  TitleDsc,
  DateAsc,
  DateDsc,
  TagsAsc,
  TagsDsc,
}

export interface LaneData {
  shouldMarkItemsComplete?: boolean;
  title: string;
  maxItems?: number;
  dom?: HTMLDivElement;
  forceEditMode?: boolean;
  sorted?: LaneSort | string;
  backgroundColor?: string;
}

export interface DataKey {
  metadataKey: string;
  label: string;
  shouldHideLabel: boolean;
  containsMarkdown: boolean;
}

export interface TagColor {
  tagKey: string;
  color: string;
  backgroundColor: string;
}

export interface TagSort {
  tag: string;
}

export interface DueDateFilterConfig {
  value: number;
  unit: 'days' | 'weeks' | 'months';
}

export type TagSymbol = '#' | '🏷️' | string;

export interface DateColor {
  isToday?: boolean;
  isBefore?: boolean;
  isAfter?: boolean;
  distance?: number;
  unit?: 'hours' | 'days' | 'weeks' | 'months';
  direction?: 'before' | 'after';
  color?: string;
  backgroundColor?: string;
}

export interface TeamMemberColorConfig {
  background: string;
  text: string;
}

export type PageDataValue =
  | string
  | number
  | Array<string | number>
  | { [k: string]: PageDataValue };

export interface PageData extends DataKey {
  value: PageDataValue;
}

export interface FileMetadata {
  [k: string]: PageData;
}

export interface ItemMetadata {
  updated?: moment.Moment;
  due?: moment.Moment;
  created?: moment.Moment;
  completed?: moment.Moment;
  date?: moment.Moment;
  time?: moment.Moment;
  dateStr?: string;
  timeStr?: string;
  tags?: string[];
  priority?: 'high' | 'medium' | 'low';
  fileAccessor?: FileAccessor;
  file?: TFile | null;
  fileMetadata?: FileMetadata;
  fileMetadataOrder?: string[];
  inlineMetadata?: InlineField[];
  startDate?: moment.Moment;
  startDateStr?: string;
}

export interface ItemData {
  blockId?: string;
  checked: boolean;
  checkChar: string;
  title: string;
  titleRaw: string;
  titleSearch: string;
  titleSearchRaw: string;
  metadata: ItemMetadata;
  forceEditMode?: boolean;
  line?: number;
  position?: {
    start: { line: number; column: number; offset: number };
    end: { line: number; column: number; offset: number };
  };
  assignedMembers?: string[];
}

export interface ErrorReport {
  description: string;
  stack: string;
}

export interface BoardData {
  frontmatter: Record<string, any>;
  settings: KanbanSettings;
  archive: Item[];
  isSearching: boolean;
  errors: ErrorReport[];
  targetHighlight?: any;
}

export type Item = Nestable<ItemData>;
export type Lane = Nestable<LaneData, Item>;
export type Board = Nestable<BoardData, Lane>;
export type MetadataSetting = Nestable<DataKey>;
export type TagColorSetting = Nestable<TagColor>;
export type TagSortSetting = Nestable<TagSort>;
export type TagSymbolSetting = Nestable<TagSymbol>;
export type DateColorSetting = Nestable<DateColor>;

export const DataTypes = {
  Item: 'item',
  Lane: 'lane',
  Board: 'board',
  MetadataSetting: 'metadata-setting',
  TagColorSetting: 'tag-color',
  TagSortSetting: 'tag-sort',
  DateColorSetting: 'date-color',
  TagSymbolSetting: 'tag-symbol',
};

export const ItemTemplate = {
  accepts: [DataTypes.Item],
  type: DataTypes.Item,
  children: [] as any[],
};

export const LaneTemplate = {
  accepts: [DataTypes.Lane],
  type: DataTypes.Lane,
};

export const BoardTemplate = {
  accepts: [] as string[],
  type: DataTypes.Board,
};

export const MetadataSettingTemplate = {
  accepts: [DataTypes.MetadataSetting],
  type: DataTypes.MetadataSetting,
  children: [] as any[],
};

export const TagSortSettingTemplate = {
  accepts: [DataTypes.TagSortSetting],
  type: DataTypes.TagSortSetting,
  children: [] as any[],
  data: { tag: '' },
};

export const TagSymbolSettingTemplate = {
  accepts: [] as string[],
  type: DataTypes.TagSymbolSetting,
  children: [] as any[],
  data: { tagKey: '', symbol: '' },
};

export const TagColorSettingTemplate = {
  accepts: [] as string[],
  type: DataTypes.TagColorSetting,
  children: [] as any[],
  data: { tagKey: '', color: '#000000', backgroundColor: '#ffffff' },
};

export const DateColorSettingTemplate = {
  accepts: [] as string[],
  type: DataTypes.DateColorSetting,
  children: [] as any[],
};

export interface EditCoordinates {
  x: number;
  y: number;
}

export enum EditingProcessState {
  Complete = 1,
  Cancel = 2,
}

export interface CardEditingState {
  editing: true;
  id: string;
}

export type EditState = CardEditingState | EditCoordinates | EditingProcessState | false;

export function isCardEditingState(state: EditState): state is CardEditingState {
  return !!(
    state &&
    typeof state === 'object' &&
    'editing' in state &&
    state.editing === true &&
    'id' in state
  );
}

export function isEditCoordinates(state: EditState): state is EditCoordinates {
  return !!(
    state &&
    typeof state === 'object' &&
    'x' in state &&
    'y' in state &&
    !('editing' in state)
  );
}

export function isEditingActive(state: EditState): state is EditCoordinates | CardEditingState {
  if (state === false || typeof state === 'number') return false;
  return true;
}

export interface KanbanSettings extends GlobalSettings {
  [key: string]: any;
  completedCountStyle?: string;
  tagColors?: TagColor[];
  tagSort?: TagSort[];
  useBuiltinRenderer?: boolean;
  customCheckboxTrackers?: CustomCheckboxTracker[];
  enableTimeTracking?: boolean;
  timeFormat?: string;
}

export type FilterDisplayMode = 'popover' | 'inline';
export type DateDisplayFormat = 'relative' | 'absolute' | string;

export interface CellLocation {
  // ... existing code ...
}

export interface GlobalSettings {
  // ... existing code ...
}

export interface SavedWorkspaceView {
  id: string;
  name: string;
  tags: string[];
  members?: string[];
  dueDateFilter?: DueDateFilterConfig;
}

export interface TimelineCardData {
  id: string;
  title: string;
  titleRaw?: string;
  sourceBoardName: string;
  sourceBoardPath: string;
}
