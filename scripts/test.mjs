import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { spawn } from 'node:child_process';

export async function discoverNamedTests(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || ['node_modules', 'fixtures', 'artifacts'].includes(entry.name)) continue;
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await discoverNamedTests(candidate));
    else if (entry.isFile() && /\.test\.[cm]?js$/u.test(entry.name)) files.push(candidate);
  }
  return files.sort();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const files = await discoverNamedTests(path.join(root, 'test'));
  if (!files.length) throw new Error('No named test files were discovered');
  // Do not execute standalone helper programs under test/, especially the explicitly
  // opted-in VM runner. Real VM acceptance remains `npm run test:p0` with its guard.
  console.log(`Running ${files.length} named test files; standalone VM runners are not auto-executed.`);
  const child = spawn(process.execPath, ['--test', ...process.argv.slice(2), ...files], { cwd: root, stdio: 'inherit' });
  child.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
  child.on('exit', (code) => { process.exitCode = code ?? 1; });
}
