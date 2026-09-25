// Price and VAT wording (compliance-spec.md section 8). One definition, reused
// by every screen that shows a price. Pure, no I/O.
//
// An osek patur does not charge VAT, so "incl. VAT" would mislead: the label
// is "final price". Only a licensed dealer (osek murshe) says "incl. VAT".
// An unknown status falls back to "final price", which is true either way.
// WORDING PENDING rotem/Yuval: both labels are in messages/*.json under
// business.price and are flagged in SYSTEM-CONTRACT.md section 3.

export const VAT_STATUSES = ['exempt', 'licensed'] as const;
export type VatStatus = (typeof VAT_STATUSES)[number];

export function isVatStatus(v: unknown): v is VatStatus {
  return typeof v === 'string' && (VAT_STATUSES as readonly string[]).includes(v);
}

/** Message key (under the "business" namespace) for the line next to a price. */
export function vatLabelKey(status: string | null | undefined): 'price.incl_vat' | 'price.final_price' {
  return status === 'licensed' ? 'price.incl_vat' : 'price.final_price';
}

const whole = new Intl.NumberFormat('he-IL', { style: 'currency', currency: 'ILS', minimumFractionDigits: 0, maximumFractionDigits: 0 });
const cents = new Intl.NumberFormat('he-IL', { style: 'currency', currency: 'ILS', minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** 120 -> "120 ₪", 12.5 -> "12.50 ₪", as he-IL formats them (number first, then the sign). */
export function formatIls(amount: number): string {
  return Number.isInteger(amount) ? whole.format(amount) : cents.format(amount);
}
