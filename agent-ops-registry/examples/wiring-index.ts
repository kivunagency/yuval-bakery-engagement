/**
 * ============================================================================
 *  EXAMPLE: lib/operations/index.ts in a real project
 * ============================================================================
 *
 * This file is the ONLY place that knows the full operation list. It runs once
 * at boot: import every operation, push it into the registry, then invalidate
 * the dispatcher's name cache.
 */
import { registry } from "../lib/operations/registry";
import { invalidateOpCache } from "../lib/operations/dispatch";
import { createModuleTree, type ModuleNode, type AppInfo } from "../lib/modules";
import { createNavigationOps } from "../lib/operations/navigation";

// ── 1. Describe the domain ──────────────────────────────────────────────────
// Flat list. Parent/child comes from the dot-paths, so there is nothing to nest.
// Descriptions are read by the agent while navigating: write them for a human
// who has never seen the system.
export const MODULE_DEFS: ModuleNode[] = [
  { path: "properties", title: "Properties", description: "Rental property portfolio: search, status, balances, and rent collection." },
  { path: "properties.search", title: "Search", description: "Find properties by id, address, tenant, or debt status." },
  { path: "properties.payments", title: "Payments", description: "Record rent payments and compute management commission. Write operations." },
  { path: "properties.aging", title: "Aging", description: "Debt aging buckets (0-30 / 31-60 / 61-90 / 90+) and collection priorities." },
  { path: "maintenance", title: "Maintenance", description: "Maintenance calls: open, assign, track, and close." },
  { path: "support", title: "Support", description: "Raise bug reports, change requests, and feature requests as tickets." },
];

export const APP_INFO: AppInfo = {
  app: "Egoz Maniv Operations",
  description:
    "Property management operations for a 433-unit rental portfolio: rent collection, " +
    "debt aging, maintenance, and support tickets. " +
    "Navigate the module tree with explore() to discover available functions before invoking them.",
};

// ── 2. Build the tree and the navigation layer ──────────────────────────────
const tree = createModuleTree(MODULE_DEFS, APP_INFO);
export const { platformManifest, getNode, expandWildcard, searchTree } = tree;

// ── 3. Import business operations ───────────────────────────────────────────
import { recordRentPayment } from "./example-operation";
// import { searchProperties } from "../lib/operations/searchProperties";
// import { getAgingReport }   from "../lib/operations/getAgingReport";
// import { createTicket }     from "../lib/operations/createTicket";

// ── 4. Populate the registry ────────────────────────────────────────────────
registry.push(
  ...createNavigationOps(tree),   // explore, search, describe_tool, invoke, load/unload, getContext
  recordRentPayment,
  // searchProperties, getAgingReport, createTicket,
);

// ── 5. Rebuild the dispatcher index. Required after mutating the registry. ──
invalidateOpCache();

export { registry };
export type { Operation } from "../lib/operations/types";
