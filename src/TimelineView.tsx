import { Events, ItemView, TAbstractFile, ViewStateResult, WorkspaceLeaf } from 'obsidian';
import { createElement } from 'preact';
import { render, unmountComponentAtNode } from 'preact/compat';

import { TimelineViewComponent } from './components/Timeline/TimelineViewComponent';
import KanbanPlugin from './main';

export const TIMELINE_VIEW_TYPE = 'timeline-view';
export const TIMELINE_ICON = 'gantt-chart-square'; // Or 'bar-chart-horizontal' / 'activity'

export class TimelineView extends ItemView {
  plugin: KanbanPlugin;
  private viewEvents = new Events(); // For internal communication if needed

  constructor(leaf: WorkspaceLeaf, plugin: KanbanPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType() {
    return TIMELINE_VIEW_TYPE;
  }

  getDisplayText() {
    return 'Timeline';
  }

  getIcon() {
    return TIMELINE_ICON;
  }

  // Basic state management, can be expanded if timeline view needs to save settings/state
  getState() {
    const state = super.getState();
    // Add any timeline-specific state to save
    // e.g., state.zoomLevel = this.zoomLevel;
    return state;
  }

  async setState(state: any, result: ViewStateResult) {
    await super.setState(state, result);
    // Restore any timeline-specific state
    // e.g., if (state.zoomLevel) this.zoomLevel = state.zoomLevel;
    this.renderComponent();
  }

  // ADDED: Method to handle file/folder renames (basic, may need more logic if scan paths are configurable)
  async handleRename(file: TAbstractFile, oldPath: string) {
    console.log(`[TimelineView] handleRename: File '${oldPath}' renamed to '${file.path}'`);
    // If the timeline view depends on specific paths that might change, handle them here.
    // For now, a simple refresh might be enough if it rescans everything.
    this.viewEvents.trigger('refresh-data'); // Assuming TimelineViewComponent listens to this
  }

  private renderComponent() {
    if (this.contentEl) {
      unmountComponentAtNode(this.contentEl); // Clean up previous render
      this.contentEl.empty(); // Ensure it's empty

      render(
        createElement(TimelineViewComponent, {
          plugin: this.plugin,
          app: this.app,
          view: this,
          // Pass other necessary props to TimelineViewComponent
          // e.g., viewEvents: this.viewEvents,
        }),
        this.contentEl
      );
    }
  }

  async onOpen() {
    this.renderComponent();

    // Example of listening to an event to refresh data, if TimelineViewComponent needs it
    // this.registerEvent(this.viewEvents.on('request-refresh', () => this.scanAndDrawTimeline()));
  }

  async onload() {
    super.onload();
    // ADDED: Register rename event listener
    this.registerEvent(this.app.vault.on('rename', this.handleRename.bind(this)));
    this.renderComponent(); // Initial render
  }

  async onClose() {
    if (this.contentEl) {
      unmountComponentAtNode(this.contentEl);
    }
  }
}
