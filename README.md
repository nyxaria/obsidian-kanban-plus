# Obsidian Kanban Plugin

Create markdown-backed Kanban boards in [Obsidian](https://obsidian.md/)

- [Bugs, Issues, & Feature Requests](https://github.com/mgmeyers/obsidian-kanban/issues)
- [Development Roadmap](https://github.com/mgmeyers/obsidian-kanban/projects/1)

![Screen Shot 2021-09-16 at 12.58.22 PM.png](https://github.com/mgmeyers/obsidian-kanban/blob/main/docs/Assets/Screen%20Shot%202021-09-16%20at%2012.58.22%20PM.png)

![Screen Shot 2021-09-16 at 1.10.38 PM.png](https://github.com/mgmeyers/obsidian-kanban/blob/main/docs/Assets/Screen%20Shot%202021-09-16%20at%201.10.38%20PM.png)

## ✨ Major Features Added

### 🏢 **Workspace View**

- **Centralized card management**: View and manage cards from all your Kanban boards in one unified interface
- **Advanced filtering**: Filter by tags, team members, due dates, and priority levels
- **Saved workspace views**: Create and save custom filter combinations for different workflows

### 👥 **Member View**

- **Team-based card management**: View cards assigned to specific team members across any/all of your Kanban boards
- **Member assignment syntax**: Use `@@username` to assign cards to team members or right click -> Assign Member

### 📊 **Timeline View**

- **Gantt-chart visualization**: View your Kanban cards in a timeline format based on start and due dates
- **Date-based scheduling**: Cards with `@start{date}` and `@{due-date}` are automatically positioned
- **Interactive timeline**: Drag and resize cards to adjust dates directly in the timeline

### 🎴 **Kanban Card Embeds**

- **Smart card previews**: Internal links to Kanban cards (`[[Board#^blockId]]`) now render as interactive card previews
- **Click-through navigation**: Click embedded cards to jump directly to the source board
- **Dynamic linked cards**: Use `kanban` code blocks to automatically display cards that link to the current note
- **Auto-updating displays**: Code blocks refresh automatically when referenced cards change
- **Customizable styling**: Inherits your board's color scheme and styling preferences

### 📧 **Email Reminders & Automation**

- **Due date reminders**: Automated email notifications for tasks approaching their due dates
- **Team member notifications**: Send reminders to team members based on card assignments
- **Gmail integration**: Direct integration with Gmail using App Passwords for automated sending
- **Configurable timeframes**: Set reminder periods (daily, weekly, etc.) and lead times

### 🎨 **Enhanced Styling & Organization**

- **Global tag colors**: Set colors for tags that apply across all your Kanban boards
- **Global tag symbols**: Assign custom symbols (emojis) to tags for consistent visual identification
- **Priority system**: High/medium/low priority cards with color coding (!high, !medium, !low)
- **Board background colors**: Card embeds and linked displays inherit colors from their source boards
- **Improved card rendering**: Better handling of nested lists, multi-line content, and complex card structures
- **Team member configuration**: Set up team members with colors and email addresses

### ⚡ **Productivity Features**

- **Auto-move completed cards**: Automatically move finished cards to a "Done" lane
- **Global search highlighting**: Search terms are highlighted across all views
- **Hide/show Done lanes**: Declutter boards by hiding completed work
- **Lane and board tagging**: Automatic tagging based on board and lane locations

## Documentation

Find the plugin documentation here: [Obsidian Kanban Plugin Documentation](https://publish.obsidian.md/kanban/)

## Support

If you find this plugin useful and would like to support its development, you can sponsor [me](https://github.com/nyxaria) on Github, or buy me a coffee.

[![GitHub Sponsors](https://img.shields.io/github/sponsors/nyxaria?label=Sponsor&logo=GitHub%20Sponsors&style=for-the-badge)](https://github.com/sponsors/nyxaria)

<a href="https://coff.ee/nyxaria"><img src="https://img.buymeacoffee.com/button-api/?text=Buy me a coffee&emoji=&slug=nyxaria&button_colour=5F7FFF&font_colour=ffffff&font_family=Lato&outline_colour=000000&coffee_colour=FFDD00"></a>

## Acknowledgements

This plugin is developed on top of [mgmeyers version](https://github.com/mgmeyers/obsidian-kanban)
