import net from 'node:net';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const INSTANCE = /^[a-f0-9]{32}$/;
const MAX_REQUEST = 64 * 1024;
const MAX_REPLY = 1024 * 1024;
export const sessionHostError = (code) => Object.assign(new Error(code), { code, safe: true });
export function sessionHostUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw sessionHostError('SESSION_HOST_URL_REJECTED'); }
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || !url.port) throw sessionHostError('SESSION_HOST_URL_REJECTED');
  return url.href;
}
const validId = (id) => typeof id === 'string' && ID.test(id);
const hash = (value) => createHash('sha256').update(value).digest('hex');

export function sessionIds(value) {
  if (!Array.isArray(value) || value.length > 512 || value.some((id) => !validId(id))) throw sessionHostError('SESSION_HOST_INVALID_INPUT');
  return [...new Set(value)];
}

// Read the evaluated configuration of the provider serving this context, not a guessed DSH_HOME path.
export function persistenceRoot(ctx) {
  const roots = new Set();
  for (const entry of ctx.loader.entries()) {
    if (entry.disabled || !entry.fiber || entry.options?.name !== '@deepseek-ai/dsh-session-persistence-jsonl') continue;
    if (entry.context.get('sessionPersistence')?.identity !== ctx.sessionPersistence.identity) continue;
    const root = entry.fiber.config?.root;
    if (typeof root === 'string' && path.isAbsolute(root)) roots.add(root);
  }
  if (roots.size !== 1) throw sessionHostError('SESSION_STORAGE_SCOPE_UNAVAILABLE');
  return [...roots][0];
}

async function privateDirectory(directory) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077)) {
    throw sessionHostError('SESSION_HOST_DIRECTORY_UNSAFE');
  }
  return fs.realpath(directory);
}

function exchange(socketPath, input, signal, timeoutMs) {
  return new Promise((resolve, reject) => {
    let finished = false;
    let bytes = 0;
    const chunks = [];
    const socket = net.createConnection(socketPath);
    const finish = (error, value) => {
      if (finished) return;
      finished = true;
      signal?.removeEventListener('abort', abort);
      socket.destroy();
      error ? reject(error) : resolve(value);
    };
    const abort = () => finish(sessionHostError('SESSION_HOST_CANCELLED'));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    socket.setTimeout(timeoutMs, () => finish(sessionHostError('SESSION_HOST_UNREACHABLE')));
    socket.on('error', () => finish(sessionHostError('SESSION_HOST_UNREACHABLE')));
    socket.on('connect', () => socket.write(JSON.stringify(input) + '\n'));
    socket.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_REPLY) return finish(sessionHostError('SESSION_HOST_INVALID_REPLY'));
      chunks.push(chunk);
      if (!chunk.includes(10)) return;
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8').trim());
        if (value?.ok !== true) return finish(sessionHostError('SESSION_HOST_UNAVAILABLE'));
        finish(null, value.result);
      } catch { finish(sessionHostError('SESSION_HOST_INVALID_REPLY')); }
    });
    socket.on('end', () => finish(sessionHostError('SESSION_HOST_UNREACHABLE')));
  });
}

