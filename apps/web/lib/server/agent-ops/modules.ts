import 'server-only';
import type { Role } from './auth';
import { roleSatisfies } from './auth';
import type { AnyOperation } from './operations/types';

// The module tree an agent walks with explore() (template lib/modules.ts,
// trimmed to what five operations need: one level of modules, no wildcards).
// Everything here is role-filtered: a role never sees an operation it cannot
// call, not even its name.

export interface ModuleNode {
  path: string;
  title: string;
  description: string;
}

export interface FnSummary {
  name: string;
  title: string;
  description: string;
  permission: 'read' | 'write';
  requiresConfirmation: boolean;
}

export interface AppInfo {
  app: string;
  description: string;
}

function visible(op: AnyOperation, role: Role): boolean {
  return !op.alwaysOn && roleSatisfies(role, op.roles);
}

function fnSummary(op: AnyOperation): FnSummary {
  return { name: op.name, title: op.title, description: op.description, permission: op.permission, requiresConfirmation: op.requiresConfirmation ?? false };
}

export function createModuleTree(MODULE_DEFS: ModuleNode[], APP_INFO: AppInfo) {
  const byPath = new Map(MODULE_DEFS.map((m) => [m.path, m]));

  function platformManifest(role: Role, ops: AnyOperation[]) {
    return {
      app: APP_INFO.app,
      description: APP_INFO.description,
      modules: MODULE_DEFS.filter((m) => ops.some((op) => op.module === m.path && visible(op, role))),
    };
  }

  function getNode(path: string, role: Role, ops: AnyOperation[]) {
    const mod = byPath.get(path);
    if (!mod) return null;
    const functions = ops.filter((op) => op.module === path && visible(op, role)).map(fnSummary);
    // A module with nothing this role can call does not exist for it.
    if (functions.length === 0) return null;
    return { ...mod, functions };
  }

  /** Bare keyword, case-insensitive, over function names and module paths. */
  function searchTree(keyword: string, role: Role, ops: AnyOperation[]) {
    const k = keyword.trim().toLowerCase();
    const functions = ops
      .filter((op) => visible(op, role) && op.module && `${op.module}/${op.name}`.toLowerCase().includes(k))
      .map((op) => ({ ...fnSummary(op), module: op.module }));
    return { functions };
  }

  return { platformManifest, getNode, searchTree };
}

export type ModuleTree = ReturnType<typeof createModuleTree>;
