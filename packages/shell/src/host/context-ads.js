import { chmodSync, existsSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { Script } from 'node:vm';

const PACKAGE_NAME = 'dsh-context';
const LOG_PREFIX = 'dsh-workspace-shell: ';

// dsh-context renders a plugin-info card and a sponsored "recom" card in one
// header column. This is a patch against the shipped bundle, so every anchor
// is exact: a layout we do not recognize is left untouched instead of guessed.
const CLIENT_LAYOUT = Object.freeze({
  blockStart: 'let Rp={id:`deepseek-platform`,name:`DeepSeek`',
  blockEnd: 'let tm=new Set;',
  bindings: 'b=Lp(t,e),x=em(t,e),',
  column: '(0,d.jsxs)(`div`,{className:`lc-col`,children:[(0,d.jsx)(b,{}),(0,d.jsx)(x,{},typeof o==`string`?o:void 0)]})',
});
const HOST_LAYOUT = Object.freeze({
  blockStart: 'const Va={id:`deepseek-platform`,name:`DeepSeek`',
  blockEnd: 'const Xa=new Set',
  registration: ',Ya(e)',
});
const AD_ROUTE = '/api/dsh-context/recom';
const AD_FEED = 'raw.githubusercontent.com/bowenliang123/dsh-context';

/**
 * Remove the advertisement code from a dsh-context Client bundle.
 * @param {string} source
 * @returns {{ state: 'patched' | 'already' | 'unsupported', source: string }}
 */
export function patchContextClient(source) {
  const complete = !source.includes(AD_ROUTE)
    && !source.includes(CLIENT_LAYOUT.bindings)
    && !source.includes(CLIENT_LAYOUT.column);
  if (complete) return { state: 'already', source };
  const start = source.indexOf(CLIENT_LAYOUT.blockStart);
  const end = source.indexOf(CLIENT_LAYOUT.blockEnd, Math.max(0, start));
  if (start < 0 || end <= start) return { state: 'unsupported', source };
  if (source.indexOf(CLIENT_LAYOUT.blockStart, start + 1) >= 0
    || source.indexOf(CLIENT_LAYOUT.blockEnd, end + 1) >= 0) return { state: 'unsupported', source };
  let next = source.slice(0, start) + source.slice(end);
  if (!next.includes(CLIENT_LAYOUT.bindings) || !next.includes(CLIENT_LAYOUT.column)) {
    return { state: 'unsupported', source };
  }
  next = next.replace(CLIENT_LAYOUT.bindings, '');
  next = next.replace(',' + CLIENT_LAYOUT.column, '');
  if (next.includes(AD_ROUTE) || next.includes(CLIENT_LAYOUT.bindings) || next.includes(CLIENT_LAYOUT.column)) {
    return { state: 'unsupported', source };
  }
  return { state: 'patched', source: next };
}

/**
 * Remove the advertisement route from a dsh-context Host bundle.
 * @param {string} source
 * @returns {{ state: 'patched' | 'already' | 'unsupported', source: string }}
 */
export function patchContextHost(source) {
  const complete = !source.includes(AD_ROUTE) && !source.includes(HOST_LAYOUT.registration);
  if (complete) return { state: 'already', source };
  const start = source.indexOf(HOST_LAYOUT.blockStart);
  const end = source.indexOf(HOST_LAYOUT.blockEnd, Math.max(0, start));
  if (start < 0 || end <= start) return { state: 'unsupported', source };
  if (source.indexOf(HOST_LAYOUT.blockStart, start + 1) >= 0
    || source.indexOf(HOST_LAYOUT.blockEnd, end + 1) >= 0) return { state: 'unsupported', source };
  let next = source.slice(0, start) + source.slice(end);
  next = next.replace(HOST_LAYOUT.registration, '');
  if (next.includes(AD_ROUTE) || next.includes(HOST_LAYOUT.registration) || next.includes(AD_FEED)) {
    return { state: 'unsupported', source };
  }
  return { state: 'patched', source: next };
}

function resolvePackage(profileDir) {
  const direct = join(profileDir, 'node_modules', PACKAGE_NAME, 'package.json');
  if (existsSync(direct)) return dirname(direct);
  try {
    return dirname(createRequire(join(profileDir, 'package.json')).resolve(PACKAGE_NAME + '/package.json'));
  } catch {
    return null;
  }
}

function writeAtomically(file, source) {
  const temporary = file + '.dsh-workspace-shell.tmp';
  writeFileSync(temporary, source, 'utf8');
  try { chmodSync(temporary, statSync(file).mode); } catch { /* Keep the process umask mode. */ }
  try {
    renameSync(temporary, file);
  } catch {
    writeFileSync(file, source, 'utf8');
    try { unlinkSync(temporary); } catch { /* The fallback already wrote the file. */ }
  }
}

function warn(logger, message) {
  try { logger?.warn?.(LOG_PREFIX + message); } catch { /* Diagnostics never break boot. */ }
}

/**
 * Patch the installed dsh-context package once. The function is a no-op when
 * the plugin is absent and never throws into the Shell lifecycle.
 * @param {{
 *   profileContext?: { dir?: string },
 *   logger?: { warn?: (message: string) => void, info?: (message: string) => void },
 *   clientModules?: { rebuilt?: (id: string) => unknown },
 * }} [options]
 * @returns {{ status: 'skipped' | 'absent' | 'patched' | 'already' | 'partial' | 'failed', version?: string, reason?: string }}
 */
export function removeContextAds(options = {}) {
  const profileDir = options.profileContext?.dir;
  if (typeof profileDir !== 'string' || profileDir === '') return { status: 'skipped' };
  try {
    const packageDir = resolvePackage(profileDir);
    if (packageDir === null) return { status: 'absent' };
    const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
    const version = typeof manifest?.version === 'string' ? manifest.version : 'unknown';
    const clientFile = join(packageDir, 'lib', 'client.js');
    const hostFile = join(packageDir, 'lib', 'index.js');
    if (!existsSync(clientFile) && !existsSync(hostFile)) {
      warn(options.logger, `cannot remove ${PACKAGE_NAME} ads (v${version}): no lib bundle`);
      return { status: 'partial', version, reason: 'missing-bundle' };
    }

    let changed = false;
    if (existsSync(clientFile)) {
      const current = readFileSync(clientFile, 'utf8');
      const result = patchContextClient(current);
      if (result.state === 'unsupported') {
        warn(options.logger, `cannot remove ${PACKAGE_NAME} ads (v${version}): unsupported Client layout`);
        return { status: 'partial', version, reason: 'unsupported-client' };
      }
      if (result.state === 'patched') {
        try {
          new Script(result.source, { filename: clientFile });
        } catch (error) {
          warn(options.logger, `cannot remove ${PACKAGE_NAME} ads (v${version}): patched Client is not parseable (${String(error?.message ?? error)})`);
          return { status: 'failed', version, reason: 'parse-client' };
        }
        writeAtomically(clientFile, result.source);
        changed = true;
      }
    }

    let hostState = 'skipped';
    if (existsSync(hostFile)) {
      const current = readFileSync(hostFile, 'utf8');
      const result = patchContextHost(current);
      hostState = result.state;
      if (result.state === 'unsupported') {
        warn(options.logger, `cannot remove ${PACKAGE_NAME} ads (v${version}): unsupported Host layout`);
        return { status: 'partial', version, reason: 'unsupported-host' };
      }
      if (result.state === 'patched') {
        writeAtomically(hostFile, result.source);
        changed = true;
      }
    }

    if (changed) {
      try { options.clientModules?.rebuilt?.(PACKAGE_NAME); } catch { /* The HMR poll notices the file change too. */ }
      try { options.logger?.info?.(`${LOG_PREFIX}removed ${PACKAGE_NAME} ad panels (v${version})`); } catch { /* Logging is best effort. */ }
      return { status: 'patched', version };
    }
    return { status: 'already', version };
  } catch (error) {
    warn(options.logger, `cannot remove ${PACKAGE_NAME} ads (${String(error?.message ?? error)})`);
    return { status: 'failed', reason: String(error?.message ?? error) };
  }
}
