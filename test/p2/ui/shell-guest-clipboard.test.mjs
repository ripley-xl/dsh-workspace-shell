import assert from 'node:assert/strict';
import test from 'node:test';

import { installClipboardFallback } from '../../../packages/guest/src/clipboard.js';

function harness({ fail = true } = {}) {
  const calls = [];
  let copied = null;
  const clipboard = {
    async writeText(text) {
      calls.push(['writeText', text]);
      if (fail) throw new DOMException('denied', 'NotAllowedError');
      return undefined;
    },
  };
  const area = {
    value: '', style: {}, removed: 0,
    setAttribute() {}, focus() { this.focused += 1; }, setSelectionRange() {}, select() { copied = this.value; },
    remove() { this.removed += 1; }, focused: 0,
  };
  const document = {
    createElement(tag) { assert.equal(tag, 'textarea'); return area; },
    execCommand(command) { calls.push(['execCommand', command, area.value]); return true; },
    body: { appendChild() {} },
  };
  const window = { navigator: { clipboard } };
  const installed = installClipboardFallback(window, document);
  return { window, document, clipboard, calls, installed, area, get copied() { return copied; } };
}

test('a rejected Clipboard API write falls back to select and copy', async () => {
  const h = harness({ fail: true });
  assert.equal(h.installed, true);
  await h.clipboard.writeText('hello');
  assert.deepEqual(h.calls, [['writeText', 'hello'], ['execCommand', 'copy', 'hello']]);
  assert.equal(h.copied, 'hello');
  assert.equal(h.area.removed, 1);
});

test('a successful Clipboard API write keeps the original behavior', async () => {
  const h = harness({ fail: false });
  await h.clipboard.writeText('hello');
  assert.deepEqual(h.calls, [['writeText', 'hello']]);
  assert.equal(h.area.removed, 0);
});

test('a page without the Clipboard API is left untouched', () => {
  const window = { navigator: {} };
  assert.equal(installClipboardFallback(window, { createElement() {} }), false);
  assert.equal(window.navigator.clipboard, undefined);
});
