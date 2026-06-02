// Dev entry: run the CLI from TypeScript source via tsx without a build step.
import { createCli } from './cli.js';

const code = await createCli().main(process.argv.slice(2));
process.exit(code);
