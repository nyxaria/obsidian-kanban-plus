import { JSX } from 'preact';

import { c } from '../helpers';
import { ItemMetadata } from '../types';

export interface ItemPriorityProps {
  priority?: 'high' | 'medium' | 'low';
  style?: JSX.CSSProperties;
  assignedMembersCount?: number;
}

function getPriorityStyle(priority?: 'high' | 'medium' | 'low') {
  switch (priority) {
    case 'high':
      return {
        backgroundColor: '#cd1e00',
        color: '#eeeeee', // Assuming white text for better contrast on red
      };
    case 'medium':
      return {
        backgroundColor: '#ff9600',
        color: '#ffffff', // Assuming white text for better contrast on orange
      };
    case 'low':
      return {
        backgroundColor: '#008bff',
        color: '#eeeeee', // Assuming black text for better contrast on yellow
      };
    default:
      return {};
  }
}

export function ItemPriority({ priority, style, assignedMembersCount = 0 }: ItemPriorityProps) {
  if (!priority) {
    return null;
  }

  const priorityStyle = getPriorityStyle(priority);
  let displayPriority = priority.charAt(0).toUpperCase() + priority.slice(1);
  if (priority === 'medium' && assignedMembersCount >= 2) {
    displayPriority = 'Med';
  }

  return (
    <div
      className={c('item-priority')}
      style={{
        ...priorityStyle,
        padding: '1px 6px',
        borderRadius: '4px',
        fontSize: '0.85em',
        fontWeight: '500',
        marginLeft: '0px', // Space from members
        marginRight: '6px', // Added padding to the right
        textTransform: 'capitalize',
        ...style,
      }}
      title={`Priority: ${displayPriority}`}
    >
      {displayPriority}
    </div>
  );
}
