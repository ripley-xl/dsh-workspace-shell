import assert from 'node:assert/strict';
import test from 'node:test';
import { defineTool as sdkDefineTool } from '@deepseek-ai/dsh-tools';

import { registerWorkspaceRuntimeTool } from '../../packages/shell/src/host/runtime-tool.js';

const ACTOR = '12345678-1234-4234-9234-123456789012';
const OWNER = `agent-${ACTOR}`;
const SECRET = 'private-token-never-return';
const TAB_HINT = 'Select this profile from the workspace tab strip. This tool does not open a GUI tab.';

function catalog(overrides = {}) {
  return {
    currentProfile: 'current',
    defaultCwd: '/work/default',
    canStop: true,
    profiles: [
      { id: 'current', isCurrent: true, web: true, tui: true },
      { id: 'web', isCurrent: false, web: true, tui: false },
      { id: 'tui', isCurrent: false, web: false, tui: true },
    ],
    runtimes: [],
    ...overrides,
  };
}

function fixture({ catalogValue, openWebResult, openTuiResult, defineTool = (definition) => definition } = {}) {
  const calls = [];
  const service = {
    async catalog(input) {
      calls.push({ method: 'catalog', input });
      return catalogValue ?? catalog();
    },
    async openWeb(input) {
      calls.push({ method: 'openWeb', input });
      return openWebResult ?? { runtimeId: 'runtime-web', url: `http://127.0.0.1:41000/?tkn=${SECRET}` };
    },
    async openTui(input) {
      calls.push({ method: 'openTui', input });
      return openTuiResult ?? { runtimeId: 'runtime-tui', output: SECRET };
    },
    async stop(input) { calls.push({ method: 'stop', input }); },
  };
  const tools = [];
  const middleware = [];
  const cleanup = { tool: 0, middleware: 0 };
  const ctx = {
    tools: {
      register(definition) {
        tools.push(definition);
        return () => { cleanup.tool += 1; };
      },
    },
    on(name, listener) {
      assert.equal(name, 'tools/pre-execute');
      middleware.push(listener);
      return () => { cleanup.middleware += 1; };
    },
  };
  const unregister = registerWorkspaceRuntimeTool(ctx, service, { defineTool });
  return {
    ctx, service, calls, tools, middleware, cleanup, unregister,
    definition: tools[0],
    async execute(args, agent = { id: ACTOR }) {
      return tools[0].execute(args, { agent, signal: new AbortController().signal });
    },
    async pre(args, name = 'workspace_runtime') {
      return middleware[0]({ name, arguments: args }, async () => ({ kind: 'allow', next: true }));
    },
  };
}

test('registers one bounded global tool and idempotently removes tool and middleware', () => {
  const state = fixture();
  assert.equal(state.tools.length, 1);
  assert.equal(state.middleware.length, 1);
  assert.equal(state.definition.name, 'workspace_runtime');
  assert.deepEqual(Object.keys(state.definition.parameters), ['operation', 'profile', 'cwd', 'id', 'cols', 'rows']);
  assert.equal('ownerId' in state.definition.parameters, false);
  assert.equal('confirmIndependentHost' in state.definition.parameters, false);
  assert.equal('sandbox_permissions' in state.definition.parameters, false);
  assert.deepEqual(state.definition.parameters.operation.enum, ['list', 'start_web', 'start_tui', 'stop']);
  assert.equal(state.definition.output.schema.type, 'object');
  assert.equal(state.definition.output.schema.additionalProperties, false);
  assert.equal(state.definition.isConcurrencySafe({ operation: 'list' }), true);
  assert.equal(state.definition.isConcurrencySafe({ operation: 'stop' }), false);
  assert.match(state.definition.description, /independent PTY/u);
  assert.match(state.definition.description, /share profile settings and DSH_HOME data/u);
  assert.match(state.definition.parameters.cwd.description, /Required for start_tui/u);
  state.unregister();
  state.unregister();
  assert.deepEqual(state.cleanup, { tool: 1, middleware: 1 });
});

test('requires an injected defineTool without importing the SDK', () => {
  assert.throws(() => registerWorkspaceRuntimeTool({}, {}, {}), /defineTool is required/u);
});

test('registration failure cleans the already registered middleware', () => {
  let removed = 0;
  const ctx = {
    on() { return () => { removed += 1; }; },
    tools: { register() { throw new Error('duplicate'); } },
  };
  assert.throws(() => registerWorkspaceRuntimeTool(ctx, {}, { defineTool: (value) => value }), /duplicate/u);
  assert.equal(removed, 1);
});

