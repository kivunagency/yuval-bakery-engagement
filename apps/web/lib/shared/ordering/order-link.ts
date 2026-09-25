// The guest's order/payment page, reached with the capability token (SEC-003:
// the order number is a label only, never the key). One place builds it.
// client-004 owns the page itself; if it settles on another path, change it
// here only (api-006 uses it for the custom-cake approval message).
export function orderPageUrl(siteUrl: string, lookupToken: string): string {
  return `${siteUrl.replace(/\/+$/, '')}/order/${encodeURIComponent(lookupToken)}`;
}
