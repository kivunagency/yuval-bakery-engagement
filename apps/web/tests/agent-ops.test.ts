import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';

// ops-registry-001 (SEC-004, SEC-017, agent-ops-registry SECURITY.md A, B, D, E):
// the dispatcher's order of checks, the confirmation, the agent token, the
// on/off switch and the operation metadata, without a server. The same
// behaviour end to end, with the DB: qa/regression.ops-registry.spec.js.

vi.mock('@/lib/server/env', () => ({
  serverEnv: () => ({ SITE_URL: 'https://bakery.example', APP_ENV: process.env.TEST_APP_ENV ?? 'local' }),
}));

import { registry } from '@/lib/server/agent-ops/operations/index';
import { runOne, invalidateOpCache, CONFIRMATION_ARG } from '@/lib/server/agent-ops/operations/dispatch';
import { defineOperation, type AnyOperation, type OperationContext } from '@/lib/server/agent-ops/operations/types';
import { ok } from '@/lib/server/agent-ops/result';
import { redact, type AuditSink } from '@/lib/server/agent-ops/auditlog';
import { confirmationSigner, canonicalJson, CONFIRMATION_TTL_SECONDS } from '@/lib/server/agent-ops/confirmation';
import { roleSatisfies, rolesAllowedIn } from '@/lib/server/agent-ops/auth';
import { mintAgentToken, verifyAgentToken, AGENT_TOKEN_MAX_SECONDS } from '@/lib/server/agent-ops/token';
import { opsRegistryConfig } from '@/lib/server/agent-ops/config';

const SECRET = 'x'.repeat(40);

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(f) ? [p] : [];
  });
}

/** A fake access token: only its exp claim is read at mint time. */
function fakeJwt(exp: number) {
  return `h.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.s`;
}

describe('the registry holds exactly the five ADR-001 operations, with least privilege', () => {
  const business = registry.filter((op) => !op.alwaysOn);

  it('names', () => {
    expect(business.map((o) => o.name).sort()).toEqual(['approveCustomCakeRequest', 'declineCustomCakeRequest', 'generateDeliveryList', 'markOrderPaid', 'updateDayCapacity']);
    expect(registry.filter((o) => o.alwaysOn).map((o) => o.name).sort()).toEqual(['describe_tool', 'explore', 'getContext', 'invoke', 'search']);
  });

  it('every write is operator-only and needs a confirmation; the one read is verifier and returns counts', () => {
    for (const op of business.filter((o) => o.permission === 'write')) {
      expect(op.roles, op.name).toEqual(['operator']);
      expect(op.requiresConfirmation, op.name).toBe(true);
    }
    const list = business.find((o) => o.name === 'generateDeliveryList');
    expect(list?.permission).toBe('read');
    expect(list?.roles).toEqual(['verifier']);
  });

  it('decline takes no free text (a reason reaches the customer, only Yuval writes it)', () => {
    const decline = business.find((o) => o.name === 'declineCustomCakeRequest');
    expect(Object.keys(decline?.inputSchema ?? {})).toEqual(['requestId']);
  });
});

