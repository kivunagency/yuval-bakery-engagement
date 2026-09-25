import type { CartLine } from '@/lib/shared/cart';

// The total the checkout screen shows before the submit button (PRD section 8:
// prices and delivery cost before payment). A PREVIEW from the prices the
// server rendered into the page. The amount the customer pays is the one the
// DB computes in fn_create_standard_order (SEC-008), shown on the order page;
// regression.checkout asserts the two are equal for the same cart.

export type QuoteLine = { productId: string; name: string; unitPrice: number; quantity: number; lineTotal: number };
export type Quote = { lines: QuoteLine[]; subtotal: number; deliveryFee: number; total: number; missing: string[] };

const round2 = (n: number) => Math.round(n * 100) / 100;

export function quoteCart(
  lines: readonly CartLine[],
  products: ReadonlyMap<string, { name: string; price: number }>,
  deliveryFee: number,
): Quote {
  const out: QuoteLine[] = [];
  const missing: string[] = [];
  for (const l of lines) {
    const p = products.get(l.productId);
    if (!p) {
      missing.push(l.productId);
      continue;
    }
    out.push({ productId: l.productId, name: p.name, unitPrice: p.price, quantity: l.quantity, lineTotal: round2(p.price * l.quantity) });
  }
  const subtotal = round2(out.reduce((s, l) => s + l.lineTotal, 0));
  return { lines: out, subtotal, deliveryFee: round2(deliveryFee), total: round2(subtotal + deliveryFee), missing };
}
