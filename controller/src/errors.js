export class RemoteError extends Error {
  constructor(code, message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = "RemoteError";
    this.code = code;
    this.exitCode = options.exitCode ?? 1;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }
}

export function asRemoteError(error, fallbackCode = "REMOTE_OPERATION_FAILED") {
  if (error instanceof RemoteError) return error;
  if (error?.name === "AbortError") {
    return new RemoteError("OPERATION_CANCELLED", "The operation was cancelled.", { cause: error });
  }
  if (error?.code === "ETIMEDOUT") {
    return new RemoteError("OPERATION_TIMEOUT", "The operation timed out.", { cause: error, retryable: true });
  }
  return new RemoteError(fallbackCode, error instanceof Error ? error.message : String(error), { cause: error });
}

export function invalidArgument(message) {
  return new RemoteError("INVALID_ARGUMENT", message, { exitCode: 2 });
}
