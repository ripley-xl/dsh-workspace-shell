import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { RemoteError } from "./errors.js";
import { redactSecrets } from "./util.js";

const execFileAsync = promisify(execFile);

export async function runProcess(file, args, options = {}) {
  try {
    const result = await execFileAsync(file, args, {
      cwd: options.cwd,
      env: options.env,
      timeout: options.timeoutMs ?? 30_000,
      maxBuffer: options.maxBuffer ?? 4 * 1024 * 1024,
      signal: options.signal,
      windowsHide: true
    });
    return { stdout: result.stdout.trim(), stderr: result.stderr.trim() };
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    const diagnostic = redactSecrets(error?.stderr || error?.message || String(error)).slice(0, 4096);
    throw new RemoteError(options.code ?? "REMOTE_PROCESS_FAILED", `${file} failed: ${diagnostic}`, {
      cause: error,
      details: { exitCode: error?.code, signal: error?.signal }
    });
  }
}

export function spawnDetached(file, args, options) {
  const child = spawn(file, args, {
    cwd: options.cwd,
    env: options.env,
    detached: true,
    stdio: ["ignore", options.stdout, options.stderr]
  });
  child.unref();
  return child;
}

export function pidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}
