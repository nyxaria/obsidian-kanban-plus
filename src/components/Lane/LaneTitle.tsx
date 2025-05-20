import { EditorView, ViewUpdate } from '@codemirror/view';
import classcat from 'classcat';
import { Dispatch, StateUpdater, useCallback, useContext, useEffect, useRef } from 'preact/hooks';
import { laneTitleWithMaxItems } from 'src/helpers';

import { MarkdownEditor, allowNewLine } from '../Editor/MarkdownEditor';
import { MarkdownRenderer } from '../MarkdownRenderer/MarkdownRenderer';
import { KanbanContext } from '../context';
import { c } from '../helpers';
import { EditState, EditingProcessState, isEditCoordinates } from '../types';

export interface LaneTitleProps {
  title: string;
  maxItems?: number;
  editState: EditState;
  setEditState: Dispatch<StateUpdater<EditState>>;
  onChange: (str: string) => void;
  id: string;
}

export function LaneLimitCounter({
  maxItems,
  itemCount,
  editState,
}: {
  maxItems: number;
  itemCount: number;
  editState: EditState;
}) {
  const { stateManager } = useContext(KanbanContext);
  const hideCount = stateManager.getSetting('hide-card-count');

  if (hideCount || isEditCoordinates(editState)) return null;

  return (
    <div
      className={classcat([
        c('lane-title-count'),
        {
          'wip-exceeded': maxItems && maxItems < itemCount,
        },
      ])}
    >
      {itemCount}
      {maxItems > 0 && (
        <>
          <span className={c('lane-title-count-separator')}>/</span>
          <span className={c('lane-title-count-limit')}>{maxItems}</span>
        </>
      )}
    </div>
  );
}

export function LaneTitle({ maxItems, editState, setEditState, title, onChange }: LaneTitleProps) {
  const { stateManager } = useContext(KanbanContext);
  const titleRef = useRef<string | null>(null);

  useEffect(() => {
    if (editState === EditingProcessState.complete) {
      if (titleRef.current !== null) onChange(titleRef.current);
      titleRef.current = null;
    } else if (editState === EditingProcessState.cancel && titleRef.current !== null) {
      titleRef.current = null;
    }
  }, [editState]);

  const onUpdate = useCallback((update: ViewUpdate) => {
    if (update.docChanged) {
      titleRef.current = update.state.doc.toString().trim();
    }
  }, []);
  const onEnter = useCallback(
    (cm: EditorView, mod: boolean, shift: boolean) => {
      if (!allowNewLine(stateManager, mod, shift)) {
        setEditState(EditingProcessState.complete);
        return true;
      }
    },
    [setEditState, stateManager]
  );
  const onSubmit = useCallback(() => setEditState(EditingProcessState.complete), [setEditState]);
  const onEscape = useCallback(() => setEditState(EditingProcessState.cancel), [setEditState]);

  return (
    <div className={c('lane-title')}>
      {isEditCoordinates(editState) ? (
        <MarkdownEditor
          editState={editState}
          className={c('lane-input')}
          onChange={onUpdate}
          onEnter={onEnter}
          onEscape={onEscape}
          onSubmit={onSubmit}
          value={laneTitleWithMaxItems(title, maxItems)}
        />
      ) : (
        <div className={c('lane-title-text')}>
          <MarkdownRenderer markdownString={title} />
        </div>
      )}
    </div>
  );
}
