import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DSH_BUILD_ID, DSH_VERSION, PNPM_VERSION } from "../../../controller/src/constants.js";

const VM = "dsh-ssh-remote-p0";
const HERE = dirname(fileURLToPath(import.meta.url));
const CONTROLLER = resolve(HERE, "../../../controller");
const HTTP_CHECKER = resolve(HERE, "verify-http.mjs");
let cleanup;

function execute(file, args, options = {}) {
  return new Promise((resolveExecute, reject) => {
    const child = spawn(file, args, { stdio: ["ignore", "pipe", "pipe"], env: process.env });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (!options.allowFailure && code !== 0) reject(new Error(`Remote command exited ${code}: ${stderr.slice(-4096)}`));
      else resolveExecute({ code, stdout, stderr });
    });
  });
}

function quote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

function remote(script, options = {}) {
  return execute("limactl", ["shell", VM, "--", "sh", "-lc", script], options);
}

function json(result, label) {
  try {
    const response = JSON.parse(result.stdout);
    assert.equal(response.ok, true, `${label}: ${result.stderr}`);
    assert.equal(response.protocolVersion, 1);
    return response;
  } catch (error) {
    throw new Error(`${label} did not return a successful protocol response: ${result.stderr}`, { cause: error });
  }
}

async function main() {
  const homeResult = await remote("printf '%s' \"$HOME\"");
  const home = homeResult.stdout;
  assert.ok(home.startsWith("/home/") || home.startsWith("/Users/"), "Unexpected isolated guest HOME.");
  const sandbox = resolve(home, "dsh-ssh-remote-p0-pnpm-runtime-test");
  assert.ok(sandbox.startsWith(`${home}/`));
  const root = resolve(sandbox, "controller");
  const dshHome = resolve(sandbox, "dsh-home");
  const bootstrap = resolve(sandbox, "bootstrap");
  const remoteArchive = resolve(sandbox, "runtime.tar.gz");
  const remoteHttpChecker = resolve(sandbox, "verify-http.mjs");
  const archive = resolve(CONTROLLER, "artifacts", `dsh-ssh-remote-${DSH_VERSION}-linux-x64-glibc.tar.gz`);
  const metadata = JSON.parse(await readFile(`${archive}.json`, "utf8"));
  const runtimeId = metadata.runtimeId;
  const installed = resolve(root, "servers", runtimeId);
  const node = resolve(installed, "bin", "node");
  const pnpm = resolve(installed, "bin", "pnpm");
  const dsh = resolve(installed, "bin", "dsh");
  const controller = resolve(installed, "controller", "src", "cli.js");
  const bootstrapNode = resolve(bootstrap, "runtime", "bin", "node");
  const bootstrapController = resolve(bootstrap, "runtime", "controller", "src", "cli.js");

  await remote(`rm -rf -- ${quote(sandbox)} && mkdir -p ${quote(bootstrap)}`);
  await execute("limactl", ["copy", "--backend=scp", archive, `${VM}:${remoteArchive}`]);
  await execute("limactl", ["copy", "--backend=scp", HTTP_CHECKER, `${VM}:${remoteHttpChecker}`]);
  await remote(`tar -xzf ${quote(remoteArchive)} --no-same-owner --no-same-permissions -C ${quote(bootstrap)}`);
  const probe = json(await remote(`${quote(bootstrapNode)} ${quote(bootstrapController)} probe --root ${quote(root)}`), "probe").result;
  assert.equal(probe.os, "linux");
  assert.equal(probe.arch, "x64");
  assert.equal(probe.libc, "glibc");
  assert.equal(probe.supported, true);

  const installCommand = `${quote(bootstrapNode)} ${quote(bootstrapController)} install --root ${quote(root)} --package ${quote(remoteArchive)} --sha256 ${quote(metadata.sha256)} --expected-version ${DSH_VERSION} --timeout-ms 600000`;
  const installedResponse = json(await remote(installCommand), "install").result;
  assert.equal(installedResponse.alreadyInstalled, false);
  assert.equal(installedResponse.runtime.dshVersion, DSH_VERSION);
  assert.equal(installedResponse.runtime.nodeVersion, "v24.22.1");
  const reinstalled = json(await remote(installCommand), "repeat install").result;
  assert.equal(reinstalled.alreadyInstalled, true);
  const pnpmVersion = await remote(`env -i HOME=${quote(home)} PATH=/usr/bin:/bin ${quote(pnpm)} --version`);
  assert.equal(pnpmVersion.stdout.trim(), PNPM_VERSION);
  const pluginManagerPnpm = await remote(`DSH_HOME=${quote(dshHome)} PATH=${quote(`${resolve(installed, "bin")}:/usr/bin:/bin`)} ${quote(dsh)} plugin --profile web --version`);
  assert.match(pluginManagerPnpm.stdout, new RegExp(`^${PNPM_VERSION.replaceAll(".", "\\.")}\\s*$`, "u"));

  const start = json(await remote(`DSH_HOME=${quote(dshHome)} ${quote(node)} ${quote(controller)} start --root ${quote(root)} --version ${DSH_VERSION} --expected-build-id ${quote(DSH_BUILD_ID)} --workspace ${quote(sandbox)} --lease-ttl-ms 30000 --idle-timeout-ms 60000 --start-timeout-ms 60000 --timeout-ms 90000`), "start").result;
  const instanceId = start.instance.instanceId;
  const recordPath = resolve(root, "instances", instanceId, "record.json");
  cleanup = () => remote(`${quote(node)} ${quote(controller)} stop --root ${quote(root)} --instance-id ${instanceId} --stop-timeout-ms 20000 --timeout-ms 30000`, { allowFailure: true });
  assert.equal(start.instance.dshVersion, DSH_VERSION);
  assert.equal(start.instance.endpoint.host, "127.0.0.1");
  assert.ok(!JSON.stringify(start).includes("authenticatedUrl"));

  const attachResult = await remote(`${quote(node)} ${quote(controller)} attach --root ${quote(root)} --instance-id ${instanceId} --expected-version ${DSH_VERSION} --expected-build-id ${quote(DSH_BUILD_ID)}`);
  const attach = json(attachResult, "attach").result;
  assert.equal(attach.instance.instanceId, instanceId);
  assert.ok(attach.authenticatedUrl.startsWith("http://127.0.0.1:"));
  const credential = new URL(attach.authenticatedUrl).searchParams.values().next().value;
  assert.ok(credential, "DSH authenticated URL must carry browser authentication state.");

  const httpResult = await remote(`${quote(node)} ${quote(remoteHttpChecker)} ${quote(recordPath)}`, { allowFailure: true });
  const http = JSON.parse(httpResult.stdout);
  assert.equal(http.status, 200);
  assert.equal(http.html, true);
  assert.ok(http.bytes > 1000);

  const heartbeat = json(await remote(`${quote(node)} ${quote(controller)} heartbeat --root ${quote(root)} --instance-id ${instanceId} --client-lease-id ${attach.clientLeaseId}`), "heartbeat").result;
  assert.equal(heartbeat.health.healthy, true);
  const statusResult = await remote(`${quote(node)} ${quote(controller)} status --root ${quote(root)} --instance-id ${instanceId}`);
  const status = json(statusResult, "status").result;
  assert.equal(status.active, true);
  assert.ok(!statusResult.stdout.includes("authenticatedUrl"));
  assert.ok(!statusResult.stdout.includes(credential));
  const logsResult = await remote(`${quote(node)} ${quote(controller)} logs --root ${quote(root)} --instance-id ${instanceId}`);
  json(logsResult, "logs");
  assert.ok(!logsResult.stdout.includes(credential), "Host logs exposed the access token.");

  const busyUninstall = await remote(`${quote(node)} ${quote(controller)} uninstall --root ${quote(root)} --version ${DSH_VERSION}`, { allowFailure: true });
  assert.equal(JSON.parse(busyUninstall.stdout).error.code, "REMOTE_INSTANCE_ACTIVE");
  const released = json(await remote(`${quote(node)} ${quote(controller)} release --root ${quote(root)} --instance-id ${instanceId} --client-lease-id ${attach.clientLeaseId}`), "release").result;
  assert.equal(released.released, true);
  json(await remote(`${quote(node)} ${quote(controller)} stop --root ${quote(root)} --instance-id ${instanceId} --stop-timeout-ms 20000 --timeout-ms 30000`), "stop");
  cleanup = undefined;
  const stopped = json(await remote(`${quote(node)} ${quote(controller)} status --root ${quote(root)} --instance-id ${instanceId}`), "stopped status").result;
  assert.equal(stopped.active, false);
  json(await remote(`${quote(node)} ${quote(controller)} uninstall --root ${quote(root)} --version ${DSH_VERSION}`), "uninstall");

  process.stdout.write(`${JSON.stringify({ ok: true, vm: VM, runtimeId, instanceId, httpStatus: http.status, pnpmVersion: PNPM_VERSION, pluginManagerPnpm: "verified", install: "verified", detachedReattach: "verified", gracefulStop: "verified" }, null, 2)}\n`);
}

if (process.env.DSH_SSH_REMOTE_P0_VM !== '1') {
  process.stderr.write('Set DSH_SSH_REMOTE_P0_VM=1 to explicitly run the isolated Lima smoke test.\n');
  process.exitCode = 1;
} else main().catch(async (error) => {
  if (cleanup) await cleanup().catch(() => {});
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exitCode = 1;
});
