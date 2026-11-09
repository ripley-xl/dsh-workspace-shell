// Pure desktop -> web alignment for the local upgrade path. Every function
// takes plain inventories and returns the next state plus the reasons for any
// skipped item; no filesystem, npm or process access happens here.
//
// Inventory shape: { dependencies: { name: spec }, bundles: string[], patchText: string|null }.

import {
  appendConfigEntry, configSignature, entryConfigLines, entryName, parsePatch, replaceEntryConfig,
} from './patch-text.js';

export const WEB_BUNDLE = '@deepseek-ai/dsh-web-app';
export const OFFICIAL_SCOPE = '@deepseek-ai/';

/** Plugins that must never be copied from desktop; the shell brings its own SSH dependency. */
export const EXCLUDED_PACKAGES = Object.freeze([
  'dsh-workspace-shell',
  'dsh-pet',
  '@local/dsh-preset-whale-maid',
  '@xmanrui/dsh-im',
  '@local/dsh-ssh-remote',
]);

/** Config entries whose values are machine-specific or intentionally narrower on web. */
export const RESERVED_PATCH_IDS = Object.freeze(['llm-deepseek-account', 'plugin-manager']);

const DEPENDENCY_NAME = /^(?:@[A-Za-z0-9][A-Za-z0-9._~-]*\/)?[A-Za-z0-9][A-Za-z0-9._~-]*$/u;
const UNSAFE_QUERY = /[?&](?:token|access[_-]?token|auth|api[_-]?key|password|passwd|secret|key)=/iu;

function dependencyMap(input) {
  if (!input || typeof input !== 'object') return {};
  const value = input.dependencies;
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function bundleList(input) {
  if (!input || typeof input !== 'object' || !Array.isArray(input.bundles)) return [];
  return input.bundles;
}

function patchTextOf(input) {
  return typeof input?.patchText === 'string' ? input.patchText : '';
}

export function isDependencyName(name) {
  return typeof name === 'string' && DEPENDENCY_NAME.test(name);
}

export function isOfficialPackage(name) {
  return typeof name === 'string' && name.startsWith(OFFICIAL_SCOPE);
}

/**
 * Dependency source class. Only registry specs, `github:`/`git+`, `file:` and
 * `link:` are supported; every other protocol or malformed value is rejected.
 */
export function dependencySource(spec) {
  if (typeof spec !== 'string' || spec === '' || spec.trim() !== spec) return 'invalid';
  if (/^(?:github:|git\+)/u.test(spec)) return 'git';
  if (/^(?:file:|link:)/u.test(spec)) return 'path';
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(spec)) return 'invalid';
  if (/[\s\u0000-\u001f\u007f]/u.test(spec)) return 'invalid';
  return 'registry';
}

/** Rejects specs carrying URL credentials or suspicious query parameters. */
export function unsafeDependencySpec(spec) {
  if (typeof spec !== 'string' || spec === '' || spec.trim() !== spec) return true;
  if (/[\u0000-\u001f\u007f]/u.test(spec)) return true;
  if (/\/\/[^/\s]*@/u.test(spec)) return true;
  if (/\/\/[^/\s]*:[^/\s]*@/u.test(spec)) return true;
  if (UNSAFE_QUERY.test(spec)) return true;
  return false;
}

/** Bundle names may arrive plain or as loader objects. */
export function bundleName(value) {
  if (typeof value === 'string') return value.trim() || null;
  if (value && typeof value === 'object') {
    for (const key of ['name', 'package', 'spec']) {
      if (typeof value[key] === 'string' && value[key].trim()) return value[key].trim();
    }
  }
  return null;
}

function excludedName(name, excluded) {
  return typeof name === 'string' && excluded.has(name);
}

function excludedSet(excluded) {
  return new Set(Array.isArray(excluded) ? excluded : EXCLUDED_PACKAGES);
}

function officialTarget(name, existing, { latest, dshVersion, changes }) {
  if (!dshVersion) return existing;
  const published = latest[name];
  if (typeof published !== 'string' || published !== dshVersion) {
    changes.push({ name, action: 'skip', from: existing, reason: 'official-version-unavailable' });
    return existing;
  }
  return dshVersion;
}

/**
 * npm names whose latest version the caller must resolve before planning.
 * Registry latest is only used where the alignment rules actually apply.
 */
