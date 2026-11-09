import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { splitSshConfigWords } from './config.js';
import { SshRemoteError } from './errors.js';

const DEFAULT_MAX_FILE_BYTES = 1024 * 1024;
const DEFAULT_MAX_FILES = 64;
const DEFAULT_MAX_DEPTH = 8;
const DEFAULT_MAX_HOSTS = 256;
const DEFAULT_MAX_GLOB_MATCHES = 1024;

function configError(message, reason) {
  return new SshRemoteError('SSH_CONFIG_INVALID', message, { details: { reason } });
}

function positiveInteger(value, fallback, name, allowZero = false) {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < (allowZero ? 0 : 1)) {
    throw new TypeError(`${name} must be ${allowZero ? 'a non-negative' : 'a positive'} integer.`);
  }
  return result;
}

function stripComment(line) {
  let quote;
  let escaped = false;
  let result = '';
  for (const character of line) {
    if (escaped) {
      result += character;
      escaped = false;
      continue;
    }
    if (character === '\\' && quote !== "'") {
      result += character;
      escaped = true;
      continue;
    }
    if (quote) {
      result += character;
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      result += character;
      continue;
    }
    if (character === '#') break;
    result += character;
  }
  return result.trim();
}

function parseDirective(line) {
  const keyMatch = line.match(/^[A-Za-z][A-Za-z0-9]*/u);
  if (!keyMatch) throw configError('The SSH configuration contains a malformed directive.', 'syntax');
  const remainder = line.slice(keyMatch[0].length);
  const valueMatch = remainder.match(/^(?:\s*=\s*|\s+)(.*)$/u);
  if (!valueMatch || !valueMatch[1].trim()) {
    throw configError('The SSH configuration contains a directive without a value.', 'syntax');
  }
  return { key: keyMatch[0].toLowerCase(), value: valueMatch[1].trim() };
}

function hasGlob(value) {
  return /[*?[]/u.test(value);
}

function globExpression(pattern) {
  let expression = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === '*') {
      expression += '.*';
      continue;
    }
    if (character === '?') {
      expression += '.';
      continue;
    }
    if (character === '[') {
      const closing = pattern.indexOf(']', index + 1);
      if (closing > index + 1) {
        let content = pattern.slice(index + 1, closing);
        let negated = false;
        if (content.startsWith('!') || content.startsWith('^')) {
          negated = true;
          content = content.slice(1);
        }
        if (content) {
          const safe = content.replace(/[\\\]]/gu, '\\$&');
          expression += `[${negated ? '^' : ''}${safe}]`;
          index = closing;
          continue;
        }
      }
    }
    expression += character.replace(/[.+^${}()|[\]\\]/gu, '\\$&');
  }
  return new RegExp(`^${expression}$`, 'u');
}

function matchGlobSegment(segment, name) {
  if (name.startsWith('.') && !segment.startsWith('.')) return false;
  return globExpression(segment).test(name);
}

function matchHostPattern(pattern, alias) {
  return globExpression(pattern.toLowerCase()).test(alias.toLowerCase());
}

function hostBlockApplies(patterns, alias) {
  if (patterns === null) return true;
  let matched = false;
  for (const pattern of patterns) {
    const negated = pattern.startsWith('!');
    const positive = negated ? pattern.slice(1) : pattern;
    if (!positive || !matchHostPattern(positive, alias)) continue;
    if (negated) return false;
    matched = true;
  }
  return matched;
}

function literalAlias(pattern) {
  return pattern && !pattern.startsWith('!') && !hasGlob(pattern);
}

function expandIncludePath(value, context, baseDirectory) {
  let expanded = value;
  if (expanded === '~') expanded = context.homeDir;
  else if (expanded.startsWith('~/')) expanded = path.join(context.homeDir, expanded.slice(2));
  else if (expanded.startsWith('~')) {
    throw configError('Home expansion for another user is not supported.', 'unsupported_home');
  }
  return path.isAbsolute(expanded)
    ? path.normalize(expanded)
    : path.resolve(baseDirectory, expanded);
}

async function expandIncludeGlob(pattern, context) {
  if (!hasGlob(pattern)) return [pattern];
  const root = path.parse(pattern).root;
  const segments = pattern.slice(root.length).split(path.sep).filter(Boolean);
  let candidates = [root];
  let matches = 0;

  for (const segment of segments) {
    const next = [];
    for (const candidate of candidates) {
      if (!hasGlob(segment)) {
        next.push(path.join(candidate, segment));
        continue;
      }
      let entries;
      try {
        entries = await fs.readdir(candidate, { withFileTypes: true });
      } catch (error) {
        if (['ENOENT', 'ENOTDIR'].includes(error?.code)) continue;
        throw configError('An SSH Include directory could not be read.', 'include_read');
      }
      entries.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        if (!matchGlobSegment(segment, entry.name)) continue;
        next.push(path.join(candidate, entry.name));
        matches += 1;
        if (matches > context.maxGlobMatches) {
          throw configError('SSH Include glob expansion exceeded its limit.', 'glob_limit');
        }
      }
    }
    candidates = next;
    if (candidates.length === 0) break;
  }

  const files = [];
  for (const candidate of candidates.sort()) {
    try {
      const stat = await fs.stat(candidate);
      if (stat.isFile()) files.push(candidate);
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error?.code)) throw error;
    }
  }
  return files;
}

