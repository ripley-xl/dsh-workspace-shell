import { spawn } from 'node:child_process';
import { Duplex } from 'node:stream';

import {
  SshRemoteError,
  abortError,
  operationTimeout,
} from './errors.js';

const DEFAULT_PROXY_TIMEOUT_MS = 10_000;

function proxyError(message, cause) {
  return new SshRemoteError('SSH_PROXY_FAILED', message, { cause });
}

function timeoutValue(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError('The proxy timeout must be a positive integer.');
  }
  return value;
}

export async function openProxyCommandTransport(config, options = {}) {
  const argv = config.proxyCommand;
  if (!Array.isArray(argv) || argv.length === 0 || argv.some((word) => typeof word !== 'string')) {
    throw new SshRemoteError('SSH_CONFIG_INVALID', 'ProxyCommand must contain a valid argv array.');
  }
  const signal = options.signal;
  if (signal?.aborted) throw abortError(signal);
  const timeoutMs = timeoutValue(options.proxyTimeoutMs ?? DEFAULT_PROXY_TIMEOUT_MS);
  const child = (options.spawn ?? spawn)(argv[0], argv.slice(1), {
    cwd: options.cwd,
    env: options.env ?? process.env,
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.stderr.resume();
  const stream = Duplex.from({ readable: child.stdout, writable: child.stdin });
  const transport = {
    error: undefined,
    stream,
    close: undefined,
  };
  let exited = false;
  let closePromise;
  let resolveExit;
  const exitPromise = new Promise((resolve) => {
    resolveExit = resolve;
  });

  const close = () => {
    if (closePromise) return closePromise;
    transport.closed = true;
    stream.destroy();
    child.stderr.destroy();
    if (!exited) child.kill('SIGTERM');
    const forcedKillTimer = setTimeout(() => {
      if (!exited) child.kill('SIGKILL');
    }, 500);
    forcedKillTimer.unref?.();
    let exitTimeout;
    closePromise = Promise.race([
      exitPromise,
      new Promise((resolve) => {
        exitTimeout = setTimeout(resolve, 1000);
      }),
    ]).finally(() => {
      clearTimeout(forcedKillTimer);
      clearTimeout(exitTimeout);
    });
    return closePromise;
  };
  transport.close = close;

  child.on('error', (error) => {
    transport.error = proxyError('The ProxyCommand process failed.', error);
    stream.destroy();
  });
  child.once('exit', () => {
    exited = true;
    if (!transport.closed && !transport.error) {
      transport.error = proxyError('The ProxyCommand process exited before the SSH connection closed.');
    }
    stream.destroy();
    resolveExit();
  });
  stream.on('error', (error) => {
    if (!transport.closed) transport.error = proxyError('The ProxyCommand byte stream failed.', error);
  });

  try {
    await new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        child.off('spawn', onSpawn);
        child.off('error', onError);
      };
      const onSpawn = () => {
        cleanup();
        resolve();
      };
      const onError = (error) => {
        cleanup();
        reject(proxyError('The ProxyCommand process could not start.', error));
      };
      const onAbort = () => {
        cleanup();
        reject(abortError(signal));
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(operationTimeout('The ProxyCommand process did not start in time.'));
      }, timeoutMs);
      timer.unref?.();
      child.once('spawn', onSpawn);
      child.once('error', onError);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
    return transport;
  } catch (error) {
    await close();
    throw error;
  }
}

export async function openProxyJumpTransport(client, config, options = {}) {
  const signal = options.signal;
  if (signal?.aborted) throw abortError(signal);
  const timeoutMs = timeoutValue(options.proxyTimeoutMs ?? DEFAULT_PROXY_TIMEOUT_MS);
  const transport = {
    error: undefined,
    stream: undefined,
    close: async () => {
      transport.closed = true;
      transport.stream?.destroy();
    },
  };

  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const finish = (error, stream) => {
      if (settled) {
        stream?.destroy();
        return;
      }
      settled = true;
      cleanup();
      if (error) {
        reject(error instanceof SshRemoteError
          ? error
          : proxyError('The ProxyJump direct-tcpip channel could not be opened.', error));
        return;
      }
      transport.stream = stream;
      stream.on('error', (streamError) => {
        if (!transport.closed) {
          transport.error = proxyError('The ProxyJump byte stream failed.', streamError);
        }
      });
      resolve(transport);
    };
    const onAbort = () => finish(abortError(signal));
    const timer = setTimeout(() => {
      finish(operationTimeout('The ProxyJump direct-tcpip channel timed out.'));
    }, timeoutMs);
    timer.unref?.();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      client.forwardOut('127.0.0.1', 0, config.hostname, config.port, finish);
    } catch (error) {
      finish(error);
    }
  });
}
