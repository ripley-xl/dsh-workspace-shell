import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

import {
  SshRemoteError,
  abortError,
  isAbortError,
  operationTimeout,
} from './errors.js';

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_CONFIG_OUTPUT_BYTES = 4 * 1024 * 1024;

function configError(message, cause) {
  return new SshRemoteError('SSH_CONFIG_INVALID', message, { cause });
}

function unsupported(message) {
  return new SshRemoteError('SSH_UNSUPPORTED_CONFIG', message);
}

export function splitSshConfigWords(value) {
  const words = [];
  let word = '';
  let quote;
  let escaped = false;
  let started = false;

  for (const character of value.trim()) {
    if (escaped) {
      word += character;
      escaped = false;
      started = true;
      continue;
    }
    if (character === '\\' && quote !== "'") {
      escaped = true;
      started = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = undefined;
      else word += character;
      started = true;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      started = true;
      continue;
    }
    if (/\s/u.test(character)) {
      if (started) words.push(word);
      word = '';
      started = false;
      continue;
    }
    word += character;
    started = true;
  }

  if (escaped || quote) throw configError('ssh -G returned an invalid quoted value.');
  if (started) words.push(word);
  return words;
}

function validateAlias(alias) {
  if (
    typeof alias !== 'string'
    || alias.length === 0
    || alias.startsWith('-')
    || /[\s\0\r\n]/u.test(alias)
  ) {
    throw configError('The SSH host alias is empty or contains invalid characters.');
  }
}

function isNone(value) {
  return value.trim().toLowerCase() === 'none';
}

function expandSshTokens(value, context) {
  let result = '';
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character !== '%') {
      result += character;
      continue;
    }
    const token = value[index + 1];
    index += 1;
    const replacements = {
      '%': '%',
      d: context.homeDir,
      h: context.hostname,
      p: String(context.port),
      r: context.user,
      u: context.localUser,
    };
    if (!Object.hasOwn(replacements, token)) {
      throw unsupported(`Unsupported OpenSSH path token %${token ?? ''}.`);
    }
    result += replacements[token];
  }
  return result;
}

function expandHome(value, homeDir) {
  if (value === '~') return homeDir;
  if (value.startsWith('~/')) return path.join(homeDir, value.slice(2));
  if (value.startsWith('~')) {
    throw unsupported('OpenSSH paths for another user are not supported.');
  }
  return value;
}

function expandPath(value, context) {
  const expanded = expandHome(expandSshTokens(value, context), context.homeDir);
  return path.resolve(context.cwd, expanded);
}

function expandAgent(value, context) {
  if (isNone(value)) return null;
  const environmentExpanded = value.replace(/^\$\{([A-Z_][A-Z0-9_]*)\}$|^\$([A-Z_][A-Z0-9_]*)$/u, (_, braced, plain) => (
    context.env[braced ?? plain] ?? ''
  ));
  if (!environmentExpanded) return null;
  return expandPath(environmentExpanded, context);
}

function singleWord(value, field) {
  const words = splitSshConfigWords(value);
  if (words.length !== 1 || words[0].length === 0) {
    throw configError(`${field} must contain exactly one value.`);
  }
  return words[0];
}

export function parseProxyJump(value) {
  if (isNone(value)) return null;
  const text = value.trim();
  if (text.includes(',')) throw unsupported('Multiple ProxyJump hops are not supported.');
  let destination = text;
  let user;
  const at = destination.lastIndexOf('@');
  if (at >= 0) {
    user = destination.slice(0, at);
    destination = destination.slice(at + 1);
    if (!user || /[\s\0]/u.test(user)) throw configError('ProxyJump contains an invalid user.');
  }

  let port;
  if (destination.startsWith('[')) {
    const closing = destination.indexOf(']');
    if (closing < 0) throw configError('ProxyJump contains an invalid bracketed host.');
    const remainder = destination.slice(closing + 1);
    destination = destination.slice(1, closing);
    if (remainder) {
      if (!remainder.startsWith(':')) throw configError('ProxyJump contains an invalid host.');
      port = remainder.slice(1);
    }
  } else if ((destination.match(/:/gu) ?? []).length === 1) {
    const separator = destination.lastIndexOf(':');
    port = destination.slice(separator + 1);
    destination = destination.slice(0, separator);
  }
  validateAlias(destination);
  if (port !== undefined) {
    if (!/^\d+$/u.test(port)) throw configError('ProxyJump contains an invalid port.');
    port = Number(port);
    if (port < 1 || port > 65_535) throw configError('ProxyJump contains an invalid port.');
  }
  return { alias: destination, port, user };
}

