import { insertBlankLine } from '@codemirror/commands';
import { EditorSelection, Extension, Prec } from '@codemirror/state';
import { EditorView, ViewUpdate, keymap, placeholder as placeholderExt } from '@codemirror/view';
import classcat from 'classcat';
import { EditorPosition, Editor as ObsidianEditor, Platform } from 'obsidian';
import { MutableRefObject, useContext, useEffect, useRef } from 'preact/compat';
import { KanbanView } from 'src/KanbanView';
import { StateManager } from 'src/StateManager';
import { t } from 'src/lang/helpers';

import { KanbanContext } from '../context';
import { c, noop } from '../helpers';
import { EditState, isEditCoordinates } from '../types';
import { datePlugins, stateManagerField } from './dateWidget';
import { kanbanCodeBlockPlugin, kanbanCodeBlockWidgetState } from './kanbanCodeBlockWidget';
import { matchDateTrigger, matchTimeTrigger } from './suggest';

interface MarkdownEditorProps {
  editorRef?: MutableRefObject<EditorView>;
  editState?: EditState;
  onEnter: (cm: EditorView, mod: boolean, shift: boolean) => boolean;
  onEscape: (cm: EditorView) => void;
  onSubmit: (cm: EditorView) => void;
  onPaste?: (e: ClipboardEvent, cm: EditorView) => void;
  onChange?: (update: ViewUpdate) => void;
  value?: string;
  className: string;
  placeholder?: string;
  itemElement?: HTMLElement;
}

export function allowNewLine(stateManager: StateManager, mod: boolean, shift: boolean) {
  if (Platform.isMobile) return !(mod || shift);
  return stateManager.getSetting('new-line-trigger') === 'enter' ? !(mod || shift) : mod || shift;
}

function getEditorAppProxy(view: KanbanView) {
  return new Proxy(view.app, {
    get(target, prop, reveiver) {
      if (prop === 'vault') {
        return new Proxy(view.app.vault, {
          get(target, prop, reveiver) {
            if (prop === 'config') {
              return new Proxy((view.app.vault as any).config, {
                get(target, prop, reveiver) {
                  if (['showLineNumber', 'foldHeading', 'foldIndent'].includes(prop as string)) {
                    return false;
                  }
                  return Reflect.get(target, prop, reveiver);
                },
              });
            }
            return Reflect.get(target, prop, reveiver);
          },
        });
      }
      return Reflect.get(target, prop, reveiver);
    },
  });
}

function getMarkdownController(
  view: KanbanView,
  getEditor: () => ObsidianEditor
): Record<any, any> {
  return {
    app: view.app,
    showSearch: noop,
    toggleMode: noop,
    onMarkdownScroll: noop,
    getMode: () => 'source',
    scroll: 0,
    editMode: null,
    get editor() {
      return getEditor();
    },
    get file() {
      return view.file;
    },
    get path() {
      return view.file.path;
    },
  };
}

function setInsertMode(cm: EditorView) {
  const vim = getVimPlugin(cm);
  if (vim) {
    (window as any).CodeMirrorAdapter?.Vim?.enterInsertMode(vim);
  }
}

function getVimPlugin(cm: EditorView): string {
  return (cm as any)?.plugins?.find((p: any) => {
    if (!p?.value) return false;
    return 'useNextTextInput' in p.value && 'waitForCopy' in p.value;
  })?.value?.cm;
}

function findCardContainer(element: HTMLElement): HTMLElement | null {
  // Try to find the card container using multiple selectors
  const selectors = [
    '.kanban-plugin__item-wrapper',
    '.kanban-plugin__item',
    '.kanban-plugin__item-content-wrapper',
    '[data-id]', // Fallback to any element with data-id
  ];

  for (const selector of selectors) {
    const container = element.closest(selector);
    if (container) {
      return container as HTMLElement;
    }
  }

  return element; // Return the element itself as fallback
}

function scrollCardIntoView(itemElement: HTMLElement, behavior: ScrollBehavior = 'smooth') {
  try {
    const cardContainer = findCardContainer(itemElement);
    if (cardContainer) {
      cardContainer.scrollIntoView({
        block: 'center',
        behavior,
        inline: 'nearest',
      });
      return true;
    }
  } catch (error) {
    console.warn('Error scrolling card into view:', error);
  }
  return false;
}

