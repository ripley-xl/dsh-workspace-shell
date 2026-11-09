import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { existsSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { compareVersions } from './registry.js';
import { SshRemoteError } from './ssh/errors.js';

const MAX_METADATA_BYTES = 64 * 1024;
const MAX_ARTIFACTS = 256;
const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.-]{0,127}$/u;
const TARGET_PATTERN = /-(linux|darwin)-(x64|arm64)-(glibc|musl|none)$/u;

const RUNTIME_MODULE_ROOT = path.dirname(fileURLToPath(import.meta.url));
const PACKAGED_RUNTIME_ARTIFACTS = path.resolve(RUNTIME_MODULE_ROOT, '../../artifacts');
const SOURCE_RUNTIME_ARTIFACTS = path.resolve(RUNTIME_MODULE_ROOT, '../../../../controller/artifacts');
export const DEFAULT_RUNTIME_ARTIFACTS = existsSync(PACKAGED_RUNTIME_ARTIFACTS)
  ? PACKAGED_RUNTIME_ARTIFACTS
  : SOURCE_RUNTIME_ARTIFACTS;

function failure(code, message, details) {
  return new SshRemoteError(code, message, { details });
}

function metadataString(value, field, max = 512) {
  if (typeof value !== 'string' || value.length === 0 || value.length > max || /[\0\r\n]/u.test(value)) {
    throw failure('REMOTE_INSTALL_FAILED', `Runtime metadata field ${field} is invalid.`);
  }
  return value;
}

function targetFromRuntimeId(runtimeId) {
  const match = TARGET_PATTERN.exec(runtimeId);
  if (!match || (match[1] === 'darwin') !== (match[3] === 'none')) {
    throw failure('REMOTE_PLATFORM_UNSUPPORTED', `Runtime ${runtimeId} does not name a supported remote target.`);
  }
  return { platform: match[1], arch: match[2], libc: match[3] };
}

function sameTarget(left, right) {
  return left.platform === right.platform && left.arch === right.arch && left.libc === right.libc;
}

/** Orders bundled runtimes newest first; the preferred version still wins. */
function compareArtifactVersions(left, right) {
  const byDshVersion = left.dshVersion.localeCompare(right.dshVersion, 'en', { numeric: true });
  if (byDshVersion !== 0) return byDshVersion;
  return String(left.controllerVersion ?? '').localeCompare(String(right.controllerVersion ?? ''), 'en', { numeric: true });
}

export function validateRuntimeArtifactMetadata(value, directory) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw failure('REMOTE_INSTALL_FAILED', 'Runtime artifact metadata must be an object.');
  }
  const dshVersion = metadataString(value.dshVersion, 'dshVersion', 128);
  if (!VERSION_PATTERN.test(dshVersion) || dshVersion.includes('..')) {
    throw failure('REMOTE_VERSION_MISMATCH', 'Runtime artifact metadata contains an invalid DSH version.');
  }
  const buildId = metadataString(value.buildId, 'buildId');
  const runtimeId = metadataString(value.runtimeId, 'runtimeId');
  const controllerVersion = value.controllerVersion === undefined ? null : metadataString(value.controllerVersion, 'controllerVersion', 128);
  const target = targetFromRuntimeId(runtimeId);
  const controller = controllerVersion === null ? '' : `-controller-${controllerVersion}`;
  const expectedId = `${dshVersion}${controller}-${target.platform}-${target.arch}-${target.libc}`;
  if (runtimeId !== expectedId) {
    throw failure('REMOTE_VERSION_MISMATCH', 'Runtime artifact ID does not match its version and target.');
  }
  const filename = metadataString(value.filename, 'filename');
  if (filename !== `dsh-ssh-remote-${runtimeId}.tar.gz` || path.basename(filename) !== filename) {
    throw failure('REMOTE_INSTALL_FAILED', 'Runtime artifact filename does not match its immutable ID.');
  }
  if (!/^[a-f0-9]{64}$/u.test(value.sha256 ?? '')) {
    throw failure('REMOTE_INSTALL_FAILED', 'Runtime artifact SHA256 is invalid.');
  }
  if (!Number.isSafeInteger(value.size) || value.size < 1) {
    throw failure('REMOTE_INSTALL_FAILED', 'Runtime artifact size is invalid.');
  }
  return {
    artifactPath: path.join(directory, filename),
    filename,
    runtimeId,
    version: dshVersion,
    dshVersion,
    buildId,
    ...(controllerVersion ? { controllerVersion } : {}),
    sha256: value.sha256,
    size: value.size,
    target,
  };
}

async function readMetadata(directory, entry) {
  if (!entry.isFile() || !entry.name.endsWith('.tar.gz.json')) return null;
  const metadataPath = path.join(directory, entry.name);
  const info = await fs.stat(metadataPath);
  if (info.size > MAX_METADATA_BYTES) throw failure('REMOTE_INSTALL_FAILED', `Runtime metadata ${entry.name} is too large.`);
  let value;
  try {
    value = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
  } catch (error) {
    throw failure('REMOTE_INSTALL_FAILED', `Runtime metadata ${entry.name} is not valid JSON.`, { cause: error?.code });
  }
  return validateRuntimeArtifactMetadata(value, directory);
}

