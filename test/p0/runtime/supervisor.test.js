import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve, delimiter } from "node:path";
import test from "node:test";
import { DSH_BUILD_ID, DSH_VERSION, PNPM_VERSION } from "../../../packages/shell/ssh-remote/controller/src/constants.js";
import { pidAlive } from "../../../packages/shell/ssh-remote/controller/src/process.js";
import { runSupervisor } from "../../../packages/shell/ssh-remote/controller/src/supervisor.js";
import { sleep } from "../../../packages/shell/ssh-remote/controller/src/util.js";
import { invoke, makeFakeRuntime, readRecord, temporaryDirectory } from "./helpers.mjs";

async function startFake(root, t, extra = []) {
  const fake = await makeFakeRuntime(root);
  const stopMarker = resolve(root, "graceful-stop.txt");
  const patch = resolve(root, "controlled-patch.yml");
  const argsFile = resolve(root, "host-args.json");
  const pnpmResultFile = resolve(root, "host-pnpm.json");
  await writeFile(patch, "# controlled test patch\n");
  const started = await invoke([
    "start", "--root", root, "--version", DSH_VERSION, "--expected-build-id", DSH_BUILD_ID,
    "--workspace", root, "--patch", patch, "--lease-ttl-ms", "1000", "--idle-timeout-ms", "60000", ...extra
  ], { env: { DSH_HOME: resolve(root, "dsh-home"), FAKE_HOST_STOP_FILE: stopMarker, FAKE_HOST_ARGS_FILE: argsFile, FAKE_HOST_PNPM_RESULT_FILE: pnpmResultFile } });
  assert.equal(started.code, 0, started.stderr);
  assert.equal(started.response.ok, true);
  const instance = started.response.result.instance;
  assert.equal(instance.state, "running");
  assert.equal(instance.endpoint.host, "127.0.0.1");
  assert.ok(instance.hostPid > 0);
  assert.ok(instance.supervisorPid > 0);
  assert.doesNotMatch(started.stdout, /super-secret-token|authenticatedUrl/u);
  t.after(async () => {
    const record = await readRecord(root, instance.instanceId).catch(() => undefined);
    if (record && record.state !== "stopped") await invoke(["stop", "--root", root, "--instance-id", instance.instanceId]);
  });
  return { instance, stopMarker, patch, argsFile, pnpmResultFile, runtimeRoot: fake.runtimeRoot };
}

