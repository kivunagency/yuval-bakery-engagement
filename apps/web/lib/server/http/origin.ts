import 'server-only';

// CSRF guard for admin API mutations (SEC-013): the request must carry an
// Origin header naming this site. Browsers always send Origin on
// PATCH/PUT/POST/DELETE fetches, so a missing Origin is refused too.
export function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get('origin');
  const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host');
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}
