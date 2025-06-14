# Test Automation Settings

This file tests the new automation settings added to the Kanban plugin.

## New Settings Added

### 1. Automatically add lane tag to new cards

- **Default**: Disabled (false)
- **Description**: When enabled, new cards will automatically include a tag with the lane name (e.g., #todo, #in-progress)
- **Setting key**: `auto-add-lane-tag`

### 2. Automatically add board tag to new cards

- **Default**: Disabled (false)
- **Description**: When enabled, new cards will automatically include a tag with the board name (e.g., #project-board, #daily-tasks)
- **Setting key**: `auto-add-board-tag`

### 3. Automatically move done cards to "Done" lane

- **Default**: Disabled (false)
- **Description**: When a card is marked as done, automatically move it to a lane named "Done". If the lane doesn't exist, it will be created.
- **Setting key**: `auto-move-done-to-lane`
- **Note**: This setting was moved from its previous location to the new "Automation" section

## Settings Location

All three automation settings are now grouped together in a new "Automation" section at the bottom of the settings UI, just before the tag color and symbol settings.

## Implementation Details

- The lane and board tag addition logic is implemented in `src/parsers/formats/list.ts` in the `newItem()` function
- The settings check `stateManager.getSetting('auto-add-lane-tag')` and `stateManager.getSetting('auto-add-board-tag')` before adding tags
- Tags are only added if the respective setting is enabled
- Lane tags are formatted as `#lane-name` (lowercase, spaces replaced with hyphens)
- Board tags are formatted as `#board-filename` (lowercase, spaces replaced with hyphens)

## Testing

To test these settings:

1. Open Kanban plugin settings
2. Navigate to the "Automation" section at the bottom
3. Toggle the settings on/off
4. Create new cards and observe whether tags are automatically added
5. For the auto-move setting, mark cards as done and observe if they move to a "Done" lane

## Backward Compatibility

- All settings default to `false` (disabled) to maintain backward compatibility
- Existing behavior is preserved when settings are disabled
- The auto-move setting retains its previous functionality, just moved to a new location
