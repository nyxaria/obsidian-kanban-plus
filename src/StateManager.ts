import update from 'immutability-helper';
import { App, TFile, moment } from 'obsidian';
import { useEffect, useState } from 'preact/compat';

import { KanbanView } from './KanbanView';
import { DEFAULT_SETTINGS, KanbanSettings, SettingRetrievers } from './Settings';
import {
  c,
  generateInstanceId,
  getDefaultDateFormat,
  getDefaultTimeFormat,
} from './components/helpers';
import { Board, BoardTemplate, Item, ItemData, Lane } from './components/types';
import { ListFormat } from './parsers/List';
import { BaseFormat, frontmatterKey, shouldRefreshBoard } from './parsers/common';
import { getTaskStatusDone } from './parsers/helpers/inlineMetadata';
import { defaultDateTrigger, defaultMetadataPosition, defaultTimeTrigger } from './settingHelpers';

export class StateManager {
  onEmpty: () => void;
  getGlobalSettings: () => KanbanSettings;

  stateReceivers: Array<(state: Board) => void> = [];
  settingsNotifiers: Map<keyof KanbanSettings, Array<() => void>> = new Map();

  viewSet: Set<KanbanView> = new Set();
  compiledSettings: KanbanSettings = {};

  app: App;
  state: Board;
  file: TFile;

  parser: BaseFormat;

  constructor(
    app: App,
    initialViewForFileContext: KanbanView,
    onEmpty: () => void,
    getGlobalSettings: () => KanbanSettings
  ) {
    this.app = app;
    this.file = initialViewForFileContext.file;
    this.onEmpty = onEmpty;
    this.getGlobalSettings = getGlobalSettings;
    this.parser = new ListFormat(this);

    // console.log(
    //   `[StateManager] Constructor completed for ${this.file?.path}. Initial parsing deferred to plugin.addView.`
    // );
  }

  getAView(): KanbanView | undefined {
    return this.viewSet.values().next().value;
  }

  hasError(): boolean {
    return !!this.state?.data?.errors?.length;
  }

  async registerView(view: KanbanView, data: string, shouldParseData: boolean) {
    if (!this.viewSet.has(view)) {
      this.viewSet.add(view);
    }

    // This helps delay blocking the UI until the the loading indicator is displayed
    await new Promise((res) => activeWindow.setTimeout(res, 10));

    // If state is not initialized, we MUST parse data or create a new board,
    // regardless of the incoming shouldParseData flag.
    if (!this.state || shouldParseData) {
      console.log(
        `[StateManager] registerView: Initializing/Re-initializing board. Has existing state: ${!!this
          .state}, shouldParseData: ${shouldParseData}`
      );
      await this.newBoard(view, data);
    } else {
      // This branch is taken if this.state exists AND shouldParseData is false.
      console.log(
        `[StateManager] registerView: Using existing board state for prerender. Board ID: ${this.state?.id}`
      );
      // this.state is guaranteed to be non-null here.
      await view.prerender(this.state);
    }

    // Defensive check, though newBoard/setError should guarantee state and state.data.settings
    if (!this.state) {
      this.setError(
        new Error('[StateManager] registerView: State is unexpectedly null after board processing.')
      );
    } else if (!this.state.data) {
      this.setError(
        new Error(
          '[StateManager] registerView: State.data is unexpectedly null after board processing.'
        )
      );
    } else if (!this.state.data.settings) {
      // setError would have been called by newBoard if settings were missing after parsing.
      // However, if newBoard itself had a more fundamental issue before setting error state,
      // this provides a fallback.
      this.setError(
        new Error(
          '[StateManager] registerView: State.data.settings is unexpectedly null after board processing.'
        )
      );
    }

    // Assuming newBoard or setError (if newBoard fails) correctly initializes this.state and this.state.data.settings
    if (this.state && this.state.data && this.state.data.settings) {
      view.populateViewState(this.state.data.settings);
    } else {
      console.error(
        '[StateManager] registerView: Cannot populate view state because state, state.data, or state.data.settings is null. This is a critical error.'
      );
      // Potentially show an error to the user through the view if possible
      if (view && typeof view.showNotice === 'function') {
        view.showNotice(
          'Critical error: Kanban board state could not be initialized. Please report this issue.'
        );
      }
    }
  }

