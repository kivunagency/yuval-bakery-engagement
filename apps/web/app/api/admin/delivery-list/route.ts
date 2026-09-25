import { NextResponse } from 'next/server';
import { getAdminSession } from '@/lib/server/auth/admin';
import { createUserClient } from '@/lib/server/supabase/server';
import { generateDeliveryList } from '@/lib/server/delivery/delivery-list';
import { deliveryListQuery, type DeliveryListApiErrorBody } from '@/lib/shared/contracts/delivery-list';

export const dynamic = 'force-dynamic';

// Personal data: never cached, never indexed. No-Referer is set in next.config.ts.
const HEADERS = { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' };
const json = (body: unknown, status: number) => NextResponse.json(body, { status, headers: HEADERS });
const fail = (error: DeliveryListApiErrorBody['error'], status: number) => json({ error } satisfies DeliveryListApiErrorBody, status);

// GET /api/admin/delivery-list?date=YYYY-MM-DD (api-008, US-7): the paid
// delivery orders of that day, courier fields only. Admin at aal2 only; every
// call is audited by the DB (delivery_list.generated). No public link (SEC-016).
export async function GET(request: Request) {
  if (!(await getAdminSession())) return fail('unauthorized', 401);
  const query = deliveryListQuery.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!query.success) return fail('invalid_input', 400);
  const result = await generateDeliveryList(await createUserClient(), query.data);
  return result.ok ? json(result.value, 200) : json(result.body, result.status);
}
