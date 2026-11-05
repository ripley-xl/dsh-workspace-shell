import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, chmod } from 'node:fs/promises';
import { createSessionHostRegistry, persistenceRoot, sessionHostUrl } from '../../packages/shell/src/host/session-hosts.js';
import { createSessionViewBroker } from '../../packages/shell/src/host/session-views.js';
import { readSessionHostInput } from '../../packages/shell/session-host/index.js';

async function fixture(t) {
  const root = await mkdtemp('/tmp/wsh-host-test-');
  const directory = root + '/r';
  const storageRoot = root + '/s';
  await mkdir(storageRoot);
  const registrations = [];
  t.after(async () => { for (const registration of registrations) await registration.dispose(); await rm(root, { recursive: true, force: true }); });
  return { root, directory, storageRoot, async register(options = {}) {
    const value = await createSessionHostRegistry({ directory, storageRoot, profile: 'web', owns: () => false, timeoutMs: 80, ...options });
    registrations.push(value); return value;
  } };
}

test('local and foreign Agent ownership comes from same-storage live registrations, not profile names', async (t) => {
  const f = await fixture(t);
  const a = await f.register({ owns: (id) => id === 'a' });
  const b = await f.register({ owns: (id) => id === 'b', attachUrl: () => 'http://127.0.0.1:1234/?token=test' });
  const result = await a.lookup(['a', 'b', 'cold']);
  assert.equal(result.sessions.a.state, 'local');
  assert.equal(result.sessions.b.state, 'foreign');
  assert.equal(result.sessions.b.host.instanceId, b.describe().instanceId);
  assert.equal(result.sessions.cold.state, 'unknown');
  assert.doesNotMatch(JSON.stringify(result), /token|url|1234/);
  assert.equal((await a.attach(b.describe().instanceId, 'b')).sessionId, 'b');
  await assert.rejects(a.attach(b.describe().instanceId, 'a'));
  await b.dispose();
  assert.equal((await a.lookup(['b'])).sessions.b.state, 'unknown');
  await assert.rejects(a.attach(b.describe().instanceId, 'b'));
});

test('different persistence scopes, duplicate owners and dead sockets never imply unowned', async (t) => {
  const f = await fixture(t);
  await mkdir(f.root + '/other');
  const a = await f.register({ owns: (id) => id === 'conflict' });
  await f.register({ owns: () => true, storageRoot: f.root + '/other' });
  assert.equal((await a.lookup(['missing'])).sessions.missing.state, 'unknown');
  await f.register({ owns: (id) => id === 'conflict' });
  assert.equal((await a.lookup(['conflict'])).sessions.conflict.state, 'unknown');
  await writeFile(f.directory + '/' + 'e'.repeat(32) + '.sock', 'not a socket', { mode: 0o600 });
  assert.equal((await a.lookup(['missing'])).sessions.missing.state, 'unknown');
});

test('registry refuses unsafe directory, invalid input, remote URLs and cancelled lookups', async (t) => {
  const f = await fixture(t);
  const a = await f.register();
  await assert.rejects(a.lookup(['../x']));
  await assert.rejects(a.lookup(['x'], AbortSignal.abort()));
  for (const url of ['https://example.com', 'http://user@127.0.0.1:1234/', 'file:///tmp/x', 'http://127.0.0.1/']) assert.throws(() => sessionHostUrl(url));
  await chmod(f.directory, 0o755);
  await assert.rejects(f.register(), /DIRECTORY_UNSAFE/);
});

test('persistence scope uses the evaluated active provider matching service identity', () => {
  const entry = { options: { name: '@deepseek-ai/dsh-session-persistence-jsonl' }, context: { get: () => ({ identity: 'a' }) }, fiber: { config: { root: '/actual' } } };
  const ctx = { sessionPersistence: { identity: 'a' }, loader: { entries: () => [entry] } };
  assert.equal(persistenceRoot(ctx), '/actual');
  entry.disabled = true;
  assert.throws(() => persistenceRoot(ctx), /SCOPE_UNAVAILABLE/);
});

