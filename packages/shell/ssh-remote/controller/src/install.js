import { randomUUID } from "node:crypto";
import { cp, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { CONTROLLER_VERSION, PROTOCOL_VERSION, RUNTIME_SCHEMA_VERSION } from "./constants.js";
import { RemoteError, invalidArgument } from "./errors.js";
import { currentTarget, runtimeId } from "./platform.js";
import { runProcess } from "./process.js";
import { withLock } from "./locks.js";
import { atomicWriteJson, ensureControllerDirectories, pathExists, readJson, safeRelativeArchivePath, sha256File } from "./util.js";

export function validateArchiveListing(names, verbose) {
  const paths = names.split("\n").filter((line) => line.length > 0);
  if (paths.length === 0) throw new RemoteError("REMOTE_INSTALL_FAILED", "The runtime archive is empty.");
  for (const path of paths) {
    if (!safeRelativeArchivePath(path)) {
      throw new RemoteError("REMOTE_INSTALL_FAILED", `Unsafe runtime archive path: ${JSON.stringify(path)}.`);
    }
  }
  for (const line of verbose.split("\n").filter(Boolean)) {
    if (!["-", "d"].includes(line[0])) {
      throw new RemoteError("REMOTE_INSTALL_FAILED", "Runtime archives may contain only regular files and directories.");
    }
  }
  return paths;
}

export function validateRuntimeManifest(manifest) {
  const stringFields = ["dshVersion", "buildId", "nodeVersion", "platform", "arch", "libc", "runtimeId"];
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new RemoteError("REMOTE_INSTALL_FAILED", "The runtime manifest is missing.");
  }
  if (manifest.schemaVersion !== RUNTIME_SCHEMA_VERSION || manifest.protocolVersion !== PROTOCOL_VERSION) {
    throw new RemoteError("REMOTE_VERSION_MISMATCH", "The runtime package uses an incompatible manifest or control protocol.");
  }
  for (const field of stringFields) {
    if (typeof manifest[field] !== "string" || manifest[field].length === 0 || manifest[field].length > 512) {
      throw new RemoteError("REMOTE_INSTALL_FAILED", `Runtime manifest field ${field} is invalid.`);
    }
  }
  const expectedId = runtimeId(manifest.dshVersion, manifest, manifest.controllerVersion ?? null);
  if (manifest.runtimeId !== expectedId) {
    throw new RemoteError("REMOTE_INSTALL_FAILED", "The runtime manifest ID does not match its version and target.");
  }
  return manifest;
}

async function assertRegularTree(root) {
  const pending = [root];
  while (pending.length) {
    const path = pending.pop();
    const info = await lstat(path);
    if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) {
      throw new RemoteError("REMOTE_INSTALL_FAILED", "Extracted runtime contains a link or special file.");
    }
    if ((info.mode & 0o7000) !== 0) {
      throw new RemoteError("REMOTE_INSTALL_FAILED", "Extracted runtime contains setuid, setgid, or sticky file modes.");
    }
    if (info.isDirectory()) {
      for (const entry of await readdir(path)) pending.push(join(path, entry));
    }
  }
}

