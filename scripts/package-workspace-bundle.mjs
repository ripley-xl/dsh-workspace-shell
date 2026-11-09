import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = fileURLToPath(new URL('..', import.meta.url));
if (!process.argv[2]) throw new Error('Usage: node scripts/package-workspace-bundle.mjs NEW_RELEASE_DIRECTORY');
const output = resolve(process.argv[2]);
await mkdir(output);
const pack = async (name) => {
  const staging = resolve(output, name);
  await cp(resolve(root, 'packages', name), staging, { recursive: true });
  execFileSync(process.execPath, [resolve(root, `scripts/build-${name}-client.mjs`), '--out-dir', staging], { stdio: 'inherit' });
  const manifest = JSON.parse(await readFile(resolve(staging, 'package.json'), 'utf8'));
  if (name === 'shell') {
    manifest.dependencies['@local/dsh-ssh-remote'] = `file:${managerTar}`;
    manifest.dependencies['dsh-workspace-guest'] = `file:${guestTar}`;
    await writeFile(resolve(staging, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
  }
  const result = JSON.parse(execFileSync('npm', ['pack', '--json', '--pack-destination', output], { cwd: staging, encoding: 'utf8' }));
  return resolve(output, result[0].filename);
};
const managerTar = await pack('manager');
const guestTar = await pack('guest');
const shellTar = await pack('shell');
console.log(JSON.stringify({ managerTar, guestTar, shellTar }, null, 2));
