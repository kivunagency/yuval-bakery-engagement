'use client';

import { forwardRef } from 'react';
import { useTranslations } from 'next-intl';
import { MAX_LINE_QUANTITY } from '@/lib/shared/cart';
import styles from '@/components/cart/cart.module.css';

// Minus, the quantity, plus: one line of the cart, used by the catalog card and
// the checkout summary. At quantity 1 the minus removes the line (trash icon,
// named "remove"). Plus stops at MAX_LINE_QUANTITY. Nothing here decides
// whether the cart fits a day: that is the DB's answer (checkout early warning).

type Props = {
  name: string;
  quantity: number;
  onDecrease: () => void;
  onIncrease: () => void;
  /** e.g. the product no longer fits the selected day: it can still be lowered or removed. */
  increaseDisabled?: boolean;
};

export const QuantityStepper = forwardRef<HTMLButtonElement, Props>(function QuantityStepper(
  { name, quantity, onDecrease, onIncrease, increaseDisabled = false },
  plusRef,
) {
  const t = useTranslations('catalog.quantity');
  const removes = quantity <= 1;
  const atMax = quantity >= MAX_LINE_QUANTITY;
  return (
    <div className={styles.stepper} role="group" aria-label={t('group', { name })} data-testid="quantity-stepper">
      <button
        type="button"
        className={styles.step}
        onClick={onDecrease}
        aria-label={removes ? t('remove', { name }) : t('decrease', { name })}
        data-testid="quantity-decrease"
      >
        {removes ? (
          <svg viewBox="0 0 256 256" fill="currentColor" aria-hidden="true">
            <path d="M216,48H176V40a24,24,0,0,0-24-24H104A24,24,0,0,0,80,40v8H40a8,8,0,0,0,0,16h8V208a16,16,0,0,0,16,16H192a16,16,0,0,0,16-16V64h8a8,8,0,0,0,0-16ZM96,40a8,8,0,0,1,8-8h48a8,8,0,0,1,8,8v8H96Zm96,168H64V64H192ZM112,104v64a8,8,0,0,1-16,0V104a8,8,0,0,1,16,0Zm48,0v64a8,8,0,0,1-16,0V104a8,8,0,0,1,16,0Z" />
          </svg>
        ) : (
          <svg viewBox="0 0 256 256" fill="currentColor" aria-hidden="true">
            <path d="M224,128a8,8,0,0,1-8,8H40a8,8,0,0,1,0-16H216A8,8,0,0,1,224,128Z" />
          </svg>
        )}
      </button>
      <output className={`${styles.qty} num`} aria-live="polite" data-testid="quantity-value">
        <span aria-hidden="true">{quantity}</span>
        <span className="visually-hidden">{t('count', { count: quantity })}</span>
      </output>
      <button
        ref={plusRef}
        type="button"
        className={styles.step}
        onClick={onIncrease}
        disabled={increaseDisabled || atMax}
        aria-label={t('increase', { name })}
        data-testid="quantity-increase"
      >
        <svg viewBox="0 0 256 256" fill="currentColor" aria-hidden="true">
          <path d="M224,128a8,8,0,0,1-8,8H136v80a8,8,0,0,1-16,0V136H40a8,8,0,0,1,0-16h80V40a8,8,0,0,1,16,0v80h80A8,8,0,0,1,224,128Z" />
        </svg>
      </button>
    </div>
  );
});
