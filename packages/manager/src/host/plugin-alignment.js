import { DEFAULT_PROFILE_ID, normalizeProfileId } from './profiles.js';
import { isNewerVersion } from './registry.js';

/**
 * Plans automatic upgrades for official remote plugins that the remote DSH
 * rejected as incompatible with its own version.
 *
 * The manager only ever removes and reinstalls a remote plugin when all of the
 * following hold:
 *   - the remote bundle is installed in a profile and DSH marked it explicitly
 *     incompatible (`incompatible-version`, or a non-empty `incompatible` list);
 *   - the local installation has a bundle with the same name;
 *   - a safe install spec can be derived for that local bundle.
 *
 * Registry specs may be a local path, tarball, `file:` reference or carry URL
 * credentials. Those are never sent to a remote Host; the entry is skipped with
 * a reason instead.
 */

const MAX_NAME_LENGTH = 256;
const MAX_SPEC_LENGTH = 512;
const MAX_VERSION_LENGTH = 128;
const LOCAL_PATH = /(?:^|[\s("'=])\/(?:[^\s/]+[\\/])+[^\s]*/u;
const WINDOWS_PATH = /(?:^|[\s("'=])[A-Za-z]:[\\/]/u;
const TARBALL = /\.(?:tgz|tar\.gz|tar|zip)(?:$|[?#])/iu;
const USER_INFO_URL = /[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s/]+@/u;
const SENSITIVE_QUERY = /[?&](?:access_?token|api_?key|auth|credential|password|secret|token)=/iu;
const PROTOCOL_SPEC = /^[A-Za-z][A-Za-z0-9+.-]*:/u;
const CONTROL_CHARACTERS = /[\0\r\n]/u;

function nonEmptyString(value, max) {
  if (typeof value !== 'string') return null;
  const result = value.trim();
  return result && result.length <= max && !CONTROL_CHARACTERS.test(result) ? result : null;
}

function safeSpec(value) {
  const spec = nonEmptyString(value, MAX_SPEC_LENGTH);
  if (!spec) return null;
  if (spec.startsWith('/') || spec.startsWith('~') || /^\.{1,2}(?:[\\/]|$)/u.test(spec)) return null;
  if (LOCAL_PATH.test(spec) || WINDOWS_PATH.test(spec)) return null;
  if (/file:/iu.test(spec)) return null;
  if (TARBALL.test(spec)) return null;
  if (USER_INFO_URL.test(spec) || SENSITIVE_QUERY.test(spec)) return null;
  if (/\s/u.test(spec)) return null;
  return spec;
}

/** The package name a registry spec installs; `null` for source-style specs. */
function registryPackageName(spec) {
  if (spec.startsWith('@')) {
    const slash = spec.indexOf('/');
    if (slash < 0) return null;
    const at = spec.indexOf('@', slash);
    return nonEmptyString(at > 0 ? spec.slice(0, at) : spec, MAX_NAME_LENGTH);
  }
  const at = spec.indexOf('@');
  return nonEmptyString(at > 0 ? spec.slice(0, at) : spec, MAX_NAME_LENGTH);
}

function versionFromSpec(spec) {
  if (PROTOCOL_SPEC.test(spec)) return null;
  const at = spec.lastIndexOf('@');
  if (at <= 0) return null;
  const version = spec.slice(at + 1);
  return version && !version.includes('/') && !version.includes(':') ? nonEmptyString(version, MAX_VERSION_LENGTH) : null;
}

/** Picks the safest install target for a local bundle, or `null`. */
function targetSpec(name, local) {
  const candidates = [];
  if (typeof local.installTarget?.spec === 'string') candidates.push(local.installTarget.spec);
  if (typeof local.version === 'string' && local.version.trim()) candidates.push(`${name}@${local.version.trim()}`);
  if (typeof local.source === 'string') candidates.push(local.source);
  for (const candidate of candidates) {
    const spec = safeSpec(candidate);
    if (!spec) continue;
    // Registry specs must install the same package we are replacing; explicit
    // source specs (github:, git+https:) name the repository instead.
    if (!PROTOCOL_SPEC.test(spec) && registryPackageName(spec) !== name) continue;
    return spec;
  }
  return null;
}

function nonEmptyArray(value) {
  return Array.isArray(value) && value.length > 0;
}

function isIncompatibleRemoteBundle(bundle) {
  if (!bundle || bundle.installed !== true || bundle.availability !== 'profile') return false;
  if (bundle?.error?.code === 'incompatible-version') return true;
  return nonEmptyArray(bundle?.error?.incompatible) || nonEmptyArray(bundle?.incompatible);
}

/**
 * @param {{ localBundles?: unknown[], remoteBundles?: unknown[], profileId?: string }} input
 * @returns {{ operations: {name: string, remoteVersion: string|null, spec: string, toVersion: string|null}[], skipped: {name: string, reason: string}[] }}
 */
export function buildPluginAlignmentPlan({ localBundles = [], remoteBundles = [], profileId = DEFAULT_PROFILE_ID } = {}) {
  // The remote Host serves exactly one profile; validating it keeps the plan
  // explicitly scoped to the Host it was read from.
  normalizeProfileId(profileId);
  const locals = new Map();
  for (const bundle of Array.isArray(localBundles) ? localBundles : []) {
    if (!bundle || typeof bundle.name !== 'string' || !bundle.name || locals.has(bundle.name)) continue;
    locals.set(bundle.name, bundle);
  }
  const remotes = new Map();
  for (const bundle of Array.isArray(remoteBundles) ? remoteBundles : []) {
    if (!bundle || typeof bundle.name !== 'string' || !bundle.name || remotes.has(bundle.name)) continue;
    remotes.set(bundle.name, bundle);
  }
  const operations = [];
  const skipped = [];
  for (const [name, bundle] of remotes) {
    if (!isIncompatibleRemoteBundle(bundle)) continue;
    const local = locals.get(name);
    if (!local) {
      skipped.push({ name, reason: 'missing-local-bundle' });
      continue;
    }
    const spec = targetSpec(name, local);
    if (!spec) {
      skipped.push({ name, reason: 'no-safe-install-spec' });
      continue;
    }
    operations.push({
      name,
      remoteVersion: nonEmptyString(bundle.version, MAX_VERSION_LENGTH),
      spec,
      toVersion: versionFromSpec(spec) ?? nonEmptyString(local.version, MAX_VERSION_LENGTH),
    });
  }
  return { operations, skipped };
}

const SOURCE_SPEC = /^(?:github:|git\+https:|https:\/\/github\.com\/)/iu;
const INTERNAL_BUNDLE = /^@local\/dsh-ssh-remote(?:-status)?(?:@|$)/u;

/**
 * Plugins that belong to the Desktop host only. The local web profile never
 * receives them (see the shell's EXCLUDED_PACKAGES), so a remote web profile
 * must not receive them either: the shell, the desktop preset, the IM bridge
 * and the pet render inside the Desktop window.
 */
export const DESKTOP_ONLY_PLUGINS = Object.freeze([
  'dsh-workspace-shell',
  'dsh-pet',
  '@local/dsh-preset-whale-maid',
  '@xmanrui/dsh-im',
  '@local/dsh-ssh-remote',
]);
const DESKTOP_ONLY = new Set(DESKTOP_ONLY_PLUGINS);

/** True when DSH installed this bundle from the registry or a source URL. */
function isShareableLocalBundle(bundle) {
  if (!bundle || typeof bundle.name !== 'string' || !bundle.name) return false;
  if (bundle.installed !== true || bundle.official === true) return false;
  if (bundle.availability === 'installation' || bundle.availability === 'missing') return false;
  if (INTERNAL_BUNDLE.test(bundle.name) || DESKTOP_ONLY.has(bundle.name)) return false;
  return true;
}

/**
 * Install spec for a bundle the local Host installed itself. Only registry and
 * public source specs qualify: a `link:`/`file:`/tarball install names a path
 * that exists on this machine only, and falling back to `name@version` would
 * silently swap it for a different artifact.
 */
function shareableSpec(name, local) {
  const candidates = [];
  if (typeof local.installTarget?.spec === 'string') candidates.push(local.installTarget.spec);
  if (typeof local.source === 'string') candidates.push(local.source);
  for (const candidate of candidates) {
    const spec = safeSpec(candidate);
    if (!spec) continue;
    if (PROTOCOL_SPEC.test(spec)) {
      if (SOURCE_SPEC.test(spec)) return spec;
      continue;
    }
    if (registryPackageName(spec) === name) return spec;
  }
  return null;
}

/** Package names of local bundles whose install spec can travel to a remote. */
export function shareableLocalPluginNames(localBundles = []) {
  const names = new Set();
  for (const bundle of Array.isArray(localBundles) ? localBundles : []) {
    if (!isShareableLocalBundle(bundle)) continue;
    if (!shareableSpec(bundle.name, bundle)) continue;
    names.add(bundle.name);
  }
  return names;
}

/**
 * Local plugins the remote profile does not have yet, or has at an older
 * version. Official bundles are excluded: their enablement is synchronized
 * separately and they ship with the runtime.
 *
 * @param {{ localBundles?: unknown[], remoteBundles?: unknown[] }} input
 */
export function planPluginSync({ localBundles = [], remoteBundles = [] } = {}) {
  const remotes = new Map();
  for (const bundle of Array.isArray(remoteBundles) ? remoteBundles : []) {
    if (!bundle || typeof bundle.name !== 'string' || !bundle.name || remotes.has(bundle.name)) continue;
    remotes.set(bundle.name, bundle);
  }
  const operations = [];
  const skipped = [];
  const seen = new Set();
  for (const local of Array.isArray(localBundles) ? localBundles : []) {
    const name = local?.name;
    if (typeof name !== 'string' || !name || seen.has(name)) continue;
    seen.add(name);
    if (!isShareableLocalBundle(local)) continue;
    const spec = shareableSpec(name, local);
    if (!spec) {
      skipped.push({ name, reason: 'local-source' });
      continue;
    }
    const localVersion = nonEmptyString(local.version, MAX_VERSION_LENGTH) ?? versionFromSpec(spec);
    const remote = remotes.get(name);
    const remoteVersion = nonEmptyString(remote?.version, MAX_VERSION_LENGTH);
    const remoteSource = nonEmptyString(remote?.source, MAX_SPEC_LENGTH) ?? nonEmptyString(remote?.spec, MAX_SPEC_LENGTH);
    if (remote?.installed === true) {
      // A git install is pinned by its spec, not by the version inside the
      // package: a new commit can keep the version and still be a different
      // build. Same source string means nothing to do.
      if (SOURCE_SPEC.test(spec)) {
        if (remoteSource === spec) continue;
        operations.push({
          name, action: 'upgrade', spec, fromVersion: remoteVersion, toVersion: localVersion, fromSpec: remoteSource,
        });
        continue;
      }
      if (!localVersion || !remoteVersion || !isNewerVersion(localVersion, remoteVersion)) continue;
      operations.push({ name, action: 'upgrade', spec, fromVersion: remoteVersion, toVersion: localVersion });
      continue;
    }
    operations.push({ name, action: 'install', spec, fromVersion: null, toVersion: localVersion });
  }
  return { operations, skipped };
}