function calculateCursorPosition(
  editState: EditState,
  value: string,
  itemElement?: HTMLElement
): number {
  // If no edit coordinates are provided, default to end of text
  if (!isEditCoordinates(editState)) {
    return value.length;
  }

  const { x, y } = editState;

  // If we have an item element, try to calculate position based on click coordinates
  if (itemElement) {
    try {
      // Get the text content element within the item
      const textElement = itemElement.querySelector(
        '.kanban-plugin__item-markdown, .kanban-plugin__item-text-wrapper'
      );

      if (textElement) {
        const rect = textElement.getBoundingClientRect();

        // Calculate relative position within the text element
        const relativeX = x - rect.left;
        const relativeY = y - rect.top;

        // If click is in the bottom half of the element, position cursor at end
        if (relativeY > rect.height / 2) {
          return value.length;
        }

        // If click is in the top half, try to find a reasonable position
        // For now, we'll estimate based on the percentage of height clicked
        const heightPercentage = relativeY / rect.height;
        const lines = value.split('\n');
        const targetLine = Math.floor(heightPercentage * lines.length);

        // Calculate character position up to the target line
        let charPosition = 0;
        for (let i = 0; i < Math.min(targetLine, lines.length); i++) {
          charPosition += lines[i].length;
          if (i < lines.length - 1) charPosition += 1; // Add 1 for newline character
        }

        return Math.min(charPosition, value.length);
      }
    } catch (error) {
      // If anything goes wrong, fall back to end position
      console.warn('Error calculating cursor position:', error);
    }
  }

  // Default to end of text
  return value.length;
}

