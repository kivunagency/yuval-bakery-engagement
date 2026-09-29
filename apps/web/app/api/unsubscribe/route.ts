import { NextResponse, type NextRequest } from 'next/server';
import { unsubscribeByToken } from '@/lib/server/identity/account';

export const dynamic = 'force-dynamic';

// POST /api/unsubscribe?token=... (compliance-spec section 5): one-click
// removal from marketing mail, no sign-in. Two callers:
//  - the button on /unsubscribe (a plain HTML form, works without JS): the
//    token comes in the form body, the answer is a 303 to the result page;
//  - a mail client following List-Unsubscribe-Post: List-Unsubscribe=One-Click
//    (RFC 8058): the token is in the query, the answer is a bare status.
// No Origin check on purpose: RFC 8058 posts come from mail providers, and
// the only effect is a withdrawal for the holder of a 128-bit token.
export async function POST(request: NextRequest) {
  let token = request.nextUrl.searchParams.get('token');
  let fromPage = false;
  const type = request.headers.get('content-type') ?? '';
  if (type.startsWith('application/x-www-form-urlencoded') || type.startsWith('multipart/form-data')) {
    const form = await request.formData().catch(() => null);
    const formToken = form?.get('token');
    if (typeof formToken === 'string') {
      token = formToken;
      fromPage = true;
    }
  }
  const result = await unsubscribeByToken(token);
  if (fromPage) {
    return NextResponse.redirect(new URL(`/unsubscribe/done?result=${result}`, request.nextUrl.origin), 303);
  }
  const status = result === 'done' ? 200 : result === 'invalid' ? 404 : 503;
  return new NextResponse(null, { status, headers: { 'Cache-Control': 'no-store' } });
}
