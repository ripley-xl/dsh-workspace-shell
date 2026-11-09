import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream';

import {
  SshRemoteError,
  abortError,
  operationTimeout,
} from './errors.js';

const DEFAULT_UPLOAD_TIMEOUT_MS = 60_000;

export async function uploadFile(client, localPath, remotePath, options = {}) {
  if (typeof remotePath !== 'string' || remotePath.length === 0 || remotePath.includes('\0')) {
    throw new TypeError('The SFTP destination must be a non-empty path without NUL bytes.');
  }
  const signal = options.signal;
  if (signal?.aborted) throw abortError(signal);
  const timeoutMs = options.timeoutMs ?? DEFAULT_UPLOAD_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new TypeError('The SFTP timeout must be a positive integer.');
  }

  return new Promise((resolve, reject) => {
    let sftp;
    let source;
    let destination;
    let settled = false;
    let bytes = 0;

    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const finish = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) {
        source?.destroy();
        destination?.destroy();
      }
      if (sftp) sftp.end();
      if (error) reject(error);
      else resolve({ bytes, remotePath });
    };
    const fail = (error) => {
      if (error instanceof SshRemoteError) finish(error);
      else finish(new SshRemoteError('SSH_SFTP_FAILED', 'The SFTP upload failed.', { cause: error }));
    };
    const onAbort = () => finish(abortError(signal));
    let timer;
    const armTimeout = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        finish(operationTimeout('The SFTP upload timed out.'));
      }, timeoutMs);
      timer.unref?.();
    };
    armTimeout();

    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      client.sftp((error, session) => {
        if (settled) {
          session?.end();
          return;
        }
        if (error) {
          fail(error);
          return;
        }
        try {
          sftp = session;
          source = createReadStream(localPath, {
            highWaterMark: options.highWaterMark ?? 64 * 1024,
          });
          source.on('data', (chunk) => {
            bytes += chunk.length;
            armTimeout();
          });
          destination = sftp.createWriteStream(remotePath, {
            flags: options.flags ?? 'w',
            highWaterMark: options.highWaterMark ?? 64 * 1024,
            mode: options.mode ?? 0o600,
          });
          const write = destination.write.bind(destination);
          destination.write = (chunk, encoding, callback) => {
            if (typeof callback !== 'function') { callback = encoding; encoding = undefined; }
            if (typeof callback !== 'function') return write(chunk, encoding, armTimeout);
            return write(chunk, encoding, (...args) => {
              armTimeout();
              callback(...args);
            });
          };
          pipeline(source, destination, (pipelineError) => {
            if (pipelineError) fail(pipelineError);
            else finish();
          });
        } catch (error) {
          fail(error);
        }
      });
    } catch (error) {
      fail(error);
    }
  });
}
