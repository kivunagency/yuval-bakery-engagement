import type { Operation } from "./types";

/**
 * The single source of truth for everything an agent can do in this system.
 *
 * Kept in its own file (rather than in index.ts) so the navigation operations
 * can import the array without creating a circular dependency: index.ts imports
 * every operation, and the navigation operations import the registry.
 *
 * index.ts populates this array in place at boot, then calls
 * `invalidateOpCache()` from dispatch.ts.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const registry: Operation<any, any>[] = [];
