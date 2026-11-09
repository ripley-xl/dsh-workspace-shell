import assert from 'node:assert/strict';
import test from 'node:test';

import { parseCommandLine } from '../../packages/shell/src/host/command-line.js';
import { readTuiDeclaration, tuiAdapter, tuiEnvironment } from '../../packages/shell/src/host/tui-adapters.js';

const manifest = (bundles) => ({ dsh: { profile: { bundles } } });

test('TUI declaration matching is case-insensitive and keeps known adapters strict', () => {
  for (const name of ['@example/My-TUI', 'example-tui@1.2.3', 'github:example/Terminal-TUI']) {
    const result = readTuiDeclaration(manifest([name]));
    assert.equal(result.tui, true, name);
    assert.equal(result.tuiFlavor, 'generic-tui', name);
    assert.equal(result.tuiConflict, false, name);
  }
  assert.equal(readTuiDeclaration(manifest(['example@tui'])).tui, false, 'version text is not a bundle name');
  assert.equal(readTuiDeclaration(manifest(['web'])).tui, false);
  assert.equal(readTuiDeclaration(manifest(['@deepseek-harness-tui/dsh-tui'])).tuiFlavor, 'dsh-tui');
  assert.equal(readTuiDeclaration(manifest(['@xmoon76/dsh-pi-tui@0.5.5'])).tuiFlavor, 'pi-tui');
  assert.equal(readTuiDeclaration(manifest(['@deepseek-harness-tui/dsh-tui', '@xmoon76/dsh-pi-tui'])).tuiConflict, true);
  assert.equal(tuiAdapter('generic-tui').packageName, null);
  assert.deepEqual(tuiEnvironment('generic-tui', { home: '/home', cwd: '/work' }), { DSH_HOME: '/home' });
});

test('TUI command parsing supports quotes and escapes without shell syntax', () => {
  assert.deepEqual(parseCommandLine('dsh --profile "my profile"'), ['dsh', '--profile', 'my profile']);
  assert.deepEqual(parseCommandLine("dsh --name 'a b' --empty ''"), ['dsh', '--name', 'a b', '--empty', '']);
  assert.deepEqual(parseCommandLine('dsh --literal "a\\"b"'), ['dsh', '--literal', 'a"b']);
  assert.deepEqual(parseCommandLine('dsh --path a\\ b'), ['dsh', '--path', 'a b']);
  assert.deepEqual(parseCommandLine('dsh | cat > /tmp/out'), ['dsh', '|', 'cat', '>', '/tmp/out']);
});

test('TUI command parsing rejects unsafe or malformed input', () => {
  for (const value of ['', '   ', 'dsh\n--version', 'dsh\0', 'dsh "', "dsh '", 'dsh\\', `dsh ${'x'.repeat(4096)}`]) {
    assert.throws(() => parseCommandLine(value), TypeError, JSON.stringify(value));
  }
  assert.throws(() => parseCommandLine(Array.from({ length: 66 }, () => 'x').join(' ')), TypeError);
  assert.throws(() => parseCommandLine(null), TypeError);
});
