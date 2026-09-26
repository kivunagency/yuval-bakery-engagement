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

/** Message key (under "business") for the one-line note above a list of prices, e.g. the catalog grid. */
export function vatNoteKey(status: string | null | undefined): 'price.all_incl_vat' | 'price.all_final' {
  return status === 'licensed' ? 'price.all_incl_vat' : 'price.all_final';
}

// The ONE money formatter of the app (screens, WhatsApp texts, emails). Digits
// and grouping are fixed (en-US), not the runtime's he-IL currency pattern, so
// the server render, the browser hydration and a plain-text message produce
// the same string whatever ICU data each has. A no-break space keeps the
// number and the sign together; in an RTL paragraph the sign renders to the
// left of the number, the Israeli convention (design-tokens.md "Price").
const whole = new Intl.NumberFormat('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0, useGrouping: true });
const cents = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: true });

/** 120 -> "120\u00a0₪", 12.5 -> "12.50\u00a0₪", 1200 -> "1,200\u00a0₪". */
export function formatIls(amount: number): string {
  return `${(Number.isInteger(amount) ? whole : cents).format(amount)}\u00a0₪`;
}