  unregisterView(view: KanbanView) {
    if (this.viewSet.has(view)) {
      this.viewSet.delete(view);

      if (this.viewSet.size === 0) {
        this.onEmpty();
      }
    }
  }

  buildSettingRetrievers(): SettingRetrievers {
    return {
      getGlobalSettings: this.getGlobalSettings,
      getGlobalSetting: this.getGlobalSetting,
      getSetting: this.getSetting,
    };
  }

  async newBoard(view: KanbanView, md: string) {
    try {
      const board = this.getParsedBoard(md);
      await view.prerender(board);
      this.setState(board, false);
    } catch (e) {
      this.setError(e);
    }
  }

  saveToDisk() {
    if (this.state.data.errors.length > 0) {
      return;
    }

    const view = this.getAView();

    if (view) {
      const fileStr = this.parser.boardToMd(this.state);
      view.requestSaveToDisk(fileStr);

      this.viewSet.forEach((view) => {
        view.data = fileStr;
      });
    }
  }

  softRefresh() {
    this.stateReceivers.forEach((receiver) => receiver({ ...this.state }));
  }

  forceRefresh() {
    if (this.state) {
      try {
        this.compileSettings();
        this.state = this.parser.reparseBoard();

        this.stateReceivers.forEach((receiver) => receiver(this.state));
        this.settingsNotifiers.forEach((notifiers) => {
          notifiers.forEach((fn) => fn());
        });
        this.viewSet.forEach((view) => view.initHeaderButtons());
      } catch (e) {
        console.error(e);
        this.setError(e);
      }
    }
  }

  setState(state: Board | ((board: Board) => Board), shouldSave: boolean = true) {
    try {
      const oldSettings = this.state?.data.settings;
      const incomingState = typeof state === 'function' ? state(this.state) : state;

      console.log(
        `[StateManager] setState: Preparing to set state for file ID: ${this.file?.path}. Incoming board ID: ${incomingState?.id}`
      );

      const newSettings = incomingState?.data.settings;

      if (
        this.state &&
        oldSettings &&
        newSettings &&
        shouldRefreshBoard(oldSettings, newSettings)
      ) {
        this.state = update(this.state, {
          data: {
            settings: {
              $set: newSettings,
            },
          },
        });
        this.compileSettings();
        this.state = this.parser.reparseBoard();
      } else {
        this.state = incomingState;
        this.compileSettings();
      }
      console.log(
        `[StateManager] setState: State has been set. Current this.state.id: ${this.state?.id}, for SM file: ${this.file?.path}`
      );

      this.viewSet.forEach((view) => {
        view.initHeaderButtons();
        view.validatePreviewCache(this.state);
      });

      if (shouldSave) {
        this.saveToDisk();
      }

      console.log(
        '[StateManager] setState: About to notify stateReceivers. Number of receivers:',
        this.stateReceivers.length,
        'New state ID:',
        this.state?.id
      );
      this.stateReceivers.forEach((receiver) => receiver(this.state));

      if (oldSettings !== newSettings && newSettings) {
        this.settingsNotifiers.forEach((notifiers, key) => {
          if ((!oldSettings && newSettings) || oldSettings[key] !== newSettings[key]) {
            notifiers.forEach((fn) => fn());
          }
        });
      }
    } catch (e) {
      console.error(e);
      this.setError(e);
    }
  }

  useState(): Board {
    const [state, setState] = useState(this.state);

    useEffect(() => {
      this.stateReceivers.push((state) => setState(state));
      setState(this.state);
      return () => {
        this.stateReceivers.remove(setState);
      };
    }, []);

    return state;
  }

  useSetting<K extends keyof KanbanSettings>(key: K): KanbanSettings[K] {
    const [state, setState] = useState<KanbanSettings[K]>(this.getSetting(key));

    useEffect(() => {
      const receiver = () => setState(this.getSetting(key));

      if (this.settingsNotifiers.has(key)) {
        this.settingsNotifiers.get(key).push(receiver);
      } else {
        this.settingsNotifiers.set(key, [receiver]);
      }

      return () => {
        this.settingsNotifiers.get(key).remove(receiver);
      };
    }, []);

    return state;
  }

