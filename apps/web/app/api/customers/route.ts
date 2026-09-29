import { NextResponse } from 'next/server';
import { isSameOrigin } from '@/lib/server/http/origin';
import { registerCustomer } from '@/lib/server/identity/customer-auth';
import { readFeatures } from '@/lib/server/features';
import type { registerAccepted, registerError } from '@/lib/shared/contracts/registration';
import type { z } from 'zod';

export const dynamic = 'force-dynamic';

type Accepted = z.infer<typeof registerAccepted>;
type ErrorBody = z.infer<typeof registerError>;

const json = (body: Accepted | ErrorBody, status: number) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

const STATUS: Record<ErrorBody['error'], number> = {
  invalid_input: 400,
  weak_password: 400,
  pwned_password: 400,
  forbidden_origin: 403,
  rate_limited: 429,
  unavailable: 503,
};

// POST /api/customers (api-010, PRD US-4): optional customer registration.
// Body: registerInput (lib/shared/contracts/registration.ts). Answers 202
// {status:'check_email'} whether the address is new, already registered or
// waiting for confirmation (SEC-014: no enumeration). The account exists
// only after the mail link is opened (/account/confirm). Marketing consent is
// not accepted here (s.30A: its own act, after sign-in).
// 404 while customer accounts are off (lib/server/features/index.ts).
export async function POST(request: Request) {
  if (!readFeatures().customerAccounts) return new NextResponse(null, { status: 404, headers: { 'Cache-Control': 'no-store' } });
  if (!isSameOrigin(request)) return json({ error: 'forbidden_origin' }, STATUS.forbidden_origin);
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return json({ error: 'invalid_input' }, 400);
  }
  const result = await registerCustomer(raw);
  if (result.ok) return json({ status: 'check_email' }, 202);
  return json(result.fields ? { error: result.error, fields: result.fields } : { error: result.error }, STATUS[result.error]);
}
