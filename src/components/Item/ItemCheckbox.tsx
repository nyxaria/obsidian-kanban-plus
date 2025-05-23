import update from 'immutability-helper';
import { JSX, memo, useCallback, useEffect, useState } from 'preact/compat';
import { StateManager } from 'src/StateManager';
import { Path } from 'src/dnd/types';
import { getTaskStatusDone, toggleTask } from 'src/parsers/helpers/inlineMetadata';

import { BoardModifiers } from '../../helpers/boardModifiers';
import { Icon } from '../Icon/Icon';
import { c } from '../helpers';
import { Item } from '../types';

interface ItemCheckboxProps {
  path: Path;
  item: Item;
  shouldMarkItemsComplete: boolean;
  stateManager: StateManager;
  boardModifiers: BoardModifiers;
  isVisible?: boolean;
  style?: JSX.CSSProperties;
}

export const ItemCheckbox = memo(function ItemCheckbox({
  shouldMarkItemsComplete,
  path,
  item,
  stateManager,
  boardModifiers,
  isVisible = true,
  style,
}: ItemCheckboxProps) {
  const shouldShowCheckbox = stateManager.useSetting('show-checkboxes');

  const [isCtrlHoveringCheckbox, setIsCtrlHoveringCheckbox] = useState(false);
  const [isHoveringCheckbox, setIsHoveringCheckbox] = useState(false);

  const onCheckboxChange = useCallback(() => {
    const updates = toggleTask(item, stateManager.file);
    if (updates) {
      const [itemStrings, checkChars, thisIndex] = updates;
      const replacements: Item[] = itemStrings.map((str, i) => {
        const next = stateManager.getNewItem(str, checkChars[i]);
        if (i === thisIndex) next.id = item.id;
        return next;
      });

      boardModifiers.replaceItem(path, replacements);
    } else {
      stateManager.setCardChecked(item, !item.data.checked);
    }
  }, [item, stateManager, boardModifiers, ...path]);

  useEffect(() => {
    if (isHoveringCheckbox) {
      const handler = (e: KeyboardEvent) => {
        if (e.metaKey || e.ctrlKey) {
          setIsCtrlHoveringCheckbox(true);
        } else {
          setIsCtrlHoveringCheckbox(false);
        }
      };

      activeWindow.addEventListener('keydown', handler);
      activeWindow.addEventListener('keyup', handler);

      return () => {
        activeWindow.removeEventListener('keydown', handler);
        activeWindow.removeEventListener('keyup', handler);
      };
    }
  }, [isHoveringCheckbox]);

  if (!(shouldMarkItemsComplete || shouldShowCheckbox)) {
    return null;
  }

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        opacity: isVisible ? 1 : 0,
        maxWidth: isVisible ? '30px' : '0px',
        minWidth: isVisible ? 'auto' : '0px',
        overflow: 'hidden',
        transition:
          'opacity 0.2s ease-in-out, max-width 0.2s ease-in-out, min-width 0.2s ease-in-out',
        ...style,
      }}
      onMouseEnter={(e) => {
        setIsHoveringCheckbox(true);

        if (e.ctrlKey || e.metaKey) {
          setIsCtrlHoveringCheckbox(true);
        }
      }}
      onMouseLeave={() => {
        setIsHoveringCheckbox(false);

        if (isCtrlHoveringCheckbox) {
          setIsCtrlHoveringCheckbox(false);
        }
      }}
      className={c('item-prefix-button-wrapper')}
    >
      {shouldShowCheckbox && !isCtrlHoveringCheckbox && (
        <input
          onChange={onCheckboxChange}
          type="checkbox"
          className="task-list-item-checkbox"
          checked={item.data.checked}
          data-task={item.data.checkChar}
          style={{ marginTop: '0.075em' }}
        />
      )}
      {(isCtrlHoveringCheckbox || (!shouldShowCheckbox && shouldMarkItemsComplete)) && (
        <a
          onClick={() => {
            boardModifiers.archiveItem(path);
          }}
          className={`${c('item-prefix-button')} clickable-icon`}
          aria-label={isCtrlHoveringCheckbox ? undefined : 'Archive card'}
        >
          <Icon name="sheets-in-box" />
        </a>
      )}
    </div>
  );
});
