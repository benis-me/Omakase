// Dev entry: run the CLI from TypeScript source via tsx without a build step.
import { main } from './index.js';

await main(process.argv.slice(2));
