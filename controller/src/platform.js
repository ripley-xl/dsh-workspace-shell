import { access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { hostname, homedir } from "node:os";
import { runProcess } from "./process.js";
import { CONTROLLER_VERSION } from "./constants.js";

export function normalizeArch(value = process.arch) {
  if (value === "x64" || value === "amd64") return "x64";
  if (value === "arm64" || value === "aarch64") return "arm64";
  return value;
}

export async function detectLibc() {
  if (process.platform !== "linux") return process.platform === "darwin" ? "none" : "unknown";
  const glibc = process.report?.getReport()?.header?.glibcVersionRuntime;
  if (glibc) return "glibc";
  try {
    const result = await runProcess("ldd", ["--version"], { timeoutMs: 2_000 });
    const text = `${result.stdout}\n${result.stderr}`;
    if (/musl/iu.test(text)) return "musl";
  } catch (error) {
    if (error?.cause?.code === "ENOENT") return "musl";
  }
  return "musl";
}

export async function probeRuntime(root) {
  const libc = await detectLibc();
  const arch = normalizeArch();
  const supported = ["x64", "arm64"].includes(arch) && (
    (process.platform === "linux" && ["glibc", "musl"].includes(libc)) ||
    (process.platform === "darwin" && libc === "none")
  );
  let homeWritable = false;
  let rootWritable = false;
  try {
    await access(homedir(), fsConstants.W_OK);
    homeWritable = true;
  } catch {}
  try {
    await access(root, fsConstants.W_OK);
    rootWritable = true;
  } catch (error) {
    if (error?.code === "ENOENT") rootWritable = homeWritable;
  }
  return {
    os: process.platform,
    arch,
    libc,
    supported,
    home: homedir(),
    shell: process.env.SHELL ?? null,
    homeWritable,
    rootWritable,
    hostname: hostname(),
    nodeVersion: process.version
  };
}

export async function currentTarget() {
  return { platform: process.platform, arch: normalizeArch(), libc: await detectLibc() };
}

export function runtimeId(version, target, controllerVersion = CONTROLLER_VERSION) {
  const controller = controllerVersion === null || controllerVersion === undefined ? "" : `-controller-${controllerVersion}`;
  return `${version}${controller}-${target.platform}-${target.arch}-${target.libc}`;
}
