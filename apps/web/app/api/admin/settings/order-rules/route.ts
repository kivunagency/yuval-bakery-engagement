import { NextResponse } from 'next/server';
import { getAdminSession } from '@/lib/server/auth/admin';
import { createUserClient } from '@/lib/server/supabase/server';
import { isSameOrigin } from '@/lib/server/http/origin';
import { updateOrderRules } from '@/lib/server/settings/order-settings';
import { orderRulesUpdate, invalidOrderRuleFields, type OrderSettingsApiErrorBody } from '@/lib/shared/contracts/order-settings';

export const dynamic = 'force-dynamic';

const json = (body: unknown, status: number) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
const fail = (error: OrderSettingsApiErrorBody['error'], status: number, fields?: string[]) =>
  json({ error, ...(fields && fields.length > 0 ? { fields } : {}) } satisfies OrderSettingsApiErrorBody, status);

// PUT /api/admin/settings/order-rules (settings-slots): payment-pending expiry hours (standard, custom cake) and the "limited" day threshold. Omitted = unchanged. Applies to orders created after the change.
// Admin at aal2 only, same Origin; the DB checks aal2 again, validates and audits.
export async function PUT(request: Request) {
  if (!(await getAdminSession())) return fail('unauthorized', 401);
  if (!isSameOrigin(request)) return fail('forbidden_origin', 403);
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return fail('invalid_input', 400);
  }
  const body = orderRulesUpdate.safeParse(raw);
  if (!body.success) return fail('invalid_input', 400, invalidOrderRuleFields(raw));
  const result = await updateOrderRules(await createUserClient(), body.data);
  return result.ok ? json(result.value, 200) : json(result.body, result.status);
}
