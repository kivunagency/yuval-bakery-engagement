'use client';

import { useRef, type KeyboardEvent } from 'react';
import type { DayState as DayStateValue } from '@/lib/shared/types';
import { DayState, isSelectableDay } from '@/components/day-state/DayState';
import styles from '@/components/day-state/day-strip.module.css';

// The day strip at the top of the catalog: a radiogroup of DayState (size
// strip). Roving tabindex; the arrow keys move between selectable days. In
// RTL the next day is to the left, so ArrowLeft moves forward in time.

type Props = {
  days: { day: string; state: DayStateValue }[];
  selected: string | null;
  onSelect: (day: string) => void;
  labelledBy: string;
};

export function DayStrip({ days, selected, onSelect, labelledBy }: Props) {
  const refs = useRef(new Map<string, HTMLButtonElement>());
  const selectable = days.filter((d) => isSelectableDay(d.state)).map((d) => d.day);
  const focusDay = selected && selectable.includes(selected) ? selected : (selectable[0] ?? days[0]?.day ?? null);

  function onKeyDown(e: KeyboardEvent<HTMLButtonElement>, day: string) {
    const step = e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowRight' || e.key === 'ArrowUp' ? -1 : 0;
    if (step === 0) return;
    e.preventDefault();
    const i = selectable.indexOf(day);
    const next = selectable[i === -1 ? 0 : Math.min(selectable.length - 1, Math.max(0, i + step))];
    if (next) {
      onSelect(next);
      refs.current.get(next)?.focus();
    }
  }

  return (
    <div className={styles.strip} role="radiogroup" aria-labelledby={labelledBy}>
      {days.map((d) => (
        <DayState
          key={d.day}
          day={d.day}
          state={d.state}
          size="strip"
          selected={d.day === selected}
          onSelect={onSelect}
          tabIndex={d.day === focusDay ? 0 : -1}
          onKeyDown={(e) => onKeyDown(e, d.day)}
          ref={(el) => {
            if (el) refs.current.set(d.day, el);
            else refs.current.delete(d.day);
          }}
        />
      ))}
    </div>
  );
}
