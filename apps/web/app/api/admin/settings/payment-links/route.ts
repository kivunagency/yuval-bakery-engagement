import { NextResponse, after } from 'next/server';
import { getAdminSession } from '@/lib/server/auth/admin';
import { createUserClient } from '@/lib/server/supabase/server';
import { isSameOrigin } from '@/lib/server/http/origin';
import { PaymentLinksChanged } from '@/lib/server/notification';
import { loadPaymentLinkSettings, updatePaymentLinks } from '@/lib/server/settings/payment-links';
import { invalidPaymentFields, paymentLinksUpdate, type PaymentSettingsApiErrorBody } from '@/lib/shared/contracts/payment-settings';

export const dynamic = 'force-dynamic';

const json = (body: unknown, status: number) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
const fail = (error: PaymentSettingsApiErrorBody['error'], status: number, fields?: string[]) =>
  json({ error, ...(fields && fields.length > 0 ? { fields } : {}) } satisfies PaymentSettingsApiErrorBody, status);

// GET /api/admin/settings/payment-links: the stored Bit and PayBox links and
// whether the order page would show each. PUT (SEC-009): change them with a
// fresh TOTP code in the same request, even inside an aal2 session. Same
// Origin only; https on the host allowlist only; audited in the DB; every
// admin is emailed after the change committed.
export async function GET() {
  if (!(await getAdminSession())) return fail('unauthorized', 401);
  try {
    return json(await loadPaymentLinkSettings(await createUserClient()), 200);
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
  const body = paymentLinksUpdate.safeParse(raw);
  if (!body.success) return fail('invalid_input', 400, invalidPaymentFields(raw));
  const result = await updatePaymentLinks(await createUserClient(), body.data);
  if (!result.ok) return json(result.body, result.status);
  const { changeId, ...value } = result.value;
  if (changeId) after(() => PaymentLinksChanged({ changeId }));
  return json(value, 200);
}