export function latestDependencyNames({ web, desktop, dshVersion = null } = {}) {
  const webDeps = dependencyMap(web);
  const desktopDeps = desktop === undefined ? null : dependencyMap(desktop);
  const names = new Set();
  const consider = (name, spec) => {
    if (!isDependencyName(name) || unsafeDependencySpec(spec)) return;
    if (dependencySource(spec) !== 'registry') return;
    names.add(name);
  };
  for (const [name, spec] of Object.entries(webDeps)) {
    if (desktopDeps && desktopDeps[name] !== undefined) {
      const desktopSpec = desktopDeps[name];
      // A raw desktop spec wins over any registry lookup.
      if (dependencySource(desktopSpec) === 'registry') consider(name, spec);
      continue;
    }
    if (desktopDeps) {
      if (isOfficialPackage(name) && dshVersion) consider(name, spec);
      continue;
    }
    // Self upgrade: every registry dependency moves to latest (official ones
    // only when a new DSH version is being installed).
    if (isOfficialPackage(name) && !dshVersion) continue;
    consider(name, spec);
  }
  if (desktopDeps) {
    for (const [name, spec] of Object.entries(desktopDeps)) {
      if (webDeps[name] !== undefined) continue;
      // Added official packages follow the new DSH version; others keep the desktop spec.
      if (isOfficialPackage(name) && dshVersion) consider(name, spec);
    }
  }
  return [...names];
}

export function alignDependencies({ desktop, web, latest = {}, dshVersion = null, excluded = EXCLUDED_PACKAGES } = {}) {
  const webDeps = dependencyMap(web);
  const desktopDeps = dependencyMap(desktop);
  const skip = excludedSet(excluded);
  const dependencies = { ...webDeps };
  const changes = [];

  const registryDesired = (name, spec, { adding = false } = {}) => {
    if (isOfficialPackage(name)) return officialTarget(name, spec, { latest, dshVersion, changes });
    const published = latest[name];
    if (typeof published !== 'string' || published === '') {
      // An added package keeps its desktop spec; only an existing web spec
      // records the missing registry answer as a reason.
      if (!adding) changes.push({ name, action: 'skip', from: spec, reason: 'latest-unavailable' });
      return spec;
    }
    return published;
  };

  for (const [name, desktopSpec] of Object.entries(desktopDeps)) {
    if (skip.has(name)) {
      changes.push({ name, action: 'skip', reason: 'excluded' });
      continue;
    }
    if (!isDependencyName(name)) {
      changes.push({ name: String(name), action: 'skip', reason: 'invalid-name' });
      continue;
    }
    if (unsafeDependencySpec(desktopSpec)) {
      changes.push({ name, action: 'skip', reason: 'unsafe-spec' });
      continue;
    }
    const source = dependencySource(desktopSpec);
    if (source === 'invalid') {
      changes.push({ name, action: 'skip', reason: 'unsupported-spec' });
      continue;
    }
    const existing = webDeps[name];
    if (existing === undefined) {
      const desired = source === 'registry' ? registryDesired(name, desktopSpec, { adding: true }) : desktopSpec;
      dependencies[name] = desired;
      changes.push({ name, action: 'add', to: desired });
      continue;
    }
    if (unsafeDependencySpec(existing)) {
      changes.push({ name, action: 'skip', reason: 'unsafe-spec' });
      continue;
    }
    const desired = source === 'registry' ? registryDesired(name, existing) : desktopSpec;
    if (desired !== existing) {
      dependencies[name] = desired;
      changes.push({ name, action: 'update', from: existing, to: desired });
    }
  }

  // Official web-only dependencies also follow a DSH upgrade, but only when
  // npm publishes that exact version for them.
  if (dshVersion) {
    for (const [name, spec] of Object.entries(webDeps)) {
      if (desktopDeps[name] !== undefined || !isOfficialPackage(name)) continue;
      if (skip.has(name) || unsafeDependencySpec(spec) || dependencySource(spec) !== 'registry') continue;
      if (latest[name] !== dshVersion) continue;
      if (dependencies[name] !== dshVersion) {
        changes.push({ name, action: 'update', from: spec, to: dshVersion });
        dependencies[name] = dshVersion;
      }
    }
  }

  return { dependencies, changes };
}

export function alignBundles({ desktop, web, excluded = EXCLUDED_PACKAGES } = {}) {
  const skip = excludedSet(excluded);
  const webBundles = [...bundleList(web)];
  const seen = new Set();
  for (const value of webBundles) {
    const name = bundleName(value);
    if (name) seen.add(name);
  }
  const bundles = [...webBundles];
  const appended = [];
  const skipped = [];
  for (const value of bundleList(desktop)) {
    const name = bundleName(value);
    if (!name) {
      skipped.push({ name: String(value), reason: 'invalid' });
      continue;
    }
    if (skip.has(name)) {
      skipped.push({ name, reason: 'excluded' });
      continue;
    }
    if (seen.has(name)) continue;
    seen.add(name);
    bundles.push(name);
    appended.push(name);
  }
  return { bundles, appended, skipped };
}

/**
 * Turns desktop patch entries into config-only operations. Only entries that
 * exist in the web combined config, are not excluded, are not reserved and
 * carry a `config` section are eligible; `disabled`-only entries never copy.
 */
