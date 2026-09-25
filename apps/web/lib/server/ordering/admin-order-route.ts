import 'server-only';
import { NextResponse } from 'next/server';
import { orderActionBody, orderIdParam, type AdminOrdersApiErrorBody } from '@/lib/shared/contracts/admin-orders';

// Shared request parsing for the /api/admin/orders routes (api-004). The
// routes themselves still call getAdminSession() and isSameOrigin() first,
// visibly (tests/admin-pages-guarded.test.ts checks every admin route file).

export const json = (body: unknown, status: number) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
export const fail = (error: AdminOrdersApiErrorBody['error'], status: number) => json({ error } satisfies AdminOrdersApiErrorBody, status);

/** The order id from the path, and a body that is empty or `{}`. Anything else: null (400). */
export async function parseOrderAction(request: Request, params: Promise<{ id: string }>): Promise<string | null> {
  const id = orderIdParam.safeParse((await params).id);
  if (!id.success) return null;
  const text = await request.text();
  if (text.trim() !== '') {
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return null;
    }
    if (!orderActionBody.safeParse(raw).success) return null;
  }
  return id.data;
}
