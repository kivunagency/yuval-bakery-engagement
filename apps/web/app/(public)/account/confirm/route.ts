import { redirect } from 'next/navigation';
import type { NextRequest } from 'next/server';
import { confirmEmail } from '@/lib/server/identity/customer-auth';

export const dynamic = 'force-dynamic';

// GET /account/confirm?token_hash=...&type=email (api-010): the link in the
// sign-up mail (supabase/templates/confirmation.html). Verifies the token on
// the server, so it works on any device, then creates the profile.
export async function GET(request: NextRequest) {
  const q = request.nextUrl.searchParams;
  const result = await confirmEmail(q.get('token_hash'), q.get('type'));
  switch (result) {
    case 'created':
      redirect('/account/welcome');
    case 'exists':
      redirect('/account');
    case 'needs_details':
    case 'phone_taken':
      redirect(`/account/complete?reason=${result}`);
    default:
      redirect('/account/login?notice=link_invalid');
  }
}
