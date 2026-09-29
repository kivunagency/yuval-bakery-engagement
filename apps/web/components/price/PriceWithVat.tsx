import { useTranslations } from 'next-intl';
import { formatIls, vatLabelKey, vatNoteKey } from '@/lib/shared/price/vat';

// The one price display every screen reuses (catalog, checkout, order page,
// admin). The amount always goes through formatIls. The VAT wording depends
// on app_settings.vat_status: "final price" for an osek patur, "incl. VAT"
// for an osek murshe (compliance-spec.md 8).

/** The amount alone, e.g. "120 ₪" (tabular digits). */
export function PriceAmount({ amount, className }: { amount: number; className?: string }) {
  return <span className={['num', className].filter(Boolean).join(' ')}>{formatIls(amount)}</span>;
}

/** "label" next to one price ("final price"); "note" above a list of prices ("All prices are final"). */
export function VatLabel({ vatStatus, variant = 'label' }: { vatStatus: string | null; variant?: 'label' | 'note' }) {
  const t = useTranslations('business');
  return <span data-testid="vat-label">{t(variant === 'note' ? vatNoteKey(vatStatus) : vatLabelKey(vatStatus))}</span>;
}

export function PriceWithVat({ amount, vatStatus }: { amount: number; vatStatus: string | null }) {
  return (
    <span data-testid="price-with-vat">
      <PriceAmount amount={amount} /> <VatLabel vatStatus={vatStatus} />
    </span>
  );
}
