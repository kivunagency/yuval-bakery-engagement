import 'server-only';
import { registry } from './registry';
import { invalidateOpCache } from './dispatch';
import { createModuleTree, type AppInfo, type ModuleNode } from '../modules';
import { createNavigationOps } from './navigation';
import { BAKERY_OPERATIONS } from './bakery';

// The ONLY place that knows the full operation list (template
// examples/wiring-index.ts). Runs once, at first import.

export const MODULE_DEFS: ModuleNode[] = [
  { path: 'orders', title: 'Orders', description: 'Customer orders: record a payment that arrived.' },
  { path: 'custom_cakes', title: 'Custom cakes', description: 'Custom-cake requests waiting for a decision: approve at a price, or decline.' },
  { path: 'delivery', title: 'Delivery', description: 'Delivery day summary: how many paid deliveries per city. Counts only.' },
  { path: 'capacity', title: 'Capacity', description: "A day's oven and work minutes, and blackout days." },
];

export const APP_INFO: AppInfo = {
  app: 'Yuval Bakery operations',
  description:
    'Operations of a one-person home bakery: orders, custom cakes, delivery days and daily baking capacity. ' +
    'Call explore() and describe_tool() before invoke(). Functions that change data need a confirmation step with the human.',
};

const tree = createModuleTree(MODULE_DEFS, APP_INFO);

if (registry.length === 0) {
  registry.push(...createNavigationOps(tree), ...BAKERY_OPERATIONS);
  invalidateOpCache();
}

export { registry };
