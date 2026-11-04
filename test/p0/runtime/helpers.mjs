import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CONTROLLER_VERSION, DSH_BUILD_ID, DSH_VERSION, NODE_VERSION, PNPM_VERSION, PROTOCOL_VERSION, RUNTIME_SCHEMA_VERSION } from "../../../packages/shell/ssh-remote/controller/src/constants.js";
import { currentTarget, runtimeId } from "../../../packages/shell/ssh-remote/controller/src/platform.js";

export const TEST_DIRECTORY = dirname(fileURLToPath(import.meta.url));
export const CONTROLLER_CLI = resolve(TEST_DIRECTORY, "../../../packages/shell/ssh-remote/controller/src/cli.js");
export const CONTROLLER_SOURCE = resolve(TEST_DIRECTORY, "../../../packages/shell/ssh-remote/controller/src");

export async function temporaryDirectory(t) {
  const path = await mkdtemp(resolve(TEST_DIRECTORY, ".tmp-"));
  t.after(async () => rm(path, { recursive: true, force: true }));
  return path;
}

export function invoke(args, options = {}) {
  return new Promise((resolveInvoke, reject) => {
    const child = spawn(process.execPath, [CONTROLLER_CLI, ...args], {
      env: { ...process.env, ...options.env },
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
      let response;
      try {
        response = JSON.parse(stdout);
      } catch (error) {
        reject(new Error(`Controller stdout was not JSON: ${stdout}\n${stderr}`, { cause: error }));
        return;
      }
      resolveInvoke({ code, signal, stdout, stderr, response });
    });
  });
}

export async function makeFakeRuntime(root) {
  const target = await currentTarget();
  const id = runtimeId(DSH_VERSION, target);
  const runtimeRoot = resolve(root, "servers", id);
  await mkdir(resolve(runtimeRoot, "bin"), { recursive: true });
  await symlink(process.execPath, resolve(runtimeRoot, "bin", "node"));
  await writeFile(resolve(runtimeRoot, "bin", "pnpm"), `#!/bin/sh\nprintf '%s\\n' '${PNPM_VERSION}'\n`, { mode: 0o755 });
  await cp(CONTROLLER_SOURCE, resolve(runtimeRoot, "controller", "src"), { recursive: true });
  const dshLib = resolve(runtimeRoot, "app", "node_modules", "@deepseek-ai", "dsh", "lib");
  await mkdir(dshLib, { recursive: true });
  const fakeHost = `import http from "node:http";
import { spawnSync } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
if (process.env.FAKE_HOST_ARGS_FILE) writeFileSync(process.env.FAKE_HOST_ARGS_FILE, JSON.stringify(process.argv.slice(2)));
if (process.env.FAKE_HOST_PNPM_RESULT_FILE) {
  const result = spawnSync("pnpm", ["--version"], { encoding: "utf8" });
  writeFileSync(process.env.FAKE_HOST_PNPM_RESULT_FILE, JSON.stringify({ path: process.env.PATH, status: result.status, stdout: result.stdout, error: result.error?.code }));
}
const server = http.createServer((request, response) => {
  response.writeHead(request.url.includes("token=super-secret-token") ? 200 : 401, { "content-type": "text/plain" });
  response.end(request.url.includes("token=super-secret-token") ? "remote-ok" : "unauthorized");
});
server.listen(0, "127.0.0.1", () => {
  console.log("dsh web: http://127.0.0.1:" + server.address().port + "/?token=super-secret-token");
});
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => {
  if (process.env.FAKE_HOST_STOP_FILE) appendFileSync(process.env.FAKE_HOST_STOP_FILE, signal + "\\n");
  server.close(() => process.exit(0));
});
`;
  await writeFile(resolve(dshLib, "bin.js"), fakeHost);
  const manifest = {
    schemaVersion: RUNTIME_SCHEMA_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    dshVersion: DSH_VERSION,
    buildId: DSH_BUILD_ID,
    controllerVersion: CONTROLLER_VERSION,
    nodeVersion: NODE_VERSION,
    pnpmVersion: PNPM_VERSION,
    platform: target.platform,
    arch: target.arch,
    libc: target.libc,
    runtimeId: id
  };
  await writeFile(resolve(runtimeRoot, "manifest.json"), `${JSON.stringify(manifest)}\n`);
  return { runtimeRoot, id, manifest };
}

export async function readRecord(root, instanceId) {
  return JSON.parse(await readFile(resolve(root, "instances", instanceId, "record.json"), "utf8"));
}
