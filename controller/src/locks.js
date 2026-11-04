import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { RemoteError } from "./errors.js";
import { pidAlive } from "./process.js";
import { ensureDirectory, sleep } from "./util.js";

export async function acquireLock(locksDirectory, name, options = {}) {
  if (!/^[a-zA-Z0-9.-]+$/u.test(name)) throw new Error("Invalid internal lock name.");
  await ensureDirectory(locksDirectory);
  const path = resolve(locksDirectory, `${name}.lock`);
  const token = randomUUID();
  const timeoutMs = options.timeoutMs ?? 30_000;
  const staleMs = options.staleMs ?? 120_000;
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      await mkdir(path, { mode: 0o700 });
      await writeFile(resolve(path, "owner.json"), `${JSON.stringify({ token, pid: process.pid, createdAt: new Date().toISOString() })}\n`, { mode: 0o600 });
      return {
        path,
        release: async () => {
          try {
            const owner = JSON.parse(await readFile(resolve(path, "owner.json"), "utf8"));
            if (owner.token === token) await rm(path, { recursive: true, force: true });
          } catch (error) {
            if (error?.code !== "ENOENT") throw error;
          }
        }
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      if (Date.now() >= deadline) {
        throw new RemoteError("REMOTE_LOCK_TIMEOUT", `Timed out waiting for lock ${name}.`, { retryable: true });
      }
      let stale = false;
      try {
        const info = await lstat(path);
        const age = Date.now() - info.mtimeMs;
        const owner = JSON.parse(await readFile(resolve(path, "owner.json"), "utf8"));
        stale = info.isDirectory() && age > (Number.isSafeInteger(owner.pid) ? 5_000 : staleMs) && (!Number.isSafeInteger(owner.pid) || !pidAlive(owner.pid));
      } catch (readError) {
        stale = readError?.code !== "ENOENT" && Date.now() >= deadline - Math.min(staleMs, timeoutMs);
      }
      if (stale) {
        await rm(path, { recursive: true, force: true });
        continue;
      }
      await sleep(50, options.signal);
    }
  }
}

export async function withLock(locksDirectory, name, action, options = {}) {
  const lock = await acquireLock(locksDirectory, name, options);
  try {
    return await action();
  } finally {
    await lock.release();
  }
}
