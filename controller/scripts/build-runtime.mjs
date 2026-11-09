#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, cp, mkdir, readFile, readdir, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { finished } from "node:stream/promises";
import { createHash } from "node:crypto";
import { parseArgs } from "node:util";
import { DSH_BUILD_ID, DSH_VERSION, NODE_VERSION, PNPM_VERSION, PROTOCOL_VERSION, RUNTIME_SCHEMA_VERSION, CONTROLLER_VERSION } from "../src/constants.js";
import { runtimeId } from "../src/platform.js";

const CONTROLLER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const NODE_ARTIFACTS = {
  "linux-x64-glibc": {
    file: `node-${NODE_VERSION}-linux-x64.tar.gz`,
    sha256: "eb6728e77c576a35162c122c45ccadf224d89ff00abc8dae46cc2897c6002d7c"
  },
  "linux-arm64-glibc": {
    file: `node-${NODE_VERSION}-linux-arm64.tar.gz`,
    sha256: "33c37be234ba8bee041961047b19160f4d7d0f164e8e246f78bdd10feff148b3"
  },
  "linux-x64-musl": {
    file: `node-${NODE_VERSION}-linux-x64-musl.tar.gz`,
    sha256: "9b250d29d6ab8ae38dd23019e2c04a6d6b2916ab1dad721c5f6e1da2b2901c6a"
  },
  "darwin-arm64-none": {
    file: `node-${NODE_VERSION}-darwin-arm64.tar.gz`,
    sha256: "89c682593d76cd44233fa53b1563264e7de9cbb189cad169135c5b4fadfbc0a7"
  },
  "darwin-x64-none": {
    file: `node-${NODE_VERSION}-darwin-x64.tar.gz`,
    sha256: "d132557e7ee2b85af08b0c8c34338e65c6430f2238d01f727728ef42dc83b035"
  }
};

function run(file, args, options = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(file, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: options.stdio ?? ["ignore", "inherit", "inherit"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolveRun({ stdout, stderr });
      else reject(new Error(`${file} exited with ${code ?? signal}.\n${stderr.slice(-4096)}`));
    });
  });
}

async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function downloadNode(artifact, cache) {
  await mkdir(cache, { recursive: true });
  const destination = resolve(cache, artifact.file);
  try {
    if (await sha256File(destination) === artifact.sha256) return destination;
    await rm(destination, { force: true });
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const url = `https://nodejs.org/dist/${NODE_VERSION}/${artifact.file}`;
  process.stderr.write(`Downloading ${url}\n`);
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`Node download returned HTTP ${response.status}.`);
  const temporary = `${destination}.${process.pid}.download`;
  const bytes = Buffer.from(await response.arrayBuffer());
  await writeFile(temporary, bytes, { mode: 0o600 });
  const actual = await sha256File(temporary);
  if (actual !== artifact.sha256) {
    await rm(temporary, { force: true });
    throw new Error(`Node SHA256 mismatch: expected ${artifact.sha256}, got ${actual}.`);
  }
  await rename(temporary, destination);
  return destination;
}

async function normalizeTree(root) {
  const epoch = new Date(0);
  const executableFiles = new Set(["bin/node", "bin/dsh", "bin/pnpm", "bin/dsh-ssh-remote-controller", "controller/src/cli.js", "controller/src/supervisor.js"]);
  async function visit(path) {
    const info = await stat(path);
    const rel = relative(root, path);
    if (info.isDirectory()) {
      await chmod(path, 0o755);
      const entries = await readdir(path);
      for (const entry of entries.sort()) await visit(resolve(path, entry));
      await utimes(path, epoch, epoch);
    } else if (info.isFile()) {
      await chmod(path, executableFiles.has(rel) || info.path?.endsWith("spawn-helper") || path.endsWith("/spawn-helper") ? 0o755 : 0o644);
      await utimes(path, epoch, epoch);
    } else {
      throw new Error(`Runtime staging contains unsupported file type at ${rel}.`);
    }
  }
  await visit(root);
  await utimes(root, epoch, epoch);
}

