/**
 * Per-caller selection store for `load_tools` / `unload_tools`.
 *
 * Progressive disclosure has two execution paths:
 *   Path A - promote an operation to a native MCP tool so it appears in
 *            tools/list with a full schema. Worth it when the agent will call
 *            the same operation repeatedly.
 *   Path B - call `invoke` without loading anything. Stateless, cheaper for
 *            one-off calls. Prefer this by default.
 *
 * This store backs Path A. Keyed by the caller's token so one agent session's
 * selection never leaks into another's tools/list.
 *
 * PRODUCTION NOTE: this is process-local. On serverless or multi-instance
 * deploys, selections will not be shared across instances (an agent may see a
 * tool it loaded disappear after a cold start). Either pin to Path B (`invoke`)
 * or back this with Redis / the session table. Path B is unaffected.
 */
interface LoadedToolsEntry {
  names: Set<string>;
  touchedAt: number;
}
interface LoadedToolsStore {
  entries: Map<string, LoadedToolsEntry>;
}

declare global {
  // eslint-disable-next-line no-var
  var __loadedToolsStore: LoadedToolsStore | undefined;
}

const store: LoadedToolsStore =
  globalThis.__loadedToolsStore ??
  (globalThis.__loadedToolsStore = { entries: new Map() });

const GC_TTL_MS = 24 * 60 * 60 * 1000;

function gc() {
  const now = Date.now();
  for (const [token, entry] of store.entries) {
    if (now - entry.touchedAt > GC_TTL_MS) store.entries.delete(token);
  }
}

function touch(token: string): LoadedToolsEntry {
  let entry = store.entries.get(token);
  if (!entry) {
    entry = { names: new Set(), touchedAt: Date.now() };
    store.entries.set(token, entry);
  } else {
    entry.touchedAt = Date.now();
  }
  return entry;
}

export function getLoaded(token: string): Set<string> {
  return store.entries.get(token)?.names ?? new Set();
}

export function addLoaded(token: string, names: string[]): void {
  gc();
  const entry = touch(token);
  for (const n of names) entry.names.add(n);
}

export function removeLoaded(token: string, names: string[]): void {
  const entry = store.entries.get(token);
  if (!entry) return;
  for (const n of names) entry.names.delete(n);
  entry.touchedAt = Date.now();
}

export function clearLoaded(token: string): void {
  store.entries.delete(token);
}
