import { randomUUID } from "node:crypto";
import { open, readdir, rm, stat } from "node:fs/promises";
import { resolve, isAbsolute, sep } from "node:path";
import net from "node:net";
import {
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_LEASE_TTL_MS,
  DEFAULT_PROFILE_ID,
  DEFAULT_START_TIMEOUT_MS,
  DEFAULT_STOP_TIMEOUT_MS,
  MAX_LOG_PAGE_BYTES,
  PROTOCOL_VERSION,
  REGISTRY_SCHEMA_VERSION
} from "./constants.js";
import { RemoteError, invalidArgument } from "./errors.js";
import { readInstalledRuntime } from "./install.js";
import { withLock } from "./locks.js";
import { currentTarget, runtimeId } from "./platform.js";
import { pidAlive, spawnDetached } from "./process.js";
import {
  atomicWriteJson,
  ensureControllerDirectories,
  ensureDirectory,
  isProfileId,
  pathExists,
  positiveInteger,
  readJson,
  redactSecrets,
  requireId,
  requireProfileId,
  requireVersion,
  sleep
} from "./util.js";

function validDate(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

export function instanceProfileId(record) {
  return record?.profileId === undefined ? DEFAULT_PROFILE_ID : record.profileId;
}

export function profileMismatch(expected, actual) {
  return new RemoteError(
    "REMOTE_PROFILE_MISMATCH",
    `The instance belongs to profile ${JSON.stringify(actual)}, not ${JSON.stringify(expected)}.`
  );
}

export function validateInstanceRecord(record) {
  if (!record || typeof record !== "object" || record.schemaVersion !== REGISTRY_SCHEMA_VERSION) {
    throw new RemoteError("REMOTE_STATE_INVALID", "Instance registry schema is invalid.");
  }
  requireId(record.instanceId, "instanceId");
  if (record.protocolVersion !== PROTOCOL_VERSION || !["starting", "running", "stopping", "stopped"].includes(record.state)) {
    throw new RemoteError("REMOTE_STATE_INVALID", "Instance protocol or state is invalid.");
  }
  if (!isProfileId(instanceProfileId(record))) {
    throw new RemoteError("REMOTE_STATE_INVALID", "Instance profile ID is invalid.");
  }
  requireVersion(record.dshVersion, "dshVersion");
  if (typeof record.buildId !== "string" || !record.buildId || typeof record.createdBy !== "string" || !record.createdBy) {
    throw new RemoteError("REMOTE_STATE_INVALID", "Instance build or creator identity is invalid.");
  }
  if (!Number.isSafeInteger(record.supervisorPid) || record.supervisorPid <= 0) {
    throw new RemoteError("REMOTE_STATE_INVALID", "Instance supervisor PID is invalid.");
  }
  if (record.hostPid !== null && (!Number.isSafeInteger(record.hostPid) || record.hostPid <= 0)) {
    throw new RemoteError("REMOTE_STATE_INVALID", "Instance host PID is invalid.");
  }
  if (record.endpoint !== null) {
    if (record.endpoint?.host !== "127.0.0.1" || !Number.isSafeInteger(record.endpoint.port) || record.endpoint.port < 1 || record.endpoint.port > 65535) {
      throw new RemoteError("REMOTE_STATE_INVALID", "Instance endpoint is not a valid loopback endpoint.");
    }
  }
  if (record.authenticatedUrl !== null) {
    let url;
    try {
      url = new URL(record.authenticatedUrl);
    } catch {
      throw new RemoteError("REMOTE_STATE_INVALID", "Instance authenticated URL is invalid.");
    }
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password) {
      throw new RemoteError("REMOTE_STATE_INVALID", "Instance authenticated URL is not loopback HTTP.");
    }
  }
  if (typeof record.workspace !== "string" || !record.workspace.startsWith("/") || !validDate(record.startedAt)) {
    throw new RemoteError("REMOTE_STATE_INVALID", "Instance workspace or start time is invalid.");
  }
  positiveInteger(record.idleTimeoutMs, "idleTimeoutMs", { min: 100, max: 24 * 60 * 60_000 });
  positiveInteger(record.leaseTtlMs, "leaseTtlMs", { min: 100, max: 10 * 60_000 });
  if (record.lastAttachAt !== null && !validDate(record.lastAttachAt)) {
    throw new RemoteError("REMOTE_STATE_INVALID", "Instance attach time is invalid.");
  }
  return record;
}