async function archiveEntries(root) {
  const paths = ["runtime"];
  async function visit(path) {
    const entries = await readdir(path, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const child = resolve(path, entry.name);
      const rel = `runtime/${relative(root, child)}`;
      paths.push(rel);
      if (entry.isDirectory()) await visit(child);
      else if (!entry.isFile()) throw new Error(`Unsupported archive entry ${rel}.`);
    }
  }
  await visit(root);
  return paths.sort();
}

async function createDeterministicArchive(root, destination) {
  const parent = dirname(root);
  const listPath = resolve(parent, "archive-files.txt");
  const entries = await archiveEntries(root);
  await writeFile(listPath, `${entries.join("\n")}\n`, { mode: 0o600 });
  const version = await run("tar", ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
  const gnu = version.stdout.startsWith("tar ");
  const args = gnu
    ? ["--format=gnu", "--owner=0", "--group=0", "--numeric-owner", "--no-recursion", "-cf", "-", "-C", parent, "-T", listPath]
    : ["--format=gnutar", "--uid", "0", "--gid", "0", "--uname", "root", "--gname", "root", "--no-recursion", "-cf", "-", "-C", parent, "-T", listPath];
  const temporary = `${destination}.${process.pid}.tmp`;
  const tar = spawn("tar", args, { env: { ...process.env, COPYFILE_DISABLE: "1", LC_ALL: "C" }, stdio: ["ignore", "pipe", "inherit"] });
  const gzip = spawn("gzip", ["-n", "-9"], { stdio: ["pipe", "pipe", "inherit"] });
  const output = createWriteStream(temporary, { mode: 0o600 });
  tar.stdout.pipe(gzip.stdin);
  gzip.stdout.pipe(output);
  const wait = (child, label) => new Promise((resolveWait, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0 ? resolveWait() : reject(new Error(`${label} exited with ${code ?? signal}.`)));
  });
  await Promise.all([wait(tar, "tar"), wait(gzip, "gzip"), finished(output)]);
  await rename(temporary, destination);
  await rm(listPath, { force: true });
}

async function assertRuntimeContents(runtimeRoot, platform, arch, libc) {
  const required = [
    "bin/node",
    "bin/pnpm",
    "app/node_modules/pnpm/bin/pnpm.cjs",
    "controller/src/cli.js",
    "controller/src/supervisor.js",
    "plugins/status/package.json",
    "plugins/status/index.js",
    "plugins/status/client.js",
    "plugins/status/src/host/index.js",
    "plugins/status/cordis.patch.yml",
    "plugins/guest-cwd/package.json",
    "plugins/guest-cwd/index.js",
    "plugins/guest-cwd/client.js",
    "plugins/guest-cwd/cordis.patch.yml",
    "plugins/guest-notify/package.json",
    "plugins/guest-notify/index.js",
    "plugins/guest-notify/client.js",
    "plugins/guest-notify/cordis.patch.yml",
    "app/node_modules/@deepseek-ai/dsh/lib/bin.js",
    "app/node_modules/@deepseek-ai/dsh-web-app/lib/index.js",
    "app/node_modules/@deepseek-ai/dsh-web-frontend/dist/index.html"
  ];
  if (platform === "linux") {
    required.push(
      `app/node_modules/node-addon-require-builtin-linux-${arch}-${libc === "glibc" ? "gnu" : "musl"}`,
      `app/node_modules/@deepseek-ai/node-addon-system-linux-${arch}/bin/${libc}/system.node`,
      `app/node_modules/@img/sharp-linux-${arch}`,
      `app/node_modules/@koromix/koffi-linux-${arch}`,
      `app/node_modules/node-pty/prebuilds/linux-${arch}/pty.node`
    );
  } else {
    required.push(
      `app/node_modules/node-addon-require-builtin-darwin-${arch}/prebuilt/darwin-${arch}-napi-v9.node`,
      `app/node_modules/@deepseek-ai/node-addon-system-darwin-${arch}/bin/system.node`,
      `app/node_modules/@img/sharp-darwin-${arch}/lib/sharp-darwin-${arch}-0.35.5.node`,
      `app/node_modules/@koromix/koffi-darwin-${arch}/darwin_${arch}/koffi.node`,
      `app/node_modules/sherpa-onnx-darwin-${arch}/sherpa-onnx.node`,
      `app/node_modules/node-pty/prebuilds/darwin-${arch}/pty.node`,
      `app/node_modules/node-pty/prebuilds/darwin-${arch}/spawn-helper`
    );
  }
  for (const path of required) {
    try {
      await stat(resolve(runtimeRoot, path));
    } catch {
      throw new Error(`Runtime is missing required dependency or asset: ${path}.`);
    }
  }
}

