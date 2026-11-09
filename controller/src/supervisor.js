import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { stat } from "node:fs/promises";
import { delimiter, isAbsolute, resolve } from "node:path";
import { parseArgs } from "node:util";
import { DEFAULT_PROFILE_ID, DEFAULT_STOP_TIMEOUT_MS, PROTOCOL_VERSION, REGISTRY_SCHEMA_VERSION } from "./constants.js";
import { createUnknownActivityProvider, readActivityState } from "./activity.js";
import { activeLeases, readLeases, updateInstanceWithLock, writeInstance } from "./instances.js";
import { readInstalledRuntime } from "./install.js";
import { pidAlive } from "./process.js";
import { ensureControllerDirectories, pathExists, positiveInteger, redactSecrets, requireId, requireProfileId, resolveDshHome } from "./util.js";

function parseSupervisorArgs(argv) {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    options: {
      root: { type: "string" },
      "runtime-root": { type: "string" },
      "instance-id": { type: "string" },
      workspace: { type: "string" },
      profile: { type: "string" },
      patch: { type: "string" },
      "idle-timeout-ms": { type: "string" },
      "lease-ttl-ms": { type: "string" },
      "start-timeout-ms": { type: "string" }
    }
  });
  for (const name of ["root", "runtime-root", "instance-id", "workspace", "idle-timeout-ms", "lease-ttl-ms"]) {
    if (!values[name]) throw new Error(`supervisor requires --${name}.`);
  }
  return {
    root: resolve(values.root),
    runtimeRoot: resolve(values["runtime-root"]),
    instanceId: requireId(values["instance-id"], "instanceId"),
    workspace: resolve(values.workspace),
    profileId: requireProfileId(values.profile ?? DEFAULT_PROFILE_ID),
    patch: values.patch,
    idleTimeoutMs: positiveInteger(values["idle-timeout-ms"], "idleTimeoutMs", { min: 100, max: 24 * 60 * 60_000 }),
    leaseTtlMs: positiveInteger(values["lease-ttl-ms"], "leaseTtlMs", { min: 100, max: 10 * 60_000 }),
    startTimeoutMs: values["start-timeout-ms"] ? positiveInteger(values["start-timeout-ms"], "startTimeoutMs", { min: 100, max: 120_000 }) : undefined
  };
}

function createLineParser(onLine) {
  let pending = "";
  return {
    push(chunk) {
      pending += chunk;
      const lines = pending.split(/\r?\n/u);
      pending = lines.pop() ?? "";
      for (const line of lines) onLine(line);
      if (pending.length > 32 * 1024) {
        onLine(`${pending.slice(0, 32 * 1024)} [truncated]`);
        pending = "";
      }
    },
    end() {
      if (pending) onLine(pending);
      pending = "";
    }
  };
}