export function sanitizeInstance(record) {
  return {
    schemaVersion: record.schemaVersion,
    instanceId: record.instanceId,
    profileId: instanceProfileId(record),
    hostPid: record.hostPid,
    supervisorPid: record.supervisorPid,
    protocolVersion: record.protocolVersion,
    dshVersion: record.dshVersion,
    buildId: record.buildId,
    endpoint: record.endpoint,
    workspace: record.workspace,
    startedAt: record.startedAt,
    createdBy: record.createdBy,
    idleTimeoutMs: record.idleTimeoutMs,
    leaseTtlMs: record.leaseTtlMs,
    lastAttachAt: record.lastAttachAt,
    state: record.state,
    exitCode: record.exitCode,
    endedAt: record.endedAt
  };
}

function instanceDirectory(root, instanceId) {
  requireId(instanceId, "instanceId");
  return resolve(root, "instances", instanceId);
}

export function instanceRecordPath(root, instanceId) {
  return resolve(instanceDirectory(root, instanceId), "record.json");
}

export function leasePath(root, instanceId) {
  return resolve(instanceDirectory(root, instanceId), "leases.json");
}

export async function readInstance(root, instanceId) {
  return validateInstanceRecord(await readJson(instanceRecordPath(root, instanceId)));
}

export async function writeInstance(root, record) {
  validateInstanceRecord(record);
  const normalized = { ...record, profileId: instanceProfileId(record) };
  await atomicWriteJson(instanceRecordPath(root, record.instanceId), normalized);
  return normalized;
}

export async function readLeases(root, instanceId) {
  const value = await readJson(leasePath(root, instanceId), { optional: true });
  if (value === undefined) return { schemaVersion: 1, instanceId, leases: {} };
  if (!value || value.schemaVersion !== 1 || value.instanceId !== instanceId || !value.leases || typeof value.leases !== "object" || Array.isArray(value.leases)) {
    throw new RemoteError("REMOTE_STATE_INVALID", "Client lease state is invalid.");
  }
  for (const [id, lease] of Object.entries(value.leases)) {
    requireId(id, "clientLeaseId");
    if (lease.clientLeaseId !== id || !validDate(lease.createdAt) || !validDate(lease.lastHeartbeatAt) || !validDate(lease.expiresAt)) {
      throw new RemoteError("REMOTE_STATE_INVALID", "Client lease entry is invalid.");
    }
  }
  return value;
}

export function activeLeases(state, now = Date.now()) {
  return Object.values(state.leases).filter((lease) => Date.parse(lease.expiresAt) > now);
}

