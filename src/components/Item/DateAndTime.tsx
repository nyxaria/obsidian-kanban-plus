import classcat from 'classcat';
import { getLinkpath, moment } from 'obsidian';
import { JSX, useMemo } from 'preact/compat';
import { StateManager } from 'src/StateManager';
import { t } from 'src/lang/helpers';

import { c } from '../helpers';
import { DateColor, Item } from '../types';

export function getRelativeDate(date: moment.Moment, time: moment.Moment) {
  if (time) {
    return time.from(moment());
  }

  const today = moment().startOf('day');

  if (today.isSame(date, 'day')) {
    return t('today');
  }

  const diff = date.diff(today, 'day');

  if (diff === -1) {
    return t('yesterday');
  }

  if (diff === 1) {
    return t('tomorrow');
  }

  return date.from(today);
}

interface DateProps {
  item: Item;
  stateManager: StateManager;
}

export function RelativeDate({ item, stateManager }: DateProps) {
  const shouldShowRelativeDate = stateManager.useSetting('show-relative-date');

  if (!shouldShowRelativeDate || !item.data.metadata.date) {
    return null;
  }

  const relativeDate = getRelativeDate(item.data.metadata.date, item.data.metadata.time);

  return <span className={c('item-metadata-date-relative')}>{relativeDate}</span>;
}

interface DateAndTimeProps {
  onEditDate?: JSX.MouseEventHandler<HTMLSpanElement>;
  onEditTime?: JSX.MouseEventHandler<HTMLSpanElement>;
  filePath: string;
  getDateColor: (date: moment.Moment) => DateColor;
  style?: JSX.CSSProperties;
}

export function DateAndTime({
  item,
  stateManager,
  filePath,
  onEditDate,
  onEditTime,
  getDateColor,
  style,
}: DateProps & DateAndTimeProps) {
  const moveDates = stateManager.useSetting('move-dates');
  console.log('[DateAndTime] moveDates setting value:', moveDates); // DEBUG LOG
  const dateFormat = stateManager.useSetting('date-format'); // User's date format
  const timeFormat = stateManager.useSetting('time-format');
  const dateDisplayFormat = stateManager.useSetting('date-display-format');
  const shouldLinkDate = stateManager.useSetting('link-date-to-daily-note');

  // Refined DEBUG LOG for metadata
  console.log(
    '[DateAndTime] item.data.metadata received. dateStr:',
    item.data.metadata.dateStr,
    'date (Moment obj exist?):',
    !!item.data.metadata.date,
    'time (Moment obj exist?):',
    !!item.data.metadata.time
  );
  const targetDate = item.data.metadata.time ?? item.data.metadata.date;
  const dateColor = useMemo(() => {
    if (!targetDate) return null;
    return getDateColor(targetDate);
  }, [targetDate, getDateColor]);

  console.log('[DateAndTime] dateColor:', JSON.stringify(dateColor));

  if (!moveDates || !targetDate) return null;

  const rawDateStr = item.data.metadata.dateStr;
  const rawTimeStr = item.data.metadata.timeStr;

  if (!rawDateStr) return null;

  // START MODIFICATION: Add onClick for global search on the date part
  const handleDateSearchClick = (e: JSX.TargetedMouseEvent<HTMLSpanElement>) => {
    e.stopPropagation(); // Prevent the parent div's onEditDate from firing
    if (item.data.metadata.date) {
      // Use the user's dateFormat setting for the search query
      const searchDate = item.data.metadata.date.format(dateFormat);
      // Consistent with Tags/Members, use stateManager.app for global search
      (stateManager.app as any).internalPlugins
        .getPluginById('global-search')
        .instance.openGlobalSearch(`@{${searchDate}}`);
    }
  };
  // END MODIFICATION

  console.log(
    '[DateAndTime] Rendering with RawDate:',
    JSON.stringify(rawDateStr),
    'RawTime:',
    rawTimeStr
  ); // DEBUG LOG

  const dateProps: HTMLAttributes<HTMLSpanElement> = {}; // This seems to be for the main div for editing
  dateProps['aria-label'] = t('Change date/time');
  // dateProps.onClick = onEditDate; // This is now on the parent div

  return (
    <div
      onClick={onEditDate} // Keep onEditDate for the whole lozenge for editing
      style={{
        cursor: 'pointer',
        padding: '1px 5px',
        borderRadius: '3px',
        fontSize: '0.9em',
        display: 'inline-flex',
        alignItems: 'center',
        backgroundColor: dateColor?.backgroundColor || 'rgba(0,0,0,0)',
        color:
          dateColor?.color ||
          dateColor?.color ||
          (dateColor?.backgroundColor ? 'var(--text-on-accent)' : 'var(--text-normal)'),
        ...style,
      }}
      className={classcat([c('item-metadata-date-lozenge')])}
      aria-label={t('Change date/time')}
    >
      {/* MODIFIED: Render date and time in separate spans */}
      <span onClick={handleDateSearchClick} style={{ cursor: 'pointer' }}>
        {' '}
        {/* cursor: help indicates clickable for search */}
        {rawDateStr}
      </span>
      {rawTimeStr && <span style={{ marginLeft: '0.4em' }}>{rawTimeStr}</span>}
      {/* {displayString} Original rendering */}
    </div>
  );
}
