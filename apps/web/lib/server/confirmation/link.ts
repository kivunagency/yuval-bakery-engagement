import 'server-only';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

// The confirmation link (US-0c): SITE_URL/confirmation/<order id>.<mac>,
// valid at least 24 months (the expiry lives in the DB).
//
// The mac is HMAC-SHA256(CONFIRMATION_LINK_SECRET, order id), 256 bits. It is
// derived, not random, because three places need the SAME link long after
// the order was placed, and the DB keeps only its sha256 (SEC-003: tokens
// are stored hashed): the order page, Yuval's WhatsApp message and the
// find-my-order result. Holding the link is the capability; the order id
// alone, the order number, or a wrong mac all get the same 404.
//
// The DB is still the gate: the route serves only when sha256(token) equals
// the stored confirmation_link_token_hash and the link is not expired,
// revoked or purged (fn_confirmation_by_link_token, B5). If the secret is
// ever changed, links already sent keep working (their hash is stored), and
// a link built with the new secret for an old order is refused rather than
// sent (linkMatchesStored).

const PREFIX = 'yb-order-confirmation-v1:';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TOKEN = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/;

function secret(): string {
  const s = process.env.CONFIRMATION_LINK_SECRET ?? '';
  if (s.length < 32) throw new Error('confirmation_link_secret_missing');
  return s;
}

function mac(orderId: string): string {
  return createHmac('sha256', secret()).update(PREFIX + orderId).digest('base64url');
}

/** The link token of one order: "<uuid>.<43 chars>" (80 characters). */
export function confirmationLinkToken(orderId: string): string {
  if (!UUID.test(orderId)) throw new Error('confirmation_invalid_order_id');
  return `${orderId}.${mac(orderId)}`;
}

/** The order id a well-formed, correctly signed token names; null otherwise (constant-time compare). */
export function orderIdFromLinkToken(token: string): string | null {
  const m = TOKEN.exec(token);
  if (!m) return null;
  const [, id, given] = m as unknown as [string, string, string];
  const expected = Buffer.from(mac(id));
  const actual = Buffer.from(given);
  return expected.length === actual.length && timingSafeEqual(expected, actual) ? id : null;
}

/** Same as the DB's fn_hash_token: hex sha256 of the token. */
export function hashLinkToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function linkMatchesStored(token: string, storedHash: string | null): boolean {
  return !!storedHash && hashLinkToken(token) === storedHash;
}

export function confirmationPath(token: string): string {
  return `/confirmation/${token}`;
}