export async function runSupervisor(options, dependencies = {}) {
  const activityProvider = dependencies.activityProvider ?? createUnknownActivityProvider();
  const paths = await ensureControllerDirectories(options.root);
  if (options.patch !== undefined && (!isAbsolute(options.patch) || !(await stat(options.patch)).isFile())) {
    throw new Error("supervisor --patch must be an absolute path to an existing file.");
  }
  const { manifest } = await readInstalledRuntime(options.root, options.runtimeId ?? "");
  const profileId = options.profileId === undefined ? DEFAULT_PROFILE_ID : requireProfileId(options.profileId);
  const hostLog = createWriteStream(resolve(paths.logs, `${options.instanceId}.host.log`), { flags: "a", mode: 0o600 });
  const supervisorLog = createWriteStream(resolve(paths.logs, `${options.instanceId}.supervisor.log`), { flags: "a", mode: 0o600 });
  const log = (message) => supervisorLog.write(`${new Date().toISOString()} ${redactSecrets(message)}\n`);
  let record = {
    schemaVersion: REGISTRY_SCHEMA_VERSION,
    instanceId: options.instanceId,
    profileId,
    hostPid: null,
    supervisorPid: process.pid,
    protocolVersion: PROTOCOL_VERSION,
    dshVersion: manifest.dshVersion,
    buildId: manifest.buildId,
    endpoint: null,
    authenticatedUrl: null,
    workspace: options.workspace,
    startedAt: new Date().toISOString(),
    createdBy: manifest.runtimeId,
    idleTimeoutMs: options.idleTimeoutMs,
    leaseTtlMs: options.leaseTtlMs,
    lastAttachAt: null,
    state: "starting"
  };
  if (await pathExists(resolve(paths.instances, options.instanceId, "record.json"))) {
    throw new Error("Instance ID already has a registry record.");
  }
  await writeInstance(options.root, record);
  log(`supervisor started for ${options.instanceId}`);

  const dshEntry = resolve(options.runtimeRoot, "app", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
  const host = spawn(resolve(options.runtimeRoot, "bin", "node"), [
    dshEntry,
    "--profile", profileId,
    ...(options.patch ? ["--patch", options.patch] : []),
    "--host", "127.0.0.1",
    "--port", "0",
    "--no-open",
    "--trusted-host", "localhost"
  ], {
    cwd: options.workspace,
    env: {
      ...process.env,
      PATH: [resolve(options.runtimeRoot, "bin"), process.env.PATH ?? ""].filter(Boolean).join(delimiter),
      DSH_HOME: resolveDshHome(options.dshHome)
    },
    detached: false,
    stdio: ["ignore", "pipe", "pipe"]
  });
  record = { ...record, hostPid: host.pid ?? null };
  await writeInstance(options.root, record);

  let stopping = false;
  let stopPromise;
  let idleSince;
  let monitor;
  let startupTimer;
  let finishLifetime;
  const lifetime = new Promise((resolveLifetime) => { finishLifetime = resolveLifetime; });
  const hostExit = new Promise((resolveExit) => {
    host.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
  const forceTimer = { value: undefined };

  async function requestStop(reason, { idle = false } = {}) {
    if (stopPromise) return stopPromise;
    stopping = true;
    stopPromise = (async () => {
      const marked = await updateInstanceWithLock(options.root, options.instanceId, async (current) => {
        if (current.state === "stopped") return current;
        if (idle) {
          const leases = await readLeases(options.root, options.instanceId);
          if (activeLeases(leases).length > 0) return null;
          const activity = await readActivityState(activityProvider, { instanceId: options.instanceId });
          if (activity.state !== "inactive") return null;
        }
        return { ...current, state: "stopping" };
      });
      if (!marked) {
        stopping = false;
        stopPromise = undefined;
        idleSince = undefined;
        return;
      }
      log(`stopping host: ${reason}`);
      clearInterval(monitor);
      if (host.exitCode === null && host.signalCode === null && pidAlive(host.pid)) host.kill("SIGTERM");
      forceTimer.value = setTimeout(() => {
        if (host.exitCode === null && host.signalCode === null && pidAlive(host.pid)) {
          log("host did not exit after SIGTERM; sending SIGKILL");
          host.kill("SIGKILL");
        }
      }, options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS);
      const exit = await hostExit;
      clearTimeout(forceTimer.value);
      await updateInstanceWithLock(options.root, options.instanceId, (current) => ({
        ...current,
        state: "stopped",
        exitCode: exit.code,
        exitSignal: exit.signal,
        endedAt: new Date().toISOString()
      }));
      log(`host stopped: ${reason}`);
      finishLifetime(exit);
    })().catch((error) => {
      log(`supervisor shutdown failed: ${error.stack ?? error}`);
      finishLifetime({ code: 1 });
    });
    return stopPromise;
  }

  let ready;
  let rejectReady;
  const readyPromise = new Promise((resolveReady, reject) => { ready = resolveReady; rejectReady = reject; });
  const announce = async (line) => {
    const match = /^dsh web:\s+(https?:\/\/\S+)\s*$/u.exec(line.trim());
    if (!match || record.state !== "starting") return;
    const url = new URL(match[1]);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.username || url.password) {
      throw new Error("DSH announced a non-loopback or invalid authenticated URL.");
    }
    const hasCredential = [...url.searchParams.keys()].some((key) => /token|key|auth/iu.test(key)) || /token|key|auth/iu.test(url.hash);
    if (!hasCredential) throw new Error("DSH startup URL did not contain browser authentication state.");
    record = {
      ...record,
      endpoint: { host: "127.0.0.1", port: Number(url.port) },
      authenticatedUrl: url.toString(),
      state: "running"
    };
    await writeInstance(options.root, record);
    log(`host ready on 127.0.0.1:${url.port}`);
    ready();
  };

  const output = (stream, isStdout) => {
    const parser = createLineParser((line) => {
      hostLog.write(`${redactSecrets(line)}\n`);
      if (isStdout) {
        announce(line).catch((error) => {
          log(`invalid startup announcement: ${error.message}`);
          requestStop("invalid-startup-announcement");
          rejectReady(error);
        });
      }
    });
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => parser.push(chunk));
    stream.on("end", () => parser.end());
  };
  output(host.stdout, true);
  output(host.stderr, false);
  host.once("error", (error) => {
    log(`host spawn failed: ${error.message}`);
    rejectReady(error);
  });
  host.once("exit", (exit) => {
    log(`host exited with code ${String(exit)}`);
    rejectReady(new Error(`DSH host exited before becoming ready: ${String(exit)}`));
    if (!stopping) requestStop("host-exit");
  });

  const onSigterm = () => requestStop("SIGTERM");
  const onSigint = () => requestStop("SIGINT");
  const onSighup = () => log("ignored SIGHUP");
  process.on("SIGTERM", onSigterm);
  process.on("SIGINT", onSigint);
  process.on("SIGHUP", onSighup);

  try {
    const startupTimeout = new Promise((_, reject) => {
      startupTimer = setTimeout(() => reject(new Error("DSH host startup timed out.")), options.startTimeoutMs ?? 45_000);
    });
    await Promise.race([readyPromise, hostExit.then((exit) => {
      throw new Error(`DSH host exited before readiness: ${JSON.stringify(exit)}`);
    }), startupTimeout]);
    monitor = setInterval(() => {
      if (stopping) return;
      readLeases(options.root, options.instanceId).then(async (leases) => {
        if (activeLeases(leases).length > 0) {
          idleSince = undefined;
          return;
        }
        const activity = await readActivityState(activityProvider, { instanceId: options.instanceId });
        if (activity.state !== "inactive") {
          idleSince = undefined;
          return;
        }
        idleSince ??= Date.now();
        if (Date.now() - idleSince >= options.idleTimeoutMs) requestStop("idle-timeout", { idle: true });
      }).catch((error) => {
        idleSince = undefined;
        log(`lease/activity check failed; keeping host running: ${error.message}`);
      });
    }, 1_000);
    await lifetime;
  } catch (error) {
    await requestStop("startup-failure");
    throw error;
  } finally {
    clearInterval(monitor);
    clearTimeout(startupTimer);
    clearTimeout(forceTimer.value);
    process.removeListener("SIGTERM", onSigterm);
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGHUP", onSighup);
    hostLog.end();
    supervisorLog.end();
  }
}

if (import.meta.main) {
  try {
    const options = parseSupervisorArgs(process.argv.slice(2));
    const runtimeId = options.runtimeRoot.split("/").pop();
    await runSupervisor({ ...options, runtimeId });
  } catch (error) {
    process.stderr.write(`${redactSecrets(error?.stack ?? error)}\n`);
    process.exitCode = 1;
  }
}
