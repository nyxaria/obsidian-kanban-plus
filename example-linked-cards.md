# Example: Linked Kanban Cards Display

This document demonstrates the new `kanban` code block feature that displays all Kanban cards that link to the current note.

## How it works

When you create a `kanban` code block in any markdown note, it will automatically:

1. Scan all Kanban boards in your vault
2. Find cards that contain wikilinks to the current note
3. Display those cards in a nice grid layout

## Example Usage

Simply add a code block with the language set to "kanban":

```kanban

```

This will be replaced with a display of all cards that link to this note.

## Card Detection

The feature looks for these types of links in Kanban cards:

- `[[Example: Linked Kanban Cards Display]]` (direct link to this note)
- `[[example-linked-cards]]` (link using filename)
- `[[Example: Linked Kanban Cards Display|Custom Text]]` (link with custom display text)

## Features

The displayed cards include:

- Card title and content
- Board name and lane name
- Tags and metadata
- Due dates (if set)
- Completion status (checkbox)
- Clickable links to open the actual card

## Settings

You can enable/disable this feature in:

1. Go to Settings → Kanban
2. Look for "Enable Kanban code blocks"
3. Toggle on/off as needed

## Use Cases

This feature is useful for:

- **Project notes**: See all tasks across different boards that relate to this project
- **Meeting notes**: View all action items that reference this meeting
- **Documentation**: Show all tasks that need to be done for this feature
- **Person pages**: Display all tasks assigned to or mentioning a specific person

## Technical Notes

- The feature only works in reading mode (not in edit mode)
- Cards are sorted by board name, then lane name, then title
- Only cards with actual wikilinks to the current note are shown
- The display updates automatically when cards are added/removed

Try creating some Kanban cards that link to this note to see the feature in action!
