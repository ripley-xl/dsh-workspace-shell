import assert from "node:assert/strict";
import { cp, mkdir, readdir, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import test from "node:test";
import { acquireLock } from "../../../controller/src/locks.js";
import { validateArchiveListing, validateRuntimeManifest } from "../../../controller/src/install.js";
import { bounded, redactSecrets, safeRelativeArchivePath, sha256File, sleep } from "../../../controller/src/util.js";
import { CONTROLLER_VERSION, DSH_BUILD_ID, DSH_VERSION, NODE_VERSION, PROTOCOL_VERSION, RUNTIME_SCHEMA_VERSION } from "../../../controller/src/constants.js";
import { invoke, temporaryDirectory, CONTROLLER_SOURCE } from "./helpers.mjs";
import { currentTarget, runtimeId } from "../../../controller/src/platform.js";

const execFileAsync = promisify(execFile);

test("probe emits one JSON protocol message and preserves requestId", async (t) => {
  const root = await temporaryDirectory(t);
  const result = await invoke(["probe", "--root", root, "--request-id", "probe-test"]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.response.protocolVersion, 1);
  assert.equal(result.response.controllerVersion, CONTROLLER_VERSION);
  assert.equal(result.response.requestId, "probe-test");
  assert.equal(result.response.ok, true);
  assert.equal(result.stdout.trim().split("\n").length, 1);
  assert.equal(typeof result.response.result.rootWritable, "boolean");
});

test("archive validation rejects traversal, absolute paths, links, and special files", () => {
  assert.equal(safeRelativeArchivePath("runtime/bin/node"), true);
  assert.equal(safeRelativeArchivePath("../outside"), false);
  assert.equal(safeRelativeArchivePath("runtime/../../outside"), false);
  assert.equal(safeRelativeArchivePath("/etc/passwd"), false);
  assert.throws(() => validateArchiveListing("../outside\n", "-rw-r--r-- 1 root root 1 ../outside"), /Unsafe runtime archive path/u);
  assert.throws(() => validateArchiveListing("runtime/link\n", "lrwxr-xr-x 1 root root 1 runtime/link"), /only regular files and directories/u);
  assert.equal(validateArchiveListing("runtime/\nruntime/bin/node\n", "drwxr-xr-x 1 root root 0 runtime/\n-rwxr-xr-x 1 root root 1 runtime/bin/node").length, 2);
});

test("runtime manifest validates its immutable identity", () => {
  const manifest = {
    schemaVersion: RUNTIME_SCHEMA_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    dshVersion: DSH_VERSION,
    buildId: DSH_BUILD_ID,
    nodeVersion: NODE_VERSION,
    platform: "linux",
    arch: "x64",
    libc: "glibc",
    runtimeId: `${DSH_VERSION}-linux-x64-glibc`
  };
  assert.equal(validateRuntimeManifest(manifest), manifest);
  assert.throws(() => validateRuntimeManifest({ ...manifest, runtimeId: "other" }), /does not match/u);
  assert.throws(() => validateRuntimeManifest({ ...manifest, protocolVersion: 99 }), /incompatible/u);
});

test("install rejects a SHA256 mismatch before extraction or publication", async (t) => {
  const root = await temporaryDirectory(t);
  const archive = resolve(root, "bad.tar.gz");
  await writeFile(archive, "not an archive");
  const actual = await sha256File(archive);
  const expected = "0".repeat(64);
  assert.notEqual(actual, expected);
  const result = await invoke(["install", "--root", root, "--package", archive, "--sha256", expected, "--request-id", "bad-sha"]);
  assert.equal(result.code, 1);
  assert.equal(result.response.ok, false);
  assert.equal(result.response.requestId, "bad-sha");
  assert.equal(result.response.error.code, "REMOTE_SHA256_MISMATCH");
  assert.doesNotMatch(result.stdout, /not an archive/u);
});

test("install self-checks, atomically publishes, and reuses an identical runtime", async (t) => {
  const temporary = await temporaryDirectory(t);
  const root = resolve(temporary, "controller");
  const stage = resolve(temporary, "stage", "runtime");
  const archive = resolve(temporary, "fixture.tar.gz");
  const target = await currentTarget();
  const id = runtimeId(DSH_VERSION, target);
  await mkdir(resolve(stage, "bin"), { recursive: true });
  const quotedNode = `'${process.execPath.replaceAll("'", `'"'"'`)}'`;
  await writeFile(resolve(stage, "bin", "node"), `#!/bin/sh\nexec ${quotedNode} "$@"\n`, { mode: 0o755 });
  await cp(CONTROLLER_SOURCE, resolve(stage, "controller", "src"), { recursive: true });
  const dshLib = resolve(stage, "app", "node_modules", "@deepseek-ai", "dsh", "lib");
  const frontend = resolve(stage, "app", "node_modules", "@deepseek-ai", "dsh-web-frontend", "dist");
  await mkdir(dshLib, { recursive: true });
  await mkdir(frontend, { recursive: true });
  await writeFile(resolve(dshLib, "bin.js"), `console.log(${JSON.stringify(DSH_VERSION)});\n`);
  await writeFile(resolve(frontend, "index.html"), "<!doctype html>\n");
  const manifest = {
    schemaVersion: RUNTIME_SCHEMA_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    dshVersion: DSH_VERSION,
    buildId: DSH_BUILD_ID,
    controllerVersion: CONTROLLER_VERSION,
    nodeVersion: process.version,
    platform: target.platform,
    arch: target.arch,
    libc: target.libc,
    runtimeId: id
  };
  await writeFile(resolve(stage, "manifest.json"), JSON.stringify(manifest));
  await execFileAsync("tar", ["-czf", archive, "-C", resolve(temporary, "stage"), "runtime"]);
  const digest = await sha256File(archive);
  const args = ["install", "--root", root, "--package", archive, "--sha256", digest];
  const installed = await invoke(args);
  assert.equal(installed.code, 0, installed.stderr);
  assert.equal(installed.response.result.alreadyInstalled, false);
  assert.equal(installed.response.result.runtime.runtimeId, id);
  const entries = await readdir(resolve(root, "servers"));
  assert.deepEqual(entries, [id]);
  const repeated = await invoke(args);
  assert.equal(repeated.code, 0, repeated.stderr);
  assert.equal(repeated.response.result.alreadyInstalled, true);
});

test("install lock excludes concurrent writers and can be reacquired", async (t) => {
  const root = await temporaryDirectory(t);
  const first = await acquireLock(root, "install-test", { timeoutMs: 100 });
  await assert.rejects(acquireLock(root, "install-test", { timeoutMs: 100 }), (error) => error.code === "REMOTE_LOCK_TIMEOUT");
  await first.release();
  const second = await acquireLock(root, "install-test", { timeoutMs: 100 });
  await second.release();
});

test("bounded operations abort their child signal on timeout", async () => {
  await assert.rejects(bounded((signal) => sleep(10_000, signal), 20), (error) => error.code === "OPERATION_TIMEOUT");
});

test("log redaction removes URL credentials and authorization values", () => {
  const text = "dsh web: http://127.0.0.1:1234/?token=very-secret&ok=1 Authorization: Bearer-secret";
  const redacted = redactSecrets(text);
  assert.doesNotMatch(redacted, /very-secret|Bearer-secret/u);
  assert.match(redacted, /ok=1/u);
  assert.match(redacted, /redacted/u);
});