async function probePort(endpoint, timeoutMs = 1_000, signal) {
  if (!endpoint) return false;
  return new Promise((resolveProbe) => {
    const socket = net.createConnection({ host: endpoint.host, port: endpoint.port });
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      signal?.removeEventListener("abort", abort);
      resolveProbe(value);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    const abort = () => finish(false);
    signal?.addEventListener("abort", abort, { once: true });
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

export async function instanceHealth(record, options = {}) {
  const hostAlive = pidAlive(record.hostPid);
  const supervisorAlive = pidAlive(record.supervisorPid);
  const reachable = record.state === "running" && hostAlive && supervisorAlive
    ? await probePort(record.endpoint, options.timeoutMs, options.signal)
    : false;
  return {
    healthy: record.state === "running" && hostAlive && supervisorAlive && reachable,
    hostAlive,
    supervisorAlive,
    reachable,
    state: record.state
  };
}

async function statusFor(root, record, signal) {
  const [health, leases] = await Promise.all([instanceHealth(record, { signal }), readLeases(root, record.instanceId)]);
  const clientCount = activeLeases(leases).length;
  return { instance: sanitizeInstance(record), health, clientCount, active: health.healthy };
}

export async function listInstances(options) {
  const expectedProfileId = requireProfileId(options.profileId ?? DEFAULT_PROFILE_ID);
  const paths = await ensureControllerDirectories(options.root);
  const entries = await readdir(paths.instances, { withFileTypes: true });
  const records = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[a-f0-9-]{36}$/iu.test(entry.name)) continue;
    const record = await readInstance(options.root, entry.name);
    if (instanceProfileId(record) !== expectedProfileId) continue;
    if (options.expectedVersion && record.dshVersion !== options.expectedVersion) continue;
    if (options.expectedBuildId && record.buildId !== options.expectedBuildId) continue;
    records.push(await statusFor(options.root, record, options.signal));
  }
  records.sort((a, b) => b.instance.startedAt.localeCompare(a.instance.startedAt));
  return { instances: records };
}

export async function instanceStatus(options) {
  const expectedProfileId = requireProfileId(options.profileId ?? DEFAULT_PROFILE_ID);
  const record = await readInstance(options.root, options.instanceId);
  if (instanceProfileId(record) !== expectedProfileId) {
    throw profileMismatch(expectedProfileId, instanceProfileId(record));
  }
  return statusFor(options.root, record, options.signal);
}

async function requireHealthy(root, instanceId, signal) {
  return requireHealthyRecord(await readInstance(root, instanceId), signal);
}

async function requireHealthyRecord(record, signal) {
  const health = await instanceHealth(record, { signal });
  if (!health.healthy) {
    throw new RemoteError("REMOTE_INSTANCE_UNAVAILABLE", `Instance ${record.instanceId} is not healthy.`, { details: { health } });
  }
  return record;
}

export async function attachInstance(options) {
  const expectedProfileId = requireProfileId(options.profileId ?? DEFAULT_PROFILE_ID);
  const paths = await ensureControllerDirectories(options.root);
  return withLock(paths.locks, `instance-${options.instanceId}`, async () => {
    let record = await readInstance(options.root, options.instanceId);
    if (instanceProfileId(record) !== expectedProfileId) {
      throw profileMismatch(expectedProfileId, instanceProfileId(record));
    }
    record = await requireHealthyRecord(record, options.signal);
    if (options.expectedVersion && record.dshVersion !== options.expectedVersion) {
      throw new RemoteError("REMOTE_VERSION_MISMATCH", "The instance DSH version does not match the local version.");
    }
    if (options.expectedBuildId && record.buildId !== options.expectedBuildId) {
      throw new RemoteError("REMOTE_VERSION_MISMATCH", "The instance build does not match the local build.");
    }
    const now = new Date();
    const clientLeaseId = options.clientLeaseId ? requireId(options.clientLeaseId, "clientLeaseId") : randomUUID();
    const leases = await readLeases(options.root, record.instanceId);
    for (const [id, lease] of Object.entries(leases.leases)) {
      if (Date.parse(lease.expiresAt) <= now.getTime()) delete leases.leases[id];
    }
    const previous = leases.leases[clientLeaseId];
    leases.leases[clientLeaseId] = {
      clientLeaseId,
      createdAt: previous?.createdAt ?? now.toISOString(),
      lastHeartbeatAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + record.leaseTtlMs).toISOString()
    };
    await atomicWriteJson(leasePath(options.root, record.instanceId), leases);
    record = { ...record, lastAttachAt: now.toISOString() };
    await writeInstance(options.root, record);
    return {
      instance: sanitizeInstance(record),
      authenticatedUrl: record.authenticatedUrl,
      clientLeaseId,
      expiresAt: leases.leases[clientLeaseId].expiresAt
    };
  }, { signal: options.signal });
}

