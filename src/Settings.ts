import update, { Spec } from 'immutability-helper';
import {
  App,
  DropdownComponent,
  Modal,
  PluginSettingTab,
  Setting,
  ToggleComponent,
} from 'obsidian';

import { KanbanView } from './KanbanView';
import {
  c,
  generateInstanceId,
  getDefaultDateFormat,
  getDefaultTimeFormat,
} from './components/helpers';
import {
  DataKey,
  DateColor,
  DateColorSetting,
  DateColorSettingTemplate,
  DateDisplayFormat,
  DueDateFilterConfig,
  FilterDisplayMode,
  MetadataSetting,
  MetadataSettingTemplate,
  TagColor,
  TagColorSetting,
  TagColorSettingTemplate,
  TagSort,
  TagSortSetting,
  TagSortSettingTemplate,
  TagSymbol,
  TagSymbolSetting,
  TagSymbolSettingTemplate,
} from './components/types';
import { getParentWindow } from './dnd/util/getWindow';
import { t } from './lang/helpers';
import KanbanPlugin from './main';
import { frontmatterKey } from './parsers/common';
import {
  createSearchSelect,
  defaultDateTrigger,
  defaultMetadataPosition,
  defaultTimeTrigger,
  getListOptions,
} from './settingHelpers';
import { cleanUpDateSettings, renderDateSettings } from './settings/DateColorSettings';
import { cleanupMetadataSettings, renderMetadataSettings } from './settings/MetadataSettings';
import { renderTagColorSettings, unmountTagColorSettings } from './settings/TagColorSettings';
import { cleanUpTagSortSettings, renderTagSortSettings } from './settings/TagSortSettings';
import { renderTagSymbolSettings, unmountTagSymbolSettings } from './settings/TagSymbolSettings';

const numberRegEx = /^\d+(?:\.\d+)?$/;

export type KanbanFormat = 'basic' | 'board' | 'table' | 'list';

export type TimeFormat = 'h:mm A' | 'HH:mm';

export interface SavedWorkspaceView {
  id: string;
  name: string;
  tags: string[];
  members?: string[];
  dueDateFilter?: DueDateFilterConfig;
  excludeArchive?: boolean;
  excludeDone?: boolean;
  sortCriteria?: 'default' | 'priority' | 'dueDate';
  sortDirection?: 'asc' | 'desc';
  scanRootPath?: string;
}

export interface TeamMemberColorConfig {
  background: string;
  text: string;
  email?: string;
}

export interface KanbanSettings {
  [frontmatterKey]?: KanbanFormat;
  'append-archive-date'?: boolean;
  'archive-date-format'?: string;
  'archive-date-separator'?: string;
  'archive-with-date'?: boolean;
  'date-colors'?: DateColor[];
  'date-display-format'?: string;
  'date-format'?: string;
  'date-picker-week-start'?: 0 | 1 | 2 | 3 | 4 | 5 | 6;
  'date-time-display-format'?: string;
  'date-trigger'?: string;
  'full-list-lane-width'?: boolean;
  'hide-card-count'?: boolean;
  'inline-metadata-position'?: 'body' | 'footer' | 'metadata-table';
  'lane-width'?: number;
  'link-date-to-daily-note'?: boolean;
  'list-collapse'?: boolean[];
  'max-archive-size'?: number;
  'metadata-keys'?: DataKey[];
  'move-dates'?: boolean;
  'move-tags'?: boolean;
  'move-task-metadata'?: boolean;
  'new-card-insertion-method'?: 'prepend' | 'prepend-compact' | 'append';
  'new-line-trigger'?: 'enter' | 'shift-enter';
  'new-note-folder'?: string;
  'new-note-template'?: string;
  'show-add-list'?: boolean;
  'show-archive-all'?: boolean;
  'show-board-settings'?: boolean;
  'show-checkboxes'?: boolean;
  'show-relative-date'?: boolean;
  'show-search'?: boolean;
  'show-set-view'?: boolean;
  'show-view-as-markdown'?: boolean;
  'table-sizing'?: Record<string, number>;
  'tag-action'?: 'kanban' | 'obsidian' | 'global';
  'tag-colors'?: TagColor[];
  'tag-sort'?: TagSort[] | string[];
  'time-format'?: string;
  'time-trigger'?: string;
  'tag-symbols'?: TagSymbolSetting[];
  'new-card-template'?: string;
  'new-lane-template'?: string;
  'show-button-for-new-card'?: boolean;
  'archive-heading'?: string;
  'archive-empty-tasks'?: boolean;
  'enable-markdown-preview-checkbox-toggle'?: boolean;
  'default-time'?: string;
  'filter-display-mode'?: FilterDisplayMode;
  'inline-date-format'?: DateDisplayFormat;
  'inline-time-format'?: TimeFormat;
  savedWorkspaceViews: SavedWorkspaceView[];
  lastSelectedWorkspaceViewId?: string;
  clickOutsideCardToSaveEdit?: boolean;
  hideHashForTagsWithoutSymbols?: boolean;
  teamMembers?: string[];
  teamMemberColors?: Record<string, TeamMemberColorConfig>;
  editable?: boolean;
  memberAssignmentPrefix?: string;
  'auto-move-done-to-lane'?: boolean;
  'auto-add-lane-tag'?: boolean;
  'auto-add-board-tag'?: boolean;
  'hide-lane-tag-display'?: boolean;
  'hide-board-tag-display'?: boolean;
  'apply-tag-colors-globally'?: boolean;
  'apply-tag-symbols-globally'?: boolean;
  enableDueDateEmailReminders?: boolean;
  dueDateReminderLastRun?: number;
  dueDateReminderTimeframeDays?: number;
  enableAutomaticEmailSending?: boolean;
  automaticEmailSenderAddress?: string;
  automaticEmailAppPassword?: string;
  automaticEmailSendingFrequencyDays?: number;
  hideDoneLane?: boolean;
  timelineDayWidth?: number;
  timelineCardHeight?: number;
  'enable-kanban-card-embeds'?: boolean; // Added
  'enable-kanban-code-blocks'?: boolean; // Added for ```kanban``` code block feature
  'hide-linked-cards-when-none-exist'?: boolean; // Hide linked cards display when no cards exist
  'hide-linked-cards-when-only-done'?: boolean; // Hide linked cards display when only done cards exist
  'use-kanban-board-background-colors'?: boolean; // Use kanban board background colors in embeds
  'member-view-lane-width'?: number; // Width of lanes in member view
  'print-debug'?: boolean; // Enable debug logging
}

export interface KanbanViewSettings {
  [frontmatterKey]?: KanbanFormat;
  'list-collapse'?: boolean[];
  'tag-symbols': TagSymbolSetting[];
  savedWorkspaceViews: SavedWorkspaceView[];
  hideHashForTagsWithoutSymbols: boolean;
  teamMembers: string[];
  teamMemberColors: Record<string, TeamMemberColorConfig>;
  editable: boolean;
  'auto-move-done-to-lane': boolean;
  'auto-add-lane-tag': boolean;
  'auto-add-board-tag': boolean;
  'hide-lane-tag-display': boolean;
  'hide-board-tag-display': boolean;
  memberAssignmentPrefix: '@@';
  enableDueDateEmailReminders: false;
  dueDateReminderLastRun: 0;
  dueDateReminderTimeframeDays: 1;
  enableAutomaticEmailSending: false;
  automaticEmailSenderAddress: '';
  automaticEmailAppPassword: '';
  automaticEmailSendingFrequencyDays: 1;
  hideDoneLane: false;
  timelineDayWidth: 50;
  timelineCardHeight: 40; // Added for consistency, though primarily global
  'enable-kanban-card-embeds': boolean;
  'enable-kanban-code-blocks': boolean;
  'use-kanban-board-background-colors': boolean;
  'member-view-lane-width': number;
  'show-checkboxes'?: boolean; // Allow member view to control checkbox display
}

export const settingKeyLookup: Set<keyof KanbanSettings> = new Set([
  frontmatterKey,
  'append-archive-date',
  'archive-date-format',
  'archive-date-separator',
  'archive-with-date',
  'date-colors',
  'date-display-format',
  'date-format',
  'date-picker-week-start',
  'date-time-display-format',
  'date-trigger',
  'full-list-lane-width',
  'hide-card-count',
  'inline-metadata-position',
  'lane-width',
  'link-date-to-daily-note',
  'list-collapse',
  'max-archive-size',
  'metadata-keys',
  'move-dates',
  'move-tags',
  'move-task-metadata',
  'new-card-insertion-method',
  'new-line-trigger',
  'new-note-folder',
  'new-note-template',
  'show-add-list',
  'show-archive-all',
  'show-board-settings',
  'show-checkboxes',
  'show-relative-date',
  'show-search',
  'show-set-view',
  'show-view-as-markdown',
  'table-sizing',
  'tag-action',
  'tag-colors',
  'tag-sort',
  'time-format',
  'time-trigger',
  'tag-symbols',
  'clickOutsideCardToSaveEdit',
  'hideHashForTagsWithoutSymbols',
  'teamMembers',
  'teamMemberColors',
  'editable',
  'memberAssignmentPrefix',
  'auto-move-done-to-lane',
  'auto-add-lane-tag',
  'auto-add-board-tag',
  'hide-lane-tag-display',
  'hide-board-tag-display',
  'apply-tag-colors-globally',
  'apply-tag-symbols-globally',
  'enableDueDateEmailReminders',
  'dueDateReminderLastRun',
  'dueDateReminderTimeframeDays',
  'enableAutomaticEmailSending',
  'automaticEmailSenderAddress',
  'automaticEmailAppPassword',
  'automaticEmailSendingFrequencyDays',
  'hideDoneLane',
  'timelineDayWidth',
  'timelineCardHeight',
  'enable-kanban-card-embeds',
  'enable-kanban-code-blocks',
  'hide-linked-cards-when-none-exist',
  'hide-linked-cards-when-only-done',
  'use-kanban-board-background-colors',
  'member-view-lane-width',
  'print-debug',
]);

export type SettingRetriever = <K extends keyof KanbanSettings>(
  key: K,
  supplied?: KanbanSettings
) => KanbanSettings[K];

export interface SettingRetrievers {
  getGlobalSettings: () => KanbanSettings;
  getGlobalSetting: SettingRetriever;
  getSetting: SettingRetriever;
}

export interface SettingsManagerConfig {
  onSettingsChange: (newSettings: KanbanSettings) => void;
}

export class SettingsManager {
  win: Window;
  app: App;
  plugin: KanbanPlugin;
  config: SettingsManagerConfig;
  settings: KanbanSettings;
  cleanupFns: Array<() => void> = [];
  applyDebounceTimer: number = 0;
  tagColorSettingsEl: HTMLElement;
  tagSymbolSettingsEl: HTMLElement;
  settingElements: Setting[] = [];

  constructor(plugin: KanbanPlugin, config: SettingsManagerConfig, settings: KanbanSettings) {
    this.app = plugin.app;
    this.plugin = plugin;
    this.config = config;
    this.settings = settings;
  }

  applySettingsUpdate(spec: Spec<KanbanSettings>) {
    this.win.clearTimeout(this.applyDebounceTimer);

    this.applyDebounceTimer = this.win.setTimeout(() => {
      this.settings = update(this.settings, spec);
      this.config.onSettingsChange(this.settings);
    }, 1000);
  }

  getSetting(key: keyof KanbanSettings, local: boolean) {
    if (local) {
      return [this.settings[key], this.plugin.settings[key]];
    }

    return [this.settings[key], null];
  }

