import { NextResponse, type NextRequest } from 'next/server';
import { getAdminSession } from '@/lib/server/auth/admin';
import { createUserClient } from '@/lib/server/supabase/server';
import { checkCustomCakeCapacity } from '@/lib/server/custom-cake/admin';
import { uuid } from '@/lib/shared/contracts/primitives';
import { customCakeCapacityQuery, type CustomCakeAdminErrorBody } from '@/lib/shared/contracts/custom-cake';

export const dynamic = 'force-dynamic';

const json = (body: unknown, status: number) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

// GET /api/admin/custom-cake-requests/[id]/capacity?oven=&work= (api-006,
// client-008): the live warning while Yuval types the time cost. The answer
// is the DB's (fn_admin_custom_cake_capacity_check), never computed here.
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!(await getAdminSession())) return json({ error: 'unauthorized' } satisfies CustomCakeAdminErrorBody, 401);
  const id = uuid.safeParse((await params).id);
  const q = customCakeCapacityQuery.safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!id.success || !q.success) return json({ error: 'invalid_input' } satisfies CustomCakeAdminErrorBody, 400);
  const result = await checkCustomCakeCapacity(await createUserClient(), id.data, q.data.oven, q.data.work);
  return result.ok ? json(result.value, 200) : json({ error: result.error } satisfies CustomCakeAdminErrorBody, result.status);
}