  compileSettings(suppliedSettings?: KanbanSettings) {
    const globalKeys = this.getGlobalSetting('metadata-keys') || [];
    const localKeys = this.getSettingRaw('metadata-keys', suppliedSettings) || [];
    const metadataKeys = Array.from(new Set([...globalKeys, ...localKeys]));

    const dateFormat =
      this.getSettingRaw('date-format', suppliedSettings) || getDefaultDateFormat(this.app);
    const dateDisplayFormat =
      this.getSettingRaw('date-display-format', suppliedSettings) || dateFormat;

    const timeFormat =
      this.getSettingRaw('time-format', suppliedSettings) || getDefaultTimeFormat(this.app);

    const archiveDateFormat =
      this.getSettingRaw('archive-date-format', suppliedSettings) || `${dateFormat} ${timeFormat}`;

    this.compiledSettings = {
      [frontmatterKey]: this.getSettingRaw(frontmatterKey, suppliedSettings) || 'board',
      'date-format': dateFormat,
      'date-display-format': dateDisplayFormat,
      'date-time-display-format': dateDisplayFormat + ' ' + timeFormat,
      'date-trigger': this.getSettingRaw('date-trigger', suppliedSettings) || defaultDateTrigger,
      'inline-metadata-position':
        this.getSettingRaw('inline-metadata-position', suppliedSettings) || defaultMetadataPosition,
      'time-format': timeFormat,
      'time-trigger': this.getSettingRaw('time-trigger', suppliedSettings) || defaultTimeTrigger,
      'link-date-to-daily-note': this.getSettingRaw('link-date-to-daily-note', suppliedSettings),
      'move-dates': this.getSettingRaw('move-dates', suppliedSettings),
      'move-tags': this.getSettingRaw('move-tags', suppliedSettings),
      'move-task-metadata': this.getSettingRaw('move-task-metadata', suppliedSettings),
      'metadata-keys': metadataKeys,
      'archive-date-separator': this.getSettingRaw('archive-date-separator') || '',
      'archive-date-format': archiveDateFormat,
      'show-add-list': this.getSettingRaw('show-add-list', suppliedSettings) ?? true,
      'show-archive-all': this.getSettingRaw('show-archive-all', suppliedSettings) ?? true,
      'show-board-settings': this.getSettingRaw('show-board-settings', suppliedSettings) ?? true,
      'show-checkboxes': this.getSettingRaw('show-checkboxes', suppliedSettings) ?? true,
      'show-relative-date': this.getSettingRaw('show-relative-date', suppliedSettings) ?? true,
      'show-search': this.getSettingRaw('show-search', suppliedSettings) ?? true,
      'show-set-view': this.getSettingRaw('show-set-view', suppliedSettings) ?? true,
      'show-view-as-markdown':
        this.getSettingRaw('show-view-as-markdown', suppliedSettings) ?? true,
      'date-picker-week-start': this.getSettingRaw('date-picker-week-start', suppliedSettings) ?? 0,
      'date-colors': this.getSettingRaw('date-colors', suppliedSettings) ?? [],
      'tag-colors': this.getSettingRaw('tag-colors', suppliedSettings) ?? [],
      'tag-sort': this.getSettingRaw('tag-sort', suppliedSettings) ?? [],
      'tag-symbols': this.getSettingRaw('tag-symbols', suppliedSettings) ?? [],
      'tag-action': this.getSettingRaw('tag-action', suppliedSettings) ?? 'obsidian',
    };
  }

  getSetting = <K extends keyof KanbanSettings>(
    key: K,
    suppliedLocalSettings?: KanbanSettings
  ): KanbanSettings[K] => {
    if (suppliedLocalSettings?.[key] !== undefined) {
      return suppliedLocalSettings[key];
    }

    if (this.compiledSettings?.[key] !== undefined) {
      return this.compiledSettings[key];
    }

    return this.getSettingRaw(key);
  };

  getSettingRaw = <K extends keyof KanbanSettings>(
    key: K,
    suppliedLocalSettings?: KanbanSettings
  ): KanbanSettings[K] => {
    if (suppliedLocalSettings?.[key] !== undefined) {
      return suppliedLocalSettings[key];
    }

    if (this.state?.data?.settings?.[key] !== undefined) {
      return this.state.data.settings[key];
    }

    return this.getGlobalSetting(key);
  };