describe('invariant: no path reaches a handler without runOne (SECURITY.md A)', () => {
  it('only dispatch.ts calls op.handler, and nothing outside agent-ops imports an operation', () => {
    const root = join(__dirname, '..');
    const all = [...files(join(root, 'lib')), ...files(join(root, 'app'))];
    const callers = all.filter((p) => /\.handler\s*\(/.test(readFileSync(p, 'utf8')));
    expect(callers.map((p) => p.slice(root.length + 1))).toEqual(['lib/server/agent-ops/operations/dispatch.ts']);
    const importers = all.filter((p) => !p.includes('agent-ops') && /agent-ops\/operations\//.test(readFileSync(p, 'utf8')));
    expect(importers).toEqual([]);
  });

  it('the MCP route resolves the principal from the Authorization header only', () => {
    const src = readFileSync(join(__dirname, '..', 'lib', 'server', 'agent-ops', 'principal.ts'), 'utf8');
    expect(src).toContain("req.headers.get('authorization')");
    expect(src).not.toMatch(/req\.(json|text|formData)\(|searchParams|cookies/);
  });
});

describe('runOne: order of checks', () => {
  let calls: string[];
  let finished: Array<[number, string]>;
  let audit: AuditSink;
  const handler = vi.fn(async (input: { n: number }) => ok({ doubled: input.n * 2 }));

  const read = defineOperation({ name: 'qaRead', title: 't', description: 'd', permission: 'read', roles: ['verifier'], inputSchema: { n: z.number().int() }, handler });
  const write = defineOperation({ name: 'qaWrite', title: 't', description: 'd', permission: 'write', roles: ['operator'], requiresConfirmation: true, inputSchema: { n: z.number().int() }, handler });

  function ctx(over: Partial<OperationContext> = {}): OperationContext {
    return { userId: 'u', role: 'operator', token: 'tok-aaaaaaaaaaaaaaaa', client: {} as SupabaseClient, audit, confirmations: confirmationSigner(SECRET, 'tok-aaaaaaaaaaaaaaaa'), appEnv: 'local', ...over };
  }

  beforeEach(() => {
    calls = [];
    finished = [];
    let id = 0;
    audit = {
      begin: async (op) => {
        calls.push(op);
        return ++id;
      },
      finish: async (callId, outcome) => {
        finished.push([callId, outcome]);
      },
    };
    handler.mockClear();
    registry.push(read as AnyOperation, write as AnyOperation);
    invalidateOpCache();
  });
  afterEach(() => {
    registry.splice(registry.indexOf(read as AnyOperation), 1);
    registry.splice(registry.indexOf(write as AnyOperation), 1);
    invalidateOpCache();
  });

  it('audits every call, unknown and refused ones too, with the outcome', async () => {
    expect((await runOne('nope', {}, ctx())).success).toBe(false);
    expect(await runOne('qaRead', { n: 2 }, ctx())).toEqual({ success: true, data: { doubled: 4 } });
    expect(calls).toEqual(['nope', 'qaRead']);
    expect(finished).toEqual([[1, 'UNKNOWN_TOOL'], [2, 'ok']]);
  });

  it('no audit row, no action: a failing begin is AUDIT_UNAVAILABLE and the handler never runs', async () => {
    audit.begin = async () => {
      throw new Error('db down');
    };
    expect((await runOne('qaRead', { n: 1 }, ctx())).success).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });

  it('over the rate limit (begin returns null) is RATE_LIMITED and the handler never runs', async () => {
    audit.begin = async () => null;
    const r = await runOne('qaRead', { n: 1 }, ctx());
    expect(r.success === false && r.error.code).toBe('RATE_LIMITED');
    expect(handler).not.toHaveBeenCalled();
  });

  it('RBAC: a verifier calling a write is FORBIDDEN before validation or confirmation', async () => {
    const r = await runOne('qaWrite', { n: 'bad' }, ctx({ role: 'verifier' }));
    expect(r.success === false && r.error.code).toBe('FORBIDDEN');
    expect(handler).not.toHaveBeenCalled();
  });

  it('production: a write is FORBIDDEN even for an operator (defense in depth behind the token checks)', async () => {
    const r = await runOne('qaWrite', { n: 1 }, ctx({ appEnv: 'prod' }));
    expect(r.success === false && r.error.code).toBe('FORBIDDEN');
    expect(handler).not.toHaveBeenCalled();
  });

  it('strict schema: unknown keys and wrong types are INVALID_ARGS; a confirmationToken on a read is an unknown key', async () => {
    for (const args of [{ n: 1, extra: true }, { n: '1' }, {}, { n: 1, [CONFIRMATION_ARG]: 'x' }]) {
      const r = await runOne('qaRead', args, ctx());
      expect(r.success === false && r.error.code, JSON.stringify(args)).toBe('INVALID_ARGS');
    }
    expect(handler).not.toHaveBeenCalled();
  });

  it('confirmation: refused with a token first; runs with it; the token is bound to the arguments and to the agent token', async () => {
    const first = await runOne('qaWrite', { n: 3 }, ctx());
    expect(first.success === false && first.error.code).toBe('CONFIRMATION_REQUIRED');
    expect(handler).not.toHaveBeenCalled();
    const token = first.success ? '' : String(first.error.details?.[CONFIRMATION_ARG]);

    expect((await runOne('qaWrite', { n: 4, [CONFIRMATION_ARG]: token }, ctx())).success).toBe(false);
    const other = ctx({ token: 'tok-bbbbbbbbbbbbbbbb', confirmations: confirmationSigner(SECRET, 'tok-bbbbbbbbbbbbbbbb') });
    expect((await runOne('qaWrite', { n: 3, [CONFIRMATION_ARG]: token }, other)).success).toBe(false);
    expect(handler).not.toHaveBeenCalled();

    expect(await runOne('qaWrite', { n: 3, [CONFIRMATION_ARG]: token }, ctx())).toEqual({ success: true, data: { doubled: 6 } });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('a throwing handler becomes HANDLER_ERROR without its message', async () => {
    handler.mockRejectedValueOnce(new Error('secret detail'));
    const r = await runOne('qaRead', { n: 1 }, ctx());
    expect(r.success === false && r.error.code).toBe('HANDLER_ERROR');
    expect(JSON.stringify(r)).not.toContain('secret detail');
  });

  it('invoke re-authorizes every inner call, single and batch', async () => {
    const single = await runOne('invoke', { name: 'qaWrite', args: { n: 1 } }, ctx({ role: 'verifier' }));
    expect(single).toEqual({ success: true, data: { success: false, error: expect.objectContaining({ code: 'FORBIDDEN' }) } });
    const batch = await runOne('invoke', { calls: [{ name: 'qaRead', args: { n: 1 } }, { name: 'qaWrite', args: { n: 1 } }] }, ctx({ role: 'verifier' }));
    expect(batch.success && (batch.data as { results: Array<{ success: boolean }> }).results.map((r) => r.success)).toEqual([true, false]);
    expect(calls).toEqual(['invoke', 'qaWrite', 'invoke', 'qaRead', 'qaWrite']);
  });
});

describe('confirmation token', () => {
  it('canonical JSON ignores key order', () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: 'z' } })).toBe(canonicalJson({ a: { c: 'z', d: [1, { x: 1, y: 2 }] }, b: 1 }));
  });

  it('expires after five minutes and depends on the secret', () => {
    let now = 1_800_000_000_000;
    const s = confirmationSigner(SECRET, 'tok', () => now);
    const { confirmationToken } = s.issue('op', { a: 1 });
    expect(s.verify('op', { a: 1 }, confirmationToken)).toBe(true);
    expect(s.verify('other', { a: 1 }, confirmationToken)).toBe(false);
    expect(confirmationSigner('y'.repeat(40), 'tok', () => now).verify('op', { a: 1 }, confirmationToken)).toBe(false);
    now += (CONFIRMATION_TTL_SECONDS + 1) * 1000;
    expect(s.verify('op', { a: 1 }, confirmationToken)).toBe(false);
    expect(s.verify('op', { a: 1 }, undefined)).toBe(false);
  });
});

