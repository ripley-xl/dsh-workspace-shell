import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { attachInstance, heartbeatInstance, instanceStatus, listInstances, readInstanceLogs, releaseInstance, startInstance, stopInstance, uninstallRuntime } from "./instances.js";
import { CONTROLLER_VERSION, PROTOCOL_VERSION } from "./constants.js";
import { asRemoteError, invalidArgument } from "./errors.js";
import { installRuntime } from "./install.js";
import { probeRuntime } from "./platform.js";
import { listWebProfiles } from "./profiles.js";
import { bounded, positiveInteger, redactSecrets, requireId, requireProfileId, requireVersion, resolveRoot } from "./util.js";

const COMMON_OPTIONS = {
  "request-id": { type: "string" },
  root: { type: "string" },
  "timeout-ms": { type: "string" },
  verbose: { type: "boolean" }
};

// Every instance lookup is scoped to one profile; the DSH default is `web`.
const PROFILE_OPTION = { profile: { type: "string" } };

const COMMANDS = {
  probe: {},
  profiles: {
    "dsh-home": { type: "string" }
  },
  install: {
    package: { type: "string" },
    sha256: { type: "string" },
    "expected-version": { type: "string" },
    "lock-timeout-ms": { type: "string" }
  },
  list: {
    ...PROFILE_OPTION,
    "expected-version": { type: "string" },
    "expected-build-id": { type: "string" }
  },
  start: {
    ...PROFILE_OPTION,
    version: { type: "string" },
    "expected-build-id": { type: "string" },
    workspace: { type: "string" },
    patch: { type: "string" },
    "idle-timeout-ms": { type: "string" },
    "lease-ttl-ms": { type: "string" },
    "start-timeout-ms": { type: "string" }
  },
  attach: {
    ...PROFILE_OPTION,
    "instance-id": { type: "string" },
    "expected-version": { type: "string" },
    "expected-build-id": { type: "string" },
    "client-lease-id": { type: "string" }
  },
  heartbeat: {
    "instance-id": { type: "string" },
    "client-lease-id": { type: "string" }
  },
  release: {
    "instance-id": { type: "string" },
    "client-lease-id": { type: "string" }
  },
  status: { ...PROFILE_OPTION, "instance-id": { type: "string" } },
  stop: {
    "instance-id": { type: "string" },
    "stop-timeout-ms": { type: "string" }
  },
  logs: {
    "instance-id": { type: "string" },
    stream: { type: "string" },
    offset: { type: "string" },
    limit: { type: "string" }
  },
  uninstall: { version: { type: "string" } }
};

function required(value, name) {
  if (!value) throw invalidArgument(`${name} is required.`);
  return value;
}

function numberOption(value, name, limits) {
  return value === undefined ? undefined : positiveInteger(value, name, limits);
}

async function dispatch(command, values, root, signal) {
  switch (command) {
    case "probe":
      return probeRuntime(root);
    case "profiles":
      return listWebProfiles({ dshHome: values["dsh-home"] });
    case "install":
      return installRuntime({
        root,
        signal,
        packagePath: required(values.package, "--package"),
        sha256: required(values.sha256, "--sha256"),
        expectedVersion: values["expected-version"],
        lockTimeoutMs: numberOption(values["lock-timeout-ms"], "lockTimeoutMs", { min: 1, max: 600_000 })
      });
    case "list":
      return listInstances({
        root,
        signal,
        profileId: values.profile,
        expectedVersion: values["expected-version"],
        expectedBuildId: values["expected-build-id"]
      });
    case "start":
      return startInstance({
        root,
        signal,
        profileId: values.profile,
        version: requireVersion(required(values.version, "--version")),
        expectedBuildId: values["expected-build-id"],
        workspace: values.workspace,
        patch: values.patch,
        idleTimeoutMs: numberOption(values["idle-timeout-ms"], "idleTimeoutMs", { min: 100, max: 24 * 60 * 60_000 }),
        leaseTtlMs: numberOption(values["lease-ttl-ms"], "leaseTtlMs", { min: 100, max: 10 * 60_000 }),
        startTimeoutMs: numberOption(values["start-timeout-ms"], "startTimeoutMs", { min: 100, max: 120_000 })
      });
    case "attach":
      return attachInstance({
        root,
        signal,
        profileId: values.profile,
        instanceId: requireId(required(values["instance-id"], "--instance-id"), "instanceId"),
        expectedVersion: values["expected-version"],
        expectedBuildId: values["expected-build-id"],
        clientLeaseId: values["client-lease-id"]
      });
    case "heartbeat":
      return heartbeatInstance({
        root,
        signal,
        instanceId: requireId(required(values["instance-id"], "--instance-id"), "instanceId"),
        clientLeaseId: requireId(required(values["client-lease-id"], "--client-lease-id"), "clientLeaseId")
      });
    case "release":
      return releaseInstance({
        root,
        signal,
        instanceId: requireId(required(values["instance-id"], "--instance-id"), "instanceId"),
        clientLeaseId: requireId(required(values["client-lease-id"], "--client-lease-id"), "clientLeaseId")
      });
    case "status":
      return instanceStatus({
        root,
        signal,
        profileId: values.profile,
        instanceId: requireId(required(values["instance-id"], "--instance-id"), "instanceId")
      });
    case "stop":
      return stopInstance({
        root,
        signal,
        instanceId: requireId(required(values["instance-id"], "--instance-id"), "instanceId"),
        stopTimeoutMs: numberOption(values["stop-timeout-ms"], "stopTimeoutMs", { min: 100, max: 120_000 })
      });
    case "logs":
      return readInstanceLogs({
        root,
        instanceId: requireId(required(values["instance-id"], "--instance-id"), "instanceId"),
        stream: values.stream,
        offset: values.offset,
        limit: values.limit
      });
    case "uninstall":
      return uninstallRuntime({ root, signal, version: requireVersion(required(values.version, "--version")) });
    default:
      throw invalidArgument(`Unknown command ${JSON.stringify(command)}.`);
  }
}

