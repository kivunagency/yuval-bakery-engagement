import { AsyncLocalStorage } from "async_hooks";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registry } from "../operations/registry";
import { auditLog } from "../auditlog";
import { fail } from "../result";
import { roleSatisfies } from "../auth";
import { getLoaded } from "../loadedTools";
import type { Role } from "../auth";

/**
 * ============================================================================
 *  MCP Streamable HTTP adapter
 * ============================================================================
 *
 * This file has ZERO knowledge of your domain. It walks `registry` and exposes
 * whatever is there. Swap the registry, get a different product's agent
 * surface, with no changes here.
 *
 * This adapter rides the OFFICIAL MCP SDK over standard Streamable HTTP. It
 * does not depend on WebMCP or any browser API, so it carries no
 * emerging-standard risk. If you adopt only one half of this template, adopt
 * this half.
 */

interface McpContext {
  role: Role;
  token: string;
}

/** Per-request context, populated by withMcpAuthRole before the handler runs. */
const mcpContext = new AsyncLocalStorage<McpContext>();

export function getMcpContext(): McpContext | undefined {
  return mcpContext.getStore();
}

/**
 * Wrap the MCP route handler so the caller's role and token are available while
 * tools are being registered.
 *
 * SECURITY: `getRole` must derive the role from a VERIFIED token. There is no
 * default role here on purpose. If verification fails, reject the request in
 * your route rather than falling back to a guest role.
 */
export function withMcpAuthRole(
  handler: (req: Request) => Promise<Response>,
  getRole: (req: Request) => Role | undefined,
  getToken: (req: Request) => string | undefined,
): (req: Request) => Promise<Response> {
  return (req: Request) => {
    const role = getRole(req);
    const token = getToken(req) ?? "";
    if (!role) return Promise.resolve(new Response("Unauthorized", { status: 401 }));
    return mcpContext.run({ role, token }, () => handler(req));
  };
}

/**
 * Register the tools this caller may currently see.
 *
 * Two filters decide what lands in tools/list:
 *   1. Role. An operation the caller cannot call is never advertised.
 *   2. Loaded state. Non-alwaysOn operations appear only after `load_tools`.
 *      This is what keeps tools/list tiny regardless of registry size.
 */
export function registerMcpTools(server: McpServer) {
  const ctx = mcpContext.getStore();
  if (!ctx) throw new Error("registerMcpTools called outside withMcpAuthRole");

  const callerRole = ctx.role;
  const loaded = getLoaded(ctx.token);

  for (const op of registry) {
    if (!roleSatisfies(callerRole, op.roles)) continue;
    if (!op.alwaysOn && !loaded.has(op.name)) continue;

    server.registerTool(
      op.name,
      {
        title: op.title,
        description: op.description,
        inputSchema: op.inputSchema as Record<string, z.ZodTypeAny>,
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async (input: Record<string, unknown>, extra: any) => {
        const userId: string | undefined = extra?.authInfo?.extra?.userId;
        const tenantId: string | undefined = extra?.authInfo?.extra?.tenantId;
        const role: Role | undefined = extra?.authInfo?.extra?.role;

        const errorOut = (code: string, message: string) => {
          const err = fail(code, message);
          auditLog.record({ operation: op.name, input, success: false, source: "agent" });
          return {
            content: [{ type: "text" as const, text: JSON.stringify(err, null, 2) }],
            isError: true,
          };
        };

        if (!userId || !role || !tenantId) {
          return errorOut("UNAUTHENTICATED", "A valid user token is required.");
        }

        // Defense in depth: the identity used to REGISTER the tool and the
        // identity presented at CALL time are checked independently.
        if (!roleSatisfies(role, op.roles)) {
          return errorOut("FORBIDDEN", `Role '${role}' is not permitted to call '${op.name}'.`);
        }

        try {
          const result = await op.handler(input, {
            userId,
            tenantId,
            role,
            token: extra?.authInfo?.token ?? "",
          });
          auditLog.record({
            operation: op.name,
            input,
            success: result.success,
            source: "agent",
            ctx: { userId, tenantId, role },
          });
          return result.success
            ? { content: [{ type: "text" as const, text: JSON.stringify(result.data, null, 2) }] }
            : { content: [{ type: "text" as const, text: JSON.stringify(result.error, null, 2) }], isError: true };
        } catch (err) {
          return errorOut("HANDLER_ERROR", String(err));
        }
      },
    );
  }
}
