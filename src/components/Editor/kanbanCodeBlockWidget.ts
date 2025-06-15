import { Extension, Range, StateField } from '@codemirror/state';
import {
  Decoration,
  DecorationSet,
  EditorView,
  PluginSpec,
  ViewPlugin,
  ViewUpdate,
  WidgetType,
} from '@codemirror/view';
import { createElement } from 'preact';
import { render, unmountComponentAtNode } from 'preact/compat';

import KanbanPlugin from '../../main';
import { stateManagerField } from './dateWidget';

interface KanbanCodeBlockWidgetState {
  plugin: KanbanPlugin;
  currentFilePath: string;
}

export const kanbanCodeBlockWidgetState = StateField.define<KanbanCodeBlockWidgetState | null>({
  create() {
    return null;
  },
  update(state) {
    return state;
  },
});

class KanbanCodeBlockWidget extends WidgetType {
  private plugin: KanbanPlugin;
  private currentFilePath: string;
  private container: HTMLElement | null = null;

  constructor(plugin: KanbanPlugin, currentFilePath: string) {
    super();
    this.plugin = plugin;
    this.currentFilePath = currentFilePath;
  }

  eq(widget: this): boolean {
    return this.plugin === widget.plugin && this.currentFilePath === widget.currentFilePath;
  }

  toDOM(): HTMLElement {
    this.container = document.createElement('div');
    this.container.className = 'kanban-plugin__linked-cards-edit-mode-container';

    // Check if the feature is enabled
    if (this.plugin.settings['enable-kanban-code-blocks'] === false) {
      this.container.innerHTML =
        '<div class="kanban-plugin__linked-cards-disabled">Kanban code blocks are disabled in settings</div>';
      return this.container;
    }

    // Dynamically import and render the LinkedCardsDisplay component
    import('../LinkedCardsDisplay')
      .then(({ LinkedCardsDisplay }) => {
        if (this.container) {
          render(
            createElement(LinkedCardsDisplay, {
              plugin: this.plugin,
              currentFilePath: this.currentFilePath,
            }),
            this.container
          );
        }
      })
      .catch((error) => {
        console.error('[KanbanPlugin] Failed to load LinkedCardsDisplay in edit mode:', error);
        if (this.container) {
          this.container.innerHTML =
            '<div class="kanban-plugin__linked-cards-error">⚠️ Error loading linked cards</div>';
        }
      });

    return this.container;
  }

  destroy(): void {
    if (this.container) {
      unmountComponentAtNode(this.container);
      this.container = null;
    }
  }

  ignoreEvent(): boolean {
    return false;
  }
}

class KanbanCodeBlockDecorator {
  decos: DecorationSet;
  private plugin: KanbanPlugin;
  private currentFilePath: string;

  constructor(view: EditorView, plugin: KanbanPlugin, currentFilePath: string) {
    this.plugin = plugin;
    this.currentFilePath = currentFilePath;
    this.decos = this.buildDecorations(view);
  }

  update(update: ViewUpdate) {
    if (update.docChanged || update.viewportChanged) {
      this.decos = this.buildDecorations(update.view);
    }
  }

  private buildDecorations(view: EditorView): DecorationSet {
    const decorations: Range<Decoration>[] = [];
    const doc = view.state.doc;
    const text = doc.toString();

    // Regular expression to match ```kanban code blocks
    const kanbanCodeBlockRegex = /^```kanban\s*\n([\s\S]*?)^```$/gm;
    let match;

    while ((match = kanbanCodeBlockRegex.exec(text)) !== null) {
      const from = match.index;
      const to = match.index + match[0].length;

      // Create a decoration that replaces the entire code block
      decorations.push(
        Decoration.replace({
          widget: new KanbanCodeBlockWidget(this.plugin, this.currentFilePath),
          block: true,
        }).range(from, to)
      );
    }

    return Decoration.set(decorations);
  }
}

const config: PluginSpec<KanbanCodeBlockDecorator> = {
  decorations: (plugin) => plugin.decos,
  provide: (pluginField) =>
    EditorView.atomicRanges.of((view) => {
      return view.plugin(pluginField)?.decos || Decoration.none;
    }),
};

export const kanbanCodeBlockPlugin: Extension = ViewPlugin.define((view) => {
  const widgetState = view.state.field(kanbanCodeBlockWidgetState);

  if (!widgetState) {
    console.warn('[KanbanPlugin] kanbanCodeBlockPlugin: No widget state found');
    return new KanbanCodeBlockDecorator(view, null as any, '');
  }

  return new KanbanCodeBlockDecorator(view, widgetState.plugin, widgetState.currentFilePath);
}, config);
