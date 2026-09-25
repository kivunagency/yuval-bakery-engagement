import { NextResponse } from 'next/server';
import { getAdminSession } from '@/lib/server/auth/admin';
import { createUserClient } from '@/lib/server/supabase/server';
import { isSameOrigin } from '@/lib/server/http/origin';
import { registerPushSubscription, revokePushSubscription } from '@/lib/server/notification/subscriptions';
import { pushSubscriptionBody, pushUnsubscribeBody, type PushApiErrorBody } from '@/lib/shared/contracts/push';

export const dynamic = 'force-dynamic';

const json = (body: unknown, status: number) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
const fail = (error: PushApiErrorBody['error'], status: number) => json({ error } satisfies PushApiErrorBody, status);

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}

// POST /api/admin/push-subscriptions (client-012, SEC-018): register this
// browser for web push. Admin at aal2 only, same Origin only; the DB checks
// aal2 again with the admin's own JWT and takes the admin id from it.
export async function POST(request: Request) {
  if (!(await getAdminSession())) return fail('unauthorized', 401);
  if (!isSameOrigin(request)) return fail('forbidden_origin', 403);
  const body = pushSubscriptionBody.safeParse(await readJson(request));
  if (!body.success) return fail('invalid_input', 400);
  const result = await registerPushSubscription(await createUserClient(), body.data);
  return json(result.body, result.status);
}

// DELETE /api/admin/push-subscriptions: stop push to this browser.
export async function DELETE(request: Request) {
  if (!(await getAdminSession())) return fail('unauthorized', 401);
  if (!isSameOrigin(request)) return fail('forbidden_origin', 403);
  const body = pushUnsubscribeBody.safeParse(await readJson(request));
  if (!body.success) return fail('invalid_input', 400);
  const result = await revokePushSubscription(await createUserClient(), body.data.endpoint);
  return json(result.body, result.status);
}