  constructUI(contentEl: HTMLElement, heading: string, local: boolean) {
    this.win = contentEl.win;

    if (!this.cleanupFns) {
      this.cleanupFns = [];
    }
    (this.win as any).tempKanbanCleanupFns = this.cleanupFns;

    const { templateFiles, vaultFolders, templateWarning } = getListOptions(this.app);

    contentEl.createEl('h3', { text: heading });

    if (local) {
      contentEl.createEl('p', {
        text: t('These settings will take precedence over the default Kanban board settings.'),
      });
    } else {
      contentEl.createEl('p', {
        text: t(
          'Set the default Kanban board settings. Settings can be overridden on a board-by-board basis.'
        ),
      });
    }

    new Setting(contentEl)
      .setName(t('Display card checkbox'))
      .setDesc(t('When toggled, a checkbox will be displayed with each card'))
      .then((setting) => {
        let toggleComponent: ToggleComponent;

        setting
          .addToggle((toggle) => {
            toggleComponent = toggle;

            const [value, globalValue] = this.getSetting('show-checkboxes', local);

            if (value !== undefined) {
              toggle.setValue(value as boolean);
            } else if (globalValue !== undefined) {
              toggle.setValue(globalValue as boolean);
            }

            toggle.onChange((newValue) => {
              this.applySettingsUpdate({
                'show-checkboxes': {
                  $set: newValue,
                },
              });
            });
          })
          .addExtraButton((b) => {
            b.setIcon('lucide-rotate-ccw')
              .setTooltip(t('Reset to default'))
              .onClick(() => {
                const [, globalValue] = this.getSetting('show-checkboxes', local);
                toggleComponent.setValue(!!globalValue);

                this.applySettingsUpdate({
                  $unset: ['show-checkboxes'],
                });
              });
          });
      });

    new Setting(contentEl)
      .setName(t("Hide 'Done' lane"))
      .setDesc(
        t(
          'If enabled, lanes with the exact title "Done" (case-insensitive) will be hidden from the board view.'
        )
      )
      .addToggle((toggle) => {
        const [value, globalValue] = this.getSetting('hideDoneLane', local);
        let currentValue = value;
        if (currentValue === undefined) {
          currentValue = globalValue;
        }
        if (currentValue === undefined) {
          currentValue = DEFAULT_SETTINGS.hideDoneLane;
        }

        toggle.setValue(!!currentValue).onChange((newValue) => {
          this.applySettingsUpdate({ hideDoneLane: { $set: newValue } });
        });
      });

    new Setting(contentEl)
      .setName(t('New line trigger'))
      .setDesc(
        t(
          'Select whether Enter or Shift+Enter creates a new line. The opposite of what you choose will create and complete editing of cards and lists.'
        )
      )
      .addDropdown((dropdown) => {
        dropdown.addOption('shift-enter', t('Shift + Enter'));
        dropdown.addOption('enter', t('Enter'));

        const [value, globalValue] = this.getSetting('new-line-trigger', local);

        dropdown.setValue((value as string) || (globalValue as string) || 'shift-enter');
        dropdown.onChange((value) => {
          this.applySettingsUpdate({
            'new-line-trigger': {
              $set: value as 'enter' | 'shift-enter',
            },
          });
        });
      });

    new Setting(contentEl)
      .setName(t('Prepend / append new cards'))
      .setDesc(
        t('This setting controls whether new cards are added to the beginning or end of the list.')
      )
      .addDropdown((dropdown) => {
        dropdown.addOption('prepend', t('Prepend'));
        dropdown.addOption('prepend-compact', t('Prepend (compact)'));
        dropdown.addOption('append', t('Append'));

        const [value, globalValue] = this.getSetting('new-card-insertion-method', local);

        dropdown.setValue((value as string) || (globalValue as string) || 'append');
        dropdown.onChange((value) => {
          this.applySettingsUpdate({
            'new-card-insertion-method': {
              $set: value as 'prepend' | 'append',
            },
          });
        });
      });

    new Setting(contentEl)
      .setName(t('Hide card counts in list titles'))
      .setDesc(t('When toggled, card counts are hidden from the list title'))
      .then((setting) => {
        let toggleComponent: ToggleComponent;

        setting
          .addToggle((toggle) => {
            toggleComponent = toggle;

            const [value, globalValue] = this.getSetting('hide-card-count', local);

            if (value !== undefined) {
              toggle.setValue(value as boolean);
            } else if (globalValue !== undefined) {
              toggle.setValue(globalValue as boolean);
            }

            toggle.onChange((newValue) => {
              this.applySettingsUpdate({
                'hide-card-count': {
                  $set: newValue,
                },
              });
            });
          })
          .addExtraButton((b) => {
            b.setIcon('lucide-rotate-ccw')
              .setTooltip(t('Reset to default'))
              .onClick(() => {
                const [, globalValue] = this.getSetting('hide-card-count', local);
                toggleComponent.setValue(!!globalValue);

                this.applySettingsUpdate({
                  $unset: ['hide-card-count'],
                });
              });
          });
      });

    new Setting(contentEl)
      .setName(t('List width'))
      .setDesc(t('Enter a number to set the list width in pixels.'))
      .addText((text) => {
        const [value, globalValue] = this.getSetting('lane-width', local);

        text.inputEl.setAttr('type', 'number');
        text.inputEl.placeholder = `${globalValue ? globalValue : '272'} (default)`;
        text.inputEl.value = value ? value.toString() : '';

        text.onChange((val) => {
          if (val && numberRegEx.test(val)) {
            text.inputEl.removeClass('error');

            this.applySettingsUpdate({
              'lane-width': {
                $set: parseInt(val),
              },
            });

            return;
          }

          if (val) {
            text.inputEl.addClass('error');
          }

          this.applySettingsUpdate({
            $unset: ['lane-width'],
          });
        });
      });

    new Setting(contentEl)
      .setName(t('Timeline Day Width'))
      .setDesc(t('The width of each day column in the timeline view, in pixels.'))
      .addText((text) => {
        const [value, globalValue] = this.getSetting('timelineDayWidth', local);
        const placeholderValue =
          globalValue !== undefined ? globalValue : DEFAULT_SETTINGS.timelineDayWidth;

        text.inputEl.setAttr('type', 'number');
        text
          .setPlaceholder(placeholderValue?.toString() || '50')
          .setValue(value?.toString() || '') // Show current local value or empty if none
          .onChange(async (val) => {
            if (val && numberRegEx.test(val) && parseInt(val) > 0) {
              text.inputEl.removeClass('error');
              this.applySettingsUpdate({
                timelineDayWidth: {
                  $set: parseInt(val),
                },
              });
            } else if (!val) {
              // If input is cleared, reset to default
              text.inputEl.removeClass('error');
              this.applySettingsUpdate({
                $unset: ['timelineDayWidth'], // This will make it use global or DEFAULT_SETTINGS value
              });
            } else {
              // Invalid input (not a positive number)
              text.inputEl.addClass('error');
              // Do not save invalid input, keep current setting or let it be default
            }
            // No need for explicit saveSettings() here as applySettingsUpdate handles it with debounce
          });
      });

    new Setting(contentEl)
      .setName(t('Timeline Card Height'))
      .setDesc(t('The height of each card in the timeline view, in pixels.'))
      .addText((text) => {
        const [value, globalValue] = this.getSetting('timelineCardHeight', local);
        const placeholderValue =
          globalValue !== undefined ? globalValue : DEFAULT_SETTINGS.timelineCardHeight;

        text.inputEl.setAttr('type', 'number');
        text
          .setPlaceholder(placeholderValue?.toString() || '40')
          .setValue(value?.toString() || '')
          .onChange(async (val) => {
            if (val && numberRegEx.test(val) && parseInt(val) > 0) {
              text.inputEl.removeClass('error');
              this.applySettingsUpdate({
                timelineCardHeight: {
                  $set: parseInt(val),
                },
              });
            } else if (!val) {
              text.inputEl.removeClass('error');
              this.applySettingsUpdate({
                $unset: ['timelineCardHeight'],
              });
            } else {
              text.inputEl.addClass('error');
            }
          });
      });

    new Setting(contentEl)
      .setName(t('Member View Lane Width'))
      .setDesc(t('Enter a number to set the lane width in pixels for the Member View.'))
      .addText((text) => {
        const [value, globalValue] = this.getSetting('member-view-lane-width', local);

        text.inputEl.setAttr('type', 'number');
        text.inputEl.placeholder = `${globalValue ? globalValue : '272'} (default)`;
        text.inputEl.value = value ? value.toString() : '';

        text.onChange((val) => {
          if (val && numberRegEx.test(val)) {
            text.inputEl.removeClass('error');

            this.applySettingsUpdate({
              'member-view-lane-width': {
                $set: parseInt(val),
              },
            });

            return;
          }

          if (val) {
            text.inputEl.addClass('error');
          }

          this.applySettingsUpdate({
            $unset: ['member-view-lane-width'],
          });
        });
      });

    new Setting(contentEl).setName(t('Expand lists to full width in list view')).then((setting) => {
      let toggleComponent: ToggleComponent;

      setting
        .addToggle((toggle) => {
          toggleComponent = toggle;

          const [value, globalValue] = this.getSetting('full-list-lane-width', local);

          if (value !== undefined) {
            toggle.setValue(value as boolean);
          } else if (globalValue !== undefined) {
            toggle.setValue(globalValue as boolean);
          }

          toggle.onChange((newValue) => {
            this.applySettingsUpdate({
              'full-list-lane-width': {
                $set: newValue,
              },
            });
          });
        })
        .addExtraButton((b) => {
          b.setIcon('lucide-rotate-ccw')
            .setTooltip(t('Reset to default'))
            .onClick(() => {
              const [, globalValue] = this.getSetting('full-list-lane-width', local);
              toggleComponent.setValue(!!globalValue);

              this.applySettingsUpdate({
                $unset: ['full-list-lane-width'],
              });
            });
        });
    });

    new Setting(contentEl)
      .setName(t('Maximum number of archived cards'))
      .setDesc(
        t(
          "Archived cards can be viewed in markdown mode. This setting will begin removing old cards once the limit is reached. Setting this value to -1 will allow a board's archive to grow infinitely."
        )
      )
      .addText((text) => {
        const [value, globalValue] = this.getSetting('max-archive-size', local);

        text.inputEl.setAttr('type', 'number');
        text.inputEl.placeholder = `${globalValue ? globalValue : '-1'} (default)`;
        text.inputEl.value = value ? value.toString() : '';

        text.onChange((val) => {
          if (val && numberRegEx.test(val)) {
            text.inputEl.removeClass('error');

            this.applySettingsUpdate({
              'max-archive-size': {
                $set: parseInt(val),
              },
            });

            return;
          }

          if (val) {
            text.inputEl.addClass('error');
          }

          this.applySettingsUpdate({
            $unset: ['max-archive-size'],
          });
        });
      });

    new Setting(contentEl)
      .setName(t('Note template'))
      .setDesc(t('This template will be used when creating new notes from Kanban cards.'))
      .then(
        createSearchSelect({
          choices: templateFiles,
          key: 'new-note-template',
          warningText: templateWarning,
          local,
          placeHolderStr: t('No template'),
          manager: this,
        })
      );

    new Setting(contentEl)
      .setName(t('Note folder'))
      .setDesc(
        t(
          'Notes created from Kanban cards will be placed in this folder. If blank, they will be placed in the default location for this vault.'
        )
      )
      .then(
        createSearchSelect({
          choices: vaultFolders,
          key: 'new-note-folder',
          local,
          placeHolderStr: t('Default folder'),
          manager: this,
        })
      );

    new Setting(contentEl)
      .setName(t('Click outside note to save edit'))
      .setDesc(
        t(
          'When enabled, clicking anywhere outside an editing note will save the changes and close the editor.'
        )
      )
      .then((setting) => {
        let toggleComponent: ToggleComponent;
        setting
          .addToggle((toggle) => {
            toggleComponent = toggle;
            const [value, globalValue] = this.getSetting('clickOutsideCardToSaveEdit', local);
            const currentActualValue =
              value !== undefined ? value : globalValue !== undefined ? globalValue : true;
            toggle.setValue(currentActualValue as boolean);

            toggle.onChange((newValue) => {
              this.applySettingsUpdate({
                clickOutsideCardToSaveEdit: { $set: newValue },
              });
            });
          })
          .addExtraButton((b) => {
            b.setIcon('lucide-rotate-ccw')
              .setTooltip(t('Reset to default'))
              .onClick(() => {
                const [, globalValue] = this.getSetting('clickOutsideCardToSaveEdit', local);
                const defaultValue = globalValue !== undefined ? globalValue : true;
                toggleComponent.setValue(defaultValue as boolean);

                this.applySettingsUpdate({
                  $unset: ['clickOutsideCardToSaveEdit'],
                });
              });
          });
      });

    contentEl.createEl('h4', { text: t('Embeds') });

    new Setting(contentEl)
      .setName(t('Enable Kanban card embeds'))
      .setDesc(
        t(
          'When enabled, internal links to Kanban cards (e.g., [[Board#^blockId]]) will be rendered as card previews instead of regular links.'
        )
      )
      .then((setting) => {
        let toggleComponent: ToggleComponent;

        setting
          .addToggle((toggle) => {
            toggleComponent = toggle;

            const [value, globalValue] = this.getSetting('enable-kanban-card-embeds', local);

            if (value !== undefined) {
              toggle.setValue(value as boolean);
            } else if (globalValue !== undefined) {
              toggle.setValue(globalValue as boolean);
            } else {
              toggle.setValue(true); // Default to enabled
            }

            toggle.onChange((newValue) => {
              this.applySettingsUpdate({
                'enable-kanban-card-embeds': {
                  $set: newValue,
                },
              });
            });
          })
          .addExtraButton((b) => {
            b.setIcon('lucide-rotate-ccw')
              .setTooltip(t('Reset to default'))
              .onClick(() => {
                const [, globalValue] = this.getSetting('enable-kanban-card-embeds', local);
                toggleComponent.setValue(globalValue !== undefined ? !!globalValue : true);

                this.applySettingsUpdate({
                  $unset: ['enable-kanban-card-embeds'],
                });
              });
          });
      });

    new Setting(contentEl)
      .setName(t('Enable Kanban code blocks'))
      .setDesc(
        t(
          'When enabled, ```kanban``` code blocks will be replaced with a display of all Kanban cards that link to the current note.'
        )
      )
      .then((setting) => {
        let toggleComponent: ToggleComponent;

        setting
          .addToggle((toggle) => {
            toggleComponent = toggle;

            const [value, globalValue] = this.getSetting('enable-kanban-code-blocks', local);

            if (value !== undefined) {
              toggle.setValue(value as boolean);
            } else if (globalValue !== undefined) {
              toggle.setValue(globalValue as boolean);
            } else {
              toggle.setValue(true); // Default to enabled
            }

            toggle.onChange((newValue) => {
              this.applySettingsUpdate({
                'enable-kanban-code-blocks': {
                  $set: newValue,
                },
              });
            });
          })
          .addExtraButton((b) => {
            b.setIcon('lucide-rotate-ccw')
              .setTooltip(t('Reset to default'))
              .onClick(() => {
                const [, globalValue] = this.getSetting('enable-kanban-code-blocks', local);
                toggleComponent.setValue(globalValue !== undefined ? !!globalValue : true);

                this.applySettingsUpdate({
                  $unset: ['enable-kanban-code-blocks'],
                });
              });
          });
      });

    new Setting(contentEl)
      .setName(t('Hide linked cards when none exist'))
      .setDesc(
        t('When enabled, the linked cards display will be hidden if no linked cards are found.')
      )
      .then((setting) => {
        let toggleComponent: ToggleComponent;

        setting
          .addToggle((toggle) => {
            toggleComponent = toggle;

            const [value, globalValue] = this.getSetting(
              'hide-linked-cards-when-none-exist',
              local
            );
            const currentActualValue =
              value !== undefined
                ? value
                : globalValue !== undefined
                  ? globalValue
                  : DEFAULT_SETTINGS['hide-linked-cards-when-none-exist'];
            toggle.setValue(currentActualValue as boolean);

            toggle.onChange((newValue) => {
              this.applySettingsUpdate({
                'hide-linked-cards-when-none-exist': {
                  $set: newValue,
                },
              });
            });
          })
          .addExtraButton((b) => {
            b.setIcon('lucide-rotate-ccw')
              .setTooltip(t('Reset to default'))
              .onClick(() => {
                const [, globalValue] = this.getSetting('hide-linked-cards-when-none-exist', local);
                const defaultValue =
                  globalValue !== undefined
                    ? globalValue
                    : DEFAULT_SETTINGS['hide-linked-cards-when-none-exist'];
                toggleComponent.setValue(defaultValue as boolean);

                this.applySettingsUpdate({
                  $unset: ['hide-linked-cards-when-none-exist'],
                });
              });
          });
      });

    new Setting(contentEl)
      .setName(t('Hide linked cards when only done cards exist'))
      .setDesc(
        t(
          'When enabled, the linked cards display will be hidden if all linked cards are marked as done.'
        )
      )
      .then((setting) => {
        let toggleComponent: ToggleComponent;

        setting
          .addToggle((toggle) => {
            toggleComponent = toggle;

            const [value, globalValue] = this.getSetting('hide-linked-cards-when-only-done', local);
            const currentActualValue =
              value !== undefined
                ? value
                : globalValue !== undefined
                  ? globalValue
                  : DEFAULT_SETTINGS['hide-linked-cards-when-only-done'];
            toggle.setValue(currentActualValue as boolean);

            toggle.onChange((newValue) => {
              this.applySettingsUpdate({
                'hide-linked-cards-when-only-done': {
                  $set: newValue,
                },
              });
            });
          })
          .addExtraButton((b) => {
            b.setIcon('lucide-rotate-ccw')
              .setTooltip(t('Reset to default'))
              .onClick(() => {
                const [, globalValue] = this.getSetting('hide-linked-cards-when-only-done', local);
                const defaultValue =
                  globalValue !== undefined
                    ? globalValue
                    : DEFAULT_SETTINGS['hide-linked-cards-when-only-done'];
                toggleComponent.setValue(defaultValue as boolean);

                this.applySettingsUpdate({
                  $unset: ['hide-linked-cards-when-only-done'],
                });
              });
          });
      });

    new Setting(contentEl)
      .setName(t('Use kanban board background colours'))
      .setDesc(
        t(
          'When enabled, kanban card embeds and linked cards will use the background colors from their original kanban boards.'
        )
      )
      .then((setting) => {
        let toggleComponent: ToggleComponent;

        setting
          .addToggle((toggle) => {
            toggleComponent = toggle;

            const [value, globalValue] = this.getSetting(
              'use-kanban-board-background-colors',
              local
            );
            const currentActualValue =
              value !== undefined
                ? value
                : globalValue !== undefined
                  ? globalValue
                  : DEFAULT_SETTINGS['use-kanban-board-background-colors'];
            toggle.setValue(currentActualValue as boolean);

            toggle.onChange((newValue) => {
              this.applySettingsUpdate({
                'use-kanban-board-background-colors': {
                  $set: newValue,
                },
              });
            });
          })
          .addExtraButton((b) => {
            b.setIcon('lucide-rotate-ccw')
              .setTooltip(t('Reset to default'))
              .onClick(() => {
                const [, globalValue] = this.getSetting(
                  'use-kanban-board-background-colors',
                  local
                );
                const defaultValue =
                  globalValue !== undefined
                    ? globalValue
                    : DEFAULT_SETTINGS['use-kanban-board-background-colors'];
                toggleComponent.setValue(defaultValue as boolean);

                this.applySettingsUpdate({
                  $unset: ['use-kanban-board-background-colors'],
                });
              });
          });
      });

    contentEl.createEl('h4', { text: t('Tags') });

    // new Setting(contentEl)
    //   .setName(t('Move tags to card footer'))
    //   .setDesc(
    //     t("When toggled, tags will be displayed in the card's footer instead of the card's body.")
    //   )
    //   .then((setting) => {
    //     let toggleComponent: ToggleComponent;

    //     setting
    //       .addToggle((toggle) => {
    //         toggleComponent = toggle;

    //         const [value, globalValue] = this.getSetting('move-tags', local);

    //         if (value !== undefined) {
    //           toggle.setValue(value as boolean);
    //         } else if (globalValue !== undefined) {
    //           toggle.setValue(globalValue as boolean);
    //         }

    //         toggle.onChange((newValue) => {
    //           this.applySettingsUpdate({
    //             'move-tags': {
    //               $set: newValue,
    //             },
    //           });
    //         });
    //       })
    //       .addExtraButton((b) => {
    //         b.setIcon('lucide-rotate-ccw')
    //           .setTooltip(t('Reset to default'))
    //           .onClick(() => {
    //             const [, globalValue] = this.getSetting('move-tags', local);
    //             toggleComponent.setValue(!!globalValue);

    //             this.applySettingsUpdate({
    //               $unset: ['move-tags'],
    //             });
    //           });
    //       });
    //   });

    new Setting(contentEl)
      .setName(t('Tag click action'))
      .setDesc(
        t(
          'This setting controls whether clicking the tags displayed below the card title opens the Obsidian search or the Kanban board search.'
        )
      )
      .addDropdown((dropdown) => {
        dropdown.addOption('kanban', t('Search Kanban Board'));
        dropdown.addOption('obsidian', t('Search Obsidian Vault'));

        const [value, globalValue] = this.getSetting('tag-action', local);

        dropdown.setValue((value as string) || (globalValue as string) || 'obsidian');
        dropdown.onChange((value) => {
          this.applySettingsUpdate({
            'tag-action': {
              $set: value as 'kanban' | 'obsidian',
            },
          });
        });
      });

    new Setting(contentEl).then((setting) => {
      const [value, globalValue] = this.getSetting('tag-sort', local);

      const keys: TagSortSetting[] = ((value || globalValue || []) as TagSort[]).map((k) => {
        return {
          ...TagSortSettingTemplate,
          id: generateInstanceId(),
          data: k,
        };
      });

      renderTagSortSettings(setting.settingEl, contentEl, keys, (keys: TagSortSetting[]) =>
        this.applySettingsUpdate({
          'tag-sort': {
            $set: keys.map((k) => k.data),
          },
        })
      );

      ((this.win as any).tempKanbanCleanupFns as Array<() => void>).push(() => {
        if (setting.settingEl) {
          cleanUpTagSortSettings(setting.settingEl);
        }
      });
    });

    new Setting(contentEl).then((setting) => {
      const [value] = this.getSetting('tag-colors', local);
      const tagColorData = value as TagColor[] | undefined;

      const keys: TagColorSetting[] = (tagColorData || []).map((k) => ({
        ...TagColorSettingTemplate,
        id: generateInstanceId(),
        data: k,
      }));
      this.tagColorSettingsEl = setting.settingEl;
      renderTagColorSettings(setting.settingEl, keys, (newKeys: TagColorSetting[]) =>
        this.applySettingsUpdate({
          'tag-colors': { $set: newKeys.map((k) => k.data) },
        })
      );
      const cleanupFunctionsArray = (this.win as any).tempKanbanCleanupFns || this.cleanupFns;
      cleanupFunctionsArray.push(() => {
        if (setting.settingEl) unmountTagColorSettings(setting.settingEl);
      });
    });

    new Setting(contentEl)
      .setName(t('Apply tag colors globally'))
      .setDesc(
        t(
          'When enabled, tag colors defined above will be applied to all tags across Obsidian, not just in Kanban boards.'
        )
      )
      .then((setting) => {
        let toggleComponent: ToggleComponent;

        setting
          .addToggle((toggle) => {
            toggleComponent = toggle;

            const [value, globalValue] = this.getSetting('apply-tag-colors-globally', local);
            const currentActualValue =
              value !== undefined
                ? value
                : globalValue !== undefined
                  ? globalValue
                  : DEFAULT_SETTINGS['apply-tag-colors-globally'];
            toggle.setValue(currentActualValue as boolean);

            toggle.onChange((newValue) => {
              this.applySettingsUpdate({
                'apply-tag-colors-globally': {
                  $set: newValue,
                },
              });
            });
          })
          .addExtraButton((b) => {
            b.setIcon('lucide-rotate-ccw')
              .setTooltip(t('Reset to default'))
              .onClick(() => {
                const [, globalValue] = this.getSetting('apply-tag-colors-globally', local);
                const defaultValue =
                  globalValue !== undefined
                    ? globalValue
                    : DEFAULT_SETTINGS['apply-tag-colors-globally'];
                toggleComponent.setValue(defaultValue as boolean);

                this.applySettingsUpdate({
                  $unset: ['apply-tag-colors-globally'],
                });
              });
          });
      });

    new Setting(contentEl).then((setting) => {
      const [value] = this.getSetting('tag-symbols', local);
      const tagSymbolData = value as TagSymbolSetting[] | undefined;

      const keys: TagSymbolSetting[] = tagSymbolData || [];

      this.tagSymbolSettingsEl = setting.settingEl;
      renderTagSymbolSettings(setting.settingEl, keys, (newKeys: TagSymbolSetting[]) =>
        this.applySettingsUpdate({
          'tag-symbols': { $set: newKeys },
        })
      );
      const cleanupFunctionsArray = (this.win as any).tempKanbanCleanupFns || this.cleanupFns;
      cleanupFunctionsArray.push(() => {
        if (setting.settingEl) unmountTagSymbolSettings(setting.settingEl);
      });
    });

    new Setting(contentEl)
      .setName(t('Apply tag symbols globally'))
      .setDesc(
        t(
          'When enabled, tag symbols defined above will be applied to all tags across Obsidian, not just in Kanban boards.'
        )
      )
      .then((setting) => {
        let toggleComponent: ToggleComponent;

        setting
          .addToggle((toggle) => {
            toggleComponent = toggle;

            const [value, globalValue] = this.getSetting('apply-tag-symbols-globally', local);
            const currentActualValue =
              value !== undefined
                ? value
                : globalValue !== undefined
                  ? globalValue
                  : DEFAULT_SETTINGS['apply-tag-symbols-globally'];
            toggle.setValue(currentActualValue as boolean);

            toggle.onChange((newValue) => {
              this.applySettingsUpdate({
                'apply-tag-symbols-globally': {
                  $set: newValue,
                },
              });
            });
          })
          .addExtraButton((b) => {
            b.setIcon('lucide-rotate-ccw')
              .setTooltip(t('Reset to default'))
              .onClick(() => {
                const [, globalValue] = this.getSetting('apply-tag-symbols-globally', local);
                const defaultValue =
                  globalValue !== undefined
                    ? globalValue
                    : DEFAULT_SETTINGS['apply-tag-symbols-globally'];
                toggleComponent.setValue(defaultValue as boolean);

                this.applySettingsUpdate({
                  $unset: ['apply-tag-symbols-globally'],
                });
              });
          });
      });

    this.settingElements.push(
      new Setting(contentEl)
        .setName(t('Hide # for tags without symbols'))
        .setDesc(
          t(
            'If enabled, tags that do not have a custom symbol will be displayed without a leading "#". If disabled (the default), they will be shown with it.'
          )
        )
        .addToggle((cb) => {
          const [val] = this.getSetting('hideHashForTagsWithoutSymbols', local);
          cb.setValue((val as boolean) ?? DEFAULT_SETTINGS.hideHashForTagsWithoutSymbols).onChange(
            (value) => {
              this.applySettingsUpdate({ hideHashForTagsWithoutSymbols: { $set: value } });
            }
          );
        })
    );

    contentEl.createEl('h4', { text: t('Date & Time') });

    // new Setting(contentEl)
    //   .setName(t('Move dates to card footer'))
    //   .setDesc(
    //     t("When toggled, dates will be displayed in the card's footer instead of the card's body.")
    //   )
    //   .then((setting) => {
    //     let toggleComponent: ToggleComponent;

    //     setting
    //       .addToggle((toggle) => {
    //         toggleComponent = toggle;

    //         const [value, globalValue] = this.getSetting('move-dates', local);

    //         if (value !== undefined) {
    //           toggle.setValue(value as boolean);
    //         } else if (globalValue !== undefined) {
    //           toggle.setValue(globalValue as boolean);
    //         }

    //         toggle.onChange((newValue) => {
    //           this.applySettingsUpdate({
    //             'move-dates': {
    //               $set: newValue,
    //             },
    //           });
    //         });
    //       })
    //       .addExtraButton((b) => {
    //         b.setIcon('lucide-rotate-ccw')
    //           .setTooltip(t('Reset to default'))
    //           .onClick(() => {
    //             const [, globalValue] = this.getSetting('move-dates', local);
    //             toggleComponent.setValue((globalValue as boolean) ?? true);

    //             this.applySettingsUpdate({
    //               $unset: ['move-dates'],
    //             });
    //           });
    //       });
    //   });

    new Setting(contentEl)
      .setName(t('Date trigger'))
      .setDesc(t('When this is typed, it will trigger the date selector'))
      .addText((text) => {
        const [value, globalValue] = this.getSetting('date-trigger', local);

        if (value || globalValue) {
          text.setValue((value || globalValue) as string);
        }

        text.setPlaceholder((globalValue as string) || defaultDateTrigger);

        text.onChange((newValue) => {
          if (newValue) {
            this.applySettingsUpdate({
              'date-trigger': {
                $set: newValue,
              },
            });
          } else {
            this.applySettingsUpdate({
              $unset: ['date-trigger'],
            });
          }
        });
      });

    new Setting(contentEl)
      .setName(t('Time trigger'))
      .setDesc(t('When this is typed, it will trigger the time selector'))
      .addText((text) => {
        const [value, globalValue] = this.getSetting('time-trigger', local);

        if (value || globalValue) {
          text.setValue((value || globalValue) as string);
        }

        text.setPlaceholder((globalValue as string) || defaultTimeTrigger);

        text.onChange((newValue) => {
          if (newValue) {
            this.applySettingsUpdate({
              'time-trigger': {
                $set: newValue,
              },
            });
          } else {
            this.applySettingsUpdate({
              $unset: ['time-trigger'],
            });
          }
        });
      });

    new Setting(contentEl).setName(t('Date format')).then((setting) => {
      setting.addMomentFormat((mf) => {
        setting.descEl.appendChild(
          createFragment((frag) => {
            frag.appendText(t('This format will be used when saving dates in markdown.'));
            frag.createEl('br');
            frag.appendText(t('For more syntax, refer to') + ' ');
            frag.createEl(
              'a',
              {
                text: t('format reference'),
                href: 'https://momentjs.com/docs/#/displaying/format/',
              },
              (a) => {
                a.setAttr('target', '_blank');
              }
            );
            frag.createEl('br');
            frag.appendText(t('Your current syntax looks like this') + ': ');
            mf.setSampleEl(frag.createEl('b', { cls: 'u-pop' }));
            frag.createEl('br');
          })
        );

        const [value, globalValue] = this.getSetting('date-format', local);
        const defaultFormat = getDefaultDateFormat(this.app);

        mf.setPlaceholder(defaultFormat);
        mf.setDefaultFormat(defaultFormat);

        if (value || globalValue) {
          mf.setValue((value || globalValue) as string);
        }

        mf.onChange((newValue) => {
          if (newValue) {
            this.applySettingsUpdate({
              'date-format': {
                $set: newValue,
              },
            });
          } else {
            this.applySettingsUpdate({
              $unset: ['date-format'],
            });
          }
        });
      });
    });

    new Setting(contentEl).setName(t('Time format')).then((setting) => {
      setting.addMomentFormat((mf) => {
        setting.descEl.appendChild(
          createFragment((frag) => {
            frag.appendText(t('For more syntax, refer to') + ' ');
            frag.createEl(
              'a',
              {
                text: t('format reference'),
                href: 'https://momentjs.com/docs/#/displaying/format/',
              },
              (a) => {
                a.setAttr('target', '_blank');
              }
            );
            frag.createEl('br');
            frag.appendText(t('Your current syntax looks like this') + ': ');
            mf.setSampleEl(frag.createEl('b', { cls: 'u-pop' }));
            frag.createEl('br');
          })
        );

        const [value, globalValue] = this.getSetting('time-format', local);
        const defaultFormat = getDefaultTimeFormat(this.app);

        mf.setPlaceholder(defaultFormat);
        mf.setDefaultFormat(defaultFormat);

        if (value || globalValue) {
          mf.setValue((value || globalValue) as string);
        }

        mf.onChange((newValue) => {
          if (newValue) {
            this.applySettingsUpdate({
              'time-format': {
                $set: newValue,
              },
            });
          } else {
            this.applySettingsUpdate({
              $unset: ['time-format'],
            });
          }
        });
      });
    });

    new Setting(contentEl).setName(t('Date display format')).then((setting) => {
      setting.addMomentFormat((mf) => {
        setting.descEl.appendChild(
          createFragment((frag) => {
            frag.appendText(t('This format will be used when displaying dates in Kanban cards.'));
            frag.createEl('br');
            frag.appendText(t('For more syntax, refer to') + ' ');
            frag.createEl(
              'a',
              {
                text: t('format reference'),
                href: 'https://momentjs.com/docs/#/displaying/format/',
              },
              (a) => {
                a.setAttr('target', '_blank');
              }
            );
            frag.createEl('br');
            frag.appendText(t('Your current syntax looks like this') + ': ');
            mf.setSampleEl(frag.createEl('b', { cls: 'u-pop' }));
            frag.createEl('br');
          })
        );

        const [value, globalValue] = this.getSetting('date-display-format', local);
        const defaultFormat = getDefaultDateFormat(this.app);

        mf.setPlaceholder(defaultFormat);
        mf.setDefaultFormat(defaultFormat);

        if (value || globalValue) {
          mf.setValue((value || globalValue) as string);
        }

        mf.onChange((newValue) => {
          if (newValue) {
            this.applySettingsUpdate({
              'date-display-format': {
                $set: newValue,
              },
            });
          } else {
            this.applySettingsUpdate({
              $unset: ['date-display-format'],
            });
          }
        });
      });
    });

    new Setting(contentEl)
      .setName(t('Show relative date'))
      .setDesc(
        t(
          "When toggled, cards will display the distance between today and the card's date. eg. 'In 3 days', 'A month ago'. Relative dates will not be shown for dates from the Tasks and Dataview plugins."
        )
      )
      .then((setting) => {
        let toggleComponent: ToggleComponent;

        setting
          .addToggle((toggle) => {
            toggleComponent = toggle;

            const [value, globalValue] = this.getSetting('show-relative-date', local);

            if (value !== undefined) {
              toggle.setValue(value as boolean);
            } else if (globalValue !== undefined) {
              toggle.setValue(globalValue as boolean);
            }

            toggle.onChange((newValue) => {
              this.applySettingsUpdate({
                'show-relative-date': {
                  $set: newValue,
                },
              });
            });
          })
          .addExtraButton((b) => {
            b.setIcon('lucide-rotate-ccw')
              .setTooltip(t('Reset to default'))
              .onClick(() => {
                const [, globalValue] = this.getSetting('show-relative-date', local);
                toggleComponent.setValue(!!globalValue);

                this.applySettingsUpdate({
                  $unset: ['show-relative-date'],
                });
              });
          });
      });

    new Setting(contentEl)
      .setName(t('Link dates to daily notes'))
      .setDesc(t('When toggled, dates will link to daily notes. Eg. [[2021-04-26]]'))
      .then((setting) => {
        let toggleComponent: ToggleComponent;

        setting
          .addToggle((toggle) => {
            toggleComponent = toggle;

            const [value, globalValue] = this.getSetting('link-date-to-daily-note', local);

            if (value !== undefined) {
              toggle.setValue(value as boolean);
            } else if (globalValue !== undefined) {
              toggle.setValue(globalValue as boolean);
            }

            toggle.onChange((newValue) => {
              this.applySettingsUpdate({
                'link-date-to-daily-note': {
                  $set: newValue,
                },
              });
            });
          })
          .addExtraButton((b) => {
            b.setIcon('lucide-rotate-ccw')
              .setTooltip(t('Reset to default'))
              .onClick(() => {
                const [, globalValue] = this.getSetting('link-date-to-daily-note', local);
                toggleComponent.setValue(!!globalValue);

                this.applySettingsUpdate({
                  $unset: ['link-date-to-daily-note'],
                });
              });
          });
      });

    new Setting(contentEl).then((setting) => {
      const [value] = this.getSetting('date-colors', local);

      const keys: DateColorSetting[] = ((value || []) as DateColor[]).map((k) => {
        return {
          ...DateColorSettingTemplate,
          id: generateInstanceId(),
          data: k,
        };
      });

      renderDateSettings(
        setting.settingEl,
        keys,
        (keys: DateColorSetting[]) =>
          this.applySettingsUpdate({
            'date-colors': {
              $set: keys.map((k) => k.data),
            },
          }),
        () => {
          const [value, globalValue] = this.getSetting('date-display-format', local);
          const defaultFormat = getDefaultDateFormat(this.app);
          return value || globalValue || defaultFormat;
        },
        () => {
          const [value, globalValue] = this.getSetting('time-format', local);
          const defaultFormat = getDefaultTimeFormat(this.app);
          return value || globalValue || defaultFormat;
        }
      );

      ((this.win as any).tempKanbanCleanupFns as Array<() => void>).push(() => {
        if (setting.settingEl) {
          cleanUpDateSettings(setting.settingEl);
        }
      });
    });

    new Setting(contentEl)
      .setName(t('Add date and time to archived cards'))
      .setDesc(
        t(
          'When toggled, the current date and time will be added to the card title when it is archived. Eg. - [ ] 2021-05-14 10:00am My card title'
        )
      )
      .then((setting) => {
        let toggleComponent: ToggleComponent;

        setting
          .addToggle((toggle) => {
            toggleComponent = toggle;

            const [value, globalValue] = this.getSetting('archive-with-date', local);

            if (value !== undefined) {
              toggle.setValue(value as boolean);
            } else if (globalValue !== undefined) {
              toggle.setValue(globalValue as boolean);
            }

            toggle.onChange((newValue) => {
              this.applySettingsUpdate({
                'archive-with-date': {
                  $set: newValue,
                },
              });
            });
          })
          .addExtraButton((b) => {
            b.setIcon('lucide-rotate-ccw')
              .setTooltip(t('Reset to default'))
              .onClick(() => {
                const [, globalValue] = this.getSetting('archive-with-date', local);
                toggleComponent.setValue(!!globalValue);

                this.applySettingsUpdate({
                  $unset: ['archive-with-date'],
                });
              });
          });
      });

    new Setting(contentEl)
      .setName(t('Add archive date/time after card title'))
      .setDesc(
        t(
          'When toggled, the archived date/time will be added after the card title, e.g.- [ ] My card title 2021-05-14 10:00am. By default, it is inserted before the title.'
        )
      )
      .then((setting) => {
        let toggleComponent: ToggleComponent;

        setting
          .addToggle((toggle) => {
            toggleComponent = toggle;

            const [value, globalValue] = this.getSetting('append-archive-date', local);

            if (value !== undefined) {
              toggle.setValue(value as boolean);
            } else if (globalValue !== undefined) {
              toggle.setValue(globalValue as boolean);
            }

            toggle.onChange((newValue) => {
              this.applySettingsUpdate({
                'append-archive-date': {
                  $set: newValue,
                },
              });
            });
          })
          .addExtraButton((b) => {
            b.setIcon('lucide-rotate-ccw')
              .setTooltip(t('Reset to default'))
              .onClick(() => {
                const [, globalValue] = this.getSetting('append-archive-date', local);
                toggleComponent.setValue(!!globalValue);

                this.applySettingsUpdate({
                  $unset: ['append-archive-date'],
                });
              });
          });
      });

    new Setting(contentEl)
      .setName(t('Archive date/time separator'))
      .setDesc(t('This will be used to separate the archived date/time from the title'))
      .addText((text) => {
        const [value, globalValue] = this.getSetting('archive-date-separator', local);

        text.inputEl.placeholder = globalValue ? `${globalValue} (default)` : '';
        text.inputEl.value = value ? (value as string) : '';

        text.onChange((val) => {
          if (val) {
            this.applySettingsUpdate({
              'archive-date-separator': {
                $set: val,
              },
            });

            return;
          }

          this.applySettingsUpdate({
            $unset: ['archive-date-separator'],
          });
        });
      });

    new Setting(contentEl).setName(t('Archive date/time format')).then((setting) => {
      setting.addMomentFormat((mf) => {
        setting.descEl.appendChild(
          createFragment((frag) => {
            frag.appendText(t('For more syntax, refer to') + ' ');
            frag.createEl(
              'a',
              {
                text: t('format reference'),
                href: 'https://momentjs.com/docs/#/displaying/format/',
              },
              (a) => {
                a.setAttr('target', '_blank');
              }
            );
            frag.createEl('br');
            frag.appendText(t('Your current syntax looks like this') + ': ');
            mf.setSampleEl(frag.createEl('b', { cls: 'u-pop' }));
            frag.createEl('br');
          })
        );

        const [value, globalValue] = this.getSetting('archive-date-format', local);

        const [dateFmt, globalDateFmt] = this.getSetting('date-format', local);
        const defaultDateFmt = dateFmt || globalDateFmt || getDefaultDateFormat(this.app);
        const [timeFmt, globalTimeFmt] = this.getSetting('time-format', local);
        const defaultTimeFmt = timeFmt || globalTimeFmt || getDefaultTimeFormat(this.app);

        const defaultFormat = `${defaultDateFmt} ${defaultTimeFmt}`;

        mf.setPlaceholder(defaultFormat);
        mf.setDefaultFormat(defaultFormat);

        if (value || globalValue) {
          mf.setValue((value || globalValue) as string);
        }

        mf.onChange((newValue) => {
          if (newValue) {
            this.applySettingsUpdate({
              'archive-date-format': {
                $set: newValue,
              },
            });
          } else {
            this.applySettingsUpdate({
              $unset: ['archive-date-format'],
            });
          }
        });
      });
    });

    new Setting(contentEl)
      .setName(t('Calendar: first day of week'))
      .setDesc(t('Override which day is used as the start of the week'))
      .addDropdown((dropdown) => {
        dropdown.addOption('', t('default'));
        dropdown.addOption('0', t('Sunday'));
        dropdown.addOption('1', t('Monday'));
        dropdown.addOption('2', t('Tuesday'));
        dropdown.addOption('3', t('Wednesday'));
        dropdown.addOption('4', t('Thursday'));
        dropdown.addOption('5', t('Friday'));
        dropdown.addOption('6', t('Saturday'));

        const [value, globalValue] = this.getSetting('date-picker-week-start', local);

        dropdown.setValue(value?.toString() || globalValue?.toString() || '');
        dropdown.onChange((value) => {
          if (value) {
            this.applySettingsUpdate({
              'date-picker-week-start': {
                $set: Number(value) as 0 | 1 | 2 | 3 | 4 | 5 | 6,
              },
            });
          } else {
            this.applySettingsUpdate({
              $unset: ['date-picker-week-start'],
            });
          }
        });
      });

    contentEl.createEl('br');
    contentEl.createEl('h4', { text: t('Inline Metadata') });

    new Setting(contentEl)
      .setName(t('Inline metadata position'))
      .setDesc(
        t('Controls where the inline metadata (from the Dataview plugin) will be displayed.')
      )
      .then((s) => {
        let input: DropdownComponent;

        s.addDropdown((dropdown) => {
          input = dropdown;

          dropdown.addOption('body', t('Card body'));
          dropdown.addOption('footer', t('Card footer'));
          dropdown.addOption('metadata-table', t('Merge with linked page metadata'));

          const [value, globalValue] = this.getSetting('inline-metadata-position', local);

          dropdown.setValue(
            value?.toString() || globalValue?.toString() || defaultMetadataPosition
          );
          dropdown.onChange((value: 'body' | 'footer' | 'metadata-table') => {
            if (value) {
              this.applySettingsUpdate({
                'inline-metadata-position': {
                  $set: value,
                },
              });
            } else {
              this.applySettingsUpdate({
                $unset: ['inline-metadata-position'],
              });
            }
          });
        }).addExtraButton((b) => {
          b.setIcon('lucide-rotate-ccw')
            .setTooltip(t('Reset to default'))
            .onClick(() => {
              const [, globalValue] = this.getSetting('inline-metadata-position', local);
              input.setValue((globalValue as string) || defaultMetadataPosition);

              this.applySettingsUpdate({
                $unset: ['inline-metadata-position'],
              });
            });
        });
      });

    new Setting(contentEl)
      .setName(t('Move task data to card footer'))
      .setDesc(
        t(
          "When toggled, task data (from the Tasks plugin) will be displayed in the card's footer instead of the card's body."
        )
      )
      .then((setting) => {
        let toggleComponent: ToggleComponent;

        setting
          .addToggle((toggle) => {
            toggleComponent = toggle;

            const [value, globalValue] = this.getSetting('move-task-metadata', local);

            if (value !== undefined) {
              toggle.setValue(value as boolean);
            } else if (globalValue !== undefined) {
              toggle.setValue(globalValue as boolean);
            }

            toggle.onChange((newValue) => {
              this.applySettingsUpdate({
                'move-task-metadata': {
                  $set: newValue,
                },
              });
            });
          })
          .addExtraButton((b) => {
            b.setIcon('lucide-rotate-ccw')
              .setTooltip(t('Reset to default'))
              .onClick(() => {
                const [, globalValue] = this.getSetting('move-task-metadata', local);
                toggleComponent.setValue(!!globalValue);

                this.applySettingsUpdate({
                  $unset: ['move-task-metadata'],
                });
              });
          });
      });

    contentEl.createEl('br');
    contentEl.createEl('h4', { text: t('Linked Page Metadata') });
    contentEl.createEl('p', {
      cls: c('metadata-setting-desc'),
      text: t(
        'Display metadata for the first note linked within a card. Specify which metadata keys to display below. An optional label can be provided, and labels can be hidden altogether.'
      ),
    });

    new Setting(contentEl).then((setting) => {
      setting.settingEl.addClass(c('draggable-setting-container'));

      const [value] = this.getSetting('metadata-keys', local);

      const keys: MetadataSetting[] = ((value as DataKey[]) || ([] as DataKey[])).map((k) => {
        return {
          ...MetadataSettingTemplate,
          id: generateInstanceId(),
          data: k,
          win: getParentWindow(contentEl),
        };
      });

      renderMetadataSettings(setting.settingEl, contentEl, keys, (keys: MetadataSetting[]) =>
        this.applySettingsUpdate({
          'metadata-keys': {
            $set: keys.map((k) => k.data),
          },
        })
      );

      ((this.win as any).tempKanbanCleanupFns as Array<() => void>).push(() => {
        if (setting.settingEl) {
          cleanupMetadataSettings(setting.settingEl);
        }
      });
    });

    contentEl.createEl('h4', { text: t('Board Header Buttons') });

    new Setting(contentEl).setName(t('Add a list')).then((setting) => {
      let toggleComponent: ToggleComponent;

      setting
        .addToggle((toggle) => {
          toggleComponent = toggle;

          const [value, globalValue] = this.getSetting('show-add-list', local);

          if (value !== undefined && value !== null) {
            toggle.setValue(value as boolean);
          } else if (globalValue !== undefined && globalValue !== null) {
            toggle.setValue(globalValue as boolean);
          } else {
            // default
            toggle.setValue(true);
          }

          toggle.onChange((newValue) => {
            this.applySettingsUpdate({
              'show-add-list': {
                $set: newValue,
              },
            });
          });
        })
        .addExtraButton((b) => {
          b.setIcon('lucide-rotate-ccw')
            .setTooltip(t('Reset to default'))
            .onClick(() => {
              const [, globalValue] = this.getSetting('show-add-list', local);
              toggleComponent.setValue(!!globalValue);

              this.applySettingsUpdate({
                $unset: ['show-add-list'],
              });
            });
        });
    });

    new Setting(contentEl).setName(t('Archive completed cards')).then((setting) => {
      let toggleComponent: ToggleComponent;

      setting
        .addToggle((toggle) => {
          toggleComponent = toggle;

          const [value, globalValue] = this.getSetting('show-archive-all', local);

          if (value !== undefined && value !== null) {
            toggle.setValue(value as boolean);
          } else if (globalValue !== undefined && globalValue !== null) {
            toggle.setValue(globalValue as boolean);
          } else {
            // default
            toggle.setValue(true);
          }

          toggle.onChange((newValue) => {
            this.applySettingsUpdate({
              'show-archive-all': {
                $set: newValue,
              },
            });
          });
        })
        .addExtraButton((b) => {
          b.setIcon('lucide-rotate-ccw')
            .setTooltip(t('Reset to default'))
            .onClick(() => {
              const [, globalValue] = this.getSetting('show-archive-all', local);
              toggleComponent.setValue(!!globalValue);

              this.applySettingsUpdate({
                $unset: ['show-archive-all'],
              });
            });
        });
    });

    new Setting(contentEl).setName(t('Open as markdown')).then((setting) => {
      let toggleComponent: ToggleComponent;

      setting
        .addToggle((toggle) => {
          toggleComponent = toggle;

          const [value, globalValue] = this.getSetting('show-view-as-markdown', local);

          if (value !== undefined && value !== null) {
            toggle.setValue(value as boolean);
          } else if (globalValue !== undefined && globalValue !== null) {
            toggle.setValue(globalValue as boolean);
          } else {
            // default
            toggle.setValue(true);
          }

          toggle.onChange((newValue) => {
            this.applySettingsUpdate({
              'show-view-as-markdown': {
                $set: newValue,
              },
            });
          });
        })
        .addExtraButton((b) => {
          b.setIcon('lucide-rotate-ccw')
            .setTooltip(t('Reset to default'))
            .onClick(() => {
              const [, globalValue] = this.getSetting('show-view-as-markdown', local);
              toggleComponent.setValue(!!globalValue);

              this.applySettingsUpdate({
                $unset: ['show-view-as-markdown'],
              });
            });
        });
    });

    new Setting(contentEl).setName(t('Open board settings')).then((setting) => {
      let toggleComponent: ToggleComponent;

      setting
        .addToggle((toggle) => {
          toggleComponent = toggle;

          const [value, globalValue] = this.getSetting('show-board-settings', local);

          if (value !== undefined && value !== null) {
            toggle.setValue(value as boolean);
          } else if (globalValue !== undefined && globalValue !== null) {
            toggle.setValue(globalValue as boolean);
          } else {
            // default
            toggle.setValue(true);
          }

          toggle.onChange((newValue) => {
            this.applySettingsUpdate({
              'show-board-settings': {
                $set: newValue,
              },
            });
          });
        })
        .addExtraButton((b) => {
          b.setIcon('lucide-rotate-ccw')
            .setTooltip(t('Reset to default'))
            .onClick(() => {
              const [, globalValue] = this.getSetting('show-board-settings', local);
              toggleComponent.setValue(!!globalValue);

              this.applySettingsUpdate({
                $unset: ['show-board-settings'],
              });
            });
        });
    });

    new Setting(contentEl).setName(t('Search...')).then((setting) => {
      let toggleComponent: ToggleComponent;

      setting
        .addToggle((toggle) => {
          toggleComponent = toggle;

          const [value, globalValue] = this.getSetting('show-search', local);

          if (value !== undefined && value !== null) {
            toggle.setValue(value as boolean);
          } else if (globalValue !== undefined && globalValue !== null) {
            toggle.setValue(globalValue as boolean);
          } else {
            // default
            toggle.setValue(true);
          }

          toggle.onChange((newValue) => {
            this.applySettingsUpdate({
              'show-search': {
                $set: newValue,
              },
            });
          });
        })
        .addExtraButton((b) => {
          b.setIcon('lucide-rotate-ccw')
            .setTooltip(t('Reset to default'))
            .onClick(() => {
              const [, globalValue] = this.getSetting('show-search', local);
              toggleComponent.setValue(!!globalValue);

              this.applySettingsUpdate({
                $unset: ['show-search'],
              });
            });
        });
    });

    new Setting(contentEl).setName(t('Board view')).then((setting) => {
      let toggleComponent: ToggleComponent;

      setting
        .addToggle((toggle) => {
          toggleComponent = toggle;

          const [value, globalValue] = this.getSetting('show-set-view', local);

          if (value !== undefined && value !== null) {
            toggle.setValue(value as boolean);
          } else if (globalValue !== undefined && globalValue !== null) {
            toggle.setValue(globalValue as boolean);
          } else {
            // default
            toggle.setValue(true);
          }

          toggle.onChange((newValue) => {
            this.applySettingsUpdate({
              'show-set-view': {
                $set: newValue,
              },
            });
          });
        })
        .addExtraButton((b) => {
          b.setIcon('lucide-rotate-ccw')
            .setTooltip(t('Reset to default'))
            .onClick(() => {
              const [, globalValue] = this.getSetting('show-set-view', local);
              toggleComponent.setValue(!!globalValue);

              this.applySettingsUpdate({
                $unset: ['show-set-view'],
              });
            });
        });
    });

    // Automation section
    contentEl.createEl('h4', { text: t('Automation') });

    new Setting(contentEl)
      .setName(t('Automatically add lane tag to new cards'))
      .setDesc(
        t(
          'When enabled, new cards will automatically include a tag with the lane name (e.g., #todo, #in-progress).'
        )
      )
      .then((setting) => {
        let toggleComponent: ToggleComponent;

        setting
          .addToggle((toggle) => {
            toggleComponent = toggle;

            const [value, globalValue] = this.getSetting('auto-add-lane-tag', local);
            const currentActualValue =
              value !== undefined
                ? value
                : globalValue !== undefined
                  ? globalValue
                  : DEFAULT_SETTINGS['auto-add-lane-tag'];
            toggle.setValue(currentActualValue as boolean);

            toggle.onChange((newValue) => {
              this.applySettingsUpdate({
                'auto-add-lane-tag': {
                  $set: newValue,
                },
              });
            });
          })
          .addExtraButton((b) => {
            b.setIcon('lucide-rotate-ccw')
              .setTooltip(t('Reset to default'))
              .onClick(() => {
                const [, globalValue] = this.getSetting('auto-add-lane-tag', local);
                const defaultValue =
                  globalValue !== undefined ? globalValue : DEFAULT_SETTINGS['auto-add-lane-tag'];
                toggleComponent.setValue(defaultValue as boolean);

                this.applySettingsUpdate({
                  $unset: ['auto-add-lane-tag'],
                });
              });
          });
      });

    new Setting(contentEl)
      .setName(t('Automatically add board tag to new cards'))
      .setDesc(
        t(
          'When enabled, new cards will automatically include a tag with the board name (e.g., #project-board, #daily-tasks).'
        )
      )
      .then((setting) => {
        let toggleComponent: ToggleComponent;

        setting
          .addToggle((toggle) => {
            toggleComponent = toggle;

            const [value, globalValue] = this.getSetting('auto-add-board-tag', local);
            const currentActualValue =
              value !== undefined
                ? value
                : globalValue !== undefined
                  ? globalValue
                  : DEFAULT_SETTINGS['auto-add-board-tag'];
            toggle.setValue(currentActualValue as boolean);

            toggle.onChange((newValue) => {
              this.applySettingsUpdate({
                'auto-add-board-tag': {
                  $set: newValue,
                },
              });
            });
          })
          .addExtraButton((b) => {
            b.setIcon('lucide-rotate-ccw')
              .setTooltip(t('Reset to default'))
              .onClick(() => {
                const [, globalValue] = this.getSetting('auto-add-board-tag', local);
                const defaultValue =
                  globalValue !== undefined ? globalValue : DEFAULT_SETTINGS['auto-add-board-tag'];
                toggleComponent.setValue(defaultValue as boolean);

                this.applySettingsUpdate({
                  $unset: ['auto-add-board-tag'],
                });
              });
          });
      });

    new Setting(contentEl)
      .setName(t('Automatically move done cards to "Done" lane'))
      .setDesc(
        t(
          'When a card is marked as done, automatically move it to a lane named "Done". If the lane doesn\'t exist, it will be created.'
        )
      )
      .then((setting) => {
        let toggleComponent: ToggleComponent;

        setting
          .addToggle((toggle) => {
            toggleComponent = toggle;

            const [value, globalValue] = this.getSetting('auto-move-done-to-lane', local);
            const currentActualValue =
              value !== undefined
                ? value
                : globalValue !== undefined
                  ? globalValue
                  : DEFAULT_SETTINGS['auto-move-done-to-lane'];
            toggle.setValue(currentActualValue as boolean);

            toggle.onChange((newValue) => {
              this.applySettingsUpdate({
                'auto-move-done-to-lane': {
                  $set: newValue,
                },
              });
            });
          })
          .addExtraButton((b) => {
            b.setIcon('lucide-rotate-ccw')
              .setTooltip(t('Reset to default'))
              .onClick(() => {
                const [, globalValue] = this.getSetting('auto-move-done-to-lane', local);
                const defaultValue =
                  globalValue !== undefined
                    ? globalValue
                    : DEFAULT_SETTINGS['auto-move-done-to-lane'];
                toggleComponent.setValue(defaultValue as boolean);

                this.applySettingsUpdate({
                  $unset: ['auto-move-done-to-lane'],
                });
              });
          });
      });

    new Setting(contentEl)
      .setName(t('Hide lane tags from kanban view'))
      .setDesc(
        t(
          'When enabled, lane tags (added automatically) will be hidden from cards in the kanban view but remain in the markdown.'
        )
      )
      .then((setting) => {
        let toggleComponent: ToggleComponent;

        setting
          .addToggle((toggle) => {
            toggleComponent = toggle;

            const [value, globalValue] = this.getSetting('hide-lane-tag-display', local);
            const currentActualValue =
              value !== undefined
                ? value
                : globalValue !== undefined
                  ? globalValue
                  : DEFAULT_SETTINGS['hide-lane-tag-display'];
            toggle.setValue(currentActualValue as boolean);

            toggle.onChange((newValue) => {
              this.applySettingsUpdate({
                'hide-lane-tag-display': {
                  $set: newValue,
                },
              });
            });
          })
          .addExtraButton((b) => {
            b.setIcon('lucide-rotate-ccw')
              .setTooltip(t('Reset to default'))
              .onClick(() => {
                const [, globalValue] = this.getSetting('hide-lane-tag-display', local);
                const defaultValue =
                  globalValue !== undefined
                    ? globalValue
                    : DEFAULT_SETTINGS['hide-lane-tag-display'];
                toggleComponent.setValue(defaultValue as boolean);

                this.applySettingsUpdate({
                  $unset: ['hide-lane-tag-display'],
                });
              });
          });
      });

    new Setting(contentEl)
      .setName(t('Hide board tags from kanban view'))
      .setDesc(
        t(
          'When enabled, board tags (added automatically) will be hidden from cards in the kanban view but remain in the markdown.'
        )
      )
      .then((setting) => {
        let toggleComponent: ToggleComponent;

        setting
          .addToggle((toggle) => {
            toggleComponent = toggle;

            const [value, globalValue] = this.getSetting('hide-board-tag-display', local);
            const currentActualValue =
              value !== undefined
                ? value
                : globalValue !== undefined
                  ? globalValue
                  : DEFAULT_SETTINGS['hide-board-tag-display'];
            toggle.setValue(currentActualValue as boolean);

            toggle.onChange((newValue) => {
              this.applySettingsUpdate({
                'hide-board-tag-display': {
                  $set: newValue,
                },
              });
            });
          })
          .addExtraButton((b) => {
            b.setIcon('lucide-rotate-ccw')
              .setTooltip(t('Reset to default'))
              .onClick(() => {
                const [, globalValue] = this.getSetting('hide-board-tag-display', local);
                const defaultValue =
                  globalValue !== undefined
                    ? globalValue
                    : DEFAULT_SETTINGS['hide-board-tag-display'];
                toggleComponent.setValue(defaultValue as boolean);

                this.applySettingsUpdate({
                  $unset: ['hide-board-tag-display'],
                });
              });
          });
      });

    this.tagColorSettingsEl = contentEl.createDiv({ cls: c('tag-color-setting-wrapper') });
    this.tagSymbolSettingsEl = contentEl.createDiv({ cls: c('tag-symbol-setting-wrapper') });
  }