  getGlobalSetting = <K extends keyof KanbanSettings>(key: K): KanbanSettings[K] => {
    const globalSettings = this.getGlobalSettings();

    if (globalSettings?.[key] !== undefined) {
      return globalSettings[key];
    }

    return null;
  };

  getParsedBoard(data: string) {
    const trimmedContent = data.trim();

    let board: Board = {
      ...BoardTemplate,
      id: this.file.path,
      children: [],
      data: {
        archive: [],
        settings: { [frontmatterKey]: 'board' },
        frontmatter: {},
        isSearching: false,
        errors: [],
      },
    };

    try {
      if (trimmedContent) {
        board = this.parser.mdToBoard(trimmedContent);
      }
    } catch (e) {
      console.error(e);

      board = update(board, {
        data: {
          errors: {
            $push: [{ description: e.toString(), stack: e.stack }],
          },
        },
      });
    }

    return board;
  }

  setError(e: any) {
    console.error('[StateManager] setError called:', e);
    const errorToStore = {
      description: e.message || 'Unknown error',
      stack: e.stack || 'No stack trace available',
      raw: e,
    };

    if (!this.state) {
      console.warn(
        '[StateManager] setError: this.state was null. Initializing minimal error state.'
      );
      this.state = {
        id: this.file ? this.file.path : 'unknown-file',
        children: [],
        data: {
          frontmatter: {},
          settings: {},
          errors: [errorToStore],
          meta: {},
          completedCounts: {},
          filter: null,
        },
        type: 'board',
      };
    } else {
      if (!this.state.data) {
        console.warn(
          '[StateManager] setError: this.state.data was null. Initializing data structure.'
        );
        this.state.data = {
          frontmatter: {},
          settings: {},
          errors: [],
          meta: {},
          completedCounts: {},
          filter: null,
        };
      }
      if (!this.state.data.errors) {
        this.state.data.errors = [];
      }
      // Ensure settings object exists if data object was just created or was incomplete
      if (!this.state.data.settings) {
        console.warn(
          '[StateManager] setError: this.state.data.settings was null within an existing state.data. Initializing settings.'
        );
        this.state.data.settings = {};
      }
      if (this.state && this.state.data && this.state.data.errors) {
        this.state.data.errors.push(errorToStore);
      } else {
        console.error(
          '[StateManager] setError: Could not store error as state.data.errors is not available even after robust init.'
        );
        this.state = {
          id: this.file ? this.file.path : 'unknown-error-state',
          children: [],
          data: {
            errors: [errorToStore],
            frontmatter: {},
            settings: {},
            meta: {},
            completedCounts: {},
            filter: null,
          },
          type: 'board',
        };
      }
    }

    try {
      console.log(
        '[StateManager] setError: Notifying stateReceivers about error state. Number of receivers:',
        this.stateReceivers.length
      );
      this.stateReceivers.forEach((receiver) => {
        if (typeof receiver === 'function') {
          receiver(this.state);
        } else {
          console.warn('[StateManager] setError: Found non-function in stateReceivers:', receiver);
        }
      });
    } catch (notificationError) {
      console.error(
        '[StateManager] setError: Error during stateReceiver notification:',
        notificationError
      );
    }
  }

  onFileMetadataChange() {
    this.reparseBoardFromMd();
  }

  async reparseBoardFromMd() {
    try {
      this.setState(this.getParsedBoard(this.getAView().data), false);
    } catch (e) {
      console.error(e);
      this.setError(e);
    }
  }

