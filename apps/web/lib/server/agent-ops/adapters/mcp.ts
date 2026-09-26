import 'server-only';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { registry } from '../operations/index';
import { runOne } from '../operations/dispatch';
import { roleSatisfies } from '../auth';
import type { OperationContext } from '../operations/types';
import type { Result } from '../result';

/**
 * MCP Streamable HTTP adapter (template lib/adapters/mcp.ts) on the official
 * SDK, stateless: a fresh server and transport per HTTP request, JSON
 * responses, no session id and no server-to-client stream. Nothing is kept
 * between requests, which is what Netlify's serverless functions need.
 *
 * Deviation from the template, on purpose: the template's tool callback
 * called op.handler() directly, a second path next to runOne. Here every
 * tools/call goes through runOne(), so it is audited, rate limited, RBAC
 * checked, validated and confirmation checked like any other call.
 *
 * tools/list shows only the always-on navigation tools the role may use; the
 * five business operations are reached with explore / describe_tool / invoke.
 */

const SERVER_INFO = { name: 'yuval-bakery-ops', version: '1.0.0' };

function toToolResult(result: Result<unknown>) {
  return result.success
    ? { content: [{ type: 'text' as const, text: JSON.stringify(result.data) }] }
    : { content: [{ type: 'text' as const, text: JSON.stringify(result.error) }], isError: true };
}

export async function handleMcpRequest(req: Request, ctx: OperationContext): Promise<Response> {
  const server = new McpServer(SERVER_INFO, { capabilities: { tools: {} } });
  for (const op of registry) {
    if (!op.alwaysOn || !roleSatisfies(ctx.role, op.roles)) continue;
    server.registerTool(op.name, { title: op.title, description: op.description, inputSchema: op.inputSchema }, async (input: Record<string, unknown>) =>
      toToolResult(await runOne(op.name, input, ctx)),
    );
  }
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  try {
    return await transport.handleRequest(req);
  } finally {
    await server.close();
  }
}
