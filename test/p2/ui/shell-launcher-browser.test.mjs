import test from 'node:test';
import assert from 'node:assert/strict';

// Opt in with an authenticated workspace-web tab in this WebBridge session.
// Only disposable launcher tabs are created; no Host, TUI or SSH connection starts.
const enabled = process.env.DSH_LAUNCHER_BROWSER_TEST === '1';
const session = process.env.DSH_BROWSER_SESSION ?? 'dsh-native-click';
const endpoint = process.env.DSH_WEBBRIDGE_URL ?? 'http://127.0.0.1:10086';

async function command(action, args = {}) {
  const response = await fetch(new URL('/command', endpoint), {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, args, session }), signal: AbortSignal.timeout(15000),
  });
  const result = await response.json();
  assert.equal(result.ok, true, `WebBridge ${action}: ${result.error?.code ?? response.status}`);
  return result.data;
}
async function evaluate(fn, ...args) {
  const result = await command('evaluate', { code: `(${fn.toString()})(...${JSON.stringify(args)})` });
  assert.notEqual(result.type, 'error', 'Browser evaluation failed');
  return result.value;
}
async function wait(selector) {
  const result = await command('wait', { selector, timeout_ms: 5000 });
  assert.notEqual(result.timedOut, true, `Timed out waiting for ${selector}`);
}
async function click(selector) {
  await wait(selector);
  const hit = await evaluate((selector) => {
    const button = document.querySelector(selector);
    const rect = button.getBoundingClientRect();
    return button.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
  }, selector);
  assert.equal(hit, true, `Pointer intercepted at ${selector}`);
  const result = await command('mouse_click', { selector, focus_emulation: true });
  assert.equal(result.success, true);
}

test('real pointer input reaches launcher profiles, sources and close controls', {
  skip: !enabled && 'Set DSH_LAUNCHER_BROWSER_TEST=1 with a workspace-web browser session', timeout: 120000,
}, async () => {
  const page = await command('snapshot', { format: 'aria', max_chars: 500 });
  const url = new URL(page.url);
  assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname), 'Use an isolated loopback test Host');
  const initial = await evaluate(() => ({
    active: document.querySelector('[data-chrome-tab][data-active=true]')?.dataset.chromeTab ?? 'local',
    ids: [...document.querySelectorAll('[data-chrome-tab]')].map((tab) => tab.dataset.chromeTab),
  }));
  const owned = new Set();
  try {
    for (const [width, height] of [[1280, 800], [390, 844]]) {
      await command('cdp', { method: 'Emulation.setDeviceMetricsOverride', params: { width, height, deviceScaleFactor: 1, mobile: false } });
      await click('[data-chrome-tab-add]');
      const active = '.wsh-workspace-surface[data-active=true]';
      await wait(`${active} [data-launcher=root]`);
      const tabId = await evaluate(() => document.querySelector('.wsh-workspace-surface[data-active=true]').dataset.tabId);
      assert.ok(!initial.ids.includes(tabId));
      owned.add(tabId);
      const state = await evaluate(() => {
        const surface = document.querySelector('.wsh-workspace-surface[data-active=true]');
        return {
          title: surface.querySelector('.wsh-launcher-title').textContent,
          profile: surface.querySelector('.wsh-launcher-subtitle').textContent,
          pointerEvents: getComputedStyle(surface.querySelector('.wsh-workspace-viewport')).pointerEvents,
          position: getComputedStyle(surface.querySelector('.wsh-launcher')).position,
          zIndex: getComputedStyle(surface.querySelector('.wsh-launcher')).zIndex,
        };
      });
      assert.ok(state.profile.includes('workspace-web'), 'Do not run against the Desktop Host');
      assert.equal(state.title, '\u65b0\u5efa\u5de5\u4f5c\u533a');
      assert.equal(state.pointerEvents, 'none');
      assert.equal(state.position, 'relative');
      assert.equal(state.zIndex, '1');
      await click(`${active} [data-profile-id="dsh-tui"]`);
      await wait(`${active} [data-profile-id="dsh-tui"][aria-checked=true]`);
      await wait(`${active} [data-launcher-panel=tui]`);
      const hasSsh = await evaluate((active) => Boolean(document.querySelector(`${active} [data-source-kind=ssh]`)), active);
      if (hasSsh) {
        await click(`${active} [data-source-kind=ssh]`);
        await wait(`${active} [data-source-kind=ssh][aria-selected=true]`);
        await click(`${active} [data-source-key=local]`);
        await wait(`${active} [data-source-key=local][aria-selected=true]`);
      }
      await click('[data-chrome-tab=local]');
      await wait('[data-chrome-tab=local][data-active=true]');
      await click(`[data-chrome-tab="${tabId}"]`);
      await wait(`${active} [data-profile-id="dsh-tui"][aria-checked=true]`);
      await click(`${active} [data-launcher-action=close]`);
      await wait('[data-chrome-tab=local][data-active=true]');
      assert.equal(await evaluate((id) => Boolean(document.querySelector(`[data-chrome-tab="${id}"]`)), tabId), false);
      owned.delete(tabId);
    }
  } finally {
    for (const id of owned) {
      await command('mouse_click', { selector: `[data-chrome-tab-close="${id}"]`, focus_emulation: true });
    }
    await command('cdp', { method: 'Emulation.clearDeviceMetricsOverride', params: {} });
    await command('mouse_click', { selector: `[data-chrome-tab="${initial.active}"]`, focus_emulation: true });
    await command('cdp', { method: 'Emulation.setFocusEmulationEnabled', params: { enabled: false } });
  }
});
