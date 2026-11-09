import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import { RemoteError, invalidArgument } from "./errors.js";

export const sleep = (ms, signal) => new Promise((resolveSleep, reject) => {
  const timer = setTimeout(resolveSleep, ms);
  if (!signal) return;
  if (signal.aborted) {
    clearTimeout(timer);
    reject(signal.reason);
    return;
  }
  signal.addEventListener("abort", () => {
    clearTimeout(timer);
    reject(signal.reason);
  }, { once: true });
});

export function requireId(value, label) {
  if (typeof value !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(value)) {
    throw invalidArgument(`${label} must be a UUID.`);
  }
  return value;
}

const PROFILE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

export function isProfileId(value) {
  return typeof value === "string" && PROFILE_ID_PATTERN.test(value);
}

export function requireProfileId(value, label = "profileId") {
  if (!isProfileId(value)) {
    throw invalidArgument(`${label} must be a DSH profile name.`);
  }
  return value;
}

export function requireVersion(value, label = "version") {
  if (typeof value !== "string" || !/^[0-9A-Za-z][0-9A-Za-z.-]{0,127}$/u.test(value) || value.includes("..")) {
    throw invalidArgument(`${label} contains unsupported characters.`);
  }
  return value;
}

export function positiveInteger(value, label, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw invalidArgument(`${label} must be an integer from ${min} through ${max}.`);
  }
  return number;
}

export async function ensureDirectory(path, mode = 0o700) {
  await mkdir(path, { recursive: true, mode });
}

export async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

export async function readJson(path, { optional = false } = {}) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (optional && error?.code === "ENOENT") return undefined;
    if (error instanceof SyntaxError) {
      throw new RemoteError("REMOTE_STATE_INVALID", `Invalid JSON state in ${path}.`, { cause: error });
    }
    throw error;
  }
}

export async function atomicWriteJson(path, value, mode = 0o600) {
  await ensureDirectory(dirname(path));
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, "wx", mode);
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
  } finally {
    if (handle) await handle.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
  }
}

export async function sha256File(path, signal) {
  const hash = createHash("sha256");
  const stream = createReadStream(path);
  if (signal) {
    const abort = () => stream.destroy(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    try {
      for await (const chunk of stream) hash.update(chunk);
    } finally {
      signal.removeEventListener("abort", abort);
    }
  } else {
    for await (const chunk of stream) hash.update(chunk);
  }
  return hash.digest("hex");
}

export function resolveRoot(root, env = process.env) {
  const selected = root ?? env.DSH_SSH_REMOTE_HOME;
  if (selected) return resolve(selected);
  return resolve(env.HOME ?? "", ".dsh", "ssh-remote");
}

export function resolveDshHome(value, env = process.env) {
  if (value !== undefined) {
    if (typeof value !== "string" || !isAbsolute(value) || value.includes("\0") || /[\r\n]/u.test(value)) {
      throw invalidArgument("--dsh-home must be an absolute path.");
    }
    return resolve(value);
  }
  const fromEnvironment = env.DSH_HOME;
  if (typeof fromEnvironment === "string" && fromEnvironment && !fromEnvironment.includes("\0") && !/[\r\n]/u.test(fromEnvironment)) {
    return fromEnvironment;
  }
  return resolve(homedir(), ".dsh");
}

export function controllerPaths(root) {
  return {
    root,
    servers: resolve(root, "servers"),
    instances: resolve(root, "instances"),
    locks: resolve(root, "locks"),
    logs: resolve(root, "logs"),
    tmp: resolve(root, "tmp")
  };
}

export async function ensureControllerDirectories(root) {
  const paths = controllerPaths(root);
  for (const path of Object.values(paths)) await ensureDirectory(path);
  return paths;
}

export function redactSecrets(input) {
  let text = String(input);
  text = text.replace(/https?:\/\/[^\s"'<>]+/giu, (candidate) => {
    try {
      const suffix = /[),.;\]}]+$/u.exec(candidate)?.[0] ?? "";
      const body = suffix ? candidate.slice(0, -suffix.length) : candidate;
      const url = new URL(body);
      for (const key of url.searchParams.keys()) {
        if (/token|key|secret|auth|credential|cookie/iu.test(key)) url.searchParams.set(key, "[redacted]");
      }
      if (/token|key|secret|auth/iu.test(url.hash)) url.hash = "[redacted]";
      if (url.username || url.password) {
        url.username = "[redacted]";
        url.password = "[redacted]";
      }
      return `${url.toString()}${suffix}`;
    } catch {
      return candidate;
    }
  });
  return text
    .replace(/((?:api[-_]?key|access[-_]?token|auth[-_]?token|password|cookie|authorization)\s*[:=]\s*)([^\s,;]+)/giu, "$1[redacted]")
    .replace(/((?:[?&])(?:token|access_token|auth_token|api_key)=)[^&\s]+/giu, "$1[redacted]");
}

export function safeRelativeArchivePath(input) {
  if (typeof input !== "string" || input.length === 0 || input.includes("\0") || input.includes("\r") || input.includes("\n")) return false;
  if (input.startsWith("/") || isAbsolute(input)) return false;
  const path = input.replace(/^\.\//u, "").replace(/\/$/u, "");
  if (!path) return true;
  return !path.split("/").some((part) => part === ".." || part === "");
}

export function publicErrorDetails(error) {
  if (!error?.details || typeof error.details !== "object") return undefined;
  return JSON.parse(redactSecrets(JSON.stringify(error.details)));
}

export async function bounded(action, timeoutMs, signal) {
  if (signal?.aborted) throw signal.reason;
  const inner = new AbortController();
  let timer;
  let abortListener;
  try {
    return await Promise.race([
      Promise.resolve().then(() => action(inner.signal)),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = new RemoteError("OPERATION_TIMEOUT", `Operation exceeded ${timeoutMs} ms.`, { retryable: true });
          inner.abort(error);
          reject(error);
        }, timeoutMs);
        if (signal) {
          abortListener = () => {
            inner.abort(signal.reason);
            reject(signal.reason);
          };
          signal.addEventListener("abort", abortListener, { once: true });
        }
      })
    ]);
  } finally {
    clearTimeout(timer);
    if (signal && abortListener) signal.removeEventListener("abort", abortListener);
  }
}

export async function writeText(path, text, mode = 0o600) {
  await ensureDirectory(dirname(path));
  await writeFile(path, text, { mode });
}
