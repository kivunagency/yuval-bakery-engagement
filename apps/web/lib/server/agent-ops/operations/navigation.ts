import 'server-only';
import { z } from 'zod';
import { defineOperation } from './types';
import { ok, fail, type Result } from '../result';
import { roleSatisfies } from '../auth';
import { registry } from './registry';
import { runOne, effectiveParallelSafe, getOpByName, CONFIRMATION_ARG } from './dispatch';
import type { ModuleTree } from '../modules';

/**
 * The navigation layer (template lib/operations/navigation.ts): the only
 * tools in tools/list. Business operations are reached through `invoke`
 * (the template's stateless Path B). Path A (load_tools / unload_tools) is
 * left out on purpose: its selection store is process-local and does not
 * survive Netlify's serverless instances (template loadedTools.ts note).
 */
export function createNavigationOps(tree: ModuleTree) {
  const explore = defineOperation({
    name: 'explore',
    title: 'Explore',
    description:
      'Navigate the operations of this bakery system. No path: the overview and its modules. ' +
      "A module path (e.g. 'orders'): the functions in it, with their permission and whether they need confirmation.",
    permission: 'read',
    roles: ['verifier'],
    alwaysOn: true,
    inputSchema: { path: z.string().max(64).optional().describe('Module path. Omit for the overview.') },
    async handler({ path }, ctx): Promise<Result<unknown>> {
      if (path === undefined) return ok(tree.platformManifest(ctx.role, registry));
      const node = tree.getNode(path, ctx.role, registry);
      return node ? ok(node) : fail('NOT_FOUND', `Module '${path}' not found.`);
    },
  });

  const search = defineOperation({
    name: 'search',
    title: 'Search',
    description: "Find functions by a keyword in their module or name, e.g. 'capacity' or 'paid'.",
    permission: 'read',
    roles: ['verifier'],
    alwaysOn: true,
    inputSchema: { pattern: z.string().min(1).max(64).describe('Keyword.') },
    async handler({ pattern }, ctx) {
      return ok(tree.searchTree(pattern, ctx.role, registry));
    },
  });

  const describeTool = defineOperation({
    name: 'describe_tool',
    title: 'Describe Tool',
    description: 'The exact input schema and metadata of one function. Call it before invoke.',
    permission: 'read',
    roles: ['verifier'],
    alwaysOn: true,
    inputSchema: { name: z.string().min(1).max(64).describe('Function name.') },
    async handler({ name }, ctx) {
      const op = getOpByName().get(name);
      // Same answer for "does not exist" and "not for your role".
      if (!op || op.alwaysOn || !roleSatisfies(ctx.role, op.roles)) return fail('UNKNOWN_TOOL', `No operation named '${name}'.`);
      return ok({
        name: op.name,
        title: op.title,
        description: op.description,
        module: op.module,
        permission: op.permission,
        requiresConfirmation: op.requiresConfirmation ?? false,
        confirmationArgument: op.requiresConfirmation ? CONFIRMATION_ARG : undefined,
        parallelSafe: effectiveParallelSafe(op),
        inputSchema: z.toJSONSchema(z.strictObject(op.inputSchema), { unrepresentable: 'any', io: 'input' }),
      });
    },
  });

  const call = z.object({ name: z.string().min(1).max(64), args: z.record(z.string(), z.unknown()).default({}) });

  const invoke = defineOperation({
    name: 'invoke',
    title: 'Invoke',
    description:
      'Call a function by name. Single: { name, args }. Batch: { calls: [{ name, args }] } (at most 10; reads run in parallel, writes in order). ' +
      'A function that changes data first answers CONFIRMATION_REQUIRED with a confirmationToken: show the human the call, and repeat it with the token only if they agree.',
    permission: 'read',
    roles: ['verifier'],
    alwaysOn: true,
    inputSchema: {
      name: z.string().min(1).max(64).optional().describe('Function name (single call).'),
      args: z.record(z.string(), z.unknown()).optional().describe('Arguments (single call).'),
      calls: z.array(call).min(1).max(10).optional().describe('Batch form. Use this or name + args, not both.'),
    },
    async handler({ name, args, calls }, ctx): Promise<Result<unknown>> {
      // runOne re-authorizes every inner call: invoke cannot reach anything the
      // caller could not reach directly. Never call a handler from here.
      if (name !== undefined && calls === undefined) return ok(await runOne(name, args ?? {}, ctx));
      if (calls !== undefined && name === undefined) {
        const results: unknown[] = new Array(calls.length);
        const isParallel = (c: { name: string }) => {
          const op = getOpByName().get(c.name);
          return op !== undefined && effectiveParallelSafe(op);
        };
        await Promise.all(calls.map(async (c, i) => (isParallel(c) ? (results[i] = await runOne(c.name, c.args, ctx)) : undefined)));
        for (const [i, c] of calls.entries()) if (!isParallel(c)) results[i] = await runOne(c.name, c.args, ctx);
        return ok({ results });
      }
      return fail('INVALID_ARGS', "Provide either 'name' (single call) or 'calls' (batch), not both.");
    },
  });

  const getContext = defineOperation({
    name: 'getContext',
    title: 'Get Context',
    description: 'Who is calling: the role of this agent token. Contains no personal data.',
    permission: 'read',
    roles: ['verifier'],
    alwaysOn: true,
    inputSchema: {},
    async handler(_input, ctx) {
      // No userId: the agent does not need it, and it would land in the model's context.
      return ok({ authenticated: true, role: ctx.role, environment: ctx.appEnv });
    },
  });

  return [explore, search, describeTool, invoke, getContext];
}
