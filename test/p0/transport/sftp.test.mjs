import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import test from 'node:test';

import { uploadFile } from '../../../packages/shell/ssh-remote/src/host/ssh/sftp.js';

async function directoryFixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sftp-'));
  t.after(() => fs.rm(directory, { force: true, recursive: true }));
  return directory;
}

function sftpFixture(write) {
  const chunks = [];
  let options;
  const session = {
    ended: false,
    createWriteStream(remotePath, streamOptions) {
      options = streamOptions;
      return new Writable({
        highWaterMark: 1024,
        write: write ?? ((chunk, encoding, callback) => {
          chunks.push(Buffer.from(chunk));
          setImmediate(callback);
        }),
      });
    },
    end() {
      this.ended = true;
    },
  };
  return {
    client: { sftp: (callback) => callback(null, session) },
    data: () => Buffer.concat(chunks),
    options: () => options,
    session,
  };
}

test('SFTP upload streams all bytes with backpressure and mode 0600', async (t) => {
  const directory = await directoryFixture(t);
  const localPath = path.join(directory, 'payload.bin');
  const payload = Buffer.alloc(256 * 1024);
  for (let index = 0; index < payload.length; index += 1) payload[index] = index % 251;
  await fs.writeFile(localPath, payload);
  const fixture = sftpFixture();

  const result = await uploadFile(fixture.client, localPath, '/tmp/remote-payload', {
    highWaterMark: 4096,
  });
  assert.equal(result.bytes, payload.length);
  assert.deepEqual(fixture.data(), payload);
  assert.equal(fixture.options().mode, 0o600);
  assert.equal(fixture.session.ended, true);
});

test('SFTP upload cancellation destroys streams and closes the SFTP session', async (t) => {
  const directory = await directoryFixture(t);
  const localPath = path.join(directory, 'payload.bin');
  await fs.writeFile(localPath, Buffer.alloc(128 * 1024, 1));
  let destination;
  let notifyCreated;
  const created = new Promise((resolve) => {
    notifyCreated = resolve;
  });
  const fixture = sftpFixture(() => {});
  const originalCreate = fixture.session.createWriteStream.bind(fixture.session);
  fixture.session.createWriteStream = (...args) => {
    destination = originalCreate(...args);
    notifyCreated();
    return destination;
  };
  const controller = new AbortController();
  const uploading = uploadFile(fixture.client, localPath, '/tmp/remote-payload', {
    signal: controller.signal,
  });
  await created;
  controller.abort();
  await assert.rejects(uploading, { code: 'OPERATION_CANCELLED' });
  assert.equal(destination.destroyed, true);
  assert.equal(fixture.session.ended, true);
});

test('SFTP timeout is based on upload inactivity rather than total duration', async (t) => {
  const directory = await directoryFixture(t);
  const localPath = path.join(directory, 'payload.bin');
  await fs.writeFile(localPath, Buffer.alloc(3, 1));
  const fixture = sftpFixture((chunk, encoding, callback) => { setTimeout(callback, 15); });
  const result = await uploadFile(fixture.client, localPath, '/tmp/out', { timeoutMs: 20, highWaterMark: 1 });
  assert.equal(result.bytes, 3);
});

test('SFTP failures and timeouts have distinct error codes', async (t) => {
  const directory = await directoryFixture(t);
  const missing = sftpFixture();
  await assert.rejects(uploadFile(missing.client, path.join(directory, 'missing'), '/tmp/out'), {
    code: 'SSH_SFTP_FAILED',
  });

  const localPath = path.join(directory, 'payload.bin');
  await fs.writeFile(localPath, Buffer.alloc(128 * 1024));
  const timeout = sftpFixture(() => {});
  await assert.rejects(uploadFile(timeout.client, localPath, '/tmp/out', { timeoutMs: 5 }), {
    code: 'OPERATION_TIMEOUT',
  });
});
