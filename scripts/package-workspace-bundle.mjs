import { cp, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = fileURLToPath(new URL('..', import.meta.url));
if (!process.argv[2]) throw new Error('Usage: node scripts/package-workspace-bundle.mjs NEW_RELEASE_DIRECTORY');
const output = resolve(process.argv[2]);
await mkdir(output);
const staging = resolve(output, 'package');
await cp(resolve(root, 'packages/shell'), staging, {
  recursive: true,
  filter: (source) => !source.includes('node_modules') && !source.includes('/artifacts'),
});
execFileSync(process.execPath, [resolve(root, 'scripts/build-shell-client.mjs'), '--out-dir', staging], { stdio: 'inherit' });
const result = JSON.parse(execFileSync('npm', ['pack', '--json', '--pack-destination', output], { cwd: staging, encoding: 'utf8' }));
console.log(JSON.stringify({ shellTar: resolve(output, result[0].filename) }, null, 2));