export async function runCli(argv = process.argv.slice(2), io = {}) {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  let requestId = randomUUID();
  let command = "unknown";
  let verbose = false;
  let response;
  try {
    command = required(argv[0], "command");
    if (!Object.hasOwn(COMMANDS, command)) throw invalidArgument(`Unknown command ${JSON.stringify(command)}.`);
    const { values, positionals } = parseArgs({
      args: argv.slice(1),
      strict: true,
      allowPositionals: true,
      options: { ...COMMON_OPTIONS, ...COMMANDS[command] }
    });
    if (positionals.length) throw invalidArgument(`Unexpected positional argument ${JSON.stringify(positionals[0])}.`);
    if (values["request-id"] !== undefined) {
      if (values["request-id"].length < 1 || values["request-id"].length > 128) throw invalidArgument("requestId must contain 1 through 128 characters.");
      requestId = values["request-id"];
    }
    verbose = values.verbose ?? false;
    const root = resolveRoot(values.root);
    const timeoutMs = numberOption(values["timeout-ms"], "timeoutMs", { min: 1, max: 600_000 }) ?? (command === "install" ? 180_000 : 45_000);
    const controller = new AbortController();
    const cancel = () => controller.abort(new DOMException("The operation was cancelled by a signal.", "AbortError"));
    process.once("SIGINT", cancel);
    process.once("SIGTERM", cancel);
    try {
      const result = await bounded((signal) => dispatch(command, values, root, signal), timeoutMs, controller.signal);
      response = { protocolVersion: PROTOCOL_VERSION, controllerVersion: CONTROLLER_VERSION, requestId, ok: true, command, result };
    } finally {
      process.removeListener("SIGINT", cancel);
      process.removeListener("SIGTERM", cancel);
    }
  } catch (rawError) {
    const error = asRemoteError(rawError, command === "install" ? "REMOTE_INSTALL_FAILED" : "REMOTE_OPERATION_FAILED");
    response = {
      protocolVersion: PROTOCOL_VERSION,
      controllerVersion: CONTROLLER_VERSION,
      requestId,
      ok: false,
      command,
      error: {
        code: error.code,
        message: redactSecrets(error.message),
        retryable: error.retryable,
        ...(error.details ? { details: JSON.parse(redactSecrets(JSON.stringify(error.details))) } : {})
      }
    };
    stderr.write(`${redactSecrets(error.message)}\n`);
    if (verbose && error.stack) {
      stderr.write(`${redactSecrets(error.stack)}\n`);
      let cause = error.cause;
      while (cause) {
        stderr.write(`Caused by: ${redactSecrets(cause.stack ?? cause)}\n`);
        cause = cause.cause;
      }
    }
    process.exitCode = error.exitCode;
  }
  stdout.write(`${JSON.stringify(response)}\n`);
  return response;
}

if (import.meta.main) await runCli();
