import classcat from 'classcat';
import { moment } from 'obsidian';
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
  onEditDate?: JSX.MouseEventHandler<HTMLDivElement>;
  getDateColor: (date: moment.Moment) => DateColor;
  style?: JSX.CSSProperties;
}

export function DateAndTime({
  item,
  stateManager,
  onEditDate,
  getDateColor,
  style,
}: DateProps & DateAndTimeProps) {
  const moveDates = stateManager.useSetting('move-dates');
  const shouldShowRelativeDate = stateManager.useSetting('show-relative-date');

  // Metadata processing
  const targetDate = item.data.metadata.time ?? item.data.metadata.date;
  const dateColor = useMemo(() => {
    if (!targetDate) return null;
    return getDateColor(targetDate);
  }, [targetDate, getDateColor]);

  // Date color calculated

  if (!moveDates || !targetDate) return null;

  const rawDateStr = item.data.metadata.dateStr;
  const rawTimeStr = item.data.metadata.timeStr;

  if (!rawDateStr) return null;

  // Determine what text to show in the lozenge
  const displayText = useMemo(() => {
    if (shouldShowRelativeDate && item.data.metadata.date) {
      const relativeText = getRelativeDate(item.data.metadata.date, item.data.metadata.time);
      return rawTimeStr ? `${relativeText} ${rawTimeStr}` : relativeText;
    } else {
      return rawTimeStr ? `${rawDateStr} ${rawTimeStr}` : rawDateStr;
    }
  }, [
    shouldShowRelativeDate,
    rawDateStr,
    rawTimeStr,
    item.data.metadata.date,
    item.data.metadata.time,
  ]);

  // Rendering date and time

  return (
    <div
      onClick={onEditDate}
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
          (dateColor?.backgroundColor ? 'var(--text-on-accent)' : 'var(--text-normal)'),
        ...style,
      }}
      className={classcat([c('item-metadata-date-lozenge')])}
      aria-label={t('Edit date')}
      title={t('Edit date')}
    >
      {displayText}
    </div>
  );
}