test("supervisor survives controller exit and lease commands protect secrets", { timeout: 30_000 }, async (t) => {
  const root = await temporaryDirectory(t);
  const { instance, stopMarker, patch, argsFile, pnpmResultFile, runtimeRoot } = await startFake(root, t);
  assert.equal(instance.profileId, "web");
  assert.equal(JSON.parse(await readFile(resolve(root, "instances", instance.instanceId, "record.json"), "utf8")).profileId, "web");
  const id = instance.instanceId;
  const hostArgs = JSON.parse(await readFile(argsFile, "utf8"));
  const profileIndex = hostArgs.indexOf("--profile");
  const patchIndex = hostArgs.indexOf("--patch");
  const hostIndex = hostArgs.indexOf("--host");
  assert.equal(profileIndex, 0);
  assert.equal(hostArgs[profileIndex + 1], "web");
  assert.equal(hostArgs[patchIndex + 1], patch);
  assert.ok(profileIndex < patchIndex && patchIndex < hostIndex);
  assert.equal(hostArgs[hostIndex + 1], "127.0.0.1");
  assert.equal(hostArgs[hostArgs.indexOf("--port") + 1], "0");
  assert.ok(hostArgs.includes("--no-open"));
  assert.equal(hostArgs[hostArgs.indexOf("--trusted-host") + 1], "localhost");
  const hostPnpm = JSON.parse(await readFile(pnpmResultFile, "utf8"));
  assert.equal(hostPnpm.status, 0);
  assert.equal(hostPnpm.error, undefined);
  assert.equal(hostPnpm.stdout.trim(), PNPM_VERSION);
  assert.equal(hostPnpm.path.split(delimiter)[0], resolve(runtimeRoot, "bin"));

  const attached = await invoke(["attach", "--root", root, "--instance-id", id, "--expected-version", DSH_VERSION, "--expected-build-id", DSH_BUILD_ID]);
  assert.equal(attached.code, 0, attached.stderr);
  assert.match(attached.response.result.authenticatedUrl, /token=super-secret-token/u);
  assert.ok(attached.response.result.clientLeaseId);
  const lease = attached.response.result.clientLeaseId;

  const status = await invoke(["status", "--root", root, "--instance-id", id]);
  assert.equal(status.response.result.active, true);
  assert.equal(status.response.result.clientCount, 1);
  assert.doesNotMatch(status.stdout, /super-secret-token|authenticatedUrl/u);
  const list = await invoke(["list", "--root", root, "--expected-version", DSH_VERSION]);
  assert.equal(list.response.result.instances.length, 1);
  assert.doesNotMatch(list.stdout, /super-secret-token|authenticatedUrl/u);

  const heartbeat = await invoke(["heartbeat", "--root", root, "--instance-id", id, "--client-lease-id", lease]);
  assert.equal(heartbeat.code, 0, heartbeat.stderr);
  assert.equal(heartbeat.response.result.health.healthy, true);
  const mismatch = await invoke(["attach", "--root", root, "--instance-id", id, "--expected-version", "0.0.0", "--request-id", "mismatch"]);
  assert.equal(mismatch.response.error.code, "REMOTE_VERSION_MISMATCH");
  assert.equal(mismatch.response.requestId, "mismatch");

  const logs = await invoke(["logs", "--root", root, "--instance-id", id]);
  assert.equal(logs.code, 0, logs.stderr);
  assert.match(logs.response.result.text, /dsh web:/u);
  assert.doesNotMatch(logs.stdout, /super-secret-token/u);
  assert.match(logs.stdout, /redacted/u);

  const released = await invoke(["release", "--root", root, "--instance-id", id, "--client-lease-id", lease]);
  assert.equal(released.response.result.released, true);
  assert.equal(released.response.result.clientCount, 0);
  const stopped = await invoke(["stop", "--root", root, "--instance-id", id, "--stop-timeout-ms", "10000"]);
  assert.equal(stopped.code, 0, stopped.stderr);
  assert.equal(stopped.response.result.stopped, true);
  assert.equal((await readRecord(root, id)).state, "stopped");
  assert.equal(pidAlive(instance.hostPid), false);
  assert.match(await readFile(stopMarker, "utf8"), /SIGTERM/u);

  const uninstalled = await invoke(["uninstall", "--root", root, "--version", DSH_VERSION]);
  assert.equal(uninstalled.code, 0, uninstalled.stderr);
  assert.equal(uninstalled.response.result.uninstalled, true);
});

test("default unknown activity prevents idle stop after leases expire", { timeout: 30_000 }, async (t) => {
  const root = await temporaryDirectory(t);
  const { instance } = await startFake(root, t, ["--lease-ttl-ms", "100", "--idle-timeout-ms", "100"]);
  await sleep(1_800);
  const status = await invoke(["status", "--root", root, "--instance-id", instance.instanceId]);
  assert.equal(status.code, 0, status.stderr);
  assert.equal(status.response.result.active, true);
  const stopped = await invoke(["stop", "--root", root, "--instance-id", instance.instanceId]);
  assert.equal(stopped.code, 0, stopped.stderr);
});

