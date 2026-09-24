import type { Role } from "./auth";
import { roleSatisfies } from "./auth";
import type { Operation } from "./operations/types";

/**
 * ============================================================================
 *  THE MODULE TREE - how an agent discovers what this system can do
 * ============================================================================
 *
 * The problem this solves: dumping every operation schema into tools/list
 * costs tokens on EVERY request, forever, including for capabilities the agent
 * will never use. At ~50 operations it is wasteful. At ~500 it is fatal.
 *
 * Instead the agent walks a tree:
 *     explore()                    -> what domains exist          (~90 tokens)
 *     explore("properties")        -> sub-modules                 (~190 cumulative)
 *     explore("properties.rent")   -> functions + permissions     (~380 cumulative)
 *     describe_tool("recordRent")  -> the exact input schema      (only now)
 *
 * Modules are pure metadata. Parent/child is inferred from dot-path prefixes,
 * so you never declare a parent: "properties.rent" is a child of "properties"
 * because of the dot. The tree builds itself from the flat list.
 *
 * An operation joins the tree by setting `module: "properties.rent"`. That is
 * the only coupling between an operation and the tree.
 *
 * EVERYTHING here is role-filtered. An agent acting as a low-privilege user
 * does not merely get "forbidden" when calling a privileged operation - it
 * never sees that the operation exists.
 */

export interface ModuleNode {
  path: string;
  title: string;
  description: string;
}

export interface FnSummary {
  name: string;
  title: string;
  description: string;
  permission: "read" | "write";
  parallelSafe: boolean;
  requiresConfirmation?: boolean;
}

export interface ExploreNode {
  path: string;
  title: string;
  description: string;
  submodules: ModuleNode[];
  functions: FnSummary[];
}

export interface PlatformManifest {
  app: string;
  description: string;
  modules: ModuleNode[];
}

export interface AppInfo {
  app: string;
  /** Shown on the bare explore() call. Tell the agent what this system IS and
   *  that it should navigate before invoking. This is prime real estate. */
  description: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyOp = Operation<any, any>;

/**
 * Build the tree helpers for a project.
 *
 * Usage in your project's lib/modules.ts:
 *
 *   export const { platformManifest, getNode, expandWildcard, searchTree } =
 *     createModuleTree(MODULE_DEFS, APP_INFO);
 */
export function createModuleTree(MODULE_DEFS: ModuleNode[], APP_INFO: AppInfo) {
  const moduleByPath = new Map(MODULE_DEFS.map((m) => [m.path, m]));

  function effectiveParallelSafe(op: AnyOp): boolean {
    if (op.parallelSafe !== undefined) return op.parallelSafe;
    return op.permission === "read";
  }

  function fnSummary(op: AnyOp): FnSummary {
    return {
      name: op.name,
      title: op.title,
      description: op.description,
      permission: op.permission,
      parallelSafe: effectiveParallelSafe(op),
      requiresConfirmation: op.requiresConfirmation,
    };
  }

  function isChildOf(childPath: string, parentPath: string): boolean {
    return childPath === parentPath || childPath.startsWith(parentPath + ".");
  }

  function directChildrenOf(parentPath: string): ModuleNode[] {
    return MODULE_DEFS.filter((m) => {
      if (m.path === parentPath) return false;
      if (!isChildOf(m.path, parentPath)) return false;
      return !m.path.slice(parentPath.length + 1).includes(".");
    });
  }

  function topLevelModules(): ModuleNode[] {
    return MODULE_DEFS.filter((m) => !m.path.includes("."));
  }

  function fnsForModule(path: string, role: Role, ops: AnyOp[]): FnSummary[] {
    return ops
      .filter((op) => op.module === path && !op.alwaysOn && roleSatisfies(role, op.roles))
      .map(fnSummary);
  }

  function platformManifest(role: Role, ops: AnyOp[]): PlatformManifest {
    return {
      app: APP_INFO.app,
      description: APP_INFO.description,
      // Only surface top-level modules the role can actually reach something in.
      modules: topLevelModules().filter((m) =>
        ops.some((op) => op.module && isChildOf(op.module, m.path) && !op.alwaysOn && roleSatisfies(role, op.roles)),
      ),
    };
  }

  function getNode(path: string, role: Role, ops: AnyOp[]): ExploreNode | null {
    const mod = moduleByPath.get(path);
    if (!mod) return null;
    return {
      path: mod.path,
      title: mod.title,
      description: mod.description,
      submodules: directChildrenOf(path),
      functions: fnsForModule(path, role, ops),
    };
  }

  function expandWildcard(pattern: string, role: Role, ops: AnyOp[]): ExploreNode[] {
    const source =
      pattern === "*"
        ? MODULE_DEFS
        : MODULE_DEFS.filter((m) => {
            const base = pattern.slice(0, -2);
            return m.path !== base && isChildOf(m.path, base);
          });
    return source.map((m) => ({
      path: m.path,
      title: m.title,
      description: m.description,
      submodules: directChildrenOf(m.path),
      functions: fnsForModule(m.path, role, ops),
    }));
  }

  function searchTree(pattern: string, role: Role, ops: AnyOp[]) {
    const re = globToRegExp(pattern);
    const functions = ops
      .filter((op) => !op.alwaysOn && op.module && roleSatisfies(role, op.roles))
      .filter((op) => re.test(`${op.module!.replace(/\./g, "/")}/${op.name}`))
      .map((op) => ({
        ...fnSummary(op),
        module: op.module!,
        path: `${op.module!.replace(/\./g, "/")}/${op.name}`,
      }));
    const modules = MODULE_DEFS
      .filter((m) => re.test(m.path.replace(/\./g, "/")))
      .filter((m) =>
        ops.some((op) => op.module && isChildOf(op.module, m.path) && !op.alwaysOn && roleSatisfies(role, op.roles)),
      );
    return { functions, modules };
  }

  return { platformManifest, getNode, expandWildcard, searchTree, MODULE_DEFS, APP_INFO };
}

/**
 * Linux-style glob to RegExp, for `search`.
 *
 *   "refund"        -> **\/*refund*   (bare keyword, matches anywhere)
 *   "*refund*"      -> **\/*refund*
 *   "finance/**"    -> everything under finance
 */
export function globToRegExp(pattern: string): RegExp {
  if (!pattern.includes("/")) {
    pattern = /[*?]/.test(pattern) ? `**/${pattern}` : `**/*${pattern}*`;
  }
  const parts: string[] = [];
  for (const seg of pattern.split("/")) {
    if (seg === "**") {
      parts.push(".*");
    } else {
      parts.push(
        seg
          .replace(/[.+^${}()|[\]\\]/g, "\\$&")
          .replace(/\*/g, "[^/]*")
          .replace(/\?/g, "[^/]"),
      );
    }
  }
  const joined = parts
    .join("/")
    .replace(/\/\.\*\//g, "(?:/.*)?/")
    .replace(/^\.\*\//, "(?:.*/)?")
    .replace(/\/\.\*$/, "(?:/.*)?");
  return new RegExp(`^${joined}$`, "i");
}