export async function heartbeatInstance(options) {
  const paths = await ensureControllerDirectories(options.root);
  return withLock(paths.locks, `instance-${options.instanceId}`, async () => {
    let record = await requireHealthy(options.root, options.instanceId, options.signal);
    const leases = await readLeases(options.root, record.instanceId);
    const lease = leases.leases[options.clientLeaseId];
    if (!lease || Date.parse(lease.expiresAt) <= Date.now()) {
      throw new RemoteError("REMOTE_LEASE_INVALID", "The client lease is absent or expired; attach again.");
    }
    const now = new Date();
    lease.lastHeartbeatAt = now.toISOString();
    lease.expiresAt = new Date(now.getTime() + record.leaseTtlMs).toISOString();
    await atomicWriteJson(leasePath(options.root, record.instanceId), leases);
    record = { ...record, lastAttachAt: now.toISOString() };
    await writeInstance(options.root, record);
    const health = await instanceHealth(record, { signal: options.signal });
    return { instanceId: record.instanceId, clientLeaseId: lease.clientLeaseId, expiresAt: lease.expiresAt, health, clientCount: activeLeases(leases).length };
  }, { signal: options.signal });
}

export async function releaseInstance(options) {
  const paths = await ensureControllerDirectories(options.root);
  return withLock(paths.locks, `instance-${options.instanceId}`, async () => {
    const record = await readInstance(options.root, options.instanceId);
    const leases = await readLeases(options.root, record.instanceId);
    const released = Object.hasOwn(leases.leases, options.clientLeaseId);
    delete leases.leases[options.clientLeaseId];
    await atomicWriteJson(leasePath(options.root, record.instanceId), leases);
    return { instanceId: record.instanceId, released, clientCount: activeLeases(leases).length };
  }, { signal: options.signal });
}

export async function startInstance(options) {
  requireVersion(options.version);
  const profileId = requireProfileId(options.profileId ?? DEFAULT_PROFILE_ID);
  const target = await currentTarget();
  const id = runtimeId(options.version, target);
  const paths = await ensureControllerDirectories(options.root);
  return withLock(paths.locks, `install-${id}`, async () => {
    const { path: runtimeRoot, manifest } = await readInstalledRuntime(options.root, id);
    if (options.expectedBuildId && manifest.buildId !== options.expectedBuildId) {
      throw new RemoteError("REMOTE_VERSION_MISMATCH", "Installed runtime build does not match the local build.");
    }
    const workspace = resolve(options.workspace ?? process.env.HOME ?? "/");
    if (!(await stat(workspace)).isDirectory()) throw invalidArgument("workspace must be an existing directory.");
    const patch = options.patch === undefined ? undefined : options.patch;
    if (patch !== undefined && (!isAbsolute(patch) || !(await stat(patch)).isFile())) {
      throw invalidArgument("patch must be an absolute path to an existing file.");
    }
    const instanceId = randomUUID();
    const logPath = resolve(paths.logs, `${instanceId}.supervisor.log`);
    const log = await open(logPath, "a", 0o600);
    let child;
    let spawnError;
    try {
      child = spawnDetached(resolve(runtimeRoot, "bin", "node"), [resolve(runtimeRoot, "controller", "src", "supervisor.js"),
        "--root", options.root,
        "--runtime-root", runtimeRoot,
        "--instance-id", instanceId,
        "--workspace", workspace,
        "--profile", profileId,
        "--idle-timeout-ms", String(options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS),
        "--lease-ttl-ms", String(options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS),
        "--start-timeout-ms", String(options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS),
        ...(patch ? ["--patch", patch] : [])
      ], {
        cwd: workspace,
        env: process.env,
        stdout: log.fd,
        stderr: log.fd
      });
      child.once("error", (error) => { spawnError = error; });
    } finally {
      await log.close();
    }
    const timeoutMs = options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;
    const deadline = Date.now() + timeoutMs;
    try {
      while (Date.now() < deadline) {
        if (spawnError) throw new RemoteError("REMOTE_INSTANCE_UNAVAILABLE", "Could not spawn the instance supervisor.", { cause: spawnError });
        const record = await readJson(instanceRecordPath(options.root, instanceId), { optional: true });
        if (record?.state === "running") {
          const valid = validateInstanceRecord(record);
          const health = await instanceHealth(valid, { signal: options.signal });
          if (health.healthy) return { instance: sanitizeInstance(valid), health };
        }
        if (record?.state === "stopped") {
          throw new RemoteError("REMOTE_INSTANCE_UNAVAILABLE", `The instance exited during startup with code ${String(record.exitCode)}.`);
        }
        await sleep(100, options.signal);
      }
      throw new RemoteError("OPERATION_TIMEOUT", `Instance did not become ready within ${timeoutMs} ms.`, { retryable: true });
    } catch (error) {
      const record = await readJson(instanceRecordPath(options.root, instanceId), { optional: true }).catch(() => undefined);
      const leases = record ? await readLeases(options.root, instanceId).catch(() => ({ leases: {} })) : { leases: {} };
      if (record && activeLeases(leases).length === 0 && pidAlive(record.supervisorPid)) {
        try { process.kill(record.supervisorPid, "SIGTERM"); } catch {}
      }
      throw error;
    }
  }, { signal: options.signal });
}