export function parseSshGOutput(alias, stdout, options = {}) {
  validateAlias(alias);
  if (typeof stdout !== 'string' || stdout.length === 0) {
    throw configError('ssh -G returned no effective configuration.');
  }

  const raw = new Map();
  for (const line of stdout.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    const separator = line.search(/\s/u);
    if (separator < 1) throw configError('ssh -G returned a malformed line.');
    const key = line.slice(0, separator).toLowerCase();
    const value = line.slice(separator).trim();
    const previous = raw.get(key);
    if (previous) previous.push(value);
    else raw.set(key, [value]);
  }

  const first = (key) => raw.get(key)?.[0];
  const hostname = first('hostname')?.trim();
  const user = first('user')?.trim();
  const portText = first('port')?.trim();
  if (!hostname || /[\s\0]/u.test(hostname)) throw configError('HostName is missing or invalid.');
  if (!user || /[\s\0]/u.test(user)) throw configError('User is missing or invalid.');
  if (!/^\d+$/u.test(portText ?? '')) throw configError('Port is missing or invalid.');
  const port = Number(portText);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw configError('Port must be an integer from 1 to 65535.');
  }

  for (const key of ['proxyjump', 'proxycommand']) {
    const value = first(key);
    if (options.proxySupport !== true && value && !isNone(value)) {
      throw unsupported(`${key === 'proxyjump' ? 'ProxyJump' : 'ProxyCommand'} is not supported.`);
    }
  }

  const strictHostKeyChecking = (first('stricthostkeychecking') ?? 'ask').trim().toLowerCase();
  if (['no', 'off'].includes(strictHostKeyChecking)) {
    throw unsupported('StrictHostKeyChecking=no/off is not supported.');
  }
  if (!['yes', 'on', 'ask', 'accept-new'].includes(strictHostKeyChecking)) {
    throw configError('StrictHostKeyChecking contains an unsupported value.');
  }

  const homeDir = options.homeDir ?? os.homedir();
  const env = options.env ?? process.env;
  const localUser = options.localUser ?? env.USER ?? os.userInfo().username;
  const context = {
    cwd: options.cwd ?? process.cwd(),
    env,
    homeDir,
    hostname,
    localUser,
    port,
    user,
  };

  const proxyCommandValue = first('proxycommand');
  const proxyJumpValue = first('proxyjump');
  const hasProxyCommand = proxyCommandValue && !isNone(proxyCommandValue);
  const hasProxyJump = proxyJumpValue && !isNone(proxyJumpValue);
  if (hasProxyCommand && hasProxyJump) {
    throw configError('ProxyCommand and ProxyJump cannot be used together.');
  }
  const proxyCommand = hasProxyCommand
    ? splitSshConfigWords(proxyCommandValue).map((word) => expandSshTokens(word, context))
    : null;
  if (proxyCommand?.length === 0 || proxyCommand?.[0] === '') {
    throw configError('ProxyCommand must name an executable.');
  }
  const proxyJump = hasProxyJump ? parseProxyJump(proxyJumpValue) : null;

  const identityFiles = (raw.get('identityfile') ?? [])
    .map((value) => singleWord(value, 'IdentityFile'))
    .filter((value) => !isNone(value))
    .map((value) => expandPath(value, context));
  const identityAgentValue = first('identityagent');
  const identityAgent = identityAgentValue === undefined
    ? undefined
    : expandAgent(singleWord(identityAgentValue, 'IdentityAgent'), context);
  const hostKeyAliasValue = first('hostkeyalias');
  const hostKeyAlias = hostKeyAliasValue
    ? expandSshTokens(singleWord(hostKeyAliasValue, 'HostKeyAlias'), context)
    : undefined;
  if (hostKeyAlias !== undefined && (!hostKeyAlias || /[\s\0,]/u.test(hostKeyAlias))) {
    throw configError('HostKeyAlias is empty or contains invalid characters.');
  }
  const pathList = (key) => (raw.get(key) ?? [])
    .flatMap((value) => splitSshConfigWords(value))
    .filter((value) => !isNone(value))
    .map((value) => expandPath(value, context));

  return {
    alias,
    hostname,
    user,
    port,
    identityFiles,
    identityAgent,
    hostKeyAlias,
    strictHostKeyChecking,
    proxyCommand,
    proxyJump,
    userKnownHostsFiles: pathList('userknownhostsfile'),
    globalKnownHostsFiles: pathList('globalknownhostsfile'),
  };
}

export async function resolveSshConfig(alias, options = {}) {
  validateAlias(alias);
  if (options.signal?.aborted) throw abortError(options.signal);

  const execute = options.execFile ?? execFile;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let stdout;
  try {
    stdout = await new Promise((resolve, reject) => {
      execute(
        options.sshPath ?? 'ssh',
        ['-G', '--', alias],
        {
          cwd: options.cwd,
          encoding: 'utf8',
          env: options.env ?? process.env,
          maxBuffer: MAX_CONFIG_OUTPUT_BYTES,
          signal: options.signal,
          timeout: timeoutMs,
          windowsHide: true,
        },
        (error, output) => error ? reject(error) : resolve(output),
      );
    });
  } catch (error) {
    if (isAbortError(error, options.signal)) throw abortError(options.signal);
    if (error?.killed) {
      throw operationTimeout('Timed out while resolving the SSH configuration.', error);
    }
    throw configError('ssh -G could not resolve this host alias.', error);
  }

  return parseSshGOutput(alias, stdout, { proxySupport: true, ...options });
}
