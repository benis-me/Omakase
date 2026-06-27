import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';

/**
 * vitest globalSetup — make `better-sqlite3` runnable under the current Node ABI.
 *
 * Running the Electron app (`electron-builder install-app-deps`, via `predev`)
 * recompiles native modules for Electron's ABI, which then crashes Node test
 * runs with a NODE_MODULE_VERSION mismatch. Detect that once before the suite and
 * rebuild for Node, so `pnpm -r test` always works — even right after running the
 * app — without a manual rebuild step.
 */
export default function ensureNodeSqlite() {
  const require = createRequire(import.meta.url);
  try {
    const Database = require('better-sqlite3');
    new Database(':memory:').close();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes('NODE_MODULE_VERSION')) throw err;
    const pkg = require.resolve('better-sqlite3/package.json');
    const dir = pkg.slice(0, pkg.length - '/package.json'.length);
    // eslint-disable-next-line no-console
    console.warn('[vitest] better-sqlite3 is Electron-ABI; rebuilding for Node…');
    execSync('npm run build-release', { cwd: dir, stdio: 'inherit' });
  }
}
