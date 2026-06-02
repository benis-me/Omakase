/**
 * The runtime registry holds the set of {@link RuntimeAgentDef}s the daemon
 * knows about. It ships the built-in adapters and lets downstream projects
 * register their own (or override a built-in) without forking.
 */
import { BUILTIN_AGENT_DEFS } from './defs/index.js';
import type { RuntimeAgentDef } from './types.js';

export interface RegisterOptions {
  /** Allow replacing an existing def with the same id. */
  override?: boolean;
}

export class RuntimeRegistry {
  private readonly defs = new Map<string, RuntimeAgentDef>();

  constructor(initial: readonly RuntimeAgentDef[] = []) {
    for (const def of initial) this.register(def);
  }

  register(def: RuntimeAgentDef, options: RegisterOptions = {}): this {
    if (this.defs.has(def.id) && !options.override) {
      throw new Error(
        `Duplicate agent definition id: "${def.id}". Pass { override: true } to replace it.`,
      );
    }
    this.defs.set(def.id, def);
    return this;
  }

  unregister(id: string): boolean {
    return this.defs.delete(id);
  }

  has(id: string): boolean {
    return this.defs.has(id);
  }

  get(id: string): RuntimeAgentDef | undefined {
    return this.defs.get(id);
  }

  list(): RuntimeAgentDef[] {
    return [...this.defs.values()];
  }

  get size(): number {
    return this.defs.size;
  }
}

export interface CreateRegistryOptions {
  /** Include the built-in adapter defs (default true). */
  includeBuiltins?: boolean;
}

/** Convenience constructor: built-ins plus any extra defs. */
export function createRegistry(
  extra: readonly RuntimeAgentDef[] = [],
  options: CreateRegistryOptions = {},
): RuntimeRegistry {
  const builtins = options.includeBuiltins === false ? [] : BUILTIN_AGENT_DEFS;
  return new RuntimeRegistry([...builtins, ...extra]);
}