async function buildTarget(platform, arch, libc, options) {
  const artifact = NODE_ARTIFACTS[`${platform}-${arch}-${libc}`];
  if (!artifact) throw new Error(`Node ${NODE_VERSION} has no pinned official ${platform}-${arch}-${libc} artifact.`);
  const id = runtimeId(DSH_VERSION, { platform, arch, libc });
  const work = resolve(options.work, id);
  const stage = resolve(work, "stage");
  const runtimeRoot = resolve(stage, "runtime");
  await rm(work, { recursive: true, force: true });
  await mkdir(runtimeRoot, { recursive: true });
  await mkdir(options.output, { recursive: true });
  await mkdir(options.cache, { recursive: true });

  const nodeArchive = await downloadNode(artifact, options.cache);
  const nodeExtract = resolve(work, "node");
  await mkdir(nodeExtract, { recursive: true });
  await run("tar", ["-xzf", nodeArchive, "--no-same-owner", "--no-same-permissions", "-C", nodeExtract]);
  await mkdir(resolve(runtimeRoot, "bin"), { recursive: true });
  await cp(resolve(nodeExtract, artifact.file.replace(/\.tar\.gz$/u, ""), "bin", "node"), resolve(runtimeRoot, "bin", "node"));

  const app = resolve(runtimeRoot, "app");
  await mkdir(app, { recursive: true });
  await cp(resolve(CONTROLLER_ROOT, "runtime", "package.json"), resolve(app, "package.json"));
  await cp(resolve(CONTROLLER_ROOT, "runtime", "package-lock.json"), resolve(app, "package-lock.json"));
  const npmArgs = ["ci", "--ignore-scripts", "--omit=dev", `--os=${platform}`, `--cpu=${arch}`, "--no-audit", "--no-fund"];
  if (platform === "linux") npmArgs.push(`--libc=${libc}`);
  await run("npm", npmArgs, { cwd: app });
  await cp(resolve(CONTROLLER_ROOT, "src"), resolve(runtimeRoot, "controller", "src"), { recursive: true });
  await cp(resolve(CONTROLLER_ROOT, "package.json"), resolve(runtimeRoot, "controller", "package.json"));
  await cp(resolve(CONTROLLER_ROOT, "..", "packages", "status"), resolve(runtimeRoot, "plugins", "status"), {
    recursive: true,
    filter: (source) => !source.split("/").includes("node_modules")
  });
  await cp(resolve(CONTROLLER_ROOT, "..", "packages", "shell", "guest-cwd"), resolve(runtimeRoot, "plugins", "guest-cwd"), { recursive: true });
  await cp(resolve(CONTROLLER_ROOT, "..", "packages", "shell", "guest-notify"), resolve(runtimeRoot, "plugins", "guest-notify"), { recursive: true });
  await rm(resolve(app, "node_modules", ".bin"), { recursive: true, force: true });

  const dshScript = `#!/bin/sh\nset -eu\nBIN_DIR=$(CDPATH= cd -P "$(dirname "$0")" && pwd)\nROOT=$(CDPATH= cd -P "$BIN_DIR/.." && pwd)\nexec "$ROOT/bin/node" "$ROOT/app/node_modules/@deepseek-ai/dsh/lib/bin.js" "$@"\n`;
  const controllerScript = `#!/bin/sh\nset -eu\nBIN_DIR=$(CDPATH= cd -P "$(dirname "$0")" && pwd)\nROOT=$(CDPATH= cd -P "$BIN_DIR/.." && pwd)\nexec "$ROOT/bin/node" "$ROOT/controller/src/cli.js" "$@"\n`;
  const pnpmScript = `#!/bin/sh\nset -eu\nBIN_DIR=$(CDPATH= cd -P "$(dirname "$0")" && pwd)\nROOT=$(CDPATH= cd -P "$BIN_DIR/.." && pwd)\nexec "$ROOT/bin/node" "$ROOT/app/node_modules/pnpm/bin/pnpm.cjs" "$@"\n`;
  await writeFile(resolve(runtimeRoot, "bin", "dsh"), dshScript, { mode: 0o755 });
  await writeFile(resolve(runtimeRoot, "bin", "pnpm"), pnpmScript, { mode: 0o755 });
  await writeFile(resolve(runtimeRoot, "bin", "dsh-ssh-remote-controller"), controllerScript, { mode: 0o755 });
  await assertRuntimeContents(runtimeRoot, platform, arch, libc);
  const pnpmCheck = await run(process.execPath, [resolve(runtimeRoot, "app", "node_modules", "pnpm", "bin", "pnpm.cjs"), "--version"], { stdio: ["ignore", "pipe", "pipe"] });
  if (pnpmCheck.stdout.trim() !== PNPM_VERSION) throw new Error(`pnpm CLI reported ${pnpmCheck.stdout.trim()}; expected ${PNPM_VERSION}.`);
  const manifest = {
    schemaVersion: RUNTIME_SCHEMA_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    dshVersion: DSH_VERSION,
    buildId: DSH_BUILD_ID,
    controllerVersion: CONTROLLER_VERSION,
    nodeVersion: NODE_VERSION,
    pnpmVersion: PNPM_VERSION,
    nodeArtifact: artifact.file,
    nodeSha256: artifact.sha256,
    platform,
    arch,
    libc,
    runtimeId: id
  };
  await writeFile(resolve(runtimeRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });
  await normalizeTree(runtimeRoot);

  const filename = `dsh-ssh-remote-${id}.tar.gz`;
  const destination = resolve(options.output, filename);
  await createDeterministicArchive(runtimeRoot, destination);
  const listing = await run("tar", ["-tzf", destination], { stdio: ["ignore", "pipe", "pipe"] });
  for (const required of ["runtime/manifest.json", "runtime/bin/node", "runtime/bin/pnpm", "runtime/app/node_modules/pnpm/bin/pnpm.cjs", "runtime/app/node_modules/@deepseek-ai/dsh-web-frontend/dist/index.html"]) {
    if (!listing.stdout.split("\n").includes(required)) throw new Error(`Built archive is missing ${required}.`);
  }
  const sha256 = await sha256File(destination);
  const size = (await stat(destination)).size;
  await writeFile(`${destination}.sha256`, `${sha256}  ${filename}\n`);
  const result = { filename, runtimeId: id, dshVersion: DSH_VERSION, buildId: DSH_BUILD_ID, controllerVersion: CONTROLLER_VERSION, nodeVersion: NODE_VERSION, pnpmVersion: PNPM_VERSION, sha256, size };
  await writeFile(`${destination}.json`, `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!options.keepWork) await rm(work, { recursive: true, force: true });
  return result;
}

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    strict: true,
    options: {
      arch: { type: "string", default: "all" },
      platform: { type: "string", default: "linux" },
      libc: { type: "string" },
      output: { type: "string" },
      work: { type: "string" },
      cache: { type: "string" },
      "keep-work": { type: "boolean", default: false }
    }
  });
  const architectures = values.arch === "all" ? ["x64", "arm64"] : [values.arch];
  const platform = values.platform;
  const libc = values.libc ?? (platform === "linux" ? "glibc" : "none");
  if (!["linux", "darwin"].includes(platform)) throw new Error("--platform must be linux or darwin.");
  if (architectures.some((arch) => !["x64", "arm64"].includes(arch))) throw new Error("--arch must be x64, arm64, or all.");
  if (platform === "linux" && !["glibc", "musl"].includes(libc)) throw new Error("Linux --libc must be glibc or musl.");
  if (platform === "darwin" && libc !== "none") throw new Error("macOS uses --libc none.");
  const options = {
    output: resolve(values.output ?? resolve(CONTROLLER_ROOT, "artifacts")),
    work: resolve(values.work ?? resolve(CONTROLLER_ROOT, ".build")),
    cache: resolve(values.cache ?? resolve(CONTROLLER_ROOT, ".cache")),
    keepWork: values.keepWork
  };
  for (const arch of architectures) await buildTarget(platform, arch, libc, options);
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exitCode = 1;
});
