import assert from 'node:assert/strict';
import test from 'node:test';

import {
  appendConfigEntry, configSignature, entryConfigLines, entryName, hasEntry, parsePatch, replaceEntryConfig,
} from '../../../packages/shell/src/host/patch-text.js';

const HEADER = [
  '# Your patch layer for this dsh profile',
  '# a top-level YAML array of loader patch entries',
  '',
];

const DOCUMENT = [
  ...HEADER,
  '- id: ui-theme',
  '  name: "@deepseek-ai/dsh-client-ui-theme"',
  '  config:',
  '    preference: dark',
  '- id: recall',
  '  name: dsh-recall-plugin',
  '  config:',
  '    gcSnaps: 50',
  '    locale: zh',
  '',
  '    baseExcludes:',
  '      - node_modules/',
  '- id: experimental-inspector',
  '  disabled: true',
  '',
].join('\n');

test('parsePatch separates the header from entries and keeps ids in order', () => {
  const parsed = parsePatch(DOCUMENT);
  assert.deepEqual(parsed.entries.map((entry) => entry.id), ['ui-theme', 'recall', 'experimental-inspector']);
  assert.deepEqual(parsed.header, HEADER);
});

test('entryConfigLines stops at the config section and keeps nested blanks', () => {
  const parsed = parsePatch(DOCUMENT);
  const recall = parsed.entries.find((entry) => entry.id === 'recall');
  assert.deepEqual(entryConfigLines(recall), [
    '  config:',
    '    gcSnaps: 50',
    '    locale: zh',
    '',
    '    baseExcludes:',
    '      - node_modules/',
  ]);
  const inspector = parsed.entries.find((entry) => entry.id === 'experimental-inspector');
  assert.equal(entryConfigLines(inspector), null);
});

test('entryName strips optional quotes', () => {
  const parsed = parsePatch(DOCUMENT);
  assert.equal(entryName(parsed.entries[0]), '@deepseek-ai/dsh-client-ui-theme');
  assert.equal(entryName(parsed.entries[1]), 'dsh-recall-plugin');
  assert.equal(entryName(parsed.entries[2]), null);
});

test('configSignature ignores trailing whitespace and the config line', () => {
  const parsed = parsePatch(DOCUMENT);
  const recall = parsed.entries.find((entry) => entry.id === 'recall');
  assert.equal(configSignature(recall), '    gcSnaps: 50\n    locale: zh\n\n    baseExcludes:\n      - node_modules/');
  const padded = parsePatch(DOCUMENT.replace('    locale: zh', '    locale: zh   '));
  assert.equal(configSignature(padded.entries[1]), configSignature(recall));
});

test('replaceEntryConfig swaps the config section and leaves the rest untouched', () => {
  const next = replaceEntryConfig(DOCUMENT, 'ui-theme', ['  config:', '    preference: light', '    density: compact']);
  assert.ok(next);
  assert.equal(next.split('\n').length, DOCUMENT.split('\n').length + 1);
  assert.match(next, /- id: ui-theme\n {2}name: "@deepseek-ai\/dsh-client-ui-theme"\n {2}config:\n {4}preference: light\n {4}density: compact\n- id: recall/u);
  // Untouched entries keep their exact bytes.
  assert.ok(next.endsWith('- id: experimental-inspector\n  disabled: true\n'));
  assert.ok(next.startsWith(HEADER.join('\n')));
});

test('replaceEntryConfig inserts a config section before trailing blanks', () => {
  const next = replaceEntryConfig(DOCUMENT, 'experimental-inspector', ['  config:', '    verbose: true']);
  assert.ok(next);
  assert.match(next, /- id: experimental-inspector\n {2}disabled: true\n {2}config:\n {4}verbose: true\n$/u);
});

test('replaceEntryConfig reports unknown ids instead of guessing', () => {
  assert.equal(replaceEntryConfig(DOCUMENT, 'missing', ['  config:', '    a: 1']), null);
});

test('appendConfigEntry adds one entry and keeps the document valid', () => {
  const next = appendConfigEntry(DOCUMENT, {
    id: 'dsh-context', name: 'dsh-context', configLines: ['  config:', '    insightsEntry: show'],
  });
  assert.ok(next.endsWith('- id: dsh-context\n  name: "dsh-context"\n  config:\n    insightsEntry: show\n'));
  assert.equal(parsePatch(next).entries.length, 4);
  assert.equal(hasEntry(next, 'dsh-context'), true);
  assert.equal(hasEntry(next, 'ui-theme'), true);
  // The original text is a strict prefix of the result.
  assert.ok(next.startsWith(DOCUMENT.trimEnd()));
});

test('appendConfigEntry works on a document without a trailing newline', () => {
  const next = appendConfigEntry('- id: a\n  name: a\n', { id: 'b', name: 'b', configLines: ['  config:', '    x: 1'] });
  assert.equal(next, '- id: a\n  name: a\n- id: b\n  name: "b"\n  config:\n    x: 1\n');
});
