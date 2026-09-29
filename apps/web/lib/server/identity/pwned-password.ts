import 'server-only';
import { createHash } from 'node:crypto';

// SEC-014: refuse passwords known from breaches, with the Have I Been Pwned
// range API (k-anonymity: only the first 5 hex chars of the SHA-1 leave the
// server, never the password or its full hash). Free, no account, no key, not
// metered. Hosted Supabase's own leaked-password check is a paid-plan feature
// (UNVERIFIED for the free plan), so the server does it.
//
// Fails OPEN: if the API is slow or down, registration goes on (the password
// still meets the 12-character floor). Returns 'unknown' so the caller can log it.

const RANGE_URL = 'https://api.pwnedpasswords.com/range/';
const TIMEOUT_MS = 2500;

export type PwnedResult = 'pwned' | 'clean' | 'unknown';

export async function checkPwnedPassword(password: string, fetchImpl: typeof fetch = fetch): Promise<PwnedResult> {
  const sha1 = createHash('sha1').update(password, 'utf8').digest('hex').toUpperCase();
  const prefix = sha1.slice(0, 5);
  const suffix = sha1.slice(5);
  try {
    const res = await fetchImpl(RANGE_URL + prefix, {
      headers: { 'Add-Padding': 'true' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: 'no-store',
    });
    if (!res.ok) return 'unknown';
    const body = await res.text();
    for (const line of body.split('\n')) {
      const [hashSuffix, count] = line.trim().split(':');
      if (hashSuffix === suffix && Number(count) > 0) return 'pwned';
    }
    return 'clean';
  } catch {
    return 'unknown';
  }
}