test('list and other tools pass through while every impactful operation asks', async () => {
  const state = fixture();
  assert.deepEqual(await state.pre({ operation: 'list' }), { kind: 'allow', next: true });
  assert.deepEqual(await state.pre({ operation: 'start_web' }, 'other_tool'), { kind: 'allow', next: true });
  for (const operation of ['start_web', 'start_tui']) {
    const decision = await state.pre({ operation, profile: 'web' });
    assert.equal(decision.kind, 'ask');
    assert.match(decision.reason, /profile "web"/u);
  }
  const web = await state.pre({ operation: 'start_web', profile: 'web' });
  assert.match(web.displayReason.en, /no other Web or TUI Host process/u);
  assert.match(web.displayReason.en, /cannot discover external Host processes/u);
  const tui = await state.pre({ operation: 'start_tui', profile: 'web', cwd: '/work/custom' });
  assert.match(tui.displayReason.en, /new TUI runtime/u);
  assert.match(tui.displayReason.en, /Existing TUI runtimes stay running/u);
  assert.match(tui.displayReason.en, /profile settings and DSH_HOME data may be shared/u);
  assert.doesNotMatch(tui.displayReason.en, /no other Web or TUI Host process/u);
  const stop = await state.pre({ operation: 'stop', id: 'runtime-1' });
  assert.equal(stop.kind, 'ask');
  assert.match(stop.displayReason.en, /all Agents and foreground or parked sessions/u);
  assert.match(stop.displayReason.en, /runtime-1/u);
  assert.deepEqual(await state.pre({ operation: 'START_WEB', profile: 'web' }), { kind: 'deny', reason: 'INVALID_INPUT' });
  assert.equal(state.calls.length, 0);
});

test('list binds the actor and returns only safe catalog fields', async () => {
  const state = fixture({
    catalogValue: catalog({
      url: `http://127.0.0.1/?tkn=${SECRET}`,
      error: { message: SECRET },
      profiles: [{ id: 'web', isCurrent: false, web: true, tui: false, token: SECRET }],
      runtimes: [{
        id: 'runtime-1', kind: 'web', profileId: 'web', phase: 'running', canStop: true,
        ownerId: 'other', url: `http://127.0.0.1/?tkn=${SECRET}`, output: SECRET, error: SECRET,
      }],
    }),
  });
  const value = await state.execute({ operation: 'list' });
  assert.deepEqual(state.calls, [{ method: 'catalog', input: { ownerId: OWNER } }]);
  assert.deepEqual(value, {
    status: 'ok', operation: 'list', currentProfile: 'current', defaultCwd: '/work/default', canStop: true,
    profiles: [{ id: 'web', isCurrent: false, web: true, tui: false }],
    runtimes: [{ id: 'runtime-1', kind: 'web', profileId: 'web', phase: 'running', canStop: true }],
  });
  assert.equal(JSON.stringify(value).includes(SECRET), false);
  assert.equal(JSON.stringify(value).includes('url'), false);
  assert.equal(JSON.stringify(value).includes('ownerId'), false);
});

test('list bounds profiles and runtimes to 128 entries and reports truncation', async () => {
  const profiles = Array.from({ length: 140 }, (_, index) => ({ id: `p-${index}`, isCurrent: false, web: true, tui: false }));
  const runtimes = Array.from({ length: 140 }, (_, index) => ({ id: `r-${index}`, kind: 'web', profileId: 'web', phase: 'running' }));
  const state = fixture({ catalogValue: catalog({ profiles, runtimes }) });
  const value = await state.execute({ operation: 'list' });
  assert.equal(value.profiles.length, 128);
  assert.equal(value.runtimes.length, 128);
  assert.equal(value.profiles.at(-1).id, 'p-127');
  assert.equal(value.runtimes.at(-1).id, 'r-127');
  assert.equal(value.truncated, true);
});

test('start_web confirms through middleware and never exposes the authenticated URL', async () => {
  const state = fixture();
  const value = await state.execute({ operation: 'start_web', profile: 'web' });
  assert.deepEqual(state.calls[0], { method: 'catalog', input: { ownerId: OWNER } });
  const { signal, ...input } = state.calls[1].input;
  assert.equal(signal instanceof AbortSignal, true);
  assert.deepEqual(input, { profileId: 'web', ownerId: OWNER, confirmIndependentHost: true });
  assert.equal(state.calls[1].method, 'openWeb');
  assert.deepEqual(value, { status: 'started', operation: 'start_web', id: 'runtime-web', profile: 'web', hint: TAB_HINT });
  assert.equal(JSON.stringify(value).includes(SECRET), false);
  assert.equal(JSON.stringify(value).includes('url'), false);
  assert.equal(state.definition.output.render({}, value)[0].text.includes(SECRET), false);
});

