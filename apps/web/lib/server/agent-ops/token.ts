import 'server-only';
import { createHash, randomBytes } from 'node:crypto';
import { EncryptJWT, jwtDecrypt } from 'jose';
import { isRole, type Role } from './auth';

// Agent tokens (SECURITY.md B, threat-model 3.7): minted by an admin at aal2
// (POST /api/admin/ops-registry/tokens), presented as `Authorization: Bearer`
// to the MCP endpoint.
//  - Encrypted and authenticated (JWE, dir + A256GCM) with a key derived from
//    OPS_REGISTRY_TOKEN_SECRET: the agent cannot read or alter what is inside.
//  - Inside: the minting admin's own Supabase access token (aal2). Every DB
//    call runs as that JWT, so the DB checks aal2 on every call and an agent
//    can never do more than that admin could. It never leaves the server in
//    clear, so it cannot be replayed against the Data API directly.
//  - aud = the MCP endpoint URL (RFC 8707), iss fixed, lifetime at most one
//    hour and never past the inner access token's own expiry.
//  - No refresh token inside: the token dies with the access token; signing
//    the admin out ends it earlier (Auth refuses the session).

export const AGENT_TOKEN_ISSUER = 'yuval-bakery/ops-registry';
export const AGENT_TOKEN_MAX_SECONDS = 60 * 60;

export type AgentTokenClaims = { tokenId: string; adminId: string; role: Role; accessToken: string; expiresAt: number };

function key(secret: string): Uint8Array {
  return new Uint8Array(createHash('sha256').update(`ops-registry-agent-token:v1\0${secret}`).digest());
}

/** Seconds since epoch of a JWT's exp claim (the inner access token was just verified by Auth). */
export function jwtExpiry(jwt: string): number | null {
  try {
    const claims = JSON.parse(Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString('utf8')) as { exp?: unknown };
    return typeof claims.exp === 'number' ? claims.exp : null;
  } catch {
    return null;
  }
}

export async function mintAgentToken(input: { secret: string; audience: string; adminId: string; role: Role; accessToken: string; now?: number }) {
  const now = input.now ?? Math.floor(Date.now() / 1000);
  const innerExp = jwtExpiry(input.accessToken);
  if (innerExp === null || innerExp <= now + 60) return null; // an access token about to expire makes a useless agent token
  const exp = Math.min(now + AGENT_TOKEN_MAX_SECONDS, innerExp);
  const tokenId = randomBytes(18).toString('base64url');
  const token = await new EncryptJWT({ role: input.role, sat: input.accessToken })
    .setProtectedHeader({ alg: 'dir', enc: 'A256GCM', typ: 'ops-agent+jwt' })
    .setIssuer(AGENT_TOKEN_ISSUER)
    .setAudience(input.audience)
    .setSubject(input.adminId)
    .setJti(tokenId)
    .setIssuedAt(now)
    .setNotBefore(now)
    .setExpirationTime(exp)
    .encrypt(key(input.secret));
  return { token, tokenId, expiresAt: exp };
}

/** The claims, or null on ANY doubt (fail closed): wrong key, audience, issuer, expired, too long-lived, bad shape. */
export async function verifyAgentToken(token: string, secret: string, audience: string): Promise<AgentTokenClaims | null> {
  if (token.length > 8192) return null;
  try {
    const { payload, protectedHeader } = await jwtDecrypt(token, key(secret), {
      issuer: AGENT_TOKEN_ISSUER,
      audience,
      keyManagementAlgorithms: ['dir'],
      contentEncryptionAlgorithms: ['A256GCM'],
      requiredClaims: ['exp', 'iat', 'jti', 'sub'],
      maxTokenAge: AGENT_TOKEN_MAX_SECONDS,
    });
    if (protectedHeader.typ !== 'ops-agent+jwt') return null;
    const { exp, iat, jti, sub, role, sat } = payload;
    if (typeof exp !== 'number' || typeof iat !== 'number' || exp - iat > AGENT_TOKEN_MAX_SECONDS) return null;
    if (typeof jti !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(jti)) return null;
    if (typeof sub !== 'string' || !isRole(role) || typeof sat !== 'string' || sat.length === 0) return null;
    return { tokenId: jti, adminId: sub, role, accessToken: sat, expiresAt: exp };
  } catch {
    return null;
  }
}
