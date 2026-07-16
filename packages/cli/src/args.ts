// A tiny, dependency-free argv parser: positionals + flags. Supports
// --flag, --flag value, --flag=value, -f, and repeatable flags.

export interface ParsedArgs {
  positionals: string[];
  /** Single-value flags (last wins). */
  flags: Record<string, string | boolean>;
  /** Repeatable flags collected into arrays. */
  multi: Record<string, string[]>;
}

export interface FlagSpec {
  /** Flags that take a value (else treated as boolean). */
  value?: string[];
  /** Flags that may repeat (collected into `multi`). */
  repeatable?: string[];
  /** Short alias -> long name. */
  alias?: Record<string, string>;
}

export function parseArgs(argv: string[], spec: FlagSpec = {}): ParsedArgs {
  const valueFlags = new Set(spec.value ?? []);
  const repeatable = new Set(spec.repeatable ?? []);
  const alias = spec.alias ?? {};
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  const multi: Record<string, string[]> = {};

  const setFlag = (name: string, value: string | boolean) => {
    if (repeatable.has(name)) {
      (multi[name] ??= []).push(String(value));
    } else {
      flags[name] = value;
    }
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      let name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
      name = alias[name] ?? name;
      if (eq !== -1) {
        setFlag(name, arg.slice(eq + 1));
      } else if (valueFlags.has(name) || repeatable.has(name)) {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('-')) {
          setFlag(name, next);
          i++;
        } else {
          setFlag(name, true);
        }
      } else {
        setFlag(name, true);
      }
    } else if (arg.startsWith('-') && arg.length > 1 && !/^-\d/.test(arg)) {
      const body = arg.slice(1);
      const eq = body.indexOf('=');
      const rawName = eq === -1 ? body : body.slice(0, eq);
      const name = alias[rawName] ?? rawName;
      if (eq !== -1) {
        setFlag(name, body.slice(eq + 1));
        continue;
      }
      if (valueFlags.has(name) || repeatable.has(name)) {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('-')) {
          setFlag(name, next);
          i++;
        } else {
          setFlag(name, true);
        }
      } else {
        setFlag(name, true);
      }
    } else {
      positionals.push(arg);
    }
  }

  return { positionals, flags, multi };
}

export function flagStr(a: ParsedArgs, name: string): string | undefined {
  const v = a.flags[name];
  return typeof v === 'string' ? v : undefined;
}

export function flagBool(a: ParsedArgs, name: string): boolean {
  return a.flags[name] === true || a.flags[name] === 'true';
}

export function flagNum(a: ParsedArgs, name: string): number | undefined {
  const v = a.flags[name];
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}
