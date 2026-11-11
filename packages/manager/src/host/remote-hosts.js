// Remote Host cards: a Guest Web Host publishes `<DSH_HOME>/workspace-hosts/
// <instanceId>.json` on its own machine (see `packages/guest/src/host/
// host-card.js`). The local Shell can only read its own disk, so the SSH
// manager reads the cards of a connected host and turns them into rows the
// launcher can open.
//
// The card carries the Host's authenticated page URL; it stays on the server
// side until `attach` builds a forwarded URL for one specific Host.

import { compareVersions } from './registry.js';
import { SshRemoteError } from './ssh/errors.js';

const INSTANCE = /^[a-f0-9]{32}$/u;
const CARD_FILE = /^([a-f0-9]{32})\.json$/u;
const HOST_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const PROFILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const MAX_CARDS = 64;
const MAX_CARD_BYTES = 64 * 1024;
const MAX_OUTPUT_BYTES = 256 * 1024;
// `exit 0` matters: an empty card directory makes the loop's last test fail,
// and a restart passes through exactly that window (old card gone, new one not
// written yet).
const REMOTE_COMMAND = 'for f in "$HOME"/.dsh/workspace-hosts/*.json; do [ -f "$f" ] && cat "$f" && printf "\\n"; done; exit 0';

function timestamp(value) {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function loopbackUrl(value) {
  let url;
  try { url = new URL(value); } catch { return null; }
  const port = Number(url.port);
  if (url.protocol !== 'http:' || !LOOPBACK_HOSTS.has(url.hostname) || !url.port
    || !Number.isInteger(port) || port < 1 || port > 65_535 || url.username || url.password) return null;
  return url;
}

/**
 * Validates one card body. Never throws: a card written by another process is
 * untrusted input, and a bad one must only disappear from the list.
 * @returns {{card: object}|{code: string}}
 */
export function readHostCard(text, instanceId) {
  let value;
  try { value = JSON.parse(text); } catch { return { code: 'HOST_CARD_INVALID' }; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { code: 'HOST_CARD_INVALID' };
  if (value.version !== 1) return { code: 'HOST_CARD_INVALID' };
  if (typeof value.instanceId !== 'string' || !INSTANCE.test(value.instanceId) || value.instanceId !== instanceId) {
    return { code: 'HOST_CARD_INVALID' };
  }
  if (typeof value.hostKey !== 'string' || !HOST_KEY.test(value.hostKey)) return { code: 'HOST_CARD_INVALID' };
  if (typeof value.profile !== 'string' || !PROFILE.test(value.profile)) return { code: 'HOST_CARD_INVALID' };
  if (!Number.isInteger(value.pid) || value.pid < 1) return { code: 'HOST_CARD_INVALID' };
  if (!Number.isInteger(value.port) || value.port < 1 || value.port > 65_535) return { code: 'HOST_CARD_INVALID' };
  if (typeof value.supervised !== 'boolean') return { code: 'HOST_CARD_INVALID' };
  if (typeof value.cwd !== 'string' || !value.cwd.startsWith('/') || value.cwd.includes('\0')) return { code: 'HOST_CARD_INVALID' };
  if (!Array.isArray(value.argv) || value.argv.length === 0 || value.argv.length > 256
    || value.argv.some((part) => typeof part !== 'string' || part.includes('\0'))) return { code: 'HOST_CARD_INVALID' };
  const startedAt = timestamp(value.startedAt);
  if (startedAt === null) return { code: 'HOST_CARD_INVALID' };
  const url = loopbackUrl(value.url);
  if (!url) return { code: 'HOST_CARD_URL_REJECTED' };
  if (String(value.url).length > 2_048) return { code: 'HOST_CARD_URL_REJECTED' };
  return {
    card: {
      instanceId,
      hostKey: value.hostKey,
      profileId: value.profile,
      pid: value.pid,
      port: value.port,
      url: url.href,
      supervised: value.supervised,
      startedAt: new Date(startedAt).toISOString(),
      startedAtMs: startedAt,
      cwd: value.cwd,
      argv: [...value.argv],
      guestVersion: typeof value.guestVersion === 'string' ? value.guestVersion : null,
    },
  };
}

/**
 * Parses the concatenated card bodies that `REMOTE_COMMAND` prints.
 * @returns {{hosts: object[], skipped: { instanceId: string|null, code: string }[]}}
 */
export function parseHostCards(output) {
  const hosts = [];
  const skipped = [];
  const seen = new Set();
  if (typeof output !== 'string') return { hosts, skipped };
  for (const raw of output.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line.length > MAX_CARD_BYTES) { skipped.push({ instanceId: null, code: 'HOST_CARD_INVALID' }); continue; }
    let instanceId = null;
    try { instanceId = JSON.parse(line)?.instanceId ?? null; } catch { instanceId = null; }
    if (typeof instanceId !== 'string' || !INSTANCE.test(instanceId)) {
      skipped.push({ instanceId: null, code: 'HOST_CARD_INVALID' });
      continue;
    }
    if (seen.has(instanceId)) continue;
    seen.add(instanceId);
    const result = readHostCard(line, instanceId);
    if (result.code) { skipped.push({ instanceId, code: result.code }); continue; }
    hosts.push(result.card);
  }
  hosts.sort((left, right) => right.startedAtMs - left.startedAtMs);
  return { hosts: hosts.slice(0, MAX_CARDS), skipped };
}

/** What the client may see before it asks to open one Host. No URL, no token. */
export function publicHost(card) {
  return {
    instanceId: card.instanceId,
    profileId: card.profileId,
    pid: card.pid,
    port: card.port,
    supervised: card.supervised,
    startedAt: card.startedAt,
    guestVersion: card.guestVersion,
  };
}

/**
 * Which of these remote pids are still alive. One extra round trip, and the only
 * way to tell a running Host from a card its dead process left behind.
 */
export async function filterLivePids(channel, pids, { signal } = {}) {
  const candidates = [...new Set(pids)].filter((pid) => Number.isInteger(pid) && pid > 0 && pid < 2 ** 31);
  if (!candidates.length) return new Set();
  const script = 'for p in ' + candidates.join(' ') + '; do kill -0 "$p" 2>/dev/null && printf "%s\\n" "$p"; done';
  const result = await channel.exec({ command: 'sh', args: ['-c', script], signal, maxStdoutBytes: 4096 });
  if (result.code !== 0) return new Set();
  return new Set(String(result.stdout).split('\n').map((line) => Number(line.trim())).filter((pid) => Number.isInteger(pid) && pid > 0));
}

/** Reads the cards of a connected Host. A missing directory is an empty list. */
export async function readRemoteHostCards(channel, { signal } = {}) {
  const result = await channel.exec({
    command: 'sh',
    args: ['-c', REMOTE_COMMAND],
    maxStdoutBytes: MAX_OUTPUT_BYTES,
    signal,
  });
  if (result.code !== 0) {
    throw new SshRemoteError('REMOTE_HOST_DISCOVERY_FAILED', 'The remote Host cards could not be read.');
  }
  return parseHostCards(result.stdout);
}

/**
 * Rewrites a card's authenticated URL onto the local end of a port forward.
 * The path and token are preserved; only host:port changes.
 */
export function forwardedUrl(cardUrl, localPort) {
  if (!Number.isInteger(localPort) || localPort < 1 || localPort > 65_535) {
    throw new SshRemoteError('TUNNEL_FAILED', 'The local port forward did not provide a port.');
  }
  const url = new URL(cardUrl);
  url.hostname = '127.0.0.1';
  url.port = String(localPort);
  return url.href;
}

export { CARD_FILE };

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

/** SIGTERM, then SIGKILL when the Host ignores it. Returns whether it is gone. */
export async function terminateRemoteProcess(channel, pid, { signal, graceMs = 8_000, pollMs = 200 } = {}) {
  if (!Number.isInteger(pid) || pid < 2) throw new SshRemoteError('INVALID_REQUEST', 'The Host pid is not usable.');
  const terminated = await channel.exec({ command: 'kill', args: ['-TERM', String(pid)], signal });
  if (terminated.code !== 0) return false;
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    const alive = await filterLivePids(channel, [pid], { signal });
    if (!alive.has(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  await channel.exec({ command: 'kill', args: ['-KILL', String(pid)], signal }).catch(() => {});
  const deadlineForKill = Date.now() + 3_000;
  while (Date.now() < deadlineForKill) {
    const alive = await filterLivePids(channel, [pid], { signal });
    if (!alive.has(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return false;
}

/**
 * The shell line that starts a Host away from the SSH session.
 *
 * `nohup cmd &` alone is not enough: the background process stays in the
 * session's process group, and sshd keeps the exec channel open until the whole
 * session exits — the launch appears to hang for the client's full timeout even
 * though the Host is already running. `setsid` gives it its own session, so the
 * channel closes as soon as the shell returns. macOS has no `setsid`, so the
 * plain `nohup` branch stays as the fallback.
 */
export function detachedCommandLine(argv, cwd) {
  const command = argv.map(shellQuote).join(' ');
  const redirect = '>/dev/null 2>&1 < /dev/null';
  return `cd ${shellQuote(cwd)} && if command -v setsid >/dev/null 2>&1; then setsid ${command} ${redirect} & else nohup ${command} ${redirect} & fi`;
}

/**
 * Starts the card's own command line again, detached, so it survives this SSH
 * session. `nohup` is the portable detach: macOS has no `setsid`.
 */
export async function respawnRemoteProcess(channel, { argv, cwd }, { signal } = {}) {
  if (!Array.isArray(argv) || argv.length === 0 || typeof cwd !== 'string' || !cwd.startsWith('/')) {
    throw new SshRemoteError('INVALID_REQUEST', 'The Host card has no usable command line.');
  }
  const line = detachedCommandLine(argv, cwd);
  const result = await channel.exec({ command: 'sh', args: ['-c', line], signal });
  return result.code === 0;
}

/** Waits until a card for the same logical Host reports a new, live process. */
export async function waitForReplacementCard(channel, { hostKey, profileId, previousInstanceId }, { signal, timeoutMs = 25_000, pollMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { hosts } = await readRemoteHostCards(channel, { signal });
    const candidate = hosts.find((card) => card.instanceId !== previousInstanceId
      && card.hostKey === hostKey && card.profileId === profileId);
    if (candidate) {
      const alive = await filterLivePids(channel, [candidate.pid], { signal });
      if (alive.has(candidate.pid)) return candidate;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return null;
}

/** Desktop-only packages never belong on a guest Web profile. */
// Only plugins that cannot exist outside the Desktop belong here. Ordinary
// client plugins (assistant panel, pet, market) sync like any other.
const DESKTOP_ONLY = new Set(['dsh-workspace-shell', '@local/dsh-preset-whale-maid']);

function localSpec(value) {
  return typeof value === 'string' && /^(?:file:|link:|github:|git:|git\+|https?:\/\/)/iu.test(value);
}

/**
 * What to install on a foreign profile so it matches this machine.
 *
 * Direction is deliberately one-way and conservative: install what the remote
 * lacks, upgrade what is older, never downgrade a newer remote plugin, never
 * push a local path (`file:`/`link:`) that only exists on this machine, and
 * never touch Desktop-only packages.
 *
 * @returns {{install: {name: string, spec: string, reason: string}[], skipped: {name: string, reason: string}[]}}
 */
export function planDiscoveredSync({ localBundles = [], remoteDependencies = {} } = {}) {
  const install = [];
  const skipped = [];
  for (const bundle of Array.isArray(localBundles) ? localBundles : []) {
    const name = typeof bundle?.name === 'string' ? bundle.name : null;
    const version = typeof bundle?.version === 'string' ? bundle.version : null;
    if (!name || !version) continue;
    if (bundle.enabled === false || bundle.availability === 'missing') continue;
    if (DESKTOP_ONLY.has(name) || name.startsWith('@local/')) continue;
    // Official bundles ship with the DSH installation on both sides; adding them
    // to the remote profile pins this machine's version over the remote's own.
    if (bundle.official === true || name.startsWith('@deepseek-ai/')) {
      skipped.push({ name, reason: 'official' });
      continue;
    }
    const remote = remoteDependencies[name];
    if (!remote) { install.push({ name, spec: `${name}@${version}`, reason: 'missing' }); continue; }
    if (localSpec(remote)) { skipped.push({ name, reason: 'local-spec' }); continue; }
    if (remote === version) continue;
    let order = 0;
    try { order = compareVersions(version, String(remote)); } catch { order = 0; }
    if (order > 0) install.push({ name, spec: `${name}@${version}`, reason: 'upgrade' });
    else skipped.push({ name, reason: 'remote-newer' });
  }
  return { install, skipped };
}

/** Reads a remote profile's dependency map. */
export async function readRemoteProfileDependencies(channel, profileId, { signal } = {}) {
  if (typeof profileId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(profileId)) {
    throw new SshRemoteError('INVALID_REQUEST', 'The profile identifier is not usable.');
  }
  const script = `cat "$HOME/.dsh/profiles/${profileId}/package.json"`;
  const result = await channel.exec({ command: 'sh', args: ['-c', script], signal });
  if (result.code !== 0) throw new SshRemoteError('REMOTE_PLUGIN_SYNC_FAILED', 'The remote profile manifest could not be read.');
  let manifest;
  try { manifest = JSON.parse(result.stdout); } catch { throw new SshRemoteError('REMOTE_PLUGIN_SYNC_FAILED', 'The remote profile manifest is not valid JSON.'); }
  const dependencies = manifest?.dependencies;
  return dependencies && typeof dependencies === 'object' && !Array.isArray(dependencies) ? dependencies : {};
}

/**
 * Runs `dsh plugin --profile <profile> add <spec>` on the remote with the same
 * interpreter the Host was started with.
 */
export async function installRemotePlugin(channel, { argv, profileId, spec }, { signal, timeoutMs = 600_000 } = {}) {
  if (!Array.isArray(argv) || argv.length < 2) throw new SshRemoteError('INVALID_REQUEST', 'The Host card has no usable interpreter.');
  // `dsh plugin` shells out to pnpm, which lives in the user's login PATH;
  // a non-login exec cannot find it (spawn pnpm ENOENT).
  const line = `exec ${[argv[0], argv[1], 'plugin', '--profile', profileId, 'add', spec].map(shellQuote).join(' ')}`;
  const result = await channel.exec({
    command: 'sh',
    args: ['-lc', line],
    signal,
    timeoutMs,
    maxStdoutBytes: 64 * 1024,
    maxStderrBytes: 64 * 1024,
  });
  return {
    ok: result.code === 0,
    code: result.code,
    detail: String(result.stderr ?? '').trim().split('\n').slice(-3).join(' '),
  };
}
