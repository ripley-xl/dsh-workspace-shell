// Reads one DSH profile directory (package.json, patch text and the combined
// config id set) for the local Host upgrade and desktop-alignment paths. Only
// real directories under `<home>/profiles` are accepted.

import { promises as nodeFs } from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { bundleName } from './desktop-align.js';

export const WEB_BUNDLE = '@deepseek-ai/dsh-web-app';
export const MAX_PACKAGE_BYTES = 1024 * 1024;
export const MAX_PATCH_BYTES = 4 * 1024 * 1024;
export const MAX_DUMP_BYTES = 8 * 1024 * 1024;
const PROFILE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const DUMP_ENTRY = /^- id:[ \t]+([^\s#]+)[ \t]*$/u;

const ERRORS = {
  UPGRADE_UNSUPPORTED_PROFILE: 'This profile is not supported for the local upgrade.',
  UPGRADE_PROFILE_UNAVAILABLE: 'The profile directory is unavailable.',
  UPGRADE_VALIDATION_FAILED: 'The profile configuration could not be validated.',
};

function failure(code) {
  const error = new Error(ERRORS[code] ?? ERRORS.UPGRADE_PROFILE_UNAVAILABLE);
  error.code = code;
  error.safe = true;
  return error;
}

function safe(error, fallback = 'UPGRADE_PROFILE_UNAVAILABLE') {
  return error?.safe === true && typeof error.code === 'string' ? error : failure(fallback);
}

function contained(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function profileIdentifier(value) {
  if (typeof value !== 'string' || !PROFILE_ID.test(value)) throw failure('UPGRADE_UNSUPPORTED_PROFILE');
  return value;
}

/** Real profile directory under `<home>/profiles/<id>`; symlinks never qualify. */
export async function resolveProfileDirectory({ id, home, fs = nodeFs } = {}) {
  profileIdentifier(id);
  if (typeof home !== 'string' || !path.isAbsolute(home)) throw failure('UPGRADE_PROFILE_UNAVAILABLE');
  try {
    const root = await fs.realpath(path.join(home, 'profiles'));
    const candidate = path.join(root, id);
    const info = await fs.lstat(candidate);
    if (info.isSymbolicLink() || !info.isDirectory()) throw failure('UPGRADE_PROFILE_UNAVAILABLE');
    const directory = await fs.realpath(candidate);
    if (!contained(root, directory)) throw failure('UPGRADE_PROFILE_UNAVAILABLE');
    return directory;
  } catch (error) {
    throw safe(error);
  }
}

async function readRegularFile(filename, maxBytes, fs) {
  const info = await fs.lstat(filename);
  if (info.isSymbolicLink() || !info.isFile() || info.size > maxBytes) throw failure('UPGRADE_PROFILE_UNAVAILABLE');
  return fs.readFile(filename, 'utf8');
}

function declaredBundles(manifest) {
  const declared = manifest?.dsh?.profile?.bundles;
  if (!Array.isArray(declared)) return [];
  return declared.map(bundleName).filter((name) => name !== null);
}

export function parseCombineIds(text) {
  const ids = new Set();
  for (const line of String(text ?? '').split('\n')) {
    const match = DUMP_ENTRY.exec(line);
    if (match) ids.add(match[1]);
  }
  return ids;
}

/**
 * Reads the writable slice of one profile: dependency specs, declared bundle
 * names, the raw patch text (`null` when absent), and the manifest for
 * round-tripping fields this feature must not touch.
 */
export async function readProfileInventory({ id, home, fs = nodeFs } = {}) {
  const dir = await resolveProfileDirectory({ id, home, fs });
  try {
    const manifestPath = path.join(dir, 'package.json');
    const info = await fs.lstat(manifestPath);
    if (info.isSymbolicLink() || !info.isFile() || info.size > MAX_PACKAGE_BYTES) throw failure('UPGRADE_PROFILE_UNAVAILABLE');
    let manifest;
    try {
      manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    } catch {
      throw failure('UPGRADE_PROFILE_UNAVAILABLE');
    }
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw failure('UPGRADE_PROFILE_UNAVAILABLE');
    const dependencies = manifest.dependencies && typeof manifest.dependencies === 'object' && !Array.isArray(manifest.dependencies)
      ? { ...manifest.dependencies }
      : {};
    let patchText = null;
    try {
      patchText = await readRegularFile(path.join(dir, 'cordis.patch.yml'), MAX_PATCH_BYTES, fs);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw safe(error);
    }
    return { id, dir, manifest, dependencies, bundles: declaredBundles(manifest), patchText };
  } catch (error) {
    throw safe(error);
  }
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

async function drain(stream) {
  if (!stream) return;
  try {
    for await (const _ of stream) void _;
  } catch {
    // Command output is private and never surfaced.
  }
}

/**
 * Runs `dsh --profile <id> --dump-config` and returns the top-level id set.
 * The executable is resolved through the same subprocess service as Host
 * starts, so no PATH or shell handling is duplicated here.
 */
export async function readCombineIds({
  id, dir, home, subprocess, cliCommand = 'dsh', graceMs = 8_000, timeoutMs = 60_000, maxBytes = MAX_DUMP_BYTES,
} = {}) {
  if (!subprocess || typeof subprocess.resolveExecutable !== 'function' || typeof subprocess.spawn !== 'function') {
    throw failure('UPGRADE_VALIDATION_FAILED');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  let handle;
  try {
    const executable = await subprocess.resolveExecutable(cliCommand, undefined, controller.signal);
    handle = subprocess.spawn({
      argv: [executable, '--profile', id, '--dump-config'],
      cwd: dir,
      stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
      graceMs,
      env: { DSH_HOME: home },
      signal: controller.signal,
    });
    const [stdout, outcome] = await Promise.all([collectText(handle.stdout, maxBytes), handle.done, drain(handle.stderr)]);
    if (outcome?.exitCode !== 0) throw failure('UPGRADE_VALIDATION_FAILED');
    return parseCombineIds(stdout);
  } catch (error) {
    try { handle?.terminate(); } catch { /* already gone */ }
    await Promise.resolve(handle?.waitForExit?.()).catch(() => false);
    throw safe(error, 'UPGRADE_VALIDATION_FAILED');
  } finally {
    clearTimeout(timer);
  }
}
