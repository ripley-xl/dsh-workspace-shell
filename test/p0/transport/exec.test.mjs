import assert from 'node:assert/strict';
import { Duplex, PassThrough } from 'node:stream';
import test from 'node:test';

import {
  buildRemoteCommand,
  execJson,
  execRemote,
  shellQuote,
} from '../../../packages/manager/src/host/ssh/exec.js';

function execFixture(onReady) {
  const input = [];
  const channel = new Duplex({
    read() {},
    write(chunk, encoding, callback) {
      input.push(Buffer.from(chunk));
      setImmediate(callback);
    },
  });
  channel.stderr = new PassThrough();
  const client = {
    exec(command, callback) {
      callback(null, channel);
      onReady?.(channel, command);
    },
  };
  return {
    channel,
    client,
    input: () => Buffer.concat(input).toString('utf8'),
  };
}

function finish(channel, { code = 0, stderr = '', stdout } = {}) {
  setImmediate(() => {
    if (stdout !== undefined) channel.emit('data', Buffer.from(stdout));
    if (stderr) channel.stderr.write(stderr);
    channel.emit('exit', code);
    channel.emit('close');
  });
}

const request = {
  command: '/usr/bin/controller',
  args: ['status'],
  payload: { instanceId: 'instance-1' },
  protocolVersion: 1,
  requestId: 'request-1',
};

test('shellQuote keeps command arguments in separate shell words', () => {
  assert.equal(shellQuote(`a'b`), `'a'"'"'b'`);
  assert.equal(buildRemoteCommand('/bin/cat', ['a b', `c'd`]), `'/bin/cat' 'a b' 'c'"'"'d'`);
});

test('execJson sends one correlated JSON request and parses one JSON response', async () => {
  const fixture = execFixture((channel) => {
    channel.on('finish', () => finish(channel, {
      stdout: `${JSON.stringify({ ok: true, protocolVersion: 1, requestId: 'request-1' })}\n`,
    }));
  });
  const response = await execJson(fixture.client, request);
  assert.equal(response.ok, true);
  const sent = JSON.parse(fixture.input());
  assert.deepEqual(sent, {
    instanceId: 'instance-1',
    protocolVersion: 1,
    requestId: 'request-1',
  });
});

test('execJson request metadata cannot be overridden by payload fields', async () => {
  const fixture = execFixture((channel) => {
    channel.on('finish', () => finish(channel, {
      stdout: JSON.stringify({ protocolVersion: 1, requestId: 'request-1' }),
    }));
  });
  await execJson(fixture.client, {
    ...request,
    payload: { protocolVersion: 99, requestId: 'forged' },
  });
  const sent = JSON.parse(fixture.input());
  assert.equal(sent.protocolVersion, 1);
  assert.equal(sent.requestId, 'request-1');
});

for (const [name, stdout] of [
  ['invalid JSON', 'not-json'],
  ['multiple JSON documents', '{"protocolVersion":1,"requestId":"request-1"}\n{}\n'],
  ['a non-object response', '[]'],
]) {
  test(`execJson rejects ${name}`, async () => {
    const fixture = execFixture((channel) => channel.on('finish', () => finish(channel, { stdout })));
    await assert.rejects(execJson(fixture.client, request), { code: 'SSH_PROTOCOL_ERROR' });
  });
}

test('execJson rejects a mismatched response correlation', async () => {
  const fixture = execFixture((channel) => channel.on('finish', () => finish(channel, {
    stdout: JSON.stringify({ protocolVersion: 1, requestId: 'other-request' }),
  })));
  await assert.rejects(execJson(fixture.client, request), { code: 'SSH_PROTOCOL_ERROR' });
});

test('execJson separates non-zero command exits from protocol failures', async () => {
  const fixture = execFixture((channel) => channel.on('finish', () => finish(channel, {
    code: 9,
    stderr: 'diagnostic',
    stdout: '{"protocolVersion":1,"requestId":"request-1"}',
  })));
  await assert.rejects(execJson(fixture.client, request), (error) => {
    assert.equal(error.code, 'SSH_EXEC_FAILED');
    assert.equal(error.details.exitCode, 9);
    assert.equal(error.details.stderr, 'diagnostic');
    return true;
  });
});

test('execRemote enforces stdout and stderr byte limits', async () => {
  const stdoutFixture = execFixture((channel) => channel.on('finish', () => finish(channel, {
    stdout: '12345',
  })));
  await assert.rejects(execRemote(stdoutFixture.client, {
    command: '/bin/cat',
    maxStdoutBytes: 4,
  }), { code: 'SSH_PROTOCOL_ERROR' });
  assert.equal(stdoutFixture.channel.destroyed, true);

  const stderrFixture = execFixture((channel) => channel.on('finish', () => finish(channel, {
    stderr: '12345',
    stdout: '',
  })));
  await assert.rejects(execRemote(stderrFixture.client, {
    command: '/bin/cat',
    maxStderrBytes: 4,
  }), { code: 'SSH_PROTOCOL_ERROR' });
});

test('execRemote handles cancellation, timeout and backpressured stdin', async () => {
  const cancellation = execFixture();
  const controller = new AbortController();
  const running = execRemote(cancellation.client, { command: '/bin/cat' }, {
    signal: controller.signal,
  });
  controller.abort();
  await assert.rejects(running, { code: 'OPERATION_CANCELLED' });
  assert.equal(cancellation.channel.destroyed, true);

  const timeout = execFixture();
  await assert.rejects(execRemote(timeout.client, { command: '/bin/cat' }, { timeoutMs: 5 }), {
    code: 'OPERATION_TIMEOUT',
  });

  const largeInput = Buffer.alloc(1024 * 1024, 42);
  const upload = execFixture((channel) => channel.on('finish', () => finish(channel, { stdout: 'ok' })));
  const result = await execRemote(upload.client, { command: '/bin/cat', input: largeInput });
  assert.equal(result.stdout, 'ok');
  assert.equal(Buffer.byteLength(upload.input()), largeInput.length);
});
