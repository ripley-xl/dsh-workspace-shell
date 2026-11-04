export class SshRemoteError extends Error {
  constructor(code, message, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'SshRemoteError';
    this.code = code;
    if (options.details !== undefined) this.details = options.details;
  }
}

export function operationCancelled(cause) {
  return new SshRemoteError('OPERATION_CANCELLED', 'The SSH operation was cancelled.', { cause });
}

export function operationTimeout(message, cause) {
  return new SshRemoteError('OPERATION_TIMEOUT', message, { cause });
}

export function abortError(signal) {
  return operationCancelled(signal?.reason);
}

export function isAbortError(error, signal) {
  return Boolean(
    signal?.aborted
    || error?.name === 'AbortError'
    || error?.code === 'ABORT_ERR',
  );
}

export function asSshRemoteError(error, code, message, details) {
  if (error instanceof SshRemoteError) return error;
  return new SshRemoteError(code, message, { cause: error, details });
}