  cleanUp() {
    if ((this.win as any)?.tempKanbanCleanupFns) {
      delete (this.win as any).tempKanbanCleanupFns;
    }
    this.win = null;
    (this.cleanupFns || []).forEach((fn) => fn());
    this.cleanupFns = [];
  }

  rerenderSettings() {
    if (this.tagColorSettingsEl) {
      unmountTagColorSettings(this.tagColorSettingsEl);
      const [tagColorsValue] = this.getSetting('tag-colors', false);
      const tagColorData = tagColorsValue as TagColor[] | undefined;

      const tagColorSettings: TagColorSetting[] = (tagColorData || []).map((k) => ({
        ...TagColorSettingTemplate,
        id: generateInstanceId(),
        data: k,
      }));
      renderTagColorSettings(this.tagColorSettingsEl, tagColorSettings, (newKeys) => {
        this.applySettingsUpdate({ 'tag-colors': { $set: newKeys.map((k) => k.data) } });
      });
    }
    if (this.tagSymbolSettingsEl) {
      unmountTagSymbolSettings(this.tagSymbolSettingsEl);
      const [tagSymbolsValue] = this.getSetting('tag-symbols', false);
      const tagSymbolData = tagSymbolsValue as TagSymbolSetting[] | undefined;

      const tagSymbolSettings: TagSymbolSetting[] = tagSymbolData || [];

      renderTagSymbolSettings(
        this.tagSymbolSettingsEl,
        tagSymbolSettings,
        (newKeys: TagSymbolSetting[]) => {
          this.applySettingsUpdate({ 'tag-symbols': { $set: newKeys } });
        }
      );
    }
  }
}

