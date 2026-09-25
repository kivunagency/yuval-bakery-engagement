// Price (design-tokens.md, "Price"): the number, then ₪, as one logical string
// inside the RTL context, no isolation, so ₪ renders to the left of the number
// as on Israeli sites. Whole shekels without decimals, otherwise two.
const whole = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0, useGrouping: true });
const cents = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: true });

export function formatPrice(amount: number): string {
  return `${(Number.isInteger(amount) ? whole : cents).format(amount)} ₪`;
}

export function Price({ amount, className }: { amount: number; className?: string }) {
  return <span className={['num', className].filter(Boolean).join(' ')}>{formatPrice(amount)}</span>;
}
