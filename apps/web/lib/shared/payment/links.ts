// Payment links (US-8, SEC-009). Pure, no I/O. Yuval's Bit and PayBox links
// are app_settings values (payment_link_bit / payment_link_paybox, read on
// the server through fn_payment_link_settings). A link is shown only if it is
// https on an allowlisted host; anything else renders a visible placeholder,
// so a mistyped or tampered value never becomes a button.
//
// UNVERIFIED (2026-09-26): the exact host names Bit and PayBox use for a
// personal payment link, and whether a link can carry a preset amount. No
// public documentation was found. So no amount is ever added to the link: the
// page shows the amount to type in, next to the button. Confirm both with a
// real link from Yuval before launch, and extend this list if needed. The
// admin screen that edits these settings must apply the same check.

export const PAYMENT_METHODS = ['bit', 'paybox'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const PAYMENT_LINK_HOSTS: Record<PaymentMethod, readonly string[]> = {
  bit: ['bitpay.co.il', 'www.bitpay.co.il'],
  paybox: ['payboxapp.com', 'www.payboxapp.com', 'links.payboxapp.com', 'payboxapp.page.link'],
};

/** The link as a URL string, or null when unset, not https, or not on the allowlist. */
export function safePaymentLink(method: PaymentMethod, raw: string | null | undefined): string | null {
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
  if (!PAYMENT_LINK_HOSTS[method].includes(url.hostname.toLowerCase())) return null;
  return url.toString();
}
