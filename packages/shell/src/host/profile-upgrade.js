// Local Web Host upgrade executor: backup, optional global DSH install, stop
// the managed Host, rewrite package.json/cordis.patch.yml, pnpm install and
// dump-config validation, with a reverse-order restore on failure.
//
// pnpm 11 stops with ERR_PNPM_IGNORED_BUILDS when a new dependency ships build
// scripts it has not seen before. A profile upgrade installs the exact
// dependency set the plan asked for, so those builds are approved by the
// upgrade itself: the package names are written into `allowBuilds` in the
// profile's pnpm-workspace.yaml and the install is retried. Only packages the
// profile explicitly denies (`allowBuilds: name: false`) stay pending, and
// those are reported through `upgrade.ignoredBuilds` for the UI to surface.
//
// The service is deliberately independent of the runtime registry: callers
// pass the profile id, the version observed for that Host and (for non-current
// Hosts) a `stopHost` callback. All process access goes through ctx.subprocess.

import { promises as nodeFs } from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import {
  applyPatchOperations, computeAlignPlan, computeSelfPlan, latestDependencyNames, WEB_BUNDLE,
} from './desktop-align.js';
import { entryConfigLines, parsePatch } from './patch-text.js';
import { createLatestVersionCache, isNewerVersion } from './registry.js';
import { profileIdentifier, readCombineIds, readProfileInventory } from './profile-inventory.js';