async function digestFile(filename, signal) {
  const hash = createHash('sha256');
  const stream = createReadStream(filename);
  const abort = () => stream.destroy(signal.reason);
  if (signal?.aborted) stream.destroy(signal.reason);
  else signal?.addEventListener('abort', abort, { once: true });
  try {
    for await (const chunk of stream) hash.update(chunk);
  } finally {
    signal?.removeEventListener('abort', abort);
  }
  return hash.digest('hex');
}

export class RuntimeCatalog {
  constructor({ directory = DEFAULT_RUNTIME_ARTIFACTS, verifyDigest = true } = {}) {
    this.directory = path.resolve(directory);
    this.verifyDigest = verifyDigest;
  }

  async list() {
    let entries;
    try {
      entries = await fs.readdir(this.directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') return [];
      throw error;
    }
    const relevant = entries.filter((entry) => entry.name.endsWith('.tar.gz.json'));
    if (relevant.length > MAX_ARTIFACTS) throw failure('REMOTE_INSTALL_FAILED', 'The runtime artifact catalog is too large.');
    const artifacts = [];
    for (const entry of relevant) {
      try {
        const artifact = await readMetadata(this.directory, entry);
        if (artifact) artifacts.push(artifact);
      } catch (error) {
        if (error?.code === 'REMOTE_PLATFORM_UNSUPPORTED') continue;
        throw error;
      }
    }
    return artifacts;
  }

  /**
   * The highest-version bundled runtime for one remote target, or `null` when
   * no artifact matches. Versions are compared with SemVer rules so a
   * prerelease never outranks its final release.
   */
  async newest({ target } = {}) {
    if (!target || !sameTarget(targetFromRuntimeId(`x-${target.platform}-${target.arch}-${target.libc}`), target)) {
      throw failure('REMOTE_PLATFORM_UNSUPPORTED', 'The remote runtime target must be Linux or macOS with a supported architecture and libc.');
    }
    const matches = (await this.list()).filter((artifact) => sameTarget(artifact.target, target));
    let newest = null;
    for (const artifact of matches) {
      let order;
      try {
        // Invalid metadata versions cannot be compared and are ignored.
        compareVersions(artifact.dshVersion, artifact.dshVersion);
        order = newest ? compareVersions(artifact.dshVersion, newest.dshVersion) : 1;
      } catch {
        continue;
      }
      if (order > 0) newest = artifact;
    }
    return newest;
  }

  async select({ version, buildId, target, signal }) {
    // `version` is a preference, not a requirement: the remote runtime version
    // comes from the runtime package bundled with this plugin.
    if (version !== undefined && version !== null) metadataString(version, 'preferred DSH version', 128);
    if (!target || !sameTarget(targetFromRuntimeId(`x-${target.platform}-${target.arch}-${target.libc}`), target)) {
      throw failure('REMOTE_PLATFORM_UNSUPPORTED', 'The remote runtime target must be Linux or macOS with a supported architecture and libc.');
    }
    const all = await this.list();
    const targetMatches = all.filter((artifact) => sameTarget(artifact.target, target));
    if (targetMatches.length === 0) {
      throw failure('REMOTE_PLATFORM_UNSUPPORTED', `No runtime artifact matches ${target.platform}-${target.arch}-${target.libc}.`);
    }
    const matches = buildId === undefined ? targetMatches : targetMatches.filter((artifact) => artifact.buildId === buildId);
    if (matches.length === 0) {
      throw failure('REMOTE_INSTALL_FAILED', 'No runtime artifact matches the requested remote build.');
    }
    const preferred = version === undefined || version === null ? [] : matches.filter((artifact) => artifact.dshVersion === version);
    const pool = preferred.length ? preferred : matches;
    const current = pool.filter((artifact) => typeof artifact.controllerVersion === 'string');
    const candidates = (current.length ? current : pool).slice().sort((left, right) => compareArtifactVersions(right, left));
    const artifact = candidates[0];
    const info = await fs.stat(artifact.artifactPath).catch((error) => {
      throw failure('REMOTE_INSTALL_FAILED', 'The selected runtime archive is unavailable.', { cause: error?.code });
    });
    if (!info.isFile() || info.size !== artifact.size) {
      throw failure('REMOTE_INSTALL_FAILED', 'The selected runtime archive size does not match its metadata.');
    }
    if (this.verifyDigest) {
      const actual = await digestFile(artifact.artifactPath, signal);
      if (actual !== artifact.sha256) {
        throw failure('REMOTE_SHA256_MISMATCH', 'The selected runtime archive digest does not match its metadata.');
      }
    }
    return artifact;
  }
}