test('start_tui requires explicit bounded cwd and terminal dimensions', async () => {
  const state = fixture();
  const first = await state.execute({ operation: 'start_tui', profile: 'tui', cwd: '/work/default' });
  assert.deepEqual(first, { status: 'started', operation: 'start_tui', id: 'runtime-tui', profile: 'tui', hint: TAB_HINT });
  assert.equal(state.calls[1].method, 'openTui');
  const { signal, ...input } = state.calls[1].input;
  assert.equal(signal instanceof AbortSignal, true);
  assert.deepEqual(input, {
    profileId: 'tui', ownerId: OWNER, cwd: '/work/default', cols: 80, rows: 24,
    confirmIndependentHost: true,
  });
  await state.execute({ operation: 'start_tui', profile: 'tui', cwd: '/work/custom', cols: 120, rows: 40 });
  assert.equal(state.calls[3].input.cwd, '/work/custom');
  assert.equal(state.calls[3].input.cols, 120);
  assert.equal(state.calls[3].input.rows, 40);
  assert.equal(JSON.stringify(first).includes(SECRET), false);
});

test('start_tui rejects a missing caller cwd instead of using the profile storage directory', async () => {
  const state = fixture();
  assert.deepEqual(await state.execute({ operation: 'start_tui', profile: 'tui' }), {
    status: 'error', code: 'INVALID_INPUT',
  });
  assert.equal(state.calls.length, 0);
});

test('stop delegates same-owner enforcement to the service and returns only safe codes', async () => {
  const state = fixture();
  assert.deepEqual(await state.execute({ operation: 'stop', id: 'runtime-1' }), {
    status: 'stopped', operation: 'stop', id: 'runtime-1',
  });
  assert.deepEqual(state.calls[0], { method: 'stop', input: { runtimeId: 'runtime-1', ownerId: OWNER } });
  state.service.stop = async () => {
    const error = new Error(`owner mismatch ${SECRET} http://127.0.0.1/?tkn=${SECRET}`);
    error.code = 'RUNTIME_OWNER_MISMATCH';
    error.safe = true;
    error.cause = SECRET;
    throw error;
  };
  const denied = await state.execute({ operation: 'stop', id: 'runtime-1' });
  assert.deepEqual(denied, { status: 'error', code: 'RUNTIME_OWNER_MISMATCH' });
  assert.equal(JSON.stringify(denied).includes(SECRET), false);
  assert.equal(state.definition.output.render({}, denied)[0].text, 'workspace_runtime failed: RUNTIME_OWNER_MISMATCH');
});

test('unknown service failures collapse to a safe generic code', async () => {
  const state = fixture();
  state.service.catalog = async () => { throw new Error(`raw ${SECRET}`); };
  assert.deepEqual(await state.execute({ operation: 'list' }), { status: 'error', code: 'RUNTIME_OPERATION_FAILED' });
});

test('missing agent and model-supplied authority fields fail before business calls', async () => {
  const state = fixture();
  await assert.rejects(state.execute({ operation: 'list' }, null), /workspace_runtime requires an agent Session/u);
  for (const args of [
    { operation: 'list', ownerId: 'other' },
    { operation: 'start_web', profile: 'web', confirmIndependentHost: false },
    { operation: 'start_web', profile: 'web', sandbox_permissions: 'danger-full-access' },
    { operation: 'stop', id: 'runtime-1', ownerId: 'other' },
  ]) {
    assert.deepEqual(await state.execute(args), { status: 'error', code: 'INVALID_INPUT' });
  }
  assert.equal(state.calls.length, 0);
});

test('conditional parameters reject missing, incompatible and out-of-range fields without side effects', async () => {
  const state = fixture();
  const invalid = [
    { operation: 'start_web' },
    { operation: 'start_web', profile: '../current' },
    { operation: 'start_web', profile: 'web', cwd: '/work' },
    { operation: 'start_tui', profile: 'tui', cwd: '/work/default', cols: 0 },
    { operation: 'start_tui', profile: 'tui', cwd: '/work/default', cols: 1001 },
    { operation: 'start_tui', profile: 'tui', cwd: '/work/default', rows: 0 },
    { operation: 'start_tui', profile: 'tui', cwd: '/work/default', rows: 501 },
    { operation: 'start_tui', profile: 'tui', cwd: 'relative' },
    { operation: 'stop' },
    { operation: 'stop', id: 'runtime-1', profile: 'web' },
    { operation: 'list', profile: 'web' },
    { operation: 'unknown' },
  ];
  for (const args of invalid) assert.deepEqual(await state.execute(args), { status: 'error', code: 'INVALID_INPUT' });
  assert.equal(state.calls.length, 0);
});