export async function stopInstance(options) {
  const paths = await ensureControllerDirectories(options.root);
  const timeoutMs = options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
  await withLock(paths.locks, `instance-${options.instanceId}`, async () => {
    const record = await readInstance(options.root, options.instanceId);
    if (record.state === "stopped") return;
    await writeInstance(options.root, { ...record, state: "stopping" });
    const targetPid = pidAlive(record.supervisorPid) ? record.supervisorPid : record.hostPid;
    if (pidAlive(targetPid)) process.kill(targetPid, "SIGTERM");
  }, { signal: options.signal });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const record = await readInstance(options.root, options.instanceId);
    if (record.state === "stopped" || (!pidAlive(record.hostPid) && !pidAlive(record.supervisorPid))) {
      if (record.state !== "stopped") await writeInstance(options.root, { ...record, state: "stopped", endedAt: new Date().toISOString() });
      return { instanceId: record.instanceId, stopped: true };
    }
    await sleep(100, options.signal);
  }
  throw new RemoteError("OPERATION_TIMEOUT", `Instance ${options.instanceId} did not stop within ${timeoutMs} ms.`, { retryable: true });
}

export async function readInstanceLogs(options) {
  const paths = await ensureControllerDirectories(options.root);
  requireId(options.instanceId, "instanceId");
  const stream = options.stream === "supervisor" ? "supervisor" : "host";
  const path = resolve(paths.logs, `${options.instanceId}.${stream}.log`);
  const info = await stat(path);
  const offset = positiveInteger(options.offset ?? 0, "offset");
  const limit = positiveInteger(options.limit ?? MAX_LOG_PAGE_BYTES, "limit", { min: 1, max: MAX_LOG_PAGE_BYTES });
  const length = Math.max(0, Math.min(limit, info.size - offset));
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    if (length) await handle.read(buffer, 0, length, offset);
    const nextOffset = offset + length;
    return {
      instanceId: options.instanceId,
      stream,
      offset,
      nextOffset,
      hasMore: nextOffset < info.size,
      text: redactSecrets(buffer.toString("utf8"))
    };
  } finally {
    await handle.close();
  }
}

export async function uninstallRuntime(options) {
  requireVersion(options.version);
  const target = await currentTarget();
  const id = runtimeId(options.version, target);
  const paths = await ensureControllerDirectories(options.root);
  return withLock(paths.locks, `install-${id}`, async () => {
    const { path: runtimeRoot } = await readInstalledRuntime(options.root, id);
    const entries = await readdir(paths.instances, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^[a-f0-9-]{36}$/iu.test(entry.name)) continue;
      const record = await readInstance(options.root, entry.name);
      if (record.createdBy === id && record.state !== "stopped" && (pidAlive(record.hostPid) || pidAlive(record.supervisorPid))) {
        throw new RemoteError("REMOTE_INSTANCE_ACTIVE", `Runtime ${id} is still used by instance ${record.instanceId}.`);
      }
    }
    await rm(runtimeRoot, { recursive: true, force: false });
    return { uninstalled: true, runtimeId: id };
  }, { signal: options.signal });
}

export async function updateInstanceWithLock(root, instanceId, update) {
  const paths = await ensureControllerDirectories(root);
  return withLock(paths.locks, `instance-${instanceId}`, async () => {
    const current = await readInstance(root, instanceId);
    const next = await update(current);
    if (next) await writeInstance(root, next);
    return next;
  });
}