test('persistence scope reads the validated config when the fiber also keeps the raw one', () => {
  // cordis 4.1 moved the validated config to `effectiveConfig` and left `fiber.config`
  // holding the raw value, where `!!js` expressions are not evaluated yet.
  const entry = { options: { name: '@deepseek-ai/dsh-session-persistence-jsonl' }, context: { get: () => ({ identity: 'a' }) }, fiber: { config: { root: { __jsExpr: 'dshHomePath("sessions")' } }, effectiveConfig: { root: '/actual' } } };
  const ctx = { sessionPersistence: { identity: 'a' }, loader: { entries: () => [entry] } };
  assert.equal(persistenceRoot(ctx), '/actual');
});

const viewId = 'a'.repeat(32), windowId = 'b'.repeat(32), tabId = 'c'.repeat(32);
test('view command requires the exact live view and selected session acknowledgment', async () => {
  let clock = 1;
  const broker = createSessionViewBroker({ now: () => clock });
  const data = { viewId, windowId, tabId, sessionId: null, active: true };
  broker.update(data);
  const pending = broker.command(viewId, { kind: 'select', sessionId: 's' });
  const command = broker.update(data).command;
  assert.throws(() => broker.acknowledge({ ...command, viewId, ok: true }));
  broker.update({ ...data, sessionId: 's' });
  broker.acknowledge({ ...command, viewId, ok: true });
  assert.equal((await pending).sessionId, 's');
  clock += 16000;
  assert.deepEqual(broker.list(windowId), []);
  assert.throws(() => broker.command(viewId, { kind: 'select', sessionId: 's' }));
  broker.dispose();
});

test('cancel, supersession and unload reject outstanding navigation', async () => {
  const broker = createSessionViewBroker();
  const data = { viewId, windowId, tabId, sessionId: null };
  broker.update(data);
  const abort = new AbortController();
  const p = broker.command(viewId, { kind: 'select', sessionId: 's' }, abort.signal);
  abort.abort(); await assert.rejects(p, /CANCELLED/);
  const p1 = broker.command(viewId, { kind: 'select', sessionId: 's' });
  const p2 = broker.command(viewId, { kind: 'select', sessionId: 't' });
  await assert.rejects(p1, /SUPERSEDED/);
  broker.dispose(); await assert.rejects(p2, /CHANGED/);
});

test('view selection traverses a real socket without URL or draft transfer', async (t) => {
  const f = await fixture(t);
  const broker = createSessionViewBroker(); t.after(() => broker.dispose());
  const a = await f.register();
  const b = await f.register({ owns: (id) => id === 's', views: broker.list, command: broker.command });
  const data = { viewId, windowId, tabId, sessionId: null };
  broker.update(data);
  assert.equal((await a.views(b.describe().instanceId, windowId))[0].viewId, viewId);
  const result = a.command(b.describe().instanceId, viewId, { kind: 'select', sessionId: 's' });
  let command;
  for (let i = 0; i < 100 && !command; i++) { await new Promise((r) => setTimeout(r, 5)); command = broker.update(data).command; }
  assert.ok(command);
  broker.update({ ...data, sessionId: 's' });
  broker.acknowledge({ ...command, viewId, ok: true });
  assert.equal((await result).sessionId, 's');
});

test('HTTP parser bounds streamed bytes for authenticated navigation', async () => {
  const request = (value) => new Request('http://localhost/api', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
  assert.deepEqual(await readSessionHostInput(request({ sessionIds: ['s'] })), { sessionIds: ['s'] });
  await assert.rejects(readSessionHostInput(request({ huge: 'x'.repeat(65536) })));
});

test('draft transport requires an exact draft receipt, hides text from discovery, and validates bounds', async () => {
  const broker = createSessionViewBroker();
  const data = { viewId, windowId, tabId, sessionId: 's' };
  broker.update(data);
  const draft = { id: 'e'.repeat(32), text: 'private failed message' };
  const task = broker.command(viewId, { kind: 'select', sessionId: 's', draft });
  const command = broker.update(data).command;
  assert.equal(command.draft.text, draft.text);
  assert.doesNotMatch(JSON.stringify(broker.list(windowId)), /private|draft/);
  assert.throws(() => broker.acknowledge({ ...command, viewId, ok: true }));
  broker.acknowledge({ ...command, viewId, ok: true, draftId: draft.id });
  assert.equal((await task).draftId, draft.id);
  assert.throws(() => broker.command(viewId, { kind: 'select', sessionId: 's', draft: { id: draft.id, text: 'x'.repeat(65536) } }), /DRAFT_INVALID/);
  broker.dispose();
});