export function alignPatch({ desktopPatch, webPatch, combineIds, excluded = EXCLUDED_PACKAGES, reserved = RESERVED_PATCH_IDS } = {}) {
  const skip = excludedSet(excluded);
  const reservedIds = new Set(Array.isArray(reserved) ? reserved : RESERVED_PATCH_IDS);
  const ids = combineIds instanceof Set ? combineIds : new Set(Array.isArray(combineIds) ? combineIds : []);
  const desktop = parsePatch(patchTextOf({ patchText: desktopPatch }));
  const web = parsePatch(patchTextOf({ patchText: webPatch }));
  const webEntries = new Map(web.entries.map((entry) => [entry.id, entry]));
  const operations = [];
  const skipped = [];
  for (const entry of desktop.entries) {
    const id = entry.id;
    if (!ids.has(id)) {
      skipped.push({ id, reason: 'not-in-combine' });
      continue;
    }
    const name = entryName(entry);
    if (name && skip.has(name)) {
      skipped.push({ id, reason: 'excluded' });
      continue;
    }
    if (reservedIds.has(id)) {
      skipped.push({ id, reason: 'reserved' });
      continue;
    }
    const configLines = entryConfigLines(entry);
    if (!configLines) {
      skipped.push({ id, reason: 'no-config' });
      continue;
    }
    const existing = webEntries.get(id);
    if (existing) {
      if (configSignature(existing) === configSignature(entry)) continue;
      operations.push({ kind: 'replace', id, configLines });
      continue;
    }
    if (!name) {
      skipped.push({ id, reason: 'no-name' });
      continue;
    }
    operations.push({ kind: 'append', id, name, configLines });
  }
  return { operations, skipped };
}

/** Applies planned patch operations in order, preserving the rest of the file. */
export function applyPatchOperations(text, operations) {
  let document = typeof text === 'string' ? text : '';
  for (const operation of operations ?? []) {
    if (operation?.kind === 'replace') {
      const next = replaceEntryConfig(document, operation.id, operation.configLines);
      if (next === null) throw new TypeError('patch entry disappeared during apply');
      document = next;
    } else if (operation?.kind === 'append') {
      document = appendConfigEntry(document, { id: operation.id, name: operation.name, configLines: operation.configLines });
    } else {
      throw new TypeError('unknown patch operation');
    }
  }
  return document;
}

/** Full web-target plan: dependencies, bundles and config entries. */
export function computeAlignPlan({ desktop, web, combineIds, latest = {}, dshVersion = null, excluded = EXCLUDED_PACKAGES } = {}) {
  const dependency = alignDependencies({ desktop, web, latest, dshVersion, excluded });
  const bundle = alignBundles({ desktop, web, excluded });
  const patch = alignPatch({
    desktopPatch: patchTextOf(desktop),
    webPatch: patchTextOf(web),
    combineIds,
    excluded,
  });
  const dependencyPending = dependency.changes.some((change) => change.action === 'add' || change.action === 'update');
  return {
    mode: 'align',
    dependencies: dependency.dependencies,
    dependencyChanges: dependency.changes,
    bundles: bundle.bundles,
    bundleAppended: bundle.appended,
    bundleSkipped: bundle.skipped,
    patchOperations: patch.operations,
    patchSkipped: patch.skipped,
    pending: dependencyPending || bundle.appended.length > 0 || patch.operations.length > 0,
  };
}

/** Non-web target plan: only existing registry dependencies move to latest. */
export function computeSelfPlan({ web, latest = {}, dshVersion = null } = {}) {
  const dependencies = {};
  const changes = [];
  for (const [name, spec] of Object.entries(dependencyMap(web))) {
    if (!isDependencyName(name)) {
      changes.push({ name: String(name), action: 'skip', reason: 'invalid-name' });
      continue;
    }
    if (unsafeDependencySpec(spec)) {
      changes.push({ name, action: 'skip', reason: 'unsafe-spec' });
      continue;
    }
    if (dependencySource(spec) !== 'registry') {
      dependencies[name] = spec;
      continue;
    }
    let desired = spec;
    if (isOfficialPackage(name)) {
      if (dshVersion) desired = officialTarget(name, spec, { latest, dshVersion, changes });
    } else {
      const published = latest[name];
      if (typeof published === 'string' && published !== '') desired = published;
      else changes.push({ name, action: 'skip', from: spec, reason: 'latest-unavailable' });
    }
    if (desired !== spec) changes.push({ name, action: 'update', from: spec, to: desired });
    dependencies[name] = desired;
  }
  const pending = changes.some((change) => change.action === 'update');
  return {
    mode: 'self',
    dependencies,
    dependencyChanges: changes,
    bundles: [...bundleList(web)],
    bundleAppended: [],
    bundleSkipped: [],
    patchOperations: [],
    patchSkipped: [],
    pending,
  };
}
