import { NextResponse } from 'next/server';
import { getAdminSession } from '@/lib/server/auth/admin';
import { createUserClient } from '@/lib/server/supabase/server';
import { isSameOrigin } from '@/lib/server/http/origin';
import { loadBusinessSettings, updateBusinessSettings } from '@/lib/server/settings/business';
import { businessSettingsUpdate, invalidBusinessFields, type BusinessSettingsApiErrorBody } from '@/lib/shared/contracts/business-settings';

export const dynamic = 'force-dynamic';

const json = (body: unknown, status: number) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
const fail = (error: BusinessSettingsApiErrorBody['error'], status: number, fields?: string[]) =>
  json({ error, ...(fields && fields.length > 0 ? { fields } : {}) } satisfies BusinessSettingsApiErrorBody, status);

// GET /api/admin/settings/business: the s.14C business details and the osek
// status. PUT: change any of them (omitted = unchanged, null or "" = unset,
// the site then shows its placeholder). Admin at aal2 only, same Origin; the
// DB checks aal2 again, validates and audits (fn_admin_set_business_details).
export async function GET() {
  if (!(await getAdminSession())) return fail('unauthorized', 401);
  try {
    return json(await loadBusinessSettings(await createUserClient()), 200);
  } catch {
    return fail('server_error', 500);
  }
}

export async function PUT(request: Request) {
  if (!(await getAdminSession())) return fail('unauthorized', 401);
  if (!isSameOrigin(request)) return fail('forbidden_origin', 403);
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return fail('invalid_input', 400);
  }
  const body = businessSettingsUpdate.safeParse(raw);
  if (!body.success) return fail('invalid_input', 400, invalidBusinessFields(raw));
  const result = await updateBusinessSettings(await createUserClient(), body.data);
  return result.ok ? json(result.value, 200) : json(result.body, result.status);
}
