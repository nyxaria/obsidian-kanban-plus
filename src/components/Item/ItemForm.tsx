import { EditorView } from '@codemirror/view';
import { Dispatch, StateUpdater, useContext, useRef } from 'preact/hooks';
import useOnclickOutside from 'react-cool-onclickoutside';
import { t } from 'src/lang/helpers';

import { MarkdownEditor, allowNewLine } from '../Editor/MarkdownEditor';
import { getDropAction } from '../Editor/helpers';
import { KanbanContext } from '../context';
import { c } from '../helpers';
import { EditState, EditingProcessState, Item, isEditCoordinates } from '../types';

interface ItemFormProps {
  addItems: (items: Item[]) => void;
  editState: EditState;
  setEditState: Dispatch<StateUpdater<EditState>>;
  hideButton?: boolean;
  laneName?: string;
}

export function ItemForm({
  addItems,
  editState,
  setEditState,
  hideButton,
  laneName,
}: ItemFormProps) {
  const { stateManager } = useContext(KanbanContext);
  const editorRef = useRef<EditorView>();

  const clear = () => setEditState(EditingProcessState.cancel);

  const handleClickOutside = () => {
    const cm = editorRef.current;
    if (cm) {
      const content = cm.state.doc.toString().trim();
      if (content) {
        // If there's content, save the card
        createItem(content);
      } else {
        // If no content, cancel
        clear();
      }
    } else {
      clear();
    }
  };

  const clickOutsideRef = useOnclickOutside(handleClickOutside, {
    ignoreClass: [c('ignore-click-outside'), 'mobile-toolbar', 'suggestion-container'],
  });

  const createItem = (title: string, shouldCloseForm: boolean = true) => {
    addItems([stateManager.getNewItem(title, ' ', false, laneName)]);
    const cm = editorRef.current;
    if (cm) {
      cm.dispatch({
        changes: {
          from: 0,
          to: cm.state.doc.length,
          insert: '',
        },
      });
    }
    // Only reset the edit state if we should close the form
    if (shouldCloseForm) {
      setEditState(EditingProcessState.cancel);
    }
  };

  if (isEditCoordinates(editState)) {
    return (
      <div className={c('item-form')} ref={clickOutsideRef}>
        <div className={c('item-input-wrapper')}>
          <MarkdownEditor
            editorRef={editorRef}
            editState={{ x: 0, y: 0 }}
            className={c('item-input')}
            placeholder={t('Card title...')}
            onEnter={(cm, mod, shift) => {
              if (!allowNewLine(stateManager, mod, shift)) {
                // Keep the form open when pressing Enter (shouldCloseForm = false)
                createItem(cm.state.doc.toString(), false);
                return true;
              }
            }}
            onSubmit={(cm) => {
              // Keep the form open for onSubmit as well
              createItem(cm.state.doc.toString(), false);
            }}
            onEscape={clear}
          />
        </div>
      </div>
    );
  }

  if (hideButton) return null;

  return (
    <div className={c('item-button-wrapper')}>
      <button
        className={c('new-item-button')}
        onClick={() => setEditState({ x: 0, y: 0 })}
        onDragOver={(e) => {
          if (getDropAction(stateManager, e.dataTransfer)) {
            setEditState({ x: 0, y: 0 });
          }
        }}
      >
        <span className={c('item-button-plus')}>+</span> {t('Add a card')}
      </button>
    </div>
  );
}