  async archiveCompletedCards() {
    const board = this.state;

    const archived: Item[] = [];
    const shouldAppendArchiveDate = !!this.getSetting('archive-with-date');
    const archiveDateSeparator = this.getSetting('archive-date-separator');
    const archiveDateFormat = this.getSetting('archive-date-format');
    const archiveDateAfterTitle = this.getSetting('append-archive-date');

    const appendArchiveDate = (item: Item) => {
      const newTitle = [moment().format(archiveDateFormat)];

      if (archiveDateSeparator) newTitle.push(archiveDateSeparator);

      newTitle.push(item.data.titleRaw);

      if (archiveDateAfterTitle) newTitle.reverse();

      const titleRaw = newTitle.join(' ');

      return this.parser.updateItemContent(item, titleRaw);
    };

    const lanes = board.children.map((lane) => {
      return update(lane, {
        children: {
          $set: lane.children.filter((item) => {
            const isComplete = item.data.checked && item.data.checkChar === getTaskStatusDone();
            if (lane.data.shouldMarkItemsComplete || isComplete) {
              archived.push(item);
            }

            return !isComplete && !lane.data.shouldMarkItemsComplete;
          }),
        },
      });
    });

    try {
      this.setState(
        update(board, {
          children: {
            $set: lanes,
          },
          data: {
            archive: {
              $push: shouldAppendArchiveDate
                ? await Promise.all(archived.map((item) => appendArchiveDate(item)))
                : archived,
            },
          },
        })
      );
    } catch (e) {
      this.setError(e);
    }
  }

  getNewItem(content: string, checkChar: string, forceEdit?: boolean, laneName?: string) {
    return this.parser.newItem(content, checkChar, forceEdit, laneName);
  }

  updateItemContent(item: Item, content: string) {
    return this.parser.updateItemContent(item, content);
  }

  async setLaneBackgroundColor(laneId: string, color: string) {
    if (!this.state) {
      console.error(
        '[StateManager] setLaneBackgroundColor: Cannot set color, state is not initialized.'
      );
      return;
    }

    const laneIndex = this.state.children.findIndex((lane) => lane.id === laneId);

    if (laneIndex === -1) {
      console.error(`[StateManager] setLaneBackgroundColor: Lane with ID "${laneId}" not found.`);
      return;
    }

    // Ensure data property exists, initialize if not (though it should for a valid lane)
    const currentLaneData = this.state.children[laneIndex].data || {};

    const updatedBoard = update(this.state, {
      children: {
        [laneIndex]: {
          data: {
            // Using $set to define/overwrite the backgroundColor property on the existing data object
            $set: { ...currentLaneData, backgroundColor: color },
          },
        },
      },
    });

    this.setState(updatedBoard); // shouldSave defaults to true
    console.log(
      `[StateManager] setLaneBackgroundColor: Color set for lane ${laneId} to ${color}. State updated.`
    );
  }

