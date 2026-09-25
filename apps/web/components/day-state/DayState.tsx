import type { KeyboardEvent, Ref } from 'react';
import { useTranslations } from 'next-intl';
import type { DayState as DayStateValue } from '@/lib/shared/types';
import { dayOfMonth, shortDate, weekdayKey } from '@/components/day-state/format';
import styles from '@/components/day-state/day-state.module.css';

// DayState (design-tokens.md, "פס ימים ולוח חודשי"): ONE component for a
// day's public state, in three sizes: `strip` (catalog day strip, 46x84),
// `cell` (checkout month calendar, 48px high) and `row` (admin lists, full
// width). Full and closed differ in word, colour and texture; state is never
// colour alone. The state itself comes from the DB (fn_public_day_availability).
// Without onSelect it renders a static element (usable from server components).

export type DayStateSize = 'strip' | 'cell' | 'row';

const SELECTABLE: ReadonlySet<DayStateValue> = new Set(['open', 'limited']);

export function isSelectableDay(state: DayStateValue): boolean {
  return SELECTABLE.has(state);
}

type Props = {
  day: string;
  state: DayStateValue;
  size?: DayStateSize;
  selected?: boolean;
  onSelect?: (day: string) => void;
  onKeyDown?: (e: KeyboardEvent<HTMLButtonElement>) => void;
  tabIndex?: number;
  ref?: Ref<HTMLButtonElement>;
};

export function DayState({ day, state, size = 'strip', selected = false, onSelect, onKeyDown, tabIndex, ref }: Props) {
  const t = useTranslations('day_state');
  const wd = weekdayKey(day);
  const selectable = isSelectableDay(state);
  const isSelected = selected && selectable;
  const word = isSelected ? t('word.selected') : state === 'too_soon' ? null : t(`word.${state}`);
  const label = t('label', { weekday: t(`weekday_long.${wd}`), date: shortDate(day), state: t(`aria.${state}`) });
  const className = [styles.day, styles[size], styles[state], isSelected ? styles.selected : ''].filter(Boolean).join(' ');

  const content =
    size === 'row' ? (
      <>
        <span className={styles.dow}>{t('day_long', { weekday: t(`weekday_long.${wd}`), date: shortDate(day) })}</span>
        {word ? <span className={styles.word}>{word}</span> : null}
      </>
    ) : (
      <>
        <span className={styles.dow} aria-hidden="true">{t(`weekday_short.${wd}`)}</span>
        <span className={`${styles.dnum} num`} aria-hidden="true">{dayOfMonth(day)}</span>
        {word ? <span className={styles.word} aria-hidden="true">{word}</span> : null}
      </>
    );

  if (!onSelect) {
    return (
      <div className={className} data-day={day} data-state={state} aria-label={label} role="img">
        {content}
      </div>
    );
  }

  return (
    <button
      ref={ref}
      type="button"
      role="radio"
      className={className}
      data-day={day}
      data-state={state}
      aria-checked={isSelected}
      aria-disabled={!selectable || undefined}
      aria-label={label}
      tabIndex={tabIndex}
      onKeyDown={onKeyDown}
      onClick={() => {
        if (selectable) onSelect(day);
      }}
    >
      {content}
    </button>
  );
}
