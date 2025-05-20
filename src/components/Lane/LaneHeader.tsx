import update from 'immutability-helper';
import { Menu } from 'obsidian';
import { memo } from 'preact/compat';
import { Dispatch, StateUpdater, useCallback, useContext, useEffect, useState } from 'preact/hooks';
import { useNestedEntityPath } from 'src/dnd/components/Droppable';
import { t } from 'src/lang/helpers';
import { parseLaneTitle } from 'src/parsers/helpers/parser';

import { getDropAction } from '../Editor/helpers';
import { GripIcon } from '../Icon/GripIcon';
import { Icon } from '../Icon/Icon';
import { KanbanContext } from '../context';
import { c, generateInstanceId } from '../helpers';
import { EditState, EditingProcessState, Lane, isEditCoordinates } from '../types';
import { ConfirmAction, useSettingsMenu } from './LaneMenu';
import { LaneMenuIcon } from './LaneMenuIcon';
import { LaneSettings } from './LaneSettings';
import { LaneLimitCounter, LaneTitle } from './LaneTitle';

interface LaneHeaderProps {
  lane: Lane;
  laneIndex: number;
  bindHandle: (el: HTMLElement) => void;
  setIsItemInputVisible?: Dispatch<StateUpdater<EditState>>;
  isCollapsed: boolean;
  toggleIsCollapsed: () => void;
}

interface LaneButtonProps {
  settingsMenu: Menu;
  editState: EditState;
  setEditState: Dispatch<StateUpdater<EditState>>;
  setIsItemInputVisible?: Dispatch<StateUpdater<EditState>>;
}

function LaneButtons({
  settingsMenu,
  editState,
  setEditState,
  setIsItemInputVisible,
}: LaneButtonProps) {
  const { stateManager } = useContext(KanbanContext);
  return (
    <div className={c('lane-settings-button-wrapper')}>
      {isEditCoordinates(editState) ? (
        <a
          onClick={() => {
            setTimeout(() => {
              console.log(
                '[LaneHeader] [LaneButtons] Close button onClick: Calling setEditState via setTimeout'
              );
              setEditState(EditingProcessState.cancel);
            }, 0);
          }}
          aria-label={t('Close')}
          className={`${c('lane-settings-button')} is-enabled clickable-icon`}
        >
          <Icon name="lucide-x" />
        </a>
      ) : (
        <>
          {setIsItemInputVisible && (
            <a
              aria-label={t('Add a card')}
              className={`${c('lane-settings-button')} clickable-icon`}
              onClick={() => {
                setTimeout(() => {
                  console.log(
                    '[LaneHeader] [LaneButtons] Add a card onClick: Calling setIsItemInputVisible via setTimeout'
                  );
                  setIsItemInputVisible({ x: 0, y: 0 });
                }, 0);
              }}
              onDragOver={(e) => {
                if (getDropAction(stateManager, e.dataTransfer)) {
                  setIsItemInputVisible({ x: 0, y: 0 });
                }
              }}
            >
              <Icon name="lucide-plus-circle" />
            </a>
          )}
          <a
            aria-label={t('More options')}
            className={`${c('lane-settings-button')} clickable-icon`}
            onClick={(e) => {
              setTimeout(() => {
                console.log(
                  '[LaneHeader] [LaneButtons] More options onClick: Showing settingsMenu via setTimeout'
                );
                settingsMenu.showAtMouseEvent(e);
              }, 0);
            }}
          >
            <Icon name="lucide-more-vertical" />
          </a>
        </>
      )}
    </div>
  );
}

export const LaneHeader = memo(function LaneHeader({
  lane,
  laneIndex,
  bindHandle,
  setIsItemInputVisible,
  isCollapsed,
  toggleIsCollapsed,
}: LaneHeaderProps) {
  const [editState, setEditState] = useState<EditState>(EditingProcessState.cancel);
  const lanePath = useNestedEntityPath(laneIndex);

  const { app, stateManager, boardModifiers } = useContext(KanbanContext);
  const { settingsMenu, confirmAction, setConfirmAction } = useSettingsMenu({
    setEditState,
    path: lanePath,
    lane,
  });

  // Defensive check for lane.data
  if (!lane.data) {
    console.error(
      `[LaneHeader] CRITICAL: lane.data is undefined for lane ID: ${lane.id}. Rendering fallback.`
    );
    // Render a minimal fallback to prevent crashes
    return (
      <div className={c('lane-header', 'lane-header-error')}>
        <div className={c('lane-title')}>Error: Lane data missing</div>
      </div>
    );
  }

  // Additional check for lane.data.title
  if (typeof lane.data.title !== 'string') {
    console.error(
      `[LaneHeader] CRITICAL: lane.data.title is not a string for lane ID: ${lane.id}. Type: ${typeof lane.data.title}. Value:`,
      lane.data.title,
      '. Rendering fallback title.'
    );
    // Potentially modify lane.data.title or use a hardcoded fallback in rendering if this occurs
    // For now, just logging. The LaneTitle component might handle it or have its own checks.
  }

  useEffect(() => {
    if (lane.data.forceEditMode) {
      setEditState({ x: 0, y: 0 });
    }
  }, [lane.data.forceEditMode]);

  const onLaneTitleChange = useCallback(
    (str: string) => {
      const { title, maxItems } = parseLaneTitle(str);
      boardModifiers.updateLane(
        lanePath,
        update(lane, {
          data: {
            title: { $set: title },
            maxItems: { $set: maxItems },
          },
        })
      );
    },
    [boardModifiers, lane, lanePath]
  );

  const onDoubleClick = useCallback(
    (e: MouseEvent) => {
      setTimeout(() => {
        console.log(
          '[LaneHeader] onDoubleClick: Calling setEditState via setTimeout. isCollapsed:',
          isCollapsed
        );
        !isCollapsed && setEditState({ x: e.clientX, y: e.clientY });
      }, 0);
    },
    [isCollapsed, setEditState]
  );

  return (
    <>
      <div
        // eslint-disable-next-line react/no-unknown-property
        onDblClick={onDoubleClick}
        className={c('lane-header-wrapper')}
      >
        <div className={c('lane-grip')} ref={bindHandle}>
          <GripIcon />
        </div>

        <div onClick={toggleIsCollapsed} className={c('lane-collapse')}>
          <Icon name="chevron-down" />
        </div>

        <LaneTitle
          id={lane.id}
          editState={editState}
          maxItems={lane.data.maxItems}
          onChange={onLaneTitleChange}
          setEditState={setEditState}
          title={lane.data.title}
        />

        <LaneLimitCounter
          editState={editState}
          itemCount={lane.children.length}
          maxItems={lane.data.maxItems}
        />

        <LaneButtons
          editState={editState}
          setEditState={setEditState}
          setIsItemInputVisible={setIsItemInputVisible}
          settingsMenu={settingsMenu}
        />
      </div>

      <LaneSettings editState={editState} lane={lane} lanePath={lanePath} />

      {confirmAction && (
        <ConfirmAction
          lane={lane}
          action={confirmAction}
          onAction={() => {
            switch (confirmAction) {
              case 'archive':
                boardModifiers.archiveLane(lanePath);
                break;
              case 'archive-items':
                boardModifiers.archiveLaneItems(lanePath);
                break;
              case 'delete':
                boardModifiers.deleteEntity(lanePath);
                break;
            }

            setConfirmAction(null);
          }}
          cancel={() => setConfirmAction(null)}
        />
      )}
    </>
  );
});