async function selfCheck(runtimeRoot, manifest, signal) {
  const node = resolve(runtimeRoot, "bin", "node");
  const dsh = resolve(runtimeRoot, "app", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
  const controller = resolve(runtimeRoot, "controller", "src", "cli.js");
  const frontend = resolve(runtimeRoot, "app", "node_modules", "@deepseek-ai", "dsh-web-frontend", "dist", "index.html");
  if (!await pathExists(frontend)) throw new RemoteError("REMOTE_INSTALL_FAILED", "Web frontend assets are absent from the runtime package.");
  const nodeResult = await runProcess(node, ["--version"], { signal, code: "REMOTE_INSTALL_FAILED" });
  if (nodeResult.stdout !== manifest.nodeVersion) {
    throw new RemoteError("REMOTE_VERSION_MISMATCH", `Bundled Node reported ${nodeResult.stdout}; expected ${manifest.nodeVersion}.`);
  }
  const dshResult = await runProcess(node, [dsh, "--version"], { signal, code: "REMOTE_INSTALL_FAILED" });
  if (dshResult.stdout !== manifest.dshVersion) {
    throw new RemoteError("REMOTE_VERSION_MISMATCH", `Bundled DSH reported ${dshResult.stdout}; expected ${manifest.dshVersion}.`);
  }
  if (manifest.pnpmVersion !== undefined) {
    const pnpm = resolve(runtimeRoot, "app", "node_modules", "pnpm", "bin", "pnpm.cjs");
    const pnpmResult = await runProcess(node, [pnpm, "--version"], { signal, code: "REMOTE_INSTALL_FAILED" });
    if (pnpmResult.stdout !== manifest.pnpmVersion) {
      throw new RemoteError("REMOTE_VERSION_MISMATCH", `Bundled pnpm reported ${pnpmResult.stdout}; expected ${manifest.pnpmVersion}.`);
    }
  }
  const controllerResult = await runProcess(node, [controller, "probe", "--request-id", "install-self-check"], { signal, code: "REMOTE_INSTALL_FAILED" });
  let response;
  try {
    response = JSON.parse(controllerResult.stdout);
  } catch (error) {
    throw new RemoteError("REMOTE_INSTALL_FAILED", "Controller self-check did not return valid JSON.", { cause: error });
  }
  if (!response.ok || response.protocolVersion !== PROTOCOL_VERSION) {
    throw new RemoteError("REMOTE_INSTALL_FAILED", "Controller self-check failed its protocol check.");
  }
}

export async function installRuntime(options) {
  if (!options.packagePath) throw invalidArgument("install requires --package.");
  if (!/^[a-f0-9]{64}$/iu.test(options.sha256 ?? "")) throw invalidArgument("install requires --sha256 with 64 hexadecimal digits.");
  const target = await currentTarget();
  const paths = await ensureControllerDirectories(options.root);
  const actualSha256 = await sha256File(options.packagePath, options.signal);
  if (actualSha256 !== options.sha256.toLowerCase()) {
    throw new RemoteError("REMOTE_SHA256_MISMATCH", "Runtime package SHA256 does not match the expected digest.", {
      details: { expected: options.sha256.toLowerCase(), actual: actualSha256 }
    });
  }

  const names = await runProcess("tar", ["-tzf", options.packagePath], { signal: options.signal, maxBuffer: 32 * 1024 * 1024, code: "REMOTE_INSTALL_FAILED" });
  const verbose = await runProcess("tar", ["-tvzf", options.packagePath], { signal: options.signal, maxBuffer: 32 * 1024 * 1024, code: "REMOTE_INSTALL_FAILED" });
  validateArchiveListing(names.stdout, verbose.stdout);

  const staging = resolve(paths.servers, `.staging-${randomUUID()}`);
  const extractedRoot = resolve(staging, "runtime");
  let finalPath;
  try {
    await ensureControllerDirectories(staging);
    await runProcess("tar", ["-xzf", options.packagePath, "--no-same-owner", "--no-same-permissions", "-C", staging], {
      signal: options.signal,
      timeoutMs: options.timeoutMs ?? 120_000,
      maxBuffer: 1024 * 1024,
      code: "REMOTE_INSTALL_FAILED"
    });
    await assertRegularTree(staging);
    const manifest = validateRuntimeManifest(await readJson(resolve(extractedRoot, "manifest.json")));
    if (manifest.platform !== target.platform || manifest.arch !== target.arch || manifest.libc !== target.libc) {
      throw new RemoteError("REMOTE_PLATFORM_UNSUPPORTED", `Runtime target ${manifest.platform}-${manifest.arch}-${manifest.libc} does not match ${target.platform}-${target.arch}-${target.libc}.`);
    }
    if (options.expectedVersion && manifest.dshVersion !== options.expectedVersion) {
      throw new RemoteError("REMOTE_VERSION_MISMATCH", `Runtime DSH ${manifest.dshVersion} does not match expected ${options.expectedVersion}.`);
    }
    finalPath = resolve(paths.servers, manifest.runtimeId);
    if (!finalPath.startsWith(`${paths.servers}${sep}`)) throw new RemoteError("REMOTE_INSTALL_FAILED", "Runtime destination escapes the server directory.");

    return await withLock(paths.locks, `install-${manifest.runtimeId}`, async () => {
      if (await pathExists(finalPath)) {
        const installedManifest = validateRuntimeManifest(await readJson(resolve(finalPath, "manifest.json")));
        const receipt = await readJson(resolve(finalPath, "install-receipt.json"), { optional: true });
        if (receipt && receipt.sha256 !== actualSha256) {
          throw new RemoteError("REMOTE_INSTALL_FAILED", "An immutable runtime with this ID already exists with a different source digest.");
        }
        return { installed: true, alreadyInstalled: true, runtime: installedManifest, path: finalPath, sha256: actualSha256 };
      }
      try {
        await selfCheck(extractedRoot, manifest, options.signal);
      } catch (error) {
        const quarantine = resolve(paths.tmp, `quarantine-${randomUUID()}`);
        await rename(extractedRoot, quarantine).catch(() => {});
        throw new RemoteError("REMOTE_INSTALL_FAILED", "Runtime self-check failed; the package was quarantined and not published.", {
          cause: error,
          details: { quarantine }
        });
      }
      await atomicWriteJson(resolve(extractedRoot, "install-receipt.json"), { schemaVersion: 1, sha256: actualSha256, installedBy: PROTOCOL_VERSION });
      await rename(extractedRoot, finalPath);
      return { installed: true, alreadyInstalled: false, runtime: manifest, path: finalPath, sha256: actualSha256 };
    }, { signal: options.signal, timeoutMs: options.lockTimeoutMs });
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}

export async function readInstalledRuntime(root, id) {
  const paths = await ensureControllerDirectories(root);
  const path = resolve(paths.servers, id);
  if (!path.startsWith(`${paths.servers}${sep}`)) throw invalidArgument("Invalid runtime ID.");
  const manifest = validateRuntimeManifest(await readJson(resolve(path, "manifest.json")));
  if (manifest.runtimeId !== id) throw new RemoteError("REMOTE_VERSION_MISMATCH", "Installed runtime directory and manifest IDs differ.");
  return { path, manifest };
}

const MINIMUM_NODE_MAJOR = 22;

function nodeMajor(value) {
  const match = /^v?(\d+)\./u.exec(typeof value === "string" ? value : "");
  return match === null ? null : Number(match[1]);
}

async function remoteToolVersion(command, code, message, signal) {
  try {
    const result = await runProcess(command, ["--version"], { signal, timeoutMs: 10_000, code });
    return result.stdout;
  } catch (error) {
    throw new RemoteError(code, message, { cause: error });
  }
}

/** Install the platform's sharp binaries that `--omit=optional` skipped. */
async function installSharpBinaries(app, target, signal) {
  const manifestPath = resolve(app, "node_modules", "sharp", "package.json");
  if (!await pathExists(manifestPath)) return;
  const optional = (await readJson(manifestPath, { optional: true }))?.optionalDependencies ?? {};
  const musl = target.platform === "linux" && target.libc === "musl";
  const suffix = `${target.platform}${musl ? "musl" : ""}-${target.arch}`;
  const wanted = Object.entries(optional)
    .filter(([name]) => (name.startsWith("@img/sharp-") || name.startsWith("@img/sharp-libvips-")) && name.endsWith(suffix))
    .map(([name, version]) => `${name}@${version}`);
  if (wanted.length === 0) return;
  await runProcess("npm", ["install", "--no-save", "--no-audit", "--no-fund", "--loglevel=error", ...wanted], {
    cwd: app, signal, timeoutMs: 240_000, code: "REMOTE_INSTALL_FAILED"
  });
}

/**
 * Install a runtime by running `npm install @deepseek-ai/dsh@<version>` on the
 * remote host. Node.js and npm must already be present; the runtime records the
 * remote Node version and never ships a bundled Node binary.
 */
export async function installRuntimeFromNpm(options) {
  const dshVersion = String(options.dshVersion ?? "");
  if (!/^[0-9A-Za-z][0-9A-Za-z.+~-]{0,127}$/u.test(dshVersion)) throw invalidArgument("install --mode npm requires a valid --dsh-version value.");
  if (!options.controllerSource) throw invalidArgument("install --mode npm requires --controller-source.");
  const target = await currentTarget();
  const paths = await ensureControllerDirectories(options.root);
  const id = runtimeId(dshVersion, target);
  const buildId = `npm:${dshVersion}`;
  const finalPath = resolve(paths.servers, id);
  if (!finalPath.startsWith(`${paths.servers}${sep}`)) throw new RemoteError("REMOTE_INSTALL_FAILED", "Runtime destination escapes the server directory.");

  const nodeVersion = await remoteToolVersion("node", "REMOTE_NODE_MISSING",
    `Node.js is not installed on the remote host. Install Node.js ${MINIMUM_NODE_MAJOR} or newer and retry.`, options.signal);
  if ((nodeMajor(nodeVersion) ?? 0) < MINIMUM_NODE_MAJOR) {
    throw new RemoteError("REMOTE_NODE_UNSUPPORTED", `The remote Node.js ${nodeVersion} is older than ${MINIMUM_NODE_MAJOR}. Install Node.js ${MINIMUM_NODE_MAJOR} or newer and retry.`);
  }
  await remoteToolVersion("npm", "REMOTE_NPM_MISSING", "npm is not available on the remote host. Install npm and retry.", options.signal);

  return await withLock(paths.locks, `install-${id}`, async () => {
    if (await pathExists(finalPath)) {
      const installedManifest = validateRuntimeManifest(await readJson(resolve(finalPath, "manifest.json")));
      return { installed: true, alreadyInstalled: true, runtime: installedManifest, path: finalPath };
    }
    const staging = resolve(paths.tmp, `.staging-${randomUUID()}`);
    try {
      const app = resolve(staging, "app");
      await mkdir(app, { recursive: true });
      await atomicWriteJson(resolve(app, "package.json"), { name: "dsh-remote-runtime", private: true, dependencies: { "@deepseek-ai/dsh": dshVersion } }, 0o600);
      await runProcess("npm", ["install", "--omit=optional", "--no-audit", "--no-fund", "--loglevel=error"], {
        cwd: app, signal: options.signal, timeoutMs: options.timeoutMs ?? 600_000, maxBuffer: 8 * 1024 * 1024, code: "REMOTE_INSTALL_FAILED"
      });
      await installSharpBinaries(app, target, options.signal);
      const installedDsh = await readJson(resolve(app, "node_modules", "@deepseek-ai", "dsh", "package.json"));
      if (installedDsh.version !== dshVersion) {
        throw new RemoteError("REMOTE_VERSION_MISMATCH", `npm installed DSH ${installedDsh.version}; expected ${dshVersion}.`);
      }
      await cp(options.controllerSource, resolve(staging, "controller"), { recursive: true });
      if (options.pluginsSource) await cp(options.pluginsSource, resolve(staging, "plugins"), { recursive: true });
      await mkdir(resolve(staging, "bin"), { recursive: true });
      const nodePath = process.execPath;
      await writeFile(resolve(staging, "bin", "node"), `#!/bin/sh\nexec "${nodePath}" "$@"\n`, { mode: 0o755 });
      await writeFile(resolve(staging, "bin", "dsh-ssh-remote-controller"),
        `#!/bin/sh\nset -eu\nBIN_DIR=$(CDPATH= cd -P "$(dirname "$0")" && pwd)\nROOT=$(CDPATH= cd -P "$BIN_DIR/.." && pwd)\nexec "$ROOT/bin/node" "$ROOT/controller/src/cli.js" "$@"\n`, { mode: 0o755 });
      const manifest = {
        schemaVersion: RUNTIME_SCHEMA_VERSION,
        protocolVersion: PROTOCOL_VERSION,
        runtimeId: id,
        dshVersion,
        buildId,
        controllerVersion: CONTROLLER_VERSION,
        nodeVersion,
        platform: target.platform,
        arch: target.arch,
        libc: target.libc,
        installMode: "npm"
      };
      validateRuntimeManifest(manifest);
      try {
        await selfCheck(staging, manifest, options.signal);
      } catch (error) {
        const quarantine = resolve(paths.tmp, `quarantine-${randomUUID()}`);
        await rename(staging, quarantine).catch(() => {});
        throw new RemoteError("REMOTE_INSTALL_FAILED", "Runtime self-check failed; the install was quarantined and not published.", {
          cause: error,
          details: { quarantine }
        });
      }
      await atomicWriteJson(resolve(staging, "install-receipt.json"), {
        schemaVersion: 1, installMode: "npm", dshVersion, controllerVersion: CONTROLLER_VERSION, installedBy: PROTOCOL_VERSION
      });
      await atomicWriteJson(resolve(staging, "manifest.json"), manifest);
      await rename(staging, finalPath);
      return { installed: true, alreadyInstalled: false, runtime: manifest, path: finalPath };
    } finally {
      await rm(staging, { recursive: true, force: true }).catch(() => {});
    }
  }, { signal: options.signal, timeoutMs: options.lockTimeoutMs });
}
