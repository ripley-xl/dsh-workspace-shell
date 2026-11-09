import {
  SshRemoteError,
  abortError,
  operationTimeout,
} from './errors.js';
import { safeMessage } from '../diagnostics.js';

const DEFAULT_EXEC_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_STDOUT = 1024 * 1024;
const DEFAULT_MAX_STDERR = 64 * 1024;

function validateText(value, field, allowEmpty = true) {
  if (typeof value !== 'string' || value.includes('\0') || (!allowEmpty && value.length === 0)) {
    throw new TypeError(`${field} must be ${allowEmpty ? 'a' : 'a non-empty'} string without NUL bytes.`);
  }
}

export function shellQuote(value) {
  validateText(value, 'The command argument');
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function buildRemoteCommand(command, args = []) {
  validateText(command, 'The remote command', false);
  if (!Array.isArray(args)) throw new TypeError('Remote command arguments must be an array.');
  return [command, ...args].map((value) => shellQuote(value)).join(' ');
}

function byteLimit(value, fallback, field) {
  const limit = value ?? fallback;
  if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError(`${field} must be a positive integer.`);
  return limit;
}

function timeoutLimit(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError('The exec timeout must be a positive integer.');
  }
  return value;
}

export async function execRemote(client, request, options = {}) {
  const command = buildRemoteCommand(request.command, request.args);
  const maxStdoutBytes = byteLimit(
    options.maxStdoutBytes ?? request.maxStdoutBytes,
    DEFAULT_MAX_STDOUT,
    'maxStdoutBytes',
  );
  const maxStderrBytes = byteLimit(
    options.maxStderrBytes ?? request.maxStderrBytes,
    DEFAULT_MAX_STDERR,
    'maxStderrBytes',
  );
  const timeoutMs = timeoutLimit(options.timeoutMs ?? request.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS);
  const signal = options.signal ?? request.signal;
  const input = request.input ?? '';
  if (typeof input !== 'string' && !Buffer.isBuffer(input) && !(input instanceof Uint8Array)) {
    throw new TypeError('Remote command input must be a string or byte array.');
  }
  if (signal?.aborted) throw abortError(signal);

  return new Promise((resolve, reject) => {
    let channel;
    let settled = false;
    let exitCode = null;
    let exitSignal;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const stdout = [];
    const stderr = [];

    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) {
        channel?.destroy();
        reject(error);
      } else {
        resolve(result);
      }
    };
    const onAbort = () => finish(abortError(signal));
    const fail = (error) => {
      if (error instanceof SshRemoteError) finish(error);
      else finish(new SshRemoteError('SSH_EXEC_FAILED', 'The remote exec channel failed.', { cause: error }));
    };
    const collect = (target, chunk, kind) => {
      if (settled) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const used = kind === 'stdout' ? stdoutBytes : stderrBytes;
      const limit = kind === 'stdout' ? maxStdoutBytes : maxStderrBytes;
      if (used + bytes.length > limit) {
        finish(new SshRemoteError(
          'SSH_PROTOCOL_ERROR',
          `Remote ${kind} exceeded the ${limit}-byte limit.`,
          { details: { stream: kind, limit } },
        ));
        return;
      }
      if (kind === 'stdout') stdoutBytes += bytes.length;
      else stderrBytes += bytes.length;
      target.push(bytes);
    };
    const timer = setTimeout(() => {
      finish(operationTimeout('The remote command timed out.'));
    }, timeoutMs);
    timer.unref?.();

    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      client.exec(command, (error, execChannel) => {
        if (settled) {
          execChannel?.destroy();
          return;
        }
        if (error) {
          fail(error);
          return;
        }
        try {
          channel = execChannel;
          channel.on('data', (chunk) => collect(stdout, chunk, 'stdout'));
          channel.stderr?.on('data', (chunk) => collect(stderr, chunk, 'stderr'));
          channel.once('error', fail);
          channel.stderr?.once('error', fail);
          channel.once('exit', (code, signalName) => {
            exitCode = code;
            exitSignal = signalName;
          });
          channel.once('close', () => {
            finish(undefined, {
              code: exitCode,
              signal: exitSignal,
              stderr: Buffer.concat(stderr).toString('utf8'),
              stdout: Buffer.concat(stdout).toString('utf8'),
            });
          });
          channel.end(input);
        } catch (error) {
          fail(error);
        }
      });
    } catch (error) {
      fail(error);
    }
  });
}

export async function execJson(client, request, options = {}) {
  if (typeof request.requestId !== 'string' || request.requestId.length === 0) {
    throw new TypeError('requestId must be a non-empty string.');
  }
  if (!['string', 'number'].includes(typeof request.protocolVersion)) {
    throw new TypeError('protocolVersion must be a string or number.');
  }
  if (request.payload !== undefined && (
    request.payload === null || typeof request.payload !== 'object' || Array.isArray(request.payload)
  )) {
    throw new TypeError('The exec JSON payload must be an object.');
  }

  let input;
  try {
    input = `${JSON.stringify({
      ...(request.payload ?? {}),
      protocolVersion: request.protocolVersion,
      requestId: request.requestId,
    })}\n`;
  } catch (error) {
    throw new SshRemoteError('SSH_PROTOCOL_ERROR', 'The exec request is not JSON serializable.', {
      cause: error,
    });
  }

  const result = await execRemote(client, {
    args: request.args,
    command: request.command,
    input,
    maxStderrBytes: request.maxStderrBytes,
    maxStdoutBytes: request.maxStdoutBytes,
    signal: request.signal,
    timeoutMs: request.timeoutMs,
  }, options);
  if (result.code !== 0) {
    throw new SshRemoteError('SSH_EXEC_FAILED', 'The remote controller command did not exit successfully.', {
      details: { exitCode: result.code, exitSignal: result.signal, stderr: safeMessage(result.stderr).slice(-4096) },
    });
  }

  let response;
  try {
    response = JSON.parse(result.stdout);
  } catch (error) {
    throw new SshRemoteError('SSH_PROTOCOL_ERROR', 'The remote controller returned invalid JSON.', {
      cause: error,
    });
  }
  if (response === null || typeof response !== 'object' || Array.isArray(response)) {
    throw new SshRemoteError('SSH_PROTOCOL_ERROR', 'The remote controller response must be a JSON object.');
  }
  if (
    response.protocolVersion !== request.protocolVersion
    || response.requestId !== request.requestId
  ) {
    throw new SshRemoteError('SSH_PROTOCOL_ERROR', 'The remote controller response correlation does not match.', {
      details: {
        expectedProtocolVersion: request.protocolVersion,
        expectedRequestId: request.requestId,
        receivedProtocolVersion: response.protocolVersion,
        receivedRequestId: response.requestId,
      },
    });
  }
  return response;
}
