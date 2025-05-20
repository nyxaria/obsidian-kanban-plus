import React, { useContext } from 'react';

import { KanbanContext } from '../../contexts/KanbanContext';
import { Item } from '../../types/Item';
import { Lane } from '../../types/Lane';
import { Items } from './Items';

interface LanesProps {
  lanes: Lane[];
  collapseDir: number;
  targetHighlight: any | null;
  cancelEditCounter: number;
}

export function Lanes({ lanes, collapseDir, targetHighlight, cancelEditCounter }: LanesProps) {
  const { boardModifiers } = useContext(KanbanContext);

  return (
    <div>
      {lanes.map((lane, laneIndex) => (
        <div key={laneIndex}>
          <Items
            laneIndex={laneIndex}
            lane={lane}
            targetHighlight={targetHighlight}
            cancelEditCounter={cancelEditCounter}
          />
        </div>
      ))}
    </div>
  );
}