export class SettingsModal extends Modal {
  view: KanbanView;
  settingsManager: SettingsManager;

  constructor(view: KanbanView, config: SettingsManagerConfig, settings: KanbanSettings) {
    super(view.app);

    this.view = view;
    this.settingsManager = new SettingsManager(view.plugin, config, settings);
  }

  onOpen() {
    const { contentEl, modalEl } = this;

    modalEl.addClass(c('board-settings-modal'));

    this.settingsManager.constructUI(contentEl, this.view.file.basename, true);
  }

  onClose() {
    const { contentEl } = this;

    this.settingsManager.cleanUp();
    contentEl.empty();
  }
}

export class KanbanSettingsTab extends PluginSettingTab {
  plugin: KanbanPlugin;
  settingsManager: SettingsManager;

  constructor(plugin: KanbanPlugin, config: SettingsManagerConfig) {
    super(plugin.app, plugin);
    this.plugin = plugin;
    this.settingsManager = new SettingsManager(plugin, config, plugin.settings);
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    this.settingsManager.constructUI(containerEl, t('Kanban board settings'), false);
    this.renderTeamMembersSetting(containerEl);
    this.renderDateColorSettings(containerEl);
    this.renderTagColorSettings(containerEl);
    this.renderTagSymbolSettings(containerEl);
    this.renderMetadataSettings(containerEl);
    this.renderTagSortSettings(containerEl);

    // Add new section for Email Reminders
    containerEl.createEl('h3', { text: t('Email Reminders') });

    new Setting(containerEl)
      .setName(t('Enable Due Date Email Reminders'))
      .setDesc(
        t(
          'If enabled, the plugin will help prepare email reminders for tasks due in 1 day or less.'
        )
      )
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.enableDueDateEmailReminders || false)
          .onChange(async (value) => {
            this.plugin.settings.enableDueDateEmailReminders = value;
            // Reset last run time if reminders are disabled, so it runs immediately if re-enabled.
            if (!value) {
              this.plugin.settings.dueDateReminderLastRun = 0;
            }
            await this.plugin.saveSettings();
            this.display(); // Refresh settings tab to show/hide related options if any were added
          });
      });

    new Setting(containerEl)
      .setName(t('Reminder Timeframe (Days)'))
      .setDesc(
        t(
          'Set the number of days in advance to send due date reminders (e.g., 1 for tasks due today or tomorrow).'
        )
      )
      .addText((text) => {
        text
          .setValue(this.plugin.settings.dueDateReminderTimeframeDays?.toString() || '1')
          .setPlaceholder('1')
          .onChange(async (value) => {
            const numValue = parseInt(value);
            if (!isNaN(numValue) && numValue >= 0) {
              this.plugin.settings.dueDateReminderTimeframeDays = numValue;
              text.inputEl.removeClass('error');
            } else {
              // Optionally, handle invalid input, e.g., by not saving or showing an error
              // For now, if invalid, it won't update the setting to a non-number
              // or could default back or show an error.
              text.inputEl.addClass('error'); // Indicate error on the input
              // Fallback to default if input is cleared or invalid to prevent NaN issues
              this.plugin.settings.dueDateReminderTimeframeDays =
                DEFAULT_SETTINGS.dueDateReminderTimeframeDays;
            }
            await this.plugin.saveSettings();
          });
        text.inputEl.type = 'number'; // Set input type to number for better UX
        text.inputEl.min = '0'; // Minimum value for the timeframe
      });

    // --- New Settings for Automatic Email Sending ---
    containerEl.createEl('h4', { text: t('Automatic Email Sending') });

    new Setting(containerEl)
      .setName(t('Enable Automatic Email Sending'))
      .setDesc(
        t(
          "If enabled, the plugin will attempt to send due date reminders automatically using the configured Gmail account (App Password required). WARNING: This stores your email and App Password in Obsidian's settings."
        )
      )
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.enableAutomaticEmailSending || false)
          .onChange(async (value) => {
            this.plugin.settings.enableAutomaticEmailSending = value;
            await this.plugin.saveSettings();
            this.display(); // Re-render to show/hide dependent fields
          });
      });

    if (this.plugin.settings.enableAutomaticEmailSending) {
      new Setting(containerEl)
        .setName(t('Sender Gmail Address'))
        .setDesc(t('Your full Gmail address (e.g., user@gmail.com).'))
        .addText((text) =>
          text
            .setPlaceholder('user@gmail.com')
            .setValue(this.plugin.settings.automaticEmailSenderAddress || '')
            .onChange(async (value) => {
              this.plugin.settings.automaticEmailSenderAddress = value;
              await this.plugin.saveSettings();
            })
        );

      new Setting(containerEl)
        .setName(t('Gmail App Password'))
        .setDesc(
          t(
            'An App Password generated for Obsidian from your Google Account settings. This is NOT your regular Gmail password.'
          )
        )
        .addText((text) => {
          text.inputEl.type = 'password'; // Mask the input
          text
            .setPlaceholder('abcd efgh ijkl mnop')
            .setValue(this.plugin.settings.automaticEmailAppPassword || '')
            .onChange(async (value) => {
              this.plugin.settings.automaticEmailAppPassword = value;
              await this.plugin.saveSettings();
            });
        });

      new Setting(containerEl)
        .setName(t('Automatic Sending Frequency (Days)'))
        .setDesc(
          t(
            'How often to automatically send reminder emails (e.g., 1 for daily, 7 for weekly). Minimum is 1 day.'
          )
        )
        .addText((text) => {
          text.inputEl.type = 'number';
          text.inputEl.min = '1'; // Minimum 1 day
          text
            .setValue(this.plugin.settings.automaticEmailSendingFrequencyDays?.toString() || '1')
            .setPlaceholder('1')
            .onChange(async (value) => {
              const numValue = parseInt(value);
              if (!isNaN(numValue) && numValue >= 1) {
                this.plugin.settings.automaticEmailSendingFrequencyDays = numValue;
                text.inputEl.removeClass('error');
              } else {
                this.plugin.settings.automaticEmailSendingFrequencyDays =
                  DEFAULT_SETTINGS.automaticEmailSendingFrequencyDays;
                text.inputEl.addClass('error');
              }
              await this.plugin.saveSettings();
            });
        });
    }
    // --- End Automatic Email Sending Settings ---

    this.renderHiddenSettings(containerEl);

    // Debug section - moved to bottom of all settings
    containerEl.createEl('h3', { text: 'Debug' });

    new Setting(containerEl)
      .setName('Print debug')
      .setDesc(
        'When enabled, debug information will be printed to the developer console. Error and warning messages will always be shown.'
      )
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings['print-debug'] || false).onChange(async (value) => {
          this.plugin.settings['print-debug'] = value;
          await this.plugin.saveSettings();
        });
      });
  }

  renderTeamMembersSetting(containerEl: HTMLElement) {
    containerEl.createEl('h4', { text: t('Team Members') });

    const membersSettingsEl = containerEl.createDiv();

    let memberNameInput: HTMLInputElement;
    new Setting(membersSettingsEl)
      .setName(t('Add team member'))
      .addText((text) => {
        memberNameInput = text.inputEl;
        text.setPlaceholder(t('Enter member name')).onChange(async (value) => {
          // Optional: live validation or feedback
        });
      })
      .addButton((button) =>
        button.setButtonText(t('Add')).onClick(async () => {
          const name = memberNameInput.value.trim();
          if (name && !this.plugin.settings.teamMembers?.includes(name)) {
            this.plugin.settings.teamMembers = [...(this.plugin.settings.teamMembers || []), name];
            const currentColors = this.plugin.settings.teamMemberColors || {};
            if (!currentColors[name]) {
              currentColors[name] = { background: '', text: '' };
              this.plugin.settings.teamMemberColors = currentColors;
            }
            await this.plugin.saveSettings();
            memberNameInput.value = ''; // Clear input
            renderMembersWithColors();
          }
        })
      );

    const memberColorSettingContainer = containerEl.createDiv();

    const renderMembersWithColors = () => {
      memberColorSettingContainer.innerHTML = ''; // Clear existing members and their color pickers

      const members = this.plugin.settings.teamMembers || [];
      const memberColors = this.plugin.settings.teamMemberColors || {};

      if (members.length === 0) {
        new Setting(memberColorSettingContainer).setDesc(
          'No team members added yet. Add members above first.'
        );
        return;
      }

      members.forEach((member) => {
        if (
          !memberColors[member] ||
          typeof memberColors[member].background === 'undefined' ||
          typeof memberColors[member].text === 'undefined'
        ) {
          memberColors[member] = { background: '', text: '' };
        }
        const currentMemberConfig = memberColors[member];

        const memberSetting = new Setting(memberColorSettingContainer)
          .setName(member)
          .setDesc('Set background, text colors, and email for this member.');

        memberSetting.controlEl.addClass('kanban-member-color-controls');

        // Background Color Picker
        memberSetting.controlEl.createEl('span', {
          text: 'Background:',
          cls: 'kanban-color-picker-label',
        });
        memberSetting.addColorPicker((picker) => {
          picker
            .setValue(currentMemberConfig.background || '#FFFFFF') // Use white if empty
            .onChange(async (value) => {
              const freshMemberColors = { ...(this.plugin.settings.teamMemberColors || {}) };
              freshMemberColors[member] = {
                ...(freshMemberColors[member] || { text: '' }),
                background: value,
              };
              this.plugin.settings.teamMemberColors = freshMemberColors;
              await this.plugin.saveSettings();
            });
        });

        // Text Color Picker
        const textLabel = memberSetting.controlEl.createEl('span', {
          text: 'Text:',
          cls: 'kanban-color-picker-label',
        });
        textLabel.style.marginLeft = '10px'; // Add some space before the text color picker
        memberSetting.addColorPicker((picker) => {
          picker
            .setValue(currentMemberConfig.text || '#000000') // Default to black if empty
            .onChange(async (value) => {
              const freshMemberColors = { ...(this.plugin.settings.teamMemberColors || {}) };
              freshMemberColors[member] = {
                ...(freshMemberColors[member] || { background: '' }),
                text: value,
              };
              this.plugin.settings.teamMemberColors = freshMemberColors;
              await this.plugin.saveSettings();
            });
        });

        // Email Input
        const emailLabel = memberSetting.controlEl.createEl('span', {
          text: 'Email:',
          cls: 'kanban-color-picker-label',
        });
        emailLabel.style.marginLeft = '10px';

        let emailInput: HTMLInputElement;
        memberSetting.addText((text) => {
          emailInput = text.inputEl;
          emailInput.style.marginLeft = '5px';
          text
            .setValue(currentMemberConfig.email || '')
            .setPlaceholder('Enter email (optional)')
            .onChange(async (value) => {
              const freshMemberColors = { ...(this.plugin.settings.teamMemberColors || {}) };
              freshMemberColors[member] = {
                ...(freshMemberColors[member] || { background: '', text: '' }),
                email: value.trim(),
              };
              this.plugin.settings.teamMemberColors = freshMemberColors;
              await this.plugin.saveSettings();
            });
        });

        // Remove Member Button for each member
        memberSetting.addButton((button) =>
          button
            .setIcon('trash')
            .setTooltip(t('Remove member'))
            .onClick(async () => {
              this.plugin.settings.teamMembers = (this.plugin.settings.teamMembers || []).filter(
                (m) => m !== member
              );
              const currentColors = this.plugin.settings.teamMemberColors || {};
              delete currentColors[member];
              this.plugin.settings.teamMemberColors = currentColors;
              await this.plugin.saveSettings();
              renderMembersWithColors(); // Re-render the updated list
            })
        );
      });
    };

    // Initial render of the members list with color pickers
    renderMembersWithColors();
  }

  renderDateColorSettings(containerEl: HTMLElement) {
    // Implementation of renderDateColorSettings method
  }

  renderTagColorSettings(containerEl: HTMLElement) {
    // Implementation of renderTagColorSettings method
  }

  renderTagSymbolSettings(containerEl: HTMLElement) {
    // Implementation of renderTagSymbolSettings method
  }

  renderMetadataSettings(containerEl: HTMLElement) {
    // Implementation of renderMetadataSettings method
  }

  renderTagSortSettings(containerEl: HTMLElement) {
    // Implementation of renderTagSortSettings method
  }

  renderHiddenSettings(containerEl: HTMLElement) {
    // Implementation of renderHiddenSettings method
  }
}

