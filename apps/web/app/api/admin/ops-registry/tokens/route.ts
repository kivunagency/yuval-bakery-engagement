import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getAdminSession } from '@/lib/server/auth/admin';
import { isSameOrigin } from '@/lib/server/http/origin';
import { opsRegistryConfig } from '@/lib/server/agent-ops/config';
import { rolesAllowedIn, ROLE_ORDER } from '@/lib/server/agent-ops/auth';
import { mintAgentTokenForAdmin } from '@/lib/server/agent-ops/mint';

export const dynamic = 'force-dynamic';

const HEADERS = { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' };
const json = (body: unknown, status: number) => NextResponse.json(body, { status, headers: HEADERS });

const mintBody = z.strictObject({ role: z.enum(ROLE_ORDER) });

// POST /api/admin/ops-registry/tokens (ops-registry-001, SEC-004): an admin at
// aal2, same Origin, mints an agent token for the MCP endpoint. Body:
// { role: 'verifier' | 'operator' }; production mints verifier only. The
// token carries this admin's own session, lives at most one hour, is bound to
// the MCP endpoint URL, and its minting is audited before it is handed out.
// Off (404) unless the registry is switched on.
export async function POST(request: Request) {
  const cfg = opsRegistryConfig();
  if (cfg.state === 'off') return new Response(null, { status: 404, headers: HEADERS });
  if (cfg.state === 'misconfigured') return json({ error: 'ops_registry_misconfigured' }, 503);

  const admin = await getAdminSession();
  if (!admin) return json({ error: 'unauthorized' }, 401);
  if (!isSameOrigin(request)) return json({ error: 'forbidden_origin' }, 403);

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return json({ error: 'invalid_input' }, 400);
  }
  const body = mintBody.safeParse(raw);
  if (!body.success) return json({ error: 'invalid_input' }, 400);
  if (!rolesAllowedIn(cfg.appEnv).includes(body.data.role)) return json({ error: 'role_not_allowed' }, 403);

  const minted = await mintAgentTokenForAdmin({ secret: cfg.secret, audience: cfg.audience, adminId: admin.userId, role: body.data.role });
  if (!minted.ok) {
    const status = minted.error === 'unauthorized' ? 401 : minted.error === 'session_expiring' ? 409 : 503;
    return json({ error: minted.error }, status);
  }

  return json({ token: minted.token, tokenType: 'Bearer', role: body.data.role, audience: cfg.audience, expiresAt: new Date(minted.expiresAt * 1000).toISOString() }, 201);
}
