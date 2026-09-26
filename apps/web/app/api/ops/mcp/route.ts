import { opsRegistryConfig } from '@/lib/server/agent-ops/config';
import { resolvePrincipal } from '@/lib/server/agent-ops/principal';
import { handleMcpRequest } from '@/lib/server/agent-ops/adapters/mcp';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// The operations registry over MCP Streamable HTTP (ops-registry-001, ADR-001
// Rule 27). Off unless OPS_REGISTRY_ENABLED=true: then every method answers
// 404, as for a route that does not exist. On without its secret: 503, never
// a fallback. On: a Bearer agent token or 401, then everything goes through
// runOne (lib/server/agent-ops). Stateless JSON mode: GET (a server-to-client
// stream) and DELETE (a session) do not apply, 405.

const HEADERS = { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' };
const MAX_BODY_BYTES = 64 * 1024;

const notFound = () => new Response(null, { status: 404, headers: HEADERS });

function refuseUnlessOn() {
  const cfg = opsRegistryConfig();
  if (cfg.state === 'off') return { response: notFound() };
  if (cfg.state === 'misconfigured') {
    console.error('ops registry: OPS_REGISTRY_ENABLED=true but OPS_REGISTRY_TOKEN_SECRET is missing or shorter than 32 characters; refusing to serve');
    return { response: Response.json({ error: 'ops_registry_misconfigured' }, { status: 503, headers: HEADERS }) };
  }
  return { cfg };
}

export async function POST(request: Request) {
  const { cfg, response } = refuseUnlessOn();
  if (!cfg) return response;

  // MCP transport security: a browser page on another origin must not drive
  // this endpoint (DNS rebinding). Agents send no Origin.
  const origin = request.headers.get('origin');
  if (origin !== null && new URL(origin).origin !== new URL(cfg.audience).origin) {
    return Response.json({ error: 'forbidden_origin' }, { status: 403, headers: HEADERS });
  }
  if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) {
    return Response.json({ error: 'payload_too_large' }, { status: 413, headers: HEADERS });
  }

  const principal = await resolvePrincipal(request, cfg);
  if (!principal) {
    return Response.json({ error: 'unauthorized' }, { status: 401, headers: { ...HEADERS, 'WWW-Authenticate': 'Bearer realm="ops-registry"' } });
  }

  const res = await handleMcpRequest(request, principal);
  for (const [k, v] of Object.entries(HEADERS)) res.headers.set(k, v);
  return res;
}

function methodNotAllowed() {
  const { cfg, response } = refuseUnlessOn();
  if (!cfg) return response;
  return new Response(null, { status: 405, headers: { ...HEADERS, Allow: 'POST' } });
}

export async function GET() {
  return methodNotAllowed();
}

export async function DELETE() {
  return methodNotAllowed();
}
