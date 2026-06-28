#!/usr/bin/env node
// Thin launcher for the built CLI. Keeping the bin minimal means the real
// argument parsing and command wiring live in TypeScript under src/ and ship
// compiled into dist/. Run `pnpm --filter @omakase/cli build` to populate dist.
import process from 'node:process';

// Storage uses the built-in `node:sqlite`, which is unflagged on Node 24 (the Electron
// app) but needs `--experimental-sqlite` on Node 22. If it isn't loadable, re-exec this
// process with the flag so the CLI works on either without a native rebuild.
try {
  await import('node:sqlite');
} catch {
  const { spawnSync } = await import('node:child_process');
  const result = spawnSync(
    process.execPath,
    ['--experimental-sqlite', '--no-warnings', process.argv[1], ...process.argv.slice(2)],
    { stdio: 'inherit' },
  );
  process.exit(result.status ?? 1);
}

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
