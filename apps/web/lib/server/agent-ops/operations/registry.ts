import 'server-only';
import type { AnyOperation } from './types';

// The single source of truth for everything an agent can do in this system.
// Own file so navigation.ts can import it without a cycle; index.ts fills it
// once at module load and calls invalidateOpCache().
export const registry: AnyOperation[] = [];
