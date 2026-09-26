import 'server-only';
import { serverEnv } from '@/lib/server/env';

// Off unless switched on (threat-model 3.7, SEC-004): in every environment,
// production included, the registry exists only when OPS_REGISTRY_ENABLED is
// exactly "true". Switched on, it refuses to serve anything without its own
// credential, OPS_REGISTRY_TOKEN_SECRET (at least 32 characters): it never
// falls back to a default key, a guest role or the service role.

export const OPS_MCP_PATH = '/api/ops/mcp';
const MIN_SECRET_LENGTH = 32;

export type OpsRegistryConfig =
  | { state: 'off' }
  | { state: 'misconfigured' }
  | { state: 'on'; secret: string; audience: string; appEnv: 'local' | 'dev' | 'prod' };

export function opsRegistryConfig(env: NodeJS.ProcessEnv = process.env): OpsRegistryConfig {
  if (env.OPS_REGISTRY_ENABLED !== 'true') return { state: 'off' };
  const secret = env.OPS_REGISTRY_TOKEN_SECRET ?? '';
  if (secret.length < MIN_SECRET_LENGTH) return { state: 'misconfigured' };
  const { SITE_URL, APP_ENV } = serverEnv();
  // RFC 8707: the token names this one resource, and is refused anywhere else.
  return { state: 'on', secret, audience: new URL(OPS_MCP_PATH, SITE_URL).toString(), appEnv: APP_ENV };
}
