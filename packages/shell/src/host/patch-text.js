// Entry-level text edits for a profile's `cordis.patch.yml`. The file is a
// top-level YAML sequence of maps; each entry starts with a column-0 `- id:`
// line. Editing the text instead of re-serializing keeps the header comment,
// key order and untouched entries byte-identical, and avoids a YAML dependency
// in the plugin.

const ENTRY_START = /^- id:[ \t]+([^\s#]+)[ \t]*$/u;
const SIBLING = /^ {2}[A-Za-z_][A-Za-z0-9_-]*:/u;
const CONFIG_START = /^ {2}config:/u;
const NAME = /^ {2}name:/u;

function linesOf(text) {
  return String(text).split('\n');
}

/** Splits a patch document into its header and addressable entries. */
export function parsePatch(text) {
  const lines = linesOf(text);
  const header = [];
  const entries = [];
  let current = null;
  for (const line of lines) {
    const match = ENTRY_START.exec(line);
    if (match) {
      current = { id: match[1], lines: [line] };
      entries.push(current);
      continue;
    }
    if (current) current.lines.push(line);
    else header.push(line);
  }
  return { header, entries };
}

/** The `config` section lines, including its `  config:` line; `null` when absent. */
export function entryConfigLines(entry) {
  if (!entry || !Array.isArray(entry.lines)) return null;
  const start = entry.lines.findIndex((line) => CONFIG_START.test(line));
  if (start < 0) return null;
  let end = start + 1;
  while (end < entry.lines.length && !SIBLING.test(entry.lines[end])) end += 1;
  while (end > start + 1 && entry.lines[end - 1].trim() === '') end -= 1;
  return entry.lines.slice(start, end);
}

/** The entry's `name` value with surrounding quotes removed, or `null`. */
export function entryName(entry) {
  if (!entry || !Array.isArray(entry.lines)) return null;
  const line = entry.lines.find((item) => NAME.test(item));
  if (!line) return null;
  const raw = line.slice(line.indexOf(':') + 1).trim();
  if (!raw) return null;
  return /^(['"]).*\1$/u.test(raw) ? raw.slice(1, -1) : raw;
}

/**
 * Normalized config body for equality checks. The `  config:` line is dropped
 * and trailing whitespace is removed, so a re-copied section compares equal.
 */
export function configSignature(entry) {
  const lines = entryConfigLines(entry);
  if (!lines) return null;
  return lines.slice(1).map((line) => line.replace(/[ \t]+$/u, '')).join('\n');
}

function trailingBlanks(lines) {
  let count = 0;
  while (count < lines.length && lines[lines.length - 1 - count].trim() === '') count += 1;
  return count;
}

function serialize(header, entries) {
  return [...header, ...entries.flatMap((entry) => entry.lines)].join('\n');
}

/**
 * Replaces one entry's `config` section with `configLines` (which must start
 * with the `  config:` line). Returns the new document, or `null` when the
 * entry is absent. Other keys and every other entry stay untouched.
 */
export function replaceEntryConfig(text, id, configLines) {
  if (!Array.isArray(configLines) || configLines.length === 0) throw new TypeError('configLines must be a non-empty array');
  const parsed = parsePatch(text);
  const entry = parsed.entries.find((item) => item.id === id);
  if (!entry) return null;
  const existing = entryConfigLines(entry);
  if (existing) {
    const start = entry.lines.indexOf(existing[0]);
    entry.lines.splice(start, existing.length, ...configLines);
  } else {
    const insertAt = entry.lines.length - trailingBlanks(entry.lines);
    entry.lines.splice(insertAt, 0, ...configLines);
  }
  return serialize(parsed.header, parsed.entries);
}

/** Appends a new entry built from `id`, `name` and the desktop config section. */
export function appendConfigEntry(text, { id, name, configLines }) {
  if (typeof id !== 'string' || !id) throw new TypeError('id is required');
  if (typeof name !== 'string' || !name) throw new TypeError('name is required');
  if (!Array.isArray(configLines) || configLines.length === 0) throw new TypeError('configLines must be a non-empty array');
  const lines = linesOf(text);
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  lines.push(`- id: ${id}`, `  name: ${JSON.stringify(name)}`, ...configLines, '');
  return lines.join('\n');
}

/** `true` when the document already has an entry with this id. */
export function hasEntry(text, id) {
  return parsePatch(text).entries.some((entry) => entry.id === id);
}
