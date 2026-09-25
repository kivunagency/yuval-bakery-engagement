import { NextResponse } from 'next/server';
import { isSameOrigin } from '@/lib/server/http/origin';
import { clientIp } from '@/lib/server/http/client-ip';
import { submitCustomCakeRequest } from '@/lib/server/custom-cake/submit';
import { customCakeSubmit, type CustomCakeApiErrorBody } from '@/lib/shared/contracts/custom-cake';

export const dynamic = 'force-dynamic';

const json = (body: unknown, status: number) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
const fail = (error: CustomCakeApiErrorBody['error'], status: number) => json({ error } satisfies CustomCakeApiErrorBody, status);

// POST /api/custom-cake-requests (api-005, PRD US-2). Creates a request in
// pending_review. It never reserves capacity and never creates an order: only
// the admin's approval does (fn_approve_custom_cake_request, ADR-002).
// Contract: lib/shared/contracts/custom-cake.ts. 201 with the request id and
// one signed upload URL per announced photo; the browser PUTs the files there
// and then calls POST /api/custom-cake-requests/[id]/photos.
export async function POST(request: Request) {
  if (!isSameOrigin(request)) return fail('invalid_input', 403);
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return fail('invalid_input', 400);
  }
  const input = customCakeSubmit.safeParse(raw);
  if (!input.success) return fail('invalid_input', 400);

  const result = await submitCustomCakeRequest(input.data, await clientIp());
  return result.ok ? json(result.value, 201) : fail(result.error, result.status);
}