test("injected inactive activity permits idle stop after lease expiry", { timeout: 30_000 }, async (t) => {
  const root = await temporaryDirectory(t);
  const fake = await makeFakeRuntime(root);
  const instanceId = randomUUID();
  let activityChecks = 0;
  const supervisorDone = runSupervisor({
    root,
    runtimeRoot: fake.runtimeRoot,
    runtimeId: fake.id,
    instanceId,
    workspace: root,
    dshHome: resolve(root, "dsh-home"),
    idleTimeoutMs: 500,
    leaseTtlMs: 200,
    startTimeoutMs: 5_000
  }, {
    activityProvider: {
      async getActivity() {
        activityChecks += 1;
        return { state: "inactive" };
      }
    }
  });
  t.after(async () => {
    const record = await readRecord(root, instanceId).catch(() => undefined);
    if (record && record.state !== "stopped" && pidAlive(record.hostPid)) process.kill(record.hostPid, "SIGTERM");
    await supervisorDone;
  });

  const readyDeadline = Date.now() + 5_000;
  while (Date.now() < readyDeadline) {
    const record = await readRecord(root, instanceId).catch(() => undefined);
    if (record?.state === "running") break;
    await sleep(50);
  }
  assert.equal((await readRecord(root, instanceId)).state, "running");
  const attached = await invoke(["attach", "--root", root, "--instance-id", instanceId]);
  assert.equal(attached.code, 0, attached.stderr);
  const lease = attached.response.result.clientLeaseId;
  await sleep(350);
  const heartbeat = await invoke(["heartbeat", "--root", root, "--instance-id", instanceId, "--client-lease-id", lease]);
  assert.equal(heartbeat.code, 1);
  assert.equal(heartbeat.response.error.code, "REMOTE_LEASE_INVALID");
  const released = await invoke(["release", "--root", root, "--instance-id", instanceId, "--client-lease-id", lease]);
  assert.equal(released.code, 0, released.stderr);
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const record = await readRecord(root, instanceId);
    if (record.state === "stopped") {
      assert.ok(activityChecks > 0);
      await supervisorDone;
      return;
    }
    await sleep(100);
  }
  assert.fail("Instance did not exit after confirmed inactive idle timeout.");
});

test("profile-scoped start, list, status and attach refuse another profile's instance", { timeout: 30_000 }, async (t) => {
  const root = await temporaryDirectory(t);
  const { instance, argsFile } = await startFake(root, t, ["--profile", "staging"]);
  assert.equal(instance.profileId, "staging");
  const hostArgs = JSON.parse(await readFile(argsFile, "utf8"));
  assert.deepEqual(hostArgs.slice(0, 2), ["--profile", "staging"]);

  const listed = await invoke(["list", "--root", root, "--profile", "staging"]);
  assert.equal(listed.code, 0, listed.stderr);
  assert.deepEqual(listed.response.result.instances.map((entry) => entry.instance.profileId), ["staging"]);

  const otherList = await invoke(["list", "--root", root, "--profile", "web"]);
  assert.equal(otherList.code, 0, otherList.stderr);
  assert.deepEqual(otherList.response.result.instances, []);
  const defaultList = await invoke(["list", "--root", root]);
  assert.deepEqual(defaultList.response.result.instances, []);

  const wrongAttach = await invoke(["attach", "--root", root, "--instance-id", instance.instanceId, "--profile", "web", "--request-id", "profile-mismatch"]);
  assert.equal(wrongAttach.code, 1);
  assert.equal(wrongAttach.response.error.code, "REMOTE_PROFILE_MISMATCH");
  assert.equal(wrongAttach.response.requestId, "profile-mismatch");
  assert.doesNotMatch(wrongAttach.stdout, /super-secret-token/u);
  assert.doesNotMatch(wrongAttach.stdout, /authenticatedUrl/u);

  const wrongStatus = await invoke(["status", "--root", root, "--instance-id", instance.instanceId, "--profile", "web"]);
  assert.equal(wrongStatus.response.error.code, "REMOTE_PROFILE_MISMATCH");
  const rightStatus = await invoke(["status", "--root", root, "--instance-id", instance.instanceId, "--profile", "staging"]);
  assert.equal(rightStatus.code, 0, rightStatus.stderr);
  assert.equal(rightStatus.response.result.instance.profileId, "staging");
  assert.equal(rightStatus.response.result.active, true);

  const attached = await invoke(["attach", "--root", root, "--instance-id", instance.instanceId, "--profile", "staging"]);
  assert.equal(attached.code, 0, attached.stderr);
  assert.equal(attached.response.result.instance.profileId, "staging");

  const invalid = await invoke(["start", "--root", root, "--version", DSH_VERSION, "--profile", "../escape"]);
  assert.equal(invalid.response.error.code, "INVALID_ARGUMENT");
  const invalidList = await invoke(["list", "--root", root, "--profile", "with space"]);
  assert.equal(invalidList.response.error.code, "INVALID_ARGUMENT");
});
