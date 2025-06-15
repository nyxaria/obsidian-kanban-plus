// English

const en = {
  // main.ts
  'Open as kanban board': 'Open as kanban board',
  'Create new board': 'Create new board',
  'Archive completed cards in active board': 'Archive completed cards in active board',
  'Error: current file is not a Kanban board': 'Error: current file is not a Kanban board',
  'Convert empty note to Kanban': 'Convert empty note to Kanban',
  'Error: cannot create Kanban, the current note is not empty':
    'Error: cannot create Kanban, the current note is not empty',
  'New kanban board': 'New kanban board',
  'Untitled Kanban': 'Untitled Kanban',
  'Toggle between Kanban and markdown mode': 'Toggle between Kanban and markdown mode',

  'View as board': 'View as board',
  'View as list': 'View as list',
  'View as table': 'View as table',
  'Board view': 'Board view',

  // KanbanView.tsx
  'Open as markdown': 'Open as markdown',
  'Open board settings': 'Open board settings',
  'Archive completed cards': 'Archive completed cards',
  'Something went wrong': 'Something went wrong',
  'You may wish to open as markdown and inspect or edit the file.':
    'You may wish to open as markdown and inspect or edit the file.',
  'Are you sure you want to archive all completed cards on this board?':
    'Are you sure you want to archive all completed cards on this board?',

  // parser.ts
  Complete: 'Complete',
  Archive: 'Archive',
  'Invalid Kanban file: problems parsing frontmatter':
    'Invalid Kanban file: problems parsing frontmatter',
  "I don't know how to interpret this line:": "I don't know how to interpret this line:",
  Untitled: 'Untitled', // auto-created column

  // settingHelpers.ts
  'Note: No template plugins are currently enabled.':
    'Note: No template plugins are currently enabled.',
  default: 'default',
  'Search...': 'Search...',

  // Settings.ts
  'New line trigger': 'New line trigger',
  'Select whether Enter or Shift+Enter creates a new line. The opposite of what you choose will create and complete editing of cards and lists.':
    'Select whether Enter or Shift+Enter creates a new line. The opposite of what you choose will create and complete editing of cards and lists.',
  'Shift + Enter': 'Shift + Enter',
  Enter: 'Enter',
  'Prepend / append new cards': 'Prepend / append new cards',
  'This setting controls whether new cards are added to the beginning or end of the list.':
    'This setting controls whether new cards are added to the beginning or end of the list.',
  Prepend: 'Prepend',
  'Prepend (compact)': 'Prepend (compact)',
  Append: 'Append',
  'These settings will take precedence over the default Kanban board settings.':
    'These settings will take precedence over the default Kanban board settings.',
  'Set the default Kanban board settings. Settings can be overridden on a board-by-board basis.':
    'Set the default Kanban board settings. Settings can be overridden on a board-by-board basis.',
  'Note template': 'Note template',
  'This template will be used when creating new notes from Kanban cards.':
    'This template will be used when creating new notes from Kanban cards.',
  'No template': 'No template',
  'Note folder': 'Note folder',
  'Notes created from Kanban cards will be placed in this folder. If blank, they will be placed in the default location for this vault.':
    'Notes created from Kanban cards will be placed in this folder. If blank, they will be placed in the default location for this vault.',
  'Default folder': 'Default folder',
  'List width': 'List width',
  'Expand lists to full width in list view': 'Expand lists to full width in list view',
  'Enter a number to set the list width in pixels.':
    'Enter a number to set the list width in pixels.',
  'Maximum number of archived cards': 'Maximum number of archived cards',
  "Archived cards can be viewed in markdown mode. This setting will begin removing old cards once the limit is reached. Setting this value to -1 will allow a board's archive to grow infinitely.":
    "Archived cards can be viewed in markdown mode. This setting will begin removing old cards once the limit is reached. Setting this value to -1 will allow a board's archive to grow infinitely.",
  'Display card checkbox': 'Display card checkbox',
  'When toggled, a checkbox will be displayed with each card':
    'When toggled, a checkbox will be displayed with each card',
  'Reset to default': 'Reset to default',
  'Date & Time': 'Date & Time',
  'Date trigger': 'Date trigger',
  'When this is typed, it will trigger the date selector':
    'When this is typed, it will trigger the date selector',
  'Time trigger': 'Time trigger',
  'When this is typed, it will trigger the time selector':
    'When this is typed, it will trigger the time selector',
  'Date format': 'Date format',
  'This format will be used when saving dates in markdown.':
    'This format will be used when saving dates in markdown.',
  'For more syntax, refer to': 'For more syntax, refer to',
  'format reference': 'format reference',
  'Your current syntax looks like this': 'Your current syntax looks like this',
  'Time format': 'Time format',
  'Date display format': 'Date display format',
  'This format will be used when displaying dates in Kanban cards.':
    'This format will be used when displaying dates in Kanban cards.',
  'Show relative date': 'Show relative date',
  "When toggled, cards will display the distance between today and the card's date. eg. 'In 3 days', 'A month ago'. Relative dates will not be shown for dates from the Tasks and Dataview plugins.":
    "When toggled, cards will display the distance between today and the card's date. eg. 'In 3 days', 'A month ago'. Relative dates will not be shown for dates from the Tasks and Dataview plugins.",

  // Timeline View Settings
  'Timeline Day Width': 'Timeline Day Width',
  'The width of each day column in the timeline view, in pixels.':
    'The width of each day column in the timeline view, in pixels.',
  'Timeline Card Height': 'Timeline Card Height',
  'The height of each card in the timeline view, in pixels.':
    'The height of each card in the timeline view, in pixels.',

  'Move dates to card footer': 'Move dates to card footer',
  "When toggled, dates will be displayed in the card's footer instead of the card's body.":
    "When toggled, dates will be displayed in the card's footer instead of the card's body.",
  'Move tags to card footer': 'Move tags to card footer',
  "When toggled, tags will be displayed in the card's footer instead of the card's body.":
    "When toggled, tags will be displayed in the card's footer instead of the card's body.",
  'Move task data to card footer': 'Move task data to card footer',
  "When toggled, task data (from the Tasks plugin) will be displayed in the card's footer instead of the card's body.":
    "When toggled, task data (from the Tasks plugin) will be displayed in the card's footer instead of the card's body.",
  'Inline metadata position': 'Inline metadata position',
  'Controls where the inline metadata (from the Dataview plugin) will be displayed.':
    'Controls where the inline metadata (from the Dataview plugin) will be displayed.',
  'Card body': 'Card body',
  'Card footer': 'Card footer',
  'Merge with linked page metadata': 'Merge with linked page metadata',

  'Hide card counts in list titles': 'Hide card counts in list titles',
  'When toggled, card counts are hidden from the list title':
    'When toggled, card counts are hidden from the list title',
  'Link dates to daily notes': 'Link dates to daily notes',
  'When toggled, dates will link to daily notes. Eg. [[2021-04-26]]':
    'When toggled, dates will link to daily notes. Eg. [[2021-04-26]]',
  'Add date and time to archived cards': 'Add date and time to archived cards',
  'When toggled, the current date and time will be added to the card title when it is archived. Eg. - [ ] 2021-05-14 10:00am My card title':
    'When toggled, the current date and time will be added to the card title when it is archived. Eg. - [ ] 2021-05-14 10:00am My card title',
  'Add archive date/time after card title': 'Add archive date/time after card title',
  'When toggled, the archived date/time will be added after the card title, e.g.- [ ] My card title 2021-05-14 10:00am. By default, it is inserted before the title.':
    'When toggled, the archived date/time will be added after the card title, e.g.- [ ] My card title 2021-05-14 10:00am. By default, it is inserted before the title.',
  'Archive date/time separator': 'Archive date/time separator',
  'This will be used to separate the archived date/time from the title':
    'This will be used to separate the archived date/time from the title',
  'Archive date/time format': 'Archive date/time format',
  'Kanban Plugin': 'Kanban Plugin',
  'Tag click action': 'Tag click action',
  'Search Kanban Board': 'Search Kanban Board',
  'Search Obsidian Vault': 'Search Obsidian Vault',
  'This setting controls whether clicking the tags displayed below the card title opens the Obsidian search or the Kanban board search.':
    'This setting controls whether clicking the tags displayed below the card title opens the Obsidian search or the Kanban board search.',
  'Tag colors': 'Tag colors',
  'Tag symbols': 'Tag symbols',
  'Set colors for tags displayed in cards.': 'Set colors for tags displayed in cards.',
  'Set symbols for tags displayed in cards.': 'Set symbols for tags displayed in cards.',
  'Hide # for tags without symbols': 'Hide # for tags without symbols',
  'If enabled, tags that do not have a custom symbol will be displayed without a leading "#". If disabled (the default), they will be shown with it.':
    'If enabled, tags that do not have a custom symbol will be displayed without a leading "#". If disabled (the default), they will be shown with it.',
  'Linked Page Metadata': 'Linked Page Metadata',
  'Inline Metadata': 'Inline Metadata',
  'Display metadata for the first note linked within a card. Specify which metadata keys to display below. An optional label can be provided, and labels can be hidden altogether.':
    'Display metadata for the first note linked within a card. Specify which metadata keys to display below. An optional label can be provided, and labels can be hidden altogether.',
  'Board Header Buttons': 'Board Header Buttons',
  'Calendar: first day of week': 'Calendar: first day of week',
  'Override which day is used as the start of the week':
    'Override which day is used as the start of the week',
  Sunday: 'Sunday',
  Monday: 'Monday',
  Tuesday: 'Tuesday',
  Wednesday: 'Wednesday',
  Thursday: 'Thursday',
  Friday: 'Friday',
  Saturday: 'Saturday',
  'Background color': 'Background color',
  Tag: 'Tag',
  Symbol: 'Symbol',
  'Tag Symbols': 'Tag Symbols',
  'Text color': 'Text color',
  'Date is': 'Date is',
  Today: 'Today',
  'After now': 'After now',
  'Before now': 'Before now',
  'Between now and': 'Between now and',
  'Display date colors': 'Display date colors',
  'Set colors for dates displayed in cards based on the rules below.':
    'Set colors for dates displayed in cards based on the rules below.',
  'Add date color': 'Add date color',

  // MetadataSettings.tsx
  'Metadata key': 'Metadata key',
  'Display label': 'Display label',
  'Hide label': 'Hide label',
  'Drag to rearrange': 'Drag to rearrange',
  Delete: 'Delete',
  'Add key': 'Add key',
  'Add tag': 'Add tag',
  'Field contains markdown': 'Field contains markdown',
  'Tag sort order': 'Tag sort order',
  'Set an explicit sort order for the specified tags.':
    'Set an explicit sort order for the specified tags.',

  // TagColorSettings.tsx
  'Add tag color': 'Add tag color',
  'Add tag symbol': 'Add tag symbol',

  // components/Table.tsx
  List: 'List',
  Card: 'Card',
  Date: 'Date',
  Tags: 'Tags',

  Priority: 'Priority',
  Start: 'Start',
  End: 'End',
  Effort: 'Effort',
  Created: 'Created',
  Scheduled: 'Scheduled',
  Due: 'Due',
  Cancelled: 'Cancelled',
  Recurrence: 'Recurrence',
  'Depends on': 'Depends on',
  ID: 'ID',

  // components/Item/Item.tsx
  'More options': 'More options',
  Cancel: 'Cancel',
  Done: 'Done',
  Save: 'Save',

  // components/Item/ItemContent.tsx
  today: 'today',
  yesterday: 'yesterday',
  tomorrow: 'tomorrow',
  'Change date': 'Change date',
  'Change time': 'Change time',

  // components/Item/ItemForm.tsx
  'Card title...': 'Card title...',
  'Add card': 'Add card',
  'Add a card': 'Add a card',

  // components/Item/ItemMenu.ts
  'Edit card': 'Edit card',
  'New note from card': 'New note from card',
  'Archive card': 'Archive card',
  'Delete card': 'Delete card',
  'Edit date': 'Edit date',
  'Add date': 'Add date',
  'Remove date': 'Remove date',
  'Edit time': 'Edit time',
  'Add time': 'Add time',
  'Remove time': 'Remove time',
  'Duplicate card': 'Duplicate card',
  'Split card': 'Split card',
  'Copy link to card': 'Copy link to card',
  'Insert card before': 'Insert card before',
  'Insert card after': 'Insert card after',
  'Add label': 'Add label',
  'Move to top': 'Move to top',
  'Move to bottom': 'Move to bottom',
  'Move to list': 'Move to list',

  // components/Lane/LaneForm.tsx
  'Enter list title...': 'Enter list title...',
  'Mark cards in this list as complete': 'Mark cards in this list as complete',
  'Add list': 'Add list',
  'Add a list': 'Add a list',

  // components/Lane/LaneHeader.tsx
  'Move list': 'Move list',
  Close: 'Close',

  // components/Lane/LaneMenu.tsx
  'Are you sure you want to delete this list and all its cards?':
    'Are you sure you want to delete this list and all its cards?',
  'Yes, delete list': 'Yes, delete list',
  'Are you sure you want to archive this list and all its cards?':
    'Are you sure you want to archive this list and all its cards?',
  'Yes, archive list': 'Yes, archive list',
  'Are you sure you want to archive all cards in this list?':
    'Are you sure you want to archive all cards in this list?',
  'Yes, archive cards': 'Yes, archive cards',
  'Edit list': 'Edit list',
  'Archive cards': 'Archive cards',
  'Archive list': 'Archive list',
  'Delete list': 'Delete list',
  'Insert list before': 'Insert list before',
  'Insert list after': 'Insert list after',
  'Sort by card text': 'Sort by card text',
  'Sort by date': 'Sort by date',
  'Sort by tags': 'Sort by tags',
  'Sort by': 'Sort by',

  // components/helpers/renderMarkdown.ts
  'Unable to find': 'Unable to find',
  'Open in default app': 'Open in default app',

  // Click to stop editing
  'Click outside note to save edit': 'Click outside note to save edit',
  'When enabled, clicking anywhere outside an editing note will save the changes and close the editor.':
    'When enabled, clicking anywhere outside an editing note will save the changes and close the editor.',

  // components/Editor/MarkdownEditor.tsx
  Submit: 'Submit',

  'Remove member': 'Remove member',
  'Team Member Colors': 'Team Member Colors',
  'Assign a color to each team member for better visual distinction in the workspace view.':
    'Assign a color to each team member for better visual distinction in the workspace view.',
  'Background Color': 'Background Color',
  'Text Color': 'Text Color',
  'Member Assignment Prefix': 'Member Assignment Prefix',
  'The prefix used to identify member assignments in card text (e.g., @@User)':
    'The prefix used to identify member assignments in card text (e.g., @@User)',

  // Embeds section
  Embeds: 'Embeds',
  'Enable Kanban card embeds': 'Enable Kanban card embeds',
  'When enabled, internal links to Kanban cards (e.g., [[Board#^blockId]]) will be rendered as card previews instead of regular links.':
    'When enabled, internal links to Kanban cards (e.g., [[Board#^blockId]]) will be rendered as card previews instead of regular links.',
  'Enable Kanban code blocks': 'Enable Kanban code blocks',
  'When enabled, ```kanban``` code blocks will be replaced with a display of all Kanban cards that link to the current note.':
    'When enabled, ```kanban``` code blocks will be replaced with a display of all Kanban cards that link to the current note.',
  'Use kanban board background colours': 'Use kanban board background colours',
  'When enabled, kanban card embeds and linked cards will use the background colors from their original kanban boards.':
    'When enabled, kanban card embeds and linked cards will use the background colors from their original kanban boards.',

  // Workspace View Specific
  'Kanban Workspace': 'Kanban Workspace',

  // Added for "auto-move-done-to-lane" setting
  'Automatically move done cards to "Done" lane': 'Automatically move done cards to "Done" lane',
  'When a card is marked as done, automatically move it to a lane named "Done". If the lane doesn\'t exist, it will be created.':
    'When a card is marked as done, automatically move it to a lane named "Done". If the lane doesn\'t exist, it will be created.',
  // Potentially missing strings flagged by linter earlier (might be duplicates or already exist, adding defensively)
  'Kanban board settings': 'Kanban board settings',
  'Team Members': 'Team Members',
  'Add team member': 'Add team member',
  'Enter member name': 'Enter member name',
  Add: 'Add',

  // Settings for Email Reminders (NEW)
  'Email Reminders': 'Email Reminders',
  'Enable Due Date Email Reminders': 'Enable Due Date Email Reminders',
  'If enabled, the plugin will help prepare email reminders for tasks due in 1 day or less.':
    'If enabled, the plugin will help prepare email reminders for tasks due in 1 day or less.',
  'Reminder Timeframe (Days)': 'Reminder Timeframe (Days)',
  'Set the number of days in advance to send due date reminders (e.g., 1 for tasks due today or tomorrow).':
    'Set the number of days in advance to send due date reminders (e.g., 1 for tasks due today or tomorrow).',

  // Settings for Automatic Email Sending (NEW)
  'Automatic Email Sending': 'Automatic Email Sending',
  'Enable Automatic Email Sending': 'Enable Automatic Email Sending',
  "If enabled, the plugin will attempt to send due date reminders automatically using the configured Gmail account (App Password required). WARNING: This stores your email and App Password in Obsidian's settings.":
    "If enabled, the plugin will attempt to send due date reminders automatically using the configured Gmail account (App Password required). WARNING: This stores your email and App Password in Obsidian's settings.",
  'Sender Gmail Address': 'Sender Gmail Address',
  'Your full Gmail address (e.g., user@gmail.com).':
    'Your full Gmail address (e.g., user@gmail.com).',
  'Gmail App Password': 'Gmail App Password',
  'An App Password generated for Obsidian from your Google Account settings. This is NOT your regular Gmail password.':
    'An App Password generated for Obsidian from your Google Account settings. This is NOT your regular Gmail password.',
  'Automatic Sending Frequency (Days)': 'Automatic Sending Frequency (Days)',
  'How often to automatically send reminder emails (e.g., 1 for daily, 7 for weekly). Minimum is 1 day.':
    'How often to automatically send reminder emails (e.g., 1 for daily, 7 for weekly). Minimum is 1 day.',
  "Hide 'Done' lane": "Hide 'Done' lane",
  'If enabled, lanes with the exact title "Done" (case-insensitive) will be hidden from the board view.':
    'If enabled, lanes with the exact title "Done" (case-insensitive) will be hidden from the board view.',
  'Display card count in list header': 'Display card count in list header',
  'When toggled, the number of cards in a list will be displayed in the list header':
    'When toggled, the number of cards in a list will be displayed in the list header',

  // Automation settings
  Automation: 'Automation',
  'Automatically add lane tag to new cards': 'Automatically add lane tag to new cards',
  'When enabled, new cards will automatically include a tag with the lane name (e.g., #todo, #in-progress).':
    'When enabled, new cards will automatically include a tag with the lane name (e.g., #todo, #in-progress).',
  'Automatically add board tag to new cards': 'Automatically add board tag to new cards',
  'When enabled, new cards will automatically include a tag with the board name (e.g., #project-board, #daily-tasks).':
    'When enabled, new cards will automatically include a tag with the board name (e.g., #project-board, #daily-tasks).',
  'Hide lane tags from kanban view': 'Hide lane tags from kanban view',
  'When enabled, lane tags (added automatically) will be hidden from cards in the kanban view but remain in the markdown.':
    'When enabled, lane tags (added automatically) will be hidden from cards in the kanban view but remain in the markdown.',
  'Hide board tags from kanban view': 'Hide board tags from kanban view',
  'When enabled, board tags (added automatically) will be hidden from cards in the kanban view but remain in the markdown.':
    'When enabled, board tags (added automatically) will be hidden from cards in the kanban view but remain in the markdown.',
  'Apply tag colors globally': 'Apply tag colors globally',
  'When enabled, tag colors defined above will be applied to all tags across Obsidian, not just in Kanban boards.':
    'When enabled, tag colors defined above will be applied to all tags across Obsidian, not just in Kanban boards.',
  'Apply tag symbols globally': 'Apply tag symbols globally',
  'When enabled, tag symbols defined above will be applied to all tags across Obsidian, not just in Kanban boards.':
    'When enabled, tag symbols defined above will be applied to all tags across Obsidian, not just in Kanban boards.',
  'Hide linked cards when none exist': 'Hide linked cards when none exist',
  'When enabled, the linked cards display will be hidden if no linked cards are found.':
    'When enabled, the linked cards display will be hidden if no linked cards are found.',
  'Hide linked cards when only done cards exist': 'Hide linked cards when only done cards exist',
  'When enabled, the linked cards display will be hidden if all linked cards are marked as done.':
    'When enabled, the linked cards display will be hidden if all linked cards are marked as done.',
};

export type Lang = typeof en;
export default en;
