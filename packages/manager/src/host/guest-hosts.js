// Starting and adopting a Guest Web Host over plain SSH: no bundled runtime,
// no controller. The remote machine's own `node` + `dsh` run the Host and its
// card is how we find it again.

import { SshRemoteError } from './ssh/errors.js';
import { filterLivePids, readRemoteHostCards } from './remote-hosts.js';

const PROFILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const VERSION = /^[vV]?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/u;

function checkProfile(profileId) {
  if (typeof profileId !== 'string' || !PROFILE.test(profileId)) {
    throw new SshRemoteError('INVALID_REQUEST', 'The profile identifier is not usable.');
  }
  return profileId;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

/**
 * Finds the interpreter a Host can be started with, preferring the exact
 * command line a running Host on this machine already used (that one is known
 * to work, including the Node it was started with).
 * @returns {Promise<{node: string, dsh: string, version: string|null, argv: string[]}|null>}
 */
export async function resolveGuestInterpreter(channel, { profileId, signal } = {}) {
  checkProfile(profileId);
  const { hosts } = await readRemoteHostCards(channel, { signal });
  const known = hosts.filter((card) => card.profileId === profileId && Array.isArray(card.argv) && card.argv.length >= 2)
    .sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt))[0];
  let node = known?.argv[0] ?? null;
  let dsh = known?.argv[1] ?? null;
  if (!node || !dsh) {
    const found = await channel.exec({
      command: 'sh',
      args: ['-lc', 'printf "%s\\n" "$(command -v node)" "$(command -v dsh)"'],
      signal,
    });
    if (found.code !== 0) return null;
    const [foundNode, foundDsh] = String(found.stdout).trim().split('\n');
    node = node ?? (foundNode || null);
    dsh = dsh ?? (foundDsh || null);
  }
  if (!node || !dsh) return null;
  const versionRun = await channel.exec({ command: node, args: [dsh, '--version'], signal, maxStdoutBytes: 4096 });
  if (versionRun.code !== 0) return null;
  const match = VERSION.exec(String(versionRun.stdout).trim().split('\n')[0]?.trim() ?? '');
  return { node, dsh, version: match ? match[1] : null, argv: [node, dsh] };
}

/** Starts a Host detached; it publishes its card when the Web server is up. */
export async function startGuestHost(channel, { interpreter, profileId, workspace }, { signal } = {}) {
  checkProfile(profileId);
  if (!interpreter?.node || !interpreter?.dsh) throw new SshRemoteError('INVALID_REQUEST', 'No remote dsh was found.');
  if (typeof workspace !== 'string' || !workspace.startsWith('/')) {
    throw new SshRemoteError('INVALID_REQUEST', 'The remote workspace is not usable.');
  }
  const line = `cd ${shellQuote(workspace)} && nohup ${shellQuote(interpreter.node)} ${shellQuote(interpreter.dsh)}`
    + ` --profile ${shellQuote(profileId)} --host 127.0.0.1 --port 0 --no-open >/dev/null 2>&1 < /dev/null &`;
  const started = await channel.exec({ command: 'sh', args: ['-c', line], signal });
  if (started.code !== 0) throw new SshRemoteError('REMOTE_HOST_START_FAILED', 'The remote dsh could not be started.');
}

/** Waits for a live card of this profile that was not there before. */
export async function waitForProfileCard(channel, { profileId, previousInstanceIds = [] }, { signal, timeoutMs = 90_000, pollMs = 500 } = {}) {
  checkProfile(profileId);
  const seen = new Set(previousInstanceIds);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { hosts } = await readRemoteHostCards(channel, { signal });
    const candidate = hosts.find((card) => card.profileId === profileId
      && card.supervised !== true && !seen.has(card.instanceId));
    if (candidate) {
      const alive = await filterLivePids(channel, [candidate.pid], { signal });
      if (alive.has(candidate.pid)) return candidate;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return null;
}
