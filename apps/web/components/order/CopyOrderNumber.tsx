'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import styles from '@/components/order/order.module.css';

// "Copy" next to the order number (design-tokens.md: on the payment screen
// the main action is copying the number into the payment note). The number
// stays selectable text when the clipboard is unavailable.
export function CopyOrderNumber({ orderNumber }: { orderNumber: string }) {
  const t = useTranslations('payment');
  const [copied, setCopied] = useState(false);
  return (
    <>
      <button
        type="button"
        className={styles.copy}
        aria-label={t('copy_label', { orderNumber })}
        data-testid="copy-order-number"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(orderNumber);
            setCopied(true);
          } catch {
            setCopied(false);
          }
        }}
      >
        {copied ? t('copied') : t('copy')}
      </button>
      <span className="visually-hidden" role="status" aria-live="polite">
        {copied ? t('copied') : ''}
      </span>
    </>
  );
}