async function readBoundedFile(file, maxBytes) {
  const handle = await fs.open(file, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw configError('An SSH Include target is not a regular file.', 'not_file');
    if (stat.size > maxBytes) throw configError('An SSH configuration file exceeded its size limit.', 'file_size');
    const buffer = Buffer.alloc(maxBytes + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > maxBytes) throw configError('An SSH configuration file exceeded its size limit.', 'file_size');
    return buffer.subarray(0, offset).toString('utf8');
  } finally {
    await handle.close();
  }
}

async function expandFile(file, context, depth, stack) {
  let realPath;
  try {
    realPath = await fs.realpath(file);
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw configError('An SSH configuration file could not be resolved.', 'include_read');
  }
  if (stack.includes(realPath)) {
    throw configError('The SSH Include chain contains a cycle.', 'include_cycle');
  }
  if (depth > context.maxDepth) {
    throw configError('The SSH Include chain exceeded its depth limit.', 'max_depth');
  }
  context.fileCount += 1;
  if (context.fileCount > context.maxFiles) {
    throw configError('The SSH configuration exceeded its included-file limit.', 'max_files');
  }

  let content;
  try {
    content = await readBoundedFile(file, context.maxFileBytes);
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const entries = [];
  const nextStack = [...stack, realPath];
  for (const line of content.split(/\r?\n/u)) {
    const text = stripComment(line);
    if (!text) continue;
    const directive = parseDirective(text);
    if (directive.key !== 'include') {
      entries.push({ ...directive, source: file });
      continue;
    }
    const patterns = splitSshConfigWords(directive.value);
    if (patterns.length === 0) throw configError('Include requires at least one path.', 'syntax');
    for (const includePattern of patterns) {
      const expanded = expandIncludePath(includePattern, context, path.dirname(file));
      const files = await expandIncludeGlob(expanded, context);
      for (const includedFile of files) {
        entries.push(...await expandFile(includedFile, context, depth + 1, nextStack));
      }
    }
  }
  return entries;
}

function displayPort(value) {
  if (!/^\d+$/u.test(value)) throw configError('A discovered SSH Port is invalid.', 'invalid_port');
  const port = Number(value);
  if (port < 1 || port > 65_535) throw configError('A discovered SSH Port is invalid.', 'invalid_port');
  return port;
}

function hostsFromEntries(entries, maxHosts) {
  const aliases = new Map();
  const blocks = [{ patterns: null, source: undefined, values: {} }];
  let current = blocks[0];

  for (const entry of entries) {
    if (entry.key === 'host') {
      const patterns = splitSshConfigWords(entry.value);
      if (patterns.length === 0) throw configError('Host requires at least one pattern.', 'syntax');
      current = { patterns, source: entry.source, values: {} };
      blocks.push(current);
      for (const pattern of patterns) {
        if (!literalAlias(pattern)) continue;
        const key = pattern.toLowerCase();
        if (!aliases.has(key)) {
          if (aliases.size >= maxHosts) {
            throw configError('The SSH configuration exceeded its host-alias limit.', 'max_hosts');
          }
          aliases.set(key, { alias: pattern, source: entry.source });
        }
      }
      continue;
    }
    if (['hostname', 'user', 'port'].includes(entry.key) && current.values[entry.key] === undefined) {
      const words = splitSshConfigWords(entry.value);
      if (words.length !== 1) throw configError('A discovered SSH display value is invalid.', 'syntax');
      current.values[entry.key] = words[0];
    }
  }

  return [...aliases.values()].map((record) => {
    const values = {};
    for (const block of blocks) {
      if (!hostBlockApplies(block.patterns, record.alias)) continue;
      for (const field of ['hostname', 'user', 'port']) {
        if (values[field] === undefined && block.values[field] !== undefined) {
          values[field] = block.values[field];
        }
      }
    }
    const result = { ...record };
    if (values.hostname !== undefined) result.hostName = values.hostname;
    if (values.user !== undefined) result.user = values.user;
    if (values.port !== undefined) result.port = displayPort(values.port);
    return result;
  });
}

export async function listConfiguredSshHosts(options = {}) {
  const homeDir = path.resolve(options.homeDir ?? os.homedir());
  const context = {
    fileCount: 0,
    homeDir,
    maxDepth: positiveInteger(options.maxDepth, DEFAULT_MAX_DEPTH, 'maxDepth', true),
    maxFileBytes: positiveInteger(options.maxFileBytes, DEFAULT_MAX_FILE_BYTES, 'maxFileBytes'),
    maxFiles: positiveInteger(options.maxFiles, DEFAULT_MAX_FILES, 'maxFiles'),
    maxGlobMatches: positiveInteger(
      options.maxGlobMatches,
      DEFAULT_MAX_GLOB_MATCHES,
      'maxGlobMatches',
    ),
  };
  const maxHosts = positiveInteger(options.maxHosts, DEFAULT_MAX_HOSTS, 'maxHosts');
  const configFile = path.resolve(options.configFile ?? path.join(homeDir, '.ssh', 'config'));
  const entries = await expandFile(configFile, context, 0, []);
  return hostsFromEntries(entries, maxHosts);
}