test('current or unavailable profiles are rejected before opening a runtime', async () => {
  const state = fixture();
  assert.deepEqual(await state.execute({ operation: 'start_web', profile: 'current' }), {
    status: 'error', code: 'CURRENT_PROFILE_USE_LOCAL',
  });
  assert.deepEqual(await state.execute({ operation: 'start_web', profile: 'missing' }), {
    status: 'error', code: 'PROFILE_NOT_FOUND',
  });
  assert.deepEqual(await state.execute({ operation: 'start_tui', profile: 'web', cwd: '/work/default' }), {
    status: 'error', code: 'TUI_NOT_INSTALLED',
  });
  assert.equal(state.calls.filter((call) => call.method !== 'catalog').length, 0);
});

test('malformed start results and unsafe paths never enter the model result', async () => {
  const malformed = fixture({ openWebResult: { runtimeId: '../escape', url: SECRET } });
  assert.deepEqual(await malformed.execute({ operation: 'start_web', profile: 'web' }), {
    status: 'error', code: 'INVALID_RUNTIME_RESULT',
  });
  const state = fixture({ catalogValue: catalog({ defaultCwd: `/${SECRET}\n`, currentProfile: `../${SECRET}` }) });
  const value = await state.execute({ operation: 'list' });
  assert.equal('defaultCwd' in value, false);
  assert.equal('currentProfile' in value, false);
  assert.equal(JSON.stringify(value).includes(SECRET), false);
});

test('real defineTool accepts a complete neutral list shape and start_web defaults', async () => {
  const state = fixture({ defineTool: sdkDefineTool });
  const listed = await state.execute({ operation: 'list', profile: '', cwd: '', id: '', cols: 80, rows: 24 });
  assert.equal(listed.status, 'ok');
  assert.equal(listed.operation, 'list');
  assert.deepEqual(state.calls[0], { method: 'catalog', input: { ownerId: OWNER } });

  const started = await state.execute({ operation: 'start_web', profile: 'web', cwd: '', id: '', cols: 80, rows: 24 });
  assert.deepEqual(started, { status: 'started', operation: 'start_web', id: 'runtime-web', profile: 'web', hint: TAB_HINT });
  assert.equal(state.calls[2].method, 'openWeb');
});

test('real defineTool accepts complete neutral start_tui and stop shapes', async () => {
  const state = fixture({ defineTool: sdkDefineTool });
  const started = await state.execute({ operation: 'start_tui', profile: 'tui', cwd: '/work/default', id: '', cols: 80, rows: 24 });
  assert.deepEqual(started, { status: 'started', operation: 'start_tui', id: 'runtime-tui', profile: 'tui', hint: TAB_HINT });
  assert.equal(state.calls[1].input.cwd, '/work/default');
  assert.equal(state.calls[1].input.cols, 80);
  assert.equal(state.calls[1].input.rows, 24);

  const stopped = await state.execute({ operation: 'stop', profile: '', cwd: '', id: 'runtime-tui', cols: 80, rows: 24 });
  assert.deepEqual(stopped, { status: 'stopped', operation: 'stop', id: 'runtime-tui' });
  assert.deepEqual(state.calls[2], { method: 'stop', input: { runtimeId: 'runtime-tui', ownerId: OWNER } });
});

test('non-default irrelevant dimensions and non-empty authority fields remain invalid with real defineTool', async () => {
  const state = fixture({ defineTool: sdkDefineTool });
  assert.deepEqual(await state.execute({ operation: 'list', profile: '', cwd: '', id: '', cols: 81, rows: 24 }), {
    status: 'error', code: 'INVALID_INPUT',
  });
  assert.deepEqual(await state.execute({ operation: 'start_web', profile: 'web', cwd: '', id: '', cols: 80, rows: 25 }), {
    status: 'error', code: 'INVALID_INPUT',
  });
  assert.deepEqual(await state.execute({ operation: 'stop', profile: '', cwd: '', id: 'runtime-1', cols: 81, rows: 24 }), {
    status: 'error', code: 'INVALID_INPUT',
  });
  assert.deepEqual(await state.execute({ operation: 'list', profile: '', cwd: '', id: '', cols: 80, rows: 24, ownerId: 'other' }), {
    status: 'error', code: 'INVALID_INPUT',
  });
  assert.equal(state.calls.length, 0);
});