const DSH_PACKAGE = '@deepseek-ai/dsh';
const BACKUP_FILES = Object.freeze(['package.json', 'cordis.patch.yml', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']);
const BACKUP_DIRECTORY = '.host-upgrades';
const WORKSPACE_FILE = 'pnpm-workspace.yaml';
const MAX_COMMAND_TEXT = 4 * 1024 * 1024;
const SAFE_COMMAND = /^[^\0\r\n]{1,4096}$/u;
const IGNORED_BUILDS = /Ignored build scripts:[ \t]*([^\n]+)/u;
const MAX_IGNORED_BUILDS = 32;
// pnpm reports registry packages as `name@1.2.3`, but git/file/link
// dependencies as `name@file:../x.tgz` or `name@https://…#sha`. Both forms are
// valid allowBuilds keys, so the charset carries the separators those specs use.
const IGNORED_BUILD_NAME = /^[A-Za-z0-9@/._#%+:~-]{1,512}$/u;
const SEMVER_SUFFIX = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$/u;
const MAX_APPROVAL_ROUNDS = 3;

const ERRORS = {
  UPGRADE_BUSY: 'Another upgrade is already running for this Host.',
  UPGRADE_UNSUPPORTED_PROFILE: 'This profile is not supported for the local upgrade.',
  UPGRADE_PROFILE_UNAVAILABLE: 'The profile directory is unavailable.',
  UPGRADE_REGISTRY_UNAVAILABLE: 'The npm registry is unavailable.',
  UPGRADE_NPM_FAILED: 'The global DSH installation failed.',
  UPGRADE_INSTALL_FAILED: 'The plugin install failed.',
  UPGRADE_VALIDATION_FAILED: 'The profile configuration could not be validated.',
  UPGRADE_BACKUP_FAILED: 'The profile files could not be backed up.',
  UPGRADE_RESTORE_FAILED: 'The profile files could not be restored.',
  UPGRADE_RUNTIME_UNAVAILABLE: 'The running Host could not be stopped.',
  UPGRADE_PLUGIN_FAILED: 'A plugin could not be installed.',
};

const UPGRADE_CODES = new Set(Object.keys(ERRORS));
const DUMP_TIMEOUT_MS = 60_000;
const INSTALL_TIMEOUT_MS = 5 * 60_000;

function failure(code) {
  const error = new Error(ERRORS[code] ?? ERRORS.UPGRADE_INSTALL_FAILED);
  error.code = code;
  error.safe = true;
  return error;
}

function safe(error, fallback = 'UPGRADE_INSTALL_FAILED') {
  return error?.safe === true && typeof error.code === 'string' ? error : failure(fallback);
}

function safeCode(error, fallback = 'UPGRADE_INSTALL_FAILED') {
  return error?.safe === true && UPGRADE_CODES.has(error.code) ? error.code : fallback;
}

function contained(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/** Package identities pnpm refused to build, keeping only safe bounded names. */
export function parseIgnoredBuilds(text) {
  if (typeof text !== 'string') return [];
  const match = IGNORED_BUILDS.exec(text);
  if (!match) return [];
  const names = [];
  for (const raw of match[1].split(',')) {
    const name = raw.trim();
    if (!name || !IGNORED_BUILD_NAME.test(name)) continue;
    if (!names.includes(name)) names.push(name);
    if (names.length >= MAX_IGNORED_BUILDS) break;
  }
  return names;
}

const YAML_ALLOW_BUILDS = /^allowBuilds:(.*)$/u;
const YAML_ALLOW_BUILD_ENTRY = /^[ \t]+(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|([^:#\s][^:]*?))[ \t]*:(?:[ \t]+(.*))?$/u;

/**
 * allowBuilds keys for pnpm's ignored-build identities. Registry packages are
 * keyed by bare name (`a@1.0.0` and `@scope/b@2.0.0` become `a` and `@scope/b`),
 * because pnpm matches those by package name. Git, file and link dependencies
 * are matched by their full spec (`pkg@file:../x.tgz`, `pkg@https://…#sha`), so
 * their version suffix is part of the key and must stay. Anything that is not a
 * safe identity is dropped.
 */
export function approveBuildNames(identities) {
  const names = [];
  for (const identity of Array.isArray(identities) ? identities : []) {
    if (typeof identity !== 'string') continue;
    const at = identity.lastIndexOf('@');
    const name = at > 0 && SEMVER_SUFFIX.test(identity.slice(at + 1)) ? identity.slice(0, at) : identity;
    if (!IGNORED_BUILD_NAME.test(name) || names.includes(name)) continue;
    names.push(name);
    if (names.length >= MAX_IGNORED_BUILDS) break;
  }
  return names;
}

/**
 * Inserts `name: true` entries into the profile's `allowBuilds` map without
 * touching the rest of pnpm-workspace.yaml. Names that already have an entry
 * keep their value: an explicit `false` is the owner's denial, not an omission.
 */
export function applyBuildApprovals(text, names) {
  const source = typeof text === 'string' ? text : '';
  const lines = source.split('\n');
  let header = -1;
  let end = -1;
  const declared = new Set();
  for (let index = 0; index < lines.length; index += 1) {
    const head = YAML_ALLOW_BUILDS.exec(lines[index].replace(/\r$/u, ''));
    if (!head) continue;
    // Only a bare `allowBuilds:` header can take appended block entries. A
    // flow-style value (`allowBuilds: {…}`, `[]`), an inline scalar or a
    // trailing comment is left untouched: appending would either duplicate the
    // key or produce an invalid block, so the caller reports the packages as
    // pending instead of corrupting the file.
    if ((head[1] ?? '').trim() !== '') return { text: source, added: [] };
    header = index;
    end = index + 1;
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const line = lines[cursor].replace(/\r$/u, '');
      if (line.trim() === '') continue;
      if (!/^[ \t]/.test(line)) break;
      end = cursor + 1;
      const match = YAML_ALLOW_BUILD_ENTRY.exec(line);
      if (match) declared.add(match[1] ?? match[2] ?? match[3].trim());
    }
    break;
  }
  const added = (Array.isArray(names) ? names : []).filter((name) => !declared.has(name));
  if (added.length === 0) return { text: source, added: [] };
  const entries = added.map((name) => `  ${JSON.stringify(name)}: true`);
  if (header < 0) {
    const separator = source === '' || source.endsWith('\n') ? '' : '\n';
    return { text: `${source}${separator}allowBuilds:\n${entries.join('\n')}\n`, added };
  }
  return { text: [...lines.slice(0, end), ...entries, ...lines.slice(end)].join('\n'), added };
}

async function collectText(stream, maxBytes) {
  if (!stream) return '';
  const decoder = new StringDecoder('utf8');
  let text = '';
  let bytes = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > maxBytes) throw failure('UPGRADE_VALIDATION_FAILED');
    text += decoder.write(buffer);
  }
  return text + decoder.end();
}

/** `pnpmCommand` from the target profile's `plugin-manager` patch entry. */
export function patchPnpmCommand(patchText) {
  if (typeof patchText !== 'string' || patchText === '') return null;
  const entry = parsePatch(patchText).entries.find((item) => item.id === 'plugin-manager');
  if (!entry) return null;
  const config = entryConfigLines(entry);
  if (!config) return null;
  for (const line of config) {
    const match = /^ {2,}pnpmCommand:[ \t]*(.+?)[ \t]*$/u.exec(line);
    if (!match) continue;
    let value = match[1];
    if (/^(['"]).*\1$/u.test(value)) value = value.slice(1, -1);
    return SAFE_COMMAND.test(value) && path.isAbsolute(value) ? value : null;
  }
  return null;
}

const DESKTOP_APP_CLI = /(?:^|\/)Applications\/DeepSeek Harness\.app\/|DeepSeek Harness\.app\//u;

/**
 * The Desktop app ships its own CLI; its DSH version follows the app update, so
 * the local upgrade must not run a global npm install for it.
 */
export function isDesktopCli(executable) {
  if (typeof executable !== 'string' || executable === '') return false;
  const normalized = path.resolve(executable);
  if (normalized === '/usr/local/bin/dsh') return true;
  return DESKTOP_APP_CLI.test(normalized);
}

export function createProfileUpgradeService(options = {}) {
  const subprocess = options.subprocess;
  const profileContext = options.profileContext;
  if (!subprocess || typeof subprocess.resolveExecutable !== 'function' || typeof subprocess.spawn !== 'function') {
    throw new TypeError('subprocess must provide resolveExecutable and spawn');
  }
  if (!profileContext || typeof profileContext.home !== 'string' || !path.isAbsolute(profileContext.home)) {
    throw new TypeError('profileContext.home must be an absolute path');
  }
  const fs = options.fs ?? nodeFs;
  const timers = {
    setTimeout: options.timers?.setTimeout ?? setTimeout,
    clearTimeout: options.timers?.clearTimeout ?? clearTimeout,
  };
  const now = options.now ?? Date.now;
  const cliCommand = options.cliCommand ?? 'dsh';
  const npmCommand = options.npmCommand ?? 'npm';
  const graceMs = options.graceMs ?? 8_000;
  const installTimeoutMs = options.installTimeoutMs ?? INSTALL_TIMEOUT_MS;
  const dumpTimeoutMs = options.dumpTimeoutMs ?? DUMP_TIMEOUT_MS;
  const latestVersions = options.latestVersions ?? createLatestVersionCache({ fetch: options.fetch });
  if (typeof latestVersions?.latest !== 'function') throw new TypeError('latestVersions.latest must be a function');
  const home = profileContext.home;
  const operations = new Map();

  const keyOf = ({ profileId, runtimeId = null }) => runtimeId ? `runtime:${runtimeId}` : `current:${profileId}`;

  async function latestVersion(name) {
    try {
      return await latestVersions.latest(name);
    } catch {
      return null;
    }
  }

  async function resolveLatest(names) {
    const entries = await Promise.all(names.map(async (name) => [name, await latestVersion(name)]));
    return Object.fromEntries(entries);
  }

  async function selfPlan(web, targetVersion) {
    const latest = await resolveLatest(latestDependencyNames({ web, dshVersion: targetVersion }));
    return computeSelfPlan({ web, latest, dshVersion: targetVersion });
  }

  /** Reads the profile, resolves npm versions and produces the write plan. */
  async function buildPlan(profileId, currentVersion) {
    const inventory = await readProfileInventory({ id: profileId, home, fs });
    if (!inventory.bundles.includes(WEB_BUNDLE)) throw failure('UPGRADE_UNSUPPORTED_PROFILE');
    const executable = await resolveExecutable(cliCommand, 'UPGRADE_PROFILE_UNAVAILABLE');
    const dshUpgradeAllowed = !isDesktopCli(executable);
    const latestDshVersion = await latestVersion(DSH_PACKAGE);
    const targetVersion = dshUpgradeAllowed && isNewerVersion(latestDshVersion, currentVersion) ? latestDshVersion : null;
    let plan;
    if (profileId === 'web') {
      const desktop = await readProfileInventory({ id: 'desktop', home, fs }).catch(() => null);
      if (desktop) {
        const combineIds = await readCombineIds({
          id: profileId, dir: inventory.dir, home, subprocess, cliCommand, graceMs, timeoutMs: dumpTimeoutMs,
        });
        const latest = await resolveLatest(latestDependencyNames({ web: inventory, desktop, dshVersion: targetVersion }));
        plan = computeAlignPlan({ desktop, web: inventory, combineIds, latest, dshVersion: targetVersion });
      } else {
        plan = await selfPlan(inventory, targetVersion);
      }
    } else {
      plan = await selfPlan(inventory, targetVersion);
    }
    return { inventory, plan, latestDshVersion, targetVersion, dshUpgradeAllowed };
  }

  async function runCapture(argv, { cwd, timeoutMs, code, capture = false, tolerateIgnoredBuilds = false }) {
    const controller = new AbortController();
    const timer = timers.setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    let handle;
    try {
      handle = subprocess.spawn({
        argv,
        cwd,
        stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
        graceMs,
        env: { DSH_HOME: home },
        signal: controller.signal,
      });
      const [stdout, outcome, stderr] = await Promise.all([
        collectText(handle.stdout, MAX_COMMAND_TEXT),
        handle.done,
        collectText(handle.stderr, MAX_COMMAND_TEXT),
      ]);
      if (outcome?.exitCode !== 0) {
        // pnpm exits non-zero only to ask for build-script approval after the
        // install itself finished; the caller validates the result anyway.
        if (tolerateIgnoredBuilds) {
          const ignoredBuilds = parseIgnoredBuilds(`${stdout}\n${stderr}`);
          if (ignoredBuilds.length) return { output: capture ? stdout : '', ignoredBuilds };
        }
        throw failure(code);
      }
      return { output: capture ? stdout : '', ignoredBuilds: [] };
    } catch (error) {
      try { handle?.terminate(); } catch { /* already gone */ }
      await Promise.resolve(handle?.waitForExit?.()).catch(() => false);
      throw safe(error, code);
    } finally {
      timers.clearTimeout(timer);
    }
  }

  async function resolveExecutable(command, code) {
    try {
      const executable = await subprocess.resolveExecutable(command, undefined, undefined);
      if (typeof executable !== 'string' || !executable) throw failure(code);
      return executable;
    } catch {
      throw failure(code);
    }
  }

  async function backupFiles(inventory) {
    const root = path.join(inventory.dir, BACKUP_DIRECTORY);
    if (!contained(inventory.dir, root)) throw failure('UPGRADE_BACKUP_FAILED');
    const stamp = new Date(now()).toISOString().replace(/[:.]/gu, '-');
    let backupDir = path.join(root, stamp);
    try {
      await fs.mkdir(root, { recursive: true, mode: 0o700 });
      await fs.chmod(root, 0o700).catch(() => {});
      for (let attempt = 0; ; attempt += 1) {
        try {
          await fs.mkdir(backupDir, { mode: 0o700 });
          break;
        } catch (error) {
          if (error?.code === 'EEXIST' && attempt < 20) {
            backupDir = path.join(root, `${stamp}-${attempt + 1}`);
            continue;
          }
          throw error;
        }
      }
      await fs.chmod(backupDir, 0o700).catch(() => {});
      const files = [];
      for (const name of BACKUP_FILES) {
        const filename = path.join(inventory.dir, name);
        let content = null;
        try {
          const info = await fs.lstat(filename);
          if (info.isSymbolicLink() || !info.isFile()) throw failure('UPGRADE_BACKUP_FAILED');
          content = await fs.readFile(filename);
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
        }
        if (content !== null) {
          const target = path.join(backupDir, name);
          await fs.writeFile(target, content, { mode: 0o600 });
          await fs.chmod(target, 0o600).catch(() => {});
        }
        files.push({ name, content });
      }
      return { dir: backupDir, files };
    } catch {
      await fs.rm(backupDir, { recursive: true, force: true }).catch(() => {});
      throw failure('UPGRADE_BACKUP_FAILED');
    }
  }

  async function restoreFiles(journal, inventory) {
    for (const file of [...journal.files].reverse()) {
      const filename = path.join(inventory.dir, file.name);
      if (file.content === null) {
        await fs.rm(filename, { force: true });
        continue;
      }
      await fs.writeFile(filename, file.content);
    }
  }

  async function resolvePnpm(inventory) {
    const fromPatch = patchPnpmCommand(inventory.patchText);
    if (fromPatch) return { argv: [fromPatch], source: 'patch' };
    const homeLauncher = path.join(home, '.dsh', 'bin', 'pnpm11');
    try {
      const info = await fs.stat(homeLauncher);
      if (info.isFile() && info.mode & 0o111) return { argv: [homeLauncher], source: 'home' };
    } catch {
      // Fall through to the app-bundled pnpm.
    }
    const bundled = await bundledPnpm();
    if (bundled) return { argv: [bundled.node, bundled.script], source: 'app' };
    throw failure('UPGRADE_INSTALL_FAILED');
  }

  async function bundledPnpm() {
    const candidates = [
      path.resolve(path.dirname(process.execPath), '..', '..', 'pnpm', 'bin', 'pnpm.mjs'),
      path.resolve(path.dirname(process.execPath), '..', 'pnpm', 'bin', 'pnpm.mjs'),
    ];
    try {
      candidates.push(fileURLToPath(import.meta.resolve('pnpm/bin/pnpm.mjs')));
    } catch {
      // The plugin may not be installed next to a resolvable pnpm package.
    }
    for (const candidate of candidates) {
      try {
        const info = await fs.stat(candidate);
        if (info.isFile()) return { node: process.execPath, script: candidate };
      } catch {
        // Try the next location.
      }
    }
    return null;
  }

  async function runPnpm(inventory, args) {
    const resolved = await resolvePnpm(inventory);
    return runCapture([...resolved.argv, ...args], {
      cwd: inventory.dir, timeoutMs: installTimeoutMs, code: 'UPGRADE_INSTALL_FAILED', tolerateIgnoredBuilds: true,
    });
  }

  /**
   * Records pnpm's ignored builds in the profile's `allowBuilds` map and
   * returns the names this call added. When nothing new can be approved (the
   * profile denies the package on purpose, or the name was already written)
   * the caller stops retrying and keeps the pending list for the UI.
   */
  async function approveBuildScripts(inventory, identities) {
    const names = approveBuildNames(identities);
    if (names.length === 0) return [];
    const filename = path.join(inventory.dir, WORKSPACE_FILE);
    let text = '';
    try {
      text = await fs.readFile(filename, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw failure('UPGRADE_INSTALL_FAILED');
    }
    const result = applyBuildApprovals(text, names);
    if (result.added.length === 0) return [];
    await fs.writeFile(filename, result.text);
    return result.added;
  }

  async function installDsh(version) {
    if (typeof version !== 'string' || !version) throw failure('UPGRADE_NPM_FAILED');
    const npm = await resolveExecutable(npmCommand, 'UPGRADE_NPM_FAILED');
    await runCapture([npm, 'install', '-g', `${DSH_PACKAGE}@${version}`], {
      cwd: home, timeoutMs: installTimeoutMs, code: 'UPGRADE_NPM_FAILED',
    });
  }

  async function validateProfile(inventory) {
    await readCombineIds({
      id: inventory.id, dir: inventory.dir, home, subprocess, cliCommand, graceMs, timeoutMs: dumpTimeoutMs,
    });
  }

  async function writeProfileFiles(inventory, plan) {
    const manifest = JSON.parse(JSON.stringify(inventory.manifest));
    if (!manifest.dsh || typeof manifest.dsh !== 'object' || !manifest.dsh.profile || typeof manifest.dsh.profile !== 'object') {
      throw failure('UPGRADE_UNSUPPORTED_PROFILE');
    }
    manifest.dependencies = { ...plan.dependencies };
    manifest.dsh.profile.bundles = [...plan.bundles];
    await fs.writeFile(path.join(inventory.dir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    if (plan.patchOperations.length > 0) {
      const next = applyPatchOperations(inventory.patchText ?? '', plan.patchOperations);
      await fs.writeFile(path.join(inventory.dir, 'cordis.patch.yml'), next);
    }
  }

  async function runUpgrade(state, { profileId, dshVersion, stopHost }) {
    let journal = null;
    let inventory = null;
    let wrote = false;
    try {
      const built = await buildPlan(profileId, dshVersion);
      inventory = built.inventory;
      if (!built.targetVersion && !built.plan.pending) {
        state.phase = 'done';
        state.noop = true;
        return;
      }
      journal = await backupFiles(inventory);
      if (built.targetVersion) {
        state.step = 'dsh';
        await installDsh(built.targetVersion);
      }
      state.step = 'stop';
      if (typeof stopHost === 'function') {
        try {
          await stopHost();
        } catch {
          throw failure('UPGRADE_RUNTIME_UNAVAILABLE');
        }
      }
      state.step = 'write';
      wrote = true;
      await writeProfileFiles(inventory, built.plan);
      state.step = 'install';
      let installed = await runPnpm(inventory, ['install']);
      for (let round = 0; installed.ignoredBuilds?.length && round < MAX_APPROVAL_ROUNDS; round += 1) {
        const approved = await approveBuildScripts(inventory, installed.ignoredBuilds);
        if (approved.length === 0) break;
        installed = await runPnpm(inventory, ['install']);
      }
      state.ignoredBuilds = installed.ignoredBuilds;
      state.step = 'validate';
      await validateProfile(inventory);
      state.phase = 'done';
    } catch (error) {
      const code = safeCode(error);
      if (wrote && journal) {
        try {
          await restoreFiles(journal, inventory);
          const lockfile = journal.files.find((file) => file.name === 'pnpm-lock.yaml');
          if (lockfile && lockfile.content !== null) await runPnpm(inventory, ['install', '--frozen-lockfile']);
        } catch {
          state.phase = 'failed';
          state.error = 'UPGRADE_RESTORE_FAILED';
          return;
        }
      }
      state.phase = 'failed';
      state.error = code;
    }
  }

  /** Cached, read-only probe used by the catalog: no writes, no upgrades. */
  async function check({ profileId, dshVersion = null } = {}) {
    profileIdentifier(profileId);
    const latestDshVersion = await latestVersion(DSH_PACKAGE);
    try {
      const built = await buildPlan(profileId, dshVersion);
      return {
        latestDshVersion: built.latestDshVersion,
        alignPending: built.plan.pending,
        dshUpgradeAllowed: built.dshUpgradeAllowed,
      };
    } catch (error) {
      return { latestDshVersion, alignPending: null, error: safeCode(error, 'UPGRADE_PROFILE_UNAVAILABLE') };
    }
  }

  function start({ profileId, runtimeId = null, dshVersion = null, stopHost = null } = {}) {
    profileIdentifier(profileId);
    if (runtimeId !== null && (typeof runtimeId !== 'string' || runtimeId === '')) throw failure('UPGRADE_RUNTIME_UNAVAILABLE');
    for (const [key, value] of operations) {
      if (value.phase !== 'running') continue;
      if (key === keyOf({ profileId, runtimeId }) || value.profileId === profileId) throw failure('UPGRADE_BUSY');
    }
    const state = { profileId, runtimeId, phase: 'running', step: 'backup', error: null, noop: false, ignoredBuilds: [] };
    operations.set(keyOf({ profileId, runtimeId }), state);
    void runUpgrade(state, { profileId, dshVersion, stopHost }).catch(() => {
      state.phase = 'failed';
      state.error = state.error ?? 'UPGRADE_INSTALL_FAILED';
    });
    return { started: true, upgrade: { phase: 'running', step: 'backup' } };
  }

  /**
   * Terminal states are consumed once: a poll observes `done`/`failed` and the
   * next poll no longer sees the operation, matching the design's "clear on
   * the next refresh" contract.
   */
  function state({ profileId, runtimeId = null } = {}) {
    const key = keyOf({ profileId, runtimeId });
    const value = operations.get(key);
    if (!value) return null;
    if (value.phase === 'running') return { phase: 'running', step: value.step };
    operations.delete(key);
    return {
      phase: value.phase,
      step: value.step,
      ...(value.error ? { error: value.error } : {}),
      ...(value.noop ? { noop: true } : {}),
      ...(Array.isArray(value.ignoredBuilds) && value.ignoredBuilds.length ? { ignoredBuilds: [...value.ignoredBuilds] } : {}),
    };
  }

  return { check, start, state };
}
