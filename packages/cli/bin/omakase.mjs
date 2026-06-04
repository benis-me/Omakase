#!/usr/bin/env node
// Thin launcher for the built CLI. Keeping the bin minimal means the real
// argument parsing and command wiring live in TypeScript under src/ and ship
// compiled into dist/. Run `pnpm --filter @omakase/cli build` to populate dist.
import process from 'node:process';

try {
  const mod = await import('../dist/index.js');
  await mod.main(process.argv.slice(2));
} catch (err) {
  const code = err && typeof err === 'object' ? err.code : undefined;
  if (code === 'ERR_MODULE_NOT_FOUND') {
    process.stderr.write(
      'omakase: compiled output missing. Build first:\n  pnpm --filter @omakase/cli build\n',
    );
    process.exit(1);
  }
  process.stderr.write(
    `${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
  );
  process.exit(1);
}
