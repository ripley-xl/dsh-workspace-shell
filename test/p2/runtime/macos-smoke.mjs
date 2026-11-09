import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DSH_BUILD_ID, DSH_VERSION, PNPM_VERSION } from "../../../controller/src/constants.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const CONTROLLER = resolve(HERE, "../../../controller");
const HTTP_CHECKER = resolve(HERE, "verify-http.mjs");

function run(file, args, options = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(file, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolveRun({ stdout, stderr });
      else reject(new Error(`${file} exited with ${code ?? signal}: ${stderr}\n${stdout}`));
    });
  });
}

function protocol(result, label) {
  const response = JSON.parse(result.stdout);
  assert.equal(response.ok, true, `${label}: ${result.stderr}`);
  assert.equal(response.protocolVersion, 1);
  return response.result;
}

async function main() {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error("This real runtime smoke test requires a macOS arm64 host.");
  }
  const temporary = await mkdtemp(resolve(HERE, ".macos-smoke-"));
  const archive = resolve(CONTROLLER, "artifacts", `dsh-ssh-remote-${DSH_VERSION}-darwin-arm64-none.tar.gz`);
  const metadata = JSON.parse(await readFile(`${archive}.json`, "utf8"));
  const root = resolve(temporary, "controller");
  const dshHome = resolve(temporary, "dsh-home");
  const bootstrap = resolve(temporary, "bootstrap");
  const bootstrapNode = resolve(bootstrap, "runtime", "bin", "node");
  const bootstrapController = resolve(bootstrap, "runtime", "controller", "src", "cli.js");
  const env = { ...process.env, HOME: temporary, DSH_HOME: dshHome };
  const installed = resolve(root, "servers", metadata.runtimeId);
  const node = resolve(installed, "bin", "node");
  const controller = resolve(installed, "controller", "src", "cli.js");
  let instanceId;
  try {
    await mkdir(bootstrap, { recursive: true });
    await run("tar", ["-xzf", archive, "--no-same-owner", "--no-same-permissions", "-C", bootstrap]);
    const probe = protocol(await run(bootstrapNode, [bootstrapController, "probe", "--root", root], { cwd: temporary, env }), "probe");
    assert.equal(probe.os, "darwin");
    assert.equal(probe.arch, "arm64");
    assert.equal(probe.libc, "none");
    assert.equal(probe.supported, true);
    const installedResult = protocol(await run(bootstrapNode, [bootstrapController, "install", "--root", root, "--package", archive, "--sha256", metadata.sha256, "--expected-version", DSH_VERSION, "--timeout-ms", "300000"], { cwd: temporary, env }), "install");
    assert.equal(installedResult.alreadyInstalled, false);
    assert.equal(installedResult.runtime.platform, "darwin");
    assert.equal(installedResult.runtime.libc, "none");
    const pnpm = await run(resolve(installed, "bin", "pnpm"), ["--version"], { cwd: temporary, env: { HOME: temporary, PATH: "/usr/bin:/bin" } });
    assert.equal(pnpm.stdout.trim(), PNPM_VERSION);

    const started = protocol(await run(node, [controller, "start", "--root", root, "--version", DSH_VERSION, "--expected-build-id", DSH_BUILD_ID, "--workspace", temporary, "--lease-ttl-ms", "30000", "--idle-timeout-ms", "100", "--start-timeout-ms", "60000", "--timeout-ms", "90000"], { cwd: temporary, env }), "start");
    instanceId = started.instance.instanceId;
    assert.equal(started.instance.endpoint.host, "127.0.0.1");
    assert.ok(!JSON.stringify(started).includes("authenticatedUrl"));
    const attached = protocol(await run(node, [controller, "attach", "--root", root, "--instance-id", instanceId, "--expected-version", DSH_VERSION, "--expected-build-id", DSH_BUILD_ID], { cwd: temporary, env }), "attach");
    const credential = new URL(attached.authenticatedUrl).searchParams.values().next().value;
    assert.ok(credential);
    const recordPath = resolve(root, "instances", instanceId, "record.json");
    const httpResult = await run(node, [HTTP_CHECKER, recordPath], { cwd: temporary, env });
    const http = JSON.parse(httpResult.stdout);
    assert.equal(http.status, 200);
    assert.equal(http.html, true);
    assert.ok(http.bytes > 1000);
    const heartbeat = protocol(await run(node, [controller, "heartbeat", "--root", root, "--instance-id", instanceId, "--client-lease-id", attached.clientLeaseId], { cwd: temporary, env }), "heartbeat");
    assert.equal(heartbeat.health.healthy, true);
    const logs = protocol(await run(node, [controller, "logs", "--root", root, "--instance-id", instanceId], { cwd: temporary, env }), "logs");
    assert.ok(!logs.text.includes(credential));
    await run(node, [controller, "release", "--root", root, "--instance-id", instanceId, "--client-lease-id", attached.clientLeaseId], { cwd: temporary, env });
    await new Promise((resolveWait) => setTimeout(resolveWait, 1_500));
    const idleStatus = protocol(await run(node, [controller, "status", "--root", root, "--instance-id", instanceId], { cwd: temporary, env }), "unknown activity status");
    assert.equal(idleStatus.active, true, "Real Host stopped while activity was unknown.");
    protocol(await run(node, [controller, "stop", "--root", root, "--instance-id", instanceId, "--timeout-ms", "30000"], { cwd: temporary, env }), "stop");
    const stopped = protocol(await run(node, [controller, "status", "--root", root, "--instance-id", instanceId], { cwd: temporary, env }), "stopped status");
    assert.equal(stopped.active, false);
    protocol(await run(node, [controller, "uninstall", "--root", root, "--version", DSH_VERSION], { cwd: temporary, env }), "uninstall");
    process.stdout.write(`${JSON.stringify({ ok: true, platform: "darwin", arch: "arm64", pnpmVersion: PNPM_VERSION, httpStatus: http.status, install: "verified", attach: "verified", unknownActivityKeptRunning: true, gracefulStop: "verified" }, null, 2)}\n`);
  } finally {
    if (instanceId) {
      await run(node, [controller, "stop", "--root", root, "--instance-id", instanceId, "--timeout-ms", "30000"], { cwd: temporary, env }).catch(() => {});
    }
    await rm(temporary, { recursive: true, force: true });
  }
}

if (process.env.DSH_SSH_REMOTE_MACOS_SMOKE !== '1') {
  process.stderr.write('Set DSH_SSH_REMOTE_MACOS_SMOKE=1 to explicitly run the isolated macOS runtime smoke test.\n');
  process.exitCode = 1;
} else main().catch((error) => {
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exitCode = 1;
});