  // Helper function to handle auto-moving done cards
  private handleAutoMoveDoneCard(board: Board, itemId: string, isChecked: boolean): Board {
    console.log(
      `[StateManager] handleAutoMoveDoneCard: Called for item ${itemId}, isChecked: ${isChecked}`
    );
    const autoMoveEnabled = this.getSetting('auto-move-done-to-lane');
    console.log(`[StateManager] handleAutoMoveDoneCard: autoMoveEnabled is ${autoMoveEnabled}`);

    if (!autoMoveEnabled || !isChecked) {
      console.log(
        '[StateManager] handleAutoMoveDoneCard: Auto-move not enabled or item not checked. Returning original board.'
      );
      return board; // No move needed
    }

    const DONE_LANE_NAME = 'Done';
    let sourceLaneIndex = -1;
    let itemIndexInSourceLane = -1;
    let itemToMove: Item | null = null;

    // Find the item and its source lane
    for (let i = 0; i < board.children.length; i++) {
      const lane = board.children[i];
      const itemIdx = lane.children.findIndex((item) => item.id === itemId);
      if (itemIdx !== -1) {
        sourceLaneIndex = i;
        itemIndexInSourceLane = itemIdx;
        itemToMove = lane.children[itemIdx];
        break;
      }
    }

    if (!itemToMove || sourceLaneIndex === -1) {
      console.warn(
        `[StateManager] Auto-move: Item ${itemId} not found in board structure for move. Original board state:`,
        JSON.stringify(board)
      );
      return board; // Item not found, should not happen if called after item update
    }
    console.log(
      `[StateManager] handleAutoMoveDoneCard: Found item '${itemToMove.data.titleRaw}' in lane '${board.children[sourceLaneIndex].data.title}'`
    );

    let doneLaneIndex = board.children.findIndex((lane) => lane.data.title === DONE_LANE_NAME);
    let newBoard = board;
    console.log(`[StateManager] handleAutoMoveDoneCard: Initial Done lane index: ${doneLaneIndex}`);

    // If "Done" lane doesn't exist, create it
    if (doneLaneIndex === -1) {
      const newLaneId = generateInstanceId();
      const newLane: Lane = {
        id: newLaneId,
        type: 'lane', // Required by Nestable
        accepts: ['item'], // Required by Nestable
        data: {
          title: DONE_LANE_NAME,
          // No other properties like collapsed, maxLimit, backgroundColor here for data
        },
        children: [],
        // No 'edit' property here
      };
      newBoard = update(board, {
        children: { $push: [newLane] },
      });
      doneLaneIndex = newBoard.children.length - 1; // New lane is at the end
      console.log(
        `[StateManager] handleAutoMoveDoneCard: "Done" lane created at index ${doneLaneIndex}`
      );
    }

    // Move the item
    // Ensure itemToMove is correctly updated if its checked status changed in the calling function
    const updatedItemToMove = { ...itemToMove, data: { ...itemToMove.data, checked: true } };

    if (sourceLaneIndex === doneLaneIndex) {
      // Item is already in the Done lane, potentially reorder to the end if behavior is desired
      // For now, if it's already in Done, we do nothing further to prevent loops or needless shuffles.
      // If it was just marked done and was already in Done, it just stays.
      console.log(
        `[StateManager] handleAutoMoveDoneCard: Item ${itemId} is already in the "Done" lane. No move performed.`
      );
      return newBoard;
    }

    console.log(
      `[StateManager] handleAutoMoveDoneCard: Attempting to move item ${itemId} from lane ${sourceLaneIndex} to lane ${doneLaneIndex}`
    );
    newBoard = update(newBoard, {
      children: {
        [sourceLaneIndex]: {
          children: { $splice: [[itemIndexInSourceLane, 1]] }, // Remove from source lane
        },
        [doneLaneIndex]: {
          children: { $push: [updatedItemToMove] }, // Add to the end of Done lane
        },
      },
    });

    return newBoard;
  }

  updateItem(itemId: string, data: Partial<ItemData>, lanes: Lane[], pos?: number) {
    console.log(
      `[StateManager] updateItem: Called for itemId: ${itemId}, full data payload:`,
      JSON.stringify(data)
    );
    const laneIdx = lanes.findIndex((lane) => lane.children.some((item) => item.id === itemId));
    if (laneIdx === -1) {
      console.warn('[StateManager] updateItem: Lane not found for item', itemId);
      return;
    }

    const itemIdx = lanes[laneIdx].children.findIndex((item) => item.id === itemId);
    if (itemIdx === -1) {
      console.warn('[StateManager] updateItem: Item not found in lane for item', itemId);
      return;
    }

    let newBoard = update(this.state, {
      children: {
        [laneIdx]: {
          children: {
            [itemIdx]: {
              data: { $merge: data },
            },
          },
        },
      },
    });

    // Handle auto-move if the card is marked as done
    if (data.checked === true) {
      newBoard = this.handleAutoMoveDoneCard(newBoard, itemId, true);
    }

    this.setState(newBoard);
  }

  setCardChecked(item: Item, checked: boolean) {
    if (!this.state) {
      console.error(
        '[StateManager] setCardChecked: Cannot set checked status, state is not initialized.'
      );
      return;
    }

    // Find the lane containing the item
    const laneIdx = this.state.children.findIndex((lane) =>
      lane.children.some((childItem) => childItem.id === item.id)
    );

    if (laneIdx === -1) {
      console.warn(`[StateManager] setCardChecked: Lane not found for item ${item.id}`);
      return;
    }

    const itemIdx = this.state.children[laneIdx].children.findIndex(
      (childItem) => childItem.id === item.id
    );

    if (itemIdx === -1) {
      console.warn(
        `[StateManager] setCardChecked: Item ${item.id} not found in lane ${this.state.children[laneIdx].data.title}`
      );
      return;
    }

    const newCheckChar = checked ? getTaskStatusDone() : ' '; // ' ' for not done, or specific char if needed

    // Call updateItem to make the change and trigger auto-move if applicable
    this.updateItem(item.id, { checked, checkChar: newCheckChar }, this.state.children);
  }
}
