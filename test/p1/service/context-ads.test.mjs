import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  patchContextClient,
  patchContextHost,
  removeContextAds,
} from '../../../packages/shell/src/host/context-ads.js';

const CLIENT_FIXTURE = [
  'const keep=1;',
  'let Rp={id:`deepseek-platform`,name:`DeepSeek`,url:`https://platform.deepseek.com/`};',
  'function em(e,t){return function(){return null}}',
  'let tm=new Set;function other(){let b=Lp(t,e),x=em(t,e),S=nm(t);',
  'return(0,d.jsxs)(`div`,{children:[(0,d.jsx)(S,{})]}),(0,d.jsxs)(`div`,{className:`lc-col`,',
  'children:[(0,d.jsx)(b,{}),(0,d.jsx)(x,{},typeof o==`string`?o:void 0)]});}',
].join('');

const HOST_FIXTURE = [
  'const keep=1;',
  'const Va={id:`deepseek-platform`,name:`DeepSeek`};',
  'function Ya(e){X({path:`/api/dsh-context/recom`,handler:async()=>({recoms:[]})})}',
  'const Xa=new Set();function yo(e,t){bi(e),Ya(e),Ba(e);}',
].join('');

test('Client patch removes the recom module and its header column', () => {
  const result = patchContextClient(CLIENT_FIXTURE);
  assert.equal(result.state, 'patched');
  assert.ok(!result.source.includes('/api/dsh-context/recom'));
  assert.ok(!result.source.includes('b=Lp(t,e)'));
  assert.ok(!result.source.includes('lc-col,'));
  assert.ok(result.source.includes('let tm=new Set;'));
  assert.ok(result.source.includes('const keep=1;'));
  assert.equal(patchContextClient(result.source).state, 'already');
});

test('Client patch refuses an unknown layout without changing it', () => {
  const unknown = 'fetch("/api/dsh-context/recom")';
  const result = patchContextClient(unknown);
  assert.equal(result.state, 'unsupported');
  assert.equal(result.source, unknown);
});

test('Host patch removes the recom route and its registration', () => {
  const result = patchContextHost(HOST_FIXTURE);
  assert.equal(result.state, 'patched');
  assert.ok(!result.source.includes('/api/dsh-context/recom'));
  assert.ok(!result.source.includes('Ya(e)'));
  assert.ok(result.source.includes('const Xa=new Set();'));
  assert.ok(result.source.includes('bi(e),Ba(e);'));
  assert.equal(patchContextHost(result.source).state, 'already');
});

test('Host patch refuses an unknown layout without changing it', () => {
  const unknown = 'route("/api/dsh-context/recom")';
  const result = patchContextHost(unknown);
  assert.equal(result.state, 'unsupported');
  assert.equal(result.source, unknown);
});

const makeProfile = async (client, host, manifest = { name: 'dsh-context', version: '0.82.2' }) => {
  const root = await mkdtemp(path.join(tmpdir(), 'workspace-shell-context-'));
  const packageDir = path.join(root, 'node_modules', 'dsh-context');
  await mkdir(path.join(packageDir, 'lib'), { recursive: true });
  await writeFile(path.join(packageDir, 'package.json'), JSON.stringify(manifest));
  if (client !== undefined) await writeFile(path.join(packageDir, 'lib', 'client.js'), client);
  if (host !== undefined) await writeFile(path.join(packageDir, 'lib', 'index.js'), host);
  return { root, packageDir };
};

test('removeContextAds patches an installed package once', async () => {
  const profile = await makeProfile(CLIENT_FIXTURE, HOST_FIXTURE);
  const rebuilt = [];
  const first = removeContextAds({
    profileContext: { dir: profile.root },
    clientModules: { rebuilt: (id) => rebuilt.push(id) },
  });
  assert.deepEqual(first, { status: 'patched', version: '0.82.2' });
  assert.deepEqual(rebuilt, ['dsh-context']);
  assert.ok(!(await readFile(path.join(profile.packageDir, 'lib', 'client.js'), 'utf8')).includes('b=Lp(t,e)'));
  assert.ok(!(await readFile(path.join(profile.packageDir, 'lib', 'index.js'), 'utf8')).includes('/api/dsh-context/recom'));
  const second = removeContextAds({ profileContext: { dir: profile.root } });
  assert.deepEqual(second, { status: 'already', version: '0.82.2' });
  assert.deepEqual(rebuilt, ['dsh-context']);
});

test('removeContextAds is a silent no-op when dsh-context is absent', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'workspace-shell-context-empty-'));
  const result = removeContextAds({ profileContext: { dir: root } });
  assert.deepEqual(result, { status: 'absent' });
  assert.equal(existsSync(path.join(root, 'node_modules', 'dsh-context')), false);
});

test('removeContextAds skips a missing profile and survives a malformed package', async () => {
  assert.deepEqual(removeContextAds({}), { status: 'skipped' });
  const root = await mkdtemp(path.join(tmpdir(), 'workspace-shell-context-bad-'));
  const packageDir = path.join(root, 'node_modules', 'dsh-context');
  await mkdir(path.join(packageDir, 'lib'), { recursive: true });
  await writeFile(path.join(packageDir, 'package.json'), '{ not json');
  const result = removeContextAds({ profileContext: { dir: root } });
  assert.equal(result.status, 'failed');
  assert.equal(typeof result.reason, 'string');
});

test('removeContextAds leaves an unknown Client layout untouched and reports it', async () => {
  const profile = await makeProfile('fetch("/api/dsh-context/recom")', HOST_FIXTURE);
  const warnings = [];
  const result = removeContextAds({
    profileContext: { dir: profile.root },
    logger: { warn: (message) => warnings.push(message) },
  });
  assert.deepEqual(result, { status: 'partial', version: '0.82.2', reason: 'unsupported-client' });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /unsupported Client layout/u);
  assert.equal(await readFile(path.join(profile.packageDir, 'lib', 'client.js'), 'utf8'), 'fetch("/api/dsh-context/recom")');
});