export const DEFAULT_SETTINGS: KanbanSettings = {
  [frontmatterKey]: 'board',
  'append-archive-date': false,
  'archive-date-format': 'MMM D, YYYY h:mm a',
  'archive-date-separator': ' - ',
  'archive-with-date': false,
  'date-colors': [
    {
      isToday: false,
      distance: 7,
      unit: 'days',
      direction: 'after',
      color: 'rgba(255, 192, 20, 0.99)',
      backgroundColor: 'rgba(0, 0, 0, 0.02)',
    },
    {
      distance: 1,
      unit: 'days',
      direction: 'after',
      color: 'rgba(255, 86, 86, 0.96)',
      isBefore: true,
      backgroundColor: 'rgba(0, 0, 0, 0.03)',
    },
  ],
  'date-display-format': 'MMM D, YYYY h:mm a',
  'date-format': 'YYYY-MM-DD',
  'date-picker-week-start': 0,
  'date-time-display-format': 'MMM D, YYYY h:mm a',
  'date-trigger': '@',
  'full-list-lane-width': false,
  'hide-card-count': false,
  'inline-metadata-position': 'body',
  'lane-width': 283,
  'link-date-to-daily-note': false,
  'list-collapse': [],
  'max-archive-size': -1,
  'metadata-keys': [],
  'move-dates': true,
  'move-tags': true,
  'move-task-metadata': false,
  'new-card-insertion-method': 'append',
  'new-line-trigger': 'shift-enter',
  'new-note-folder': '',
  'new-note-template': '',
  'show-add-list': true,
  'show-archive-all': true,
  'show-board-settings': true,
  'show-checkboxes': true,
  'show-relative-date': true,
  'show-search': true,
  'show-set-view': true,
  'show-view-as-markdown': true,
  'table-sizing': {},
  'tag-action': 'kanban',
  'tag-colors': [
    {
      tagKey: '#done',
      color: 'rgba(215, 215, 215, 1)',
      backgroundColor: 'rgba(245, 240, 255, 0.23)',
    },
    {
      tagKey: '#bug',
      color: 'rgba(211, 211, 211, 1)',
      backgroundColor: 'rgba(255, 0, 0, 0.58)',
    },
    {
      tagKey: '#doing',
      color: 'rgba(240, 240, 240, 1)',
      backgroundColor: 'rgba(0, 139, 7, 1)',
    },
    {
      tagKey: '#feature',
      color: 'rgba(242, 242, 242, 1)',
      backgroundColor: 'rgba(123, 62, 255, 1)',
    },
    {
      tagKey: '#improvement',
      color: 'rgba(255, 255, 255, 1)',
      backgroundColor: 'rgba(0, 117, 185, 1)',
    },
  ],
  'tag-sort': [],
  'time-format': 'HH:mm',
  'time-trigger': '@@',
  'tag-symbols': [
    {
      id: 'default-done',
      type: 'tag-symbol',
      accepts: [],
      children: [],
      data: {
        tagKey: '#done',
        symbol: '☑️',
      },
    },
    {
      id: 'default-bug',
      type: 'tag-symbol',
      accepts: [],
      children: [],
      data: {
        tagKey: '#bug',
        symbol: '❌',
      },
    },
    {
      id: 'default-doing',
      type: 'tag-symbol',
      accepts: [],
      children: [],
      data: {
        tagKey: '#doing',
        symbol: '🚀',
      },
    },
    {
      id: 'default-feature',
      type: 'tag-symbol',
      accepts: [],
      children: [],
      data: {
        tagKey: '#feature',
        symbol: '✨',
      },
    },
    {
      id: 'default-improvement',
      type: 'tag-symbol',
      accepts: [],
      children: [],
      data: {
        tagKey: '#improvement',
        symbol: '📈',
      },
    },
  ],
  'new-card-template': '',
  'new-lane-template': '',
  'show-button-for-new-card': true,
  'archive-heading': '## Archive',
  'archive-empty-tasks': false,
  'enable-markdown-preview-checkbox-toggle': false,
  'default-time': '12:00',
  'filter-display-mode': 'popover',
  'inline-date-format': 'relative',
  'inline-time-format': 'h:mm A',
  savedWorkspaceViews: [],
  lastSelectedWorkspaceViewId: undefined,
  clickOutsideCardToSaveEdit: true,
  hideHashForTagsWithoutSymbols: true,
  teamMembers: ['Me'],
  teamMemberColors: {
    Me: {
      background: '#afffad',
      text: '#404040',
      email: 'my@email',
    },
  },
  editable: true,
  memberAssignmentPrefix: '@@',
  'auto-move-done-to-lane': true,
  'auto-add-lane-tag': true,
  'auto-add-board-tag': true,
  'hide-lane-tag-display': true,
  'hide-board-tag-display': true,
  'apply-tag-colors-globally': true,
  'apply-tag-symbols-globally': true,
  enableDueDateEmailReminders: true,
  dueDateReminderLastRun: 0,
  dueDateReminderTimeframeDays: 7,
  enableAutomaticEmailSending: true,
  automaticEmailSenderAddress: '',
  automaticEmailAppPassword: '',
  automaticEmailSendingFrequencyDays: 7,
  hideDoneLane: true,
  timelineDayWidth: 50,
  timelineCardHeight: 40,
  'enable-kanban-card-embeds': true,
  'enable-kanban-code-blocks': true,
  'hide-linked-cards-when-none-exist': true,
  'hide-linked-cards-when-only-done': false,
  'use-kanban-board-background-colors': true,
  'member-view-lane-width': 350,
  'print-debug': false,
};

export const kanbanBoardProcessor = (settings: KanbanSettings) => {
  // ... existing code ...
};