export function MarkdownEditor({
  editorRef,
  onEnter,
  onEscape,
  onChange,
  onPaste,
  className,
  onSubmit,
  editState,
  value,
  placeholder,
  itemElement,
}: MarkdownEditorProps) {
  const { view, stateManager } = useContext(KanbanContext);
  const elRef = useRef<HTMLDivElement>();
  const internalRef = useRef<EditorView>();

  useEffect(() => {
    class Editor extends view.plugin.MarkdownEditor {
      isKanbanEditor = true;

      showTasksPluginAutoSuggest(
        cursor: EditorPosition,
        editor: ObsidianEditor,
        lineHasGlobalFilter: boolean
      ) {
        if (matchTimeTrigger(stateManager.getSetting('time-trigger'), editor, cursor)) return false;
        if (matchDateTrigger(stateManager.getSetting('date-trigger'), editor, cursor)) return false;
        if (lineHasGlobalFilter && cursor.line === 0) return true;
        return undefined;
      }

      updateBottomPadding() {}
      onUpdate(update: ViewUpdate, changed: boolean) {
        super.onUpdate(update, changed);
        onChange && onChange(update);
      }
      buildLocalExtensions(): Extension[] {
        const extensions = super.buildLocalExtensions();

        extensions.push(stateManagerField.init(() => stateManager));
        extensions.push(datePlugins);

        // Add kanban code block widget support
        const plugin = (view as any)?.plugin;
        if (plugin) {
          extensions.push(
            kanbanCodeBlockWidgetState.init(() => ({
              plugin: plugin,
              currentFilePath: view.file?.path || '',
            }))
          );
          extensions.push(kanbanCodeBlockPlugin);
        }
        extensions.push(
          Prec.highest(
            EditorView.domEventHandlers({
              focus: (evt) => {
                view.activeEditor = this.owner;
                if (Platform.isMobile) {
                  view.contentEl.addClass('is-mobile-editing');
                }

                evt.win.setTimeout(() => {
                  this.app.workspace.activeEditor = this.owner;
                  if (Platform.isMobile) {
                    this.app.mobileToolbar.update();
                  }
                });
                return true;
              },
              blur: () => {
                if (Platform.isMobile) {
                  view.contentEl.removeClass('is-mobile-editing');
                  this.app.mobileToolbar.update();
                }
                return true;
              },
            })
          )
        );

        if (placeholder) extensions.push(placeholderExt(placeholder));
        if (onPaste) {
          extensions.push(
            Prec.high(
              EditorView.domEventHandlers({
                paste: onPaste,
              })
            )
          );
        }

        const makeEnterHandler = (mod: boolean, shift: boolean) => (cm: EditorView) => {
          const didRun = onEnter(cm, mod, shift);
          if (didRun) return true;
          if (this.app.vault.getConfig('smartIndentList')) {
            this.editor.newlineAndIndentContinueMarkdownList();
          } else {
            insertBlankLine(cm as any);
          }
          return true;
        };

        extensions.push(
          Prec.highest(
            keymap.of([
              {
                key: 'Enter',
                run: makeEnterHandler(false, false),
                shift: makeEnterHandler(false, true),
                preventDefault: true,
              },
              {
                key: 'Mod-Enter',
                run: makeEnterHandler(true, false),
                shift: makeEnterHandler(true, true),
                preventDefault: true,
              },
              {
                key: 'Escape',
                run: (cm) => {
                  onEscape(cm);
                  return false;
                },
                preventDefault: true,
              },
            ])
          )
        );

        return extensions;
      }
    }

    const controller = getMarkdownController(view, () => editor.editor);
    const app = getEditorAppProxy(view);
    const editor = view.plugin.addChild(new (Editor as any)(app, elRef.current, controller));
    const cm: EditorView = editor.cm;

    internalRef.current = cm;
    if (editorRef) editorRef.current = cm;

    controller.editMode = editor;
    editor.set(value || '');

    // Calculate cursor position based on click coordinates or default to end
    const cursorPosition = calculateCursorPosition(editState, value || '', itemElement);

    if (isEditCoordinates(editState)) {
      const editorInstance = internalRef.current;
      if (editorInstance && !editorInstance.hasFocus) {
        editorInstance.focus();
      }

      // Set cursor position WITHOUT automatic scrolling to prevent conflicts
      cm.dispatch({
        selection: EditorSelection.cursor(cursorPosition),
        scrollIntoView: false, // This prevents CodeMirror's automatic scrolling
      });

      // Now handle scrolling manually with smooth animation
      cm.dom.win.setTimeout(() => {
        setInsertMode(cm);

        // Ensure the entire card is visible with smooth scrolling
        if (itemElement) {
          if (!scrollCardIntoView(itemElement, 'smooth')) {
            // Fallback if scrollCardIntoView fails
            try {
              itemElement.scrollIntoView({ block: 'center', behavior: 'smooth' });
            } catch (error) {
              console.warn('Fallback scroll failed:', error);
            }
          }
        }

        // Then, after scrolling animation, fine-tune cursor visibility if needed
        cm.dom.win.setTimeout(() => {
          const cursorElement = cm.dom.querySelector('.cm-cursor');
          if (cursorElement) {
            // Check if cursor is already visible before scrolling
            const cursorRect = cursorElement.getBoundingClientRect();
            const viewportHeight = window.innerHeight;
            const isVisible = cursorRect.top >= 0 && cursorRect.bottom <= viewportHeight;

            if (!isVisible) {
              cursorElement.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
            }
          }
        }, 300); // Wait for card scroll animation to complete
      }, 50);
    } else {
      // For non-editing states, set cursor normally
      cm.dispatch({ selection: EditorSelection.cursor(cursorPosition) });
    }

    const onShow = () => {
      // For mobile, ensure the entire card is visible when keyboard shows
      if (itemElement) {
        if (!scrollCardIntoView(itemElement, 'smooth')) {
          // Fallback if scrollCardIntoView fails
          elRef.current.scrollIntoView({ block: 'end', behavior: 'smooth' });
        }
      } else {
        elRef.current.scrollIntoView({ block: 'end', behavior: 'smooth' });
      }
    };

    if (Platform.isMobile) {
      cm.dom.win.addEventListener('keyboardDidShow', onShow);
    }

    return () => {
      if (Platform.isMobile) {
        cm.dom.win.removeEventListener('keyboardDidShow', onShow);

        if (view.activeEditor === controller) {
          view.activeEditor = null;
        }

        if (app.workspace.activeEditor === controller) {
          app.workspace.activeEditor = null;
          (app as any).mobileToolbar.update();
          view.contentEl.removeClass('is-mobile-editing');
        }
      }
      view.plugin.removeChild(editor);
      internalRef.current = null;
      if (editorRef) editorRef.current = null;
    };
  }, []);

  // New useEffect to handle incoming value changes AFTER initial mount
  useEffect(() => {
    const cm = internalRef.current;
    if (cm && value !== undefined) {
      if (cm.state.doc.toString() !== value) {
        cm.dispatch({
          changes: { from: 0, to: cm.state.doc.length, insert: value || '' },
        });
        const cursorPosition = calculateCursorPosition(editState, value || '', itemElement);
        // Set cursor position without triggering automatic scroll
        cm.dispatch({ selection: EditorSelection.cursor(cursorPosition) });
      }
    }
  }, [value, editState, itemElement]);

  const cls = ['cm-table-widget'];
  if (className) cls.push(className);

  return (
    <>
      <div className={classcat(cls)} ref={elRef}></div>
      {Platform.isMobile && (
        <button
          onClick={() => onSubmit(internalRef.current)}
          className={classcat([c('item-submit-button'), 'mod-cta'])}
        >
          {t('Submit')}
        </button>
      )}
    </>
  );
}