describe('agent token (SECURITY.md B: audience-bound, expires, fail closed)', () => {
  const audience = 'https://bakery.example/api/ops/mcp';
  const base = { secret: SECRET, audience, adminId: '00000000-0000-4000-8000-00000000000a', role: 'verifier' as const };

  it('round trip; the admin access token inside is not readable', async () => {
    const accessToken = fakeJwt(Math.floor(Date.now() / 1000) + 3000);
    const minted = await mintAgentToken({ ...base, accessToken });
    expect(minted).not.toBeNull();
    expect(minted!.token).not.toContain(accessToken.split('.')[1]);
    const claims = await verifyAgentToken(minted!.token, SECRET, audience);
    expect(claims).toMatchObject({ adminId: base.adminId, role: 'verifier', accessToken, tokenId: minted!.tokenId });
  });

  it('lives at most one hour, and never past the admin access token', async () => {
    const now = Math.floor(Date.now() / 1000);
    const long = await mintAgentToken({ ...base, accessToken: fakeJwt(now + 5 * 3600), now });
    expect(long!.expiresAt - now).toBe(AGENT_TOKEN_MAX_SECONDS);
    const short = await mintAgentToken({ ...base, accessToken: fakeJwt(now + 600), now });
    expect(short!.expiresAt).toBe(now + 600);
    expect(await mintAgentToken({ ...base, accessToken: fakeJwt(now + 30), now })).toBeNull();
    expect(await mintAgentToken({ ...base, accessToken: 'not-a-jwt', now })).toBeNull();
  });

  it('refused with another audience, another secret, when expired, or tampered', async () => {
    const now = Math.floor(Date.now() / 1000);
    const { token } = (await mintAgentToken({ ...base, accessToken: fakeJwt(now + 3000) }))!;
    expect(await verifyAgentToken(token, SECRET, 'https://bakery.example/api/other')).toBeNull();
    expect(await verifyAgentToken(token, 'z'.repeat(40), audience)).toBeNull();
    expect(await verifyAgentToken(`${token.slice(0, -3)}AAA`, SECRET, audience)).toBeNull();
    const old = (await mintAgentToken({ ...base, accessToken: fakeJwt(now - 3000 + 600), now: now - 3000 }))!;
    expect(await verifyAgentToken(old.token, SECRET, audience)).toBeNull();
  });
});

