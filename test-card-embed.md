# Test Kanban Card Embeds

This is a test file to demonstrate the new Kanban card embed feature.

## How it works

When you have a Kanban board with cards that have block IDs, you can now reference them in other notes and they will be rendered as card previews instead of just links.

**NEW**: Card embeds now work in both **reading mode** and **edit mode**!

### Example Usage

Instead of seeing a plain link like this:

- [[Monomotion Mechanics/_Kanban/Overall#^bshqle]]

You'll now see a rendered preview of the actual Kanban card with:

- Card title and content
- Tags and metadata
- Due dates and other information
- A visual card-like appearance

### Modes

- **Reading Mode**: Card embeds are rendered via markdown post-processor
- **Edit Mode**: Card embeds are rendered via CodeMirror extension (NEW!)

Both modes provide the same visual card preview experience.

### Settings

This feature can be enabled/disabled in the Kanban plugin settings:

- Go to Settings > Kanban
- Look for "Enable Kanban card embeds"
- Toggle on/off as needed

### Technical Details

The feature works by:

1. Detecting internal links with block references (`#^blockId`)
2. Checking if the target file is a Kanban board
3. Finding the card with the matching block ID
4. Rendering a preview component instead of the plain link

**Reading Mode**: Uses `registerMarkdownPostProcessor` to process rendered HTML
**Edit Mode**: Uses `registerEditorExtension` with CodeMirror decorations to replace wikilinks

This makes it much easier to reference and preview Kanban cards from other notes without having to navigate to the board itself.

### Test Links

Here are some test links to try (should work in both reading and edit modes):

- [[Monomotion Mechanics/_Kanban/Overall#^bshqle|Test Card Link]]
- [[Monomotion Mechanics/_Kanban/Overall#^bshqle]]

Note: These will only work if you have a Kanban board at that path with a card containing the block ID `^bshqle`.