export async function createSessionHostRegistry({ directory, storageRoot, profile, owns, attachUrl, views, command, timeoutMs = 2000, instanceId = randomUUID().replaceAll('-', '') }) {
  if (typeof process.getuid !== 'function') throw sessionHostError('SESSION_HOST_PLATFORM_UNSUPPORTED');
  if (!INSTANCE.test(instanceId) || !validId(profile) || typeof owns !== 'function') throw sessionHostError('SESSION_HOST_INVALID_INPUT');
  directory = await privateDirectory(directory);
  await fs.mkdir(storageRoot, { recursive: true, mode: 0o700 });
  const canonicalRoot = await fs.realpath(storageRoot);
  const rootStat = await fs.stat(canonicalRoot);
  const storageId = hash(`${canonicalRoot}\0${rootStat.dev}\0${rootStat.ino}`);
  const socketPath = path.join(directory, instanceId + '.sock');
  if (Buffer.byteLength(socketPath) > 100) throw sessionHostError('SESSION_HOST_SOCKET_PATH_TOO_LONG');
  const lifetime = new AbortController();
  const sockets = new Set();
  let disposed = false;
  let disposal;
  const describe = () => ({ instanceId, storageId, profile, canAttach: typeof attachUrl === 'function' });
  const claim = (id) => !disposed && owns(id) === true;
  const serve = async (input, signal) => {
    if (disposed || input?.version !== 1 || input.instanceId !== instanceId || input.storageId !== storageId) throw sessionHostError('SESSION_HOST_CHANGED');
    if (input.action === 'inspect') return { host: describe(), owned: sessionIds(input.sessionIds).filter(claim) };
    if (input.action === 'views' && views) return { host: describe(), views: views(input.windowId) };
    if (input.action === 'command' && command) {
      if (input.command?.kind === 'select' && !claim(input.command.sessionId)) throw sessionHostError('SESSION_HOST_CHANGED');
      return { host: describe(), receipt: await command(input.viewId, input.command, signal) };
    }
    if (input.action !== 'attach' || !validId(input.sessionId) || !claim(input.sessionId) || !attachUrl) throw sessionHostError('SESSION_HOST_CHANGED');
    const url = await attachUrl();
    if (!claim(input.sessionId)) throw sessionHostError('SESSION_HOST_CHANGED');
    return { host: describe(), sessionId: input.sessionId, url: sessionHostUrl(url) };
  };
  const server = net.createServer((socket) => {
    if (sockets.size >= 32 || disposed) { socket.destroy(); return; }
    sockets.add(socket);
    const abort = new AbortController();
    socket.on('close', () => { sockets.delete(socket); abort.abort(); });
    socket.on('error', () => {});
    socket.setTimeout(timeoutMs, () => socket.destroy());
    let bytes = 0, handled = false;
    const chunks = [];
    socket.on('data', (chunk) => {
      if (handled) return;
      bytes += chunk.length;
      if (bytes > MAX_REQUEST) { handled = true; socket.destroy(); return; }
      chunks.push(chunk);
      if (!chunk.includes(10)) return;
      handled = true;
      Promise.resolve().then(() => {
        const input = JSON.parse(Buffer.concat(chunks).toString('utf8').trim());
        if (input.action === 'command') socket.setTimeout(65000);
        return serve(input, AbortSignal.any([lifetime.signal, abort.signal]));
      })
        .then((result) => socket.end(JSON.stringify({ ok: true, result }) + '\n'), () => socket.end('{"ok":false}\n'));
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
  let socketIdentity;
  try { await fs.chmod(socketPath, 0o600); socketIdentity = await fs.lstat(socketPath); }
  catch (error) { await new Promise((resolve) => server.close(resolve)); throw error; }
  server.on('error', () => {});
  const ask = async (id, action, data, signal) => {
    if (disposed || signal?.aborted) throw sessionHostError('SESSION_HOST_CANCELLED');
    if (!INSTANCE.test(id)) throw sessionHostError('SESSION_HOST_INVALID_INPUT');
    const target = path.join(directory, id + '.sock');
    const stat = await fs.lstat(target);
    if (!stat.isSocket() || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw sessionHostError('SESSION_HOST_DIRECTORY_UNSAFE');
    const result = await exchange(target, { version: 1, instanceId: id, storageId, action, ...data }, AbortSignal.any([lifetime.signal, ...(signal ? [signal] : [])]), action === 'command' ? 65000 : timeoutMs);
    if (result?.host?.instanceId !== id || result.host.storageId !== storageId || !validId(result.host.profile)) throw sessionHostError('SESSION_HOST_CHANGED');
    // Do not forward extra peer fields (including credentials) into public status snapshots.
    return { ...result, host: { instanceId: id, storageId, profile: result.host.profile, canAttach: result.host.canAttach === true } };
  };
  return Object.freeze({
    describe,
    async lookup(ids, signal) {
      ids = sessionIds(ids);
      if (disposed || signal?.aborted) throw sessionHostError('SESSION_HOST_CANCELLED');
      const names = (await fs.readdir(directory)).filter((name) => /^[a-f0-9]{32}\.sock$/.test(name) && name !== instanceId + '.sock');
      if (names.length > 64) throw sessionHostError('SESSION_HOST_LIMIT');
      const owners = new Map(ids.map((id) => [id, claim(id) ? [describe()] : []]));
      // Bound open sockets and retain uncertainty when any peer cannot answer.
      for (let offset = 0; offset < names.length; offset += 4) {
        await Promise.all(names.slice(offset, offset + 4).map(async (name) => {
          try {
            const result = await ask(name.slice(0, -5), 'inspect', { sessionIds: ids }, signal);
            for (const id of sessionIds(result.owned)) if (owners.has(id)) owners.get(id).push(result.host);
          } catch { /* Missing peers never establish that a session is unowned. */ }
        }));
      }
      if (disposed || signal?.aborted) throw sessionHostError('SESSION_HOST_CANCELLED');
      return { host: describe(), sessions: Object.fromEntries(ids.map((id) => {
        const hosts = owners.get(id);
        const owner = hosts.length === 1 ? hosts[0] : null;
        return [id, owner ? { state: owner.instanceId === instanceId ? 'local' : 'foreign', host: owner } : { state: 'unknown' }];
      })) };
    },
    async attach(id, sessionId, signal) {
      if (!validId(sessionId)) throw sessionHostError('SESSION_HOST_INVALID_INPUT');
      const result = await ask(id, 'attach', { sessionId }, signal);
      if (result.sessionId !== sessionId) throw sessionHostError('SESSION_HOST_CHANGED');
      return { host: result.host, sessionId, url: sessionHostUrl(result.url) };
    },
    async views(id, windowId, signal) {
      if (!INSTANCE.test(windowId)) throw sessionHostError('SESSION_HOST_INVALID_INPUT');
      return (await ask(id, 'views', { windowId }, signal)).views;
    },
    async command(id, viewId, value, signal) {
      return (await ask(id, 'command', { viewId, command: value }, signal)).receipt;
    },
    dispose() {
      if (disposal) return disposal;
      disposed = true; lifetime.abort();
      for (const socket of sockets) socket.destroy();
      disposal = new Promise((resolve) => server.close(resolve)).then(async () => {
        // Never remove a foreign replacement of this socket path.
        const current = await fs.lstat(socketPath).catch(() => null);
        if (current?.ino === socketIdentity.ino && current.dev === socketIdentity.dev) await fs.unlink(socketPath);
      });
      return disposal;
    },
  });
}