describe('switch and roles per environment (threat-model 3.7)', () => {
  it('off unless OPS_REGISTRY_ENABLED is exactly "true"', () => {
    for (const v of [undefined, '', '1', 'TRUE', 'yes', 'false']) expect(opsRegistryConfig({ OPS_REGISTRY_ENABLED: v, OPS_REGISTRY_TOKEN_SECRET: SECRET }).state).toBe('off');
  });

  it('on without a secret of 32+ characters is misconfigured, never a fallback', () => {
    for (const s of [undefined, '', 'short', 'x'.repeat(31)]) expect(opsRegistryConfig({ OPS_REGISTRY_ENABLED: 'true', OPS_REGISTRY_TOKEN_SECRET: s }).state).toBe('misconfigured');
    expect(opsRegistryConfig({ OPS_REGISTRY_ENABLED: 'true', OPS_REGISTRY_TOKEN_SECRET: SECRET })).toEqual({
      state: 'on',
      secret: SECRET,
      audience: 'https://bakery.example/api/ops/mcp',
      appEnv: 'local',
    });
  });

  it('production allows the verifier role only; roles are hierarchical and unknown roles fail', () => {
    expect(rolesAllowedIn('prod')).toEqual(['verifier']);
    expect(rolesAllowedIn('dev')).toEqual(['verifier', 'operator']);
    expect(roleSatisfies('operator', ['verifier'])).toBe(true);
    expect(roleSatisfies('verifier', ['operator'])).toBe(false);
    expect(roleSatisfies('admin' as never, ['verifier'])).toBe(false);
  });
});

describe('audit redaction (SEC-017, threat-model 3.7)', () => {
  it('personal and secret keys are redacted at any depth', () => {
    expect(
      redact({ date: '2027-01-01', phone: '+972501112233', args: { guestName: 'Dana', deliveryAddress: 'x', notes: 'y', inscriptionText: 'z', email: 'e', reason: 'r', confirmationToken: 't' }, calls: [{ name: 'op', args: { phone: 'p' } }] }),
    ).toEqual({
      date: '2027-01-01',
      phone: '[REDACTED]',
      args: { guestName: '[REDACTED]', deliveryAddress: '[REDACTED]', notes: '[REDACTED]', inscriptionText: '[REDACTED]', email: '[REDACTED]', reason: '[REDACTED]', confirmationToken: '[REDACTED]' },
      calls: [{ name: '[REDACTED]', args: { phone: '[REDACTED]' } }],
    });
  });
});
