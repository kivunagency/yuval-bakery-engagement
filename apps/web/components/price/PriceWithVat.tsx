import { useTranslations } from 'next-intl';
import { formatIls, vatLabelKey } from '@/lib/shared/price/vat';

// The one price-and-VAT line every screen reuses (catalog, checkout, order
// confirmation). The label depends on app_settings.vat_status: "final price"
// for an osek patur, "incl. VAT" for an osek murshe (compliance-spec.md 8).
export function VatLabel({ vatStatus }: { vatStatus: string | null }) {
  const t = useTranslations('business');
  return <span data-testid="vat-label">{t(vatLabelKey(vatStatus))}</span>;
}

export function PriceWithVat({ amount, vatStatus }: { amount: number; vatStatus: string | null }) {
  return (
    <span data-testid="price-with-vat">
      <span className="num">{formatIls(amount)}</span> <VatLabel vatStatus={vatStatus} />
    </span>
  );
}
