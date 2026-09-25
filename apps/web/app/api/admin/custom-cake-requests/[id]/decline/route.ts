import { NextResponse } from 'next/server';
import { getAdminSession } from '@/lib/server/auth/admin';
import { createUserClient } from '@/lib/server/supabase/server';
import { isSameOrigin } from '@/lib/server/http/origin';
import { declineCustomCake } from '@/lib/server/custom-cake/admin';
import { uuid } from '@/lib/shared/contracts/primitives';
import { customCakeDecline, type CustomCakeAdminErrorBody } from '@/lib/shared/contracts/custom-cake';

export const dynamic = 'force-dynamic';

const json = (body: unknown, status: number) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

// POST /api/admin/custom-cake-requests/[id]/decline (api-006). Admin at aal2,
// same Origin. Optional reason (max 300), written by Yuval. No capacity was
// ever held by a request, so nothing is released. 409 when not pending.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await getAdminSession())) return json({ error: 'unauthorized' } satisfies CustomCakeAdminErrorBody, 401);
  if (!isSameOrigin(request)) return json({ error: 'forbidden_origin' } satisfies CustomCakeAdminErrorBody, 403);
  const id = uuid.safeParse((await params).id);
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return json({ error: 'invalid_input' } satisfies CustomCakeAdminErrorBody, 400);
  }
  const body = customCakeDecline.safeParse(raw);
  if (!id.success || !body.success) return json({ error: 'invalid_input' } satisfies CustomCakeAdminErrorBody, 400);

  const result = await declineCustomCake(await createUserClient(), id.data, body.data.reason);
  return result.ok ? json(result.value, 200) : json({ error: result.error } satisfies CustomCakeAdminErrorBody, result.status);
}
