import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// This checks the actual CSS cascade, not native window displacement.
const playwright = process.env.DSH_PLAYWRIGHT_MODULE
  ?? '/Users/okarinhuang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
const { chromium } = await import(playwright);
const shell = resolve(process.argv[2] ?? 'packages/shell');
const output = resolve(process.argv[3] ?? 'artifacts/workspace-tabs/native-drag-browser');
const { shellCss } = await import(pathToFileURL(resolve(shell, 'src/styles.js')));
const { css: tabsCss } = await import(pathToFileURL(resolve(shell, 'src/chrome-tabs.js')));
const frontend = '/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist/assets';
const files = (await readdir(frontend)).filter((name) => /^index-.*\.css$/.test(name));
assert.equal(files.length, 1, 'Select one installed DSH base stylesheet');
const baseCss = await readFile(resolve(frontend, files[0]), 'utf8');
const themeSource = await readFile('/Users/okarinhuang/.dsh/profiles/desktop/node_modules/@nonamelego/dsh-catppuccin/lib/client.js', 'utf8');
const declaration = themeSource.split('\n').find((line) => line.trim().startsWith('const GLASS_CSS_TEXT = '));
assert.ok(declaration, 'Installed theme must expose its generated stylesheet');
const themeCss = JSON.parse(declaration.trim().slice('const GLASS_CSS_TEXT = '.length, -1));
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.DSH_CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});
const results = [];
try {
  const page = await browser.newPage();
  await page.setContent(`<!doctype html><html data-platform="darwin" data-dsh-glass><body>
    <div id="root"><div data-workspace-shell="active" class="wsh-frame">
      <header class="wsh-header"><div class="wsh-tabstrip-host"><div class="ct-root">
        <div class="ct-tabs" style="-webkit-app-region:drag"><div class="ct-tab" role="tab"><button class="ct-tab-body">Local</button><button class="ct-close">x</button></div></div>
        <button class="ct-add">+</button><div class="ct-blank" data-window-drag></div>
      </div></div></header><main class="wsh-main"><input aria-label="Draft"></main>
    </div></div>
    <span data-dsh-glass-fade="top" aria-hidden="true"></span>
    <span data-dsh-glass-fade="bottom" aria-hidden="true"></span>
    <div role="dialog" style="position:fixed;top:100px;left:50px;width:100px;height:80px"><button>Dialog action</button></div>
    </body></html>`);
  await page.addStyleTag({ content: baseCss + '\n' + themeCss + '\n' + tabsCss });
  await page.addStyleTag({ content: '#root{height:100vh}.wsh-frame{display:grid;height:100%}body{margin:0}' });
  const region = (selector) => page.locator(selector).evaluate((node) => getComputedStyle(node).getPropertyValue('-webkit-app-region'));
  const fade = '[data-dsh-glass-fade=top]';
  assert.equal(await region(fade), 'no-drag', 'Reproduce the installed theme/base conflict');
  const patch = await page.addStyleTag({ content: shellCss });
  for (const [width, height] of [[1280, 800], [520, 800], [390, 844]]) {
    await page.setViewportSize({ width, height });
    assert.equal(await region(fade), 'none');
    assert.equal(await region('.ct-blank'), 'drag');
    for (const selector of ['.ct-tab', '.ct-add', '.ct-tab-body', '.ct-close', '[role=dialog]', '[role=dialog] button', 'input']) {
      assert.equal(await region(selector), 'no-drag', selector + ' must remain interactive');
    }
    const geometry = await page.locator('.ct-blank').evaluate((blank) => {
      const r = blank.getBoundingClientRect();
      const fade = document.querySelector('[data-dsh-glass-fade=top]');
      return {
        blank: r.toJSON(), fade: fade.getBoundingClientRect().toJSON(),
        pointerEvents: getComputedStyle(fade).pointerEvents,
        blankReceivesPointer: [6, 24, 40].every((y) => document.elementFromPoint(r.x + r.width / 2, y) === blank),
      };
    });
    assert.equal(geometry.fade.height, 13);
    assert.equal(geometry.pointerEvents, 'none');
    assert.ok(geometry.blankReceivesPointer);
    assert.ok(geometry.blank.width >= 8);
    await page.locator('input').fill('Preserved draft');
    await page.screenshot({ path: resolve(output, `drag-regions-${width}.png`) });
    results.push({ width, height, geometry });
  }
  // Remote/launcher fences hide this body sibling, then restore it on Local.
  for (let i = 0; i < 3; i += 1) {
    await page.locator(fade).evaluate((node) => { node.style.display = 'none'; });
    await page.locator(fade).evaluate((node) => { node.style.removeProperty('display'); });
    assert.equal(await region(fade), 'none');
  }
  await page.locator(fade).evaluate((node) => node.replaceWith(node.cloneNode(true)));
  assert.equal(await region(fade), 'none', 'Theme reinsertion must retain the reset');
  await page.locator('[data-workspace-shell]').evaluate((node) => node.removeAttribute('data-workspace-shell'));
  assert.equal(await region(fade), 'no-drag', 'Do not change the native frame after Shell unmount');
  await page.locator('.wsh-frame').evaluate((node) => node.setAttribute('data-workspace-shell', 'active'));
  assert.equal(await region(fade), 'none');
  await page.locator('html').evaluate((node) => node.removeAttribute('data-dsh-glass'));
  assert.equal(await region(fade), 'none', 'Inactive theme leaves its fade elements mounted');
  await page.locator('html').evaluate((node) => node.setAttribute('data-dsh-glass', ''));
  assert.equal(await page.locator('input').inputValue(), 'Preserved draft');
  await patch.evaluate((node) => node.remove());
  assert.equal(await region(fade), 'no-drag', 'Removing the patch reproduces the bad region');
  await writeFile(resolve(output, 'verification.json'), JSON.stringify({
    passed: true, shell, nativeDisplacementVerified: false, results,
    checks: ['installed theme/base conflict', 'top decorative layer reset', 'button and dialog no-drag',
      'pointer hit testing', 'hide/show', 'theme reinsertion', 'Shell unmount', 'theme off/on', 'draft preservation', 'reversible reproduction'],
  }, null, 2) + '\n');
  console.log('Installed CSS conflict reproduced; scoped fix and 3 viewport regressions passed. Native displacement still requires separate verification.');
} finally {
  await browser.close();
}
