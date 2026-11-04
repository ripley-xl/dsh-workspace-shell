import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
const playwrightModule = process.env.DSH_PLAYWRIGHT_MODULE;
if (playwrightModule === undefined) throw new Error('Set DSH_PLAYWRIGHT_MODULE to the playwright entry module (for example node_modules/playwright/index.mjs)');
const { chromium } = await import(playwrightModule);

const dshInstall = process.env.DSH_INSTALL_DIR;
if (dshInstall === undefined) throw new Error('Set DSH_INSTALL_DIR to the installed @deepseek-ai/dsh package directory');
const project = fileURLToPath(new URL('..', import.meta.url));
const shellDirectory = process.argv[2] ? resolve(process.argv[2]) : project + '/packages/shell';
const managerDirectory = resolve(shellDirectory, '../manager');
const home = await mkdtemp('/tmp/wsh-browser-');
const output = process.argv[3] ? resolve(process.argv[3]) : project + '/artifacts/workspace-tabs/session-host-send-failure';
await mkdir(output, { recursive: true });
await writeFile(output + '/verification.json', JSON.stringify({ passed: false, started: new Date().toISOString(), shellDirectory }, null, 2) + '\n');
const children = [];
let browser, debugPage;
const errors = [];
async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 8000);
  await exited; clearTimeout(timer);
}
try {
  await mkdir(home + '/sessions');
  const overlay = home + '/test.patch.json';
  await writeFile(overlay, JSON.stringify([{ insert: [
    { id: 'workspace-shell', name: shellDirectory + '/index.js', config: {} },
    { id: 'workspace-test-seed', name: project + '/test/fixtures/session-host-seed.js', config: {} },
  ] }, { id: 'ui-settings-general', name: '@deepseek-ai/dsh-client-ui-settings-general', config: { welcomeNoticeVersion: '2026-09-28.1' } }]));
  async function start() {
    const child = spawn(process.execPath, [dshInstall + '/lib/bin.js', '--profile', 'web', '--patch', overlay, '--no-open', '--host', '127.0.0.1', '--port', '0'], {
      cwd: home, env: { HOME: home, DSH_HOME: home, PATH: process.env.PATH, DSH_TELEMETRY_DISABLED: '1', DEEPSEEK_API_KEY: 'isolated-test-no-inference' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(child);
    return new Promise((resolve, reject) => {
      let stdout = '', stderr = '';
      const timer = setTimeout(() => reject(new Error('Isolated Host startup timed out: ' + stderr.slice(-3000))), 60000);
      child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-20000); });
      child.stdout.on('data', (chunk) => {
        stdout = (stdout + chunk).slice(-20000);
        const match = stdout.match(/dsh web: (http:\/\/\S+)/);
        if (match) { clearTimeout(timer); resolve(match[1]); }
      });
      child.once('exit', (code) => { clearTimeout(timer); reject(new Error('Isolated Host exited ' + code + ': ' + stderr.slice(-5000))); });
    });
  }
  const urlA = await start(), urlB = await start();
  console.log('Two isolated Hosts started');
  browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const pageA = await context.newPage(), pageB = await context.newPage(); debugPage = pageA;
  for (const page of [pageA, pageB]) {
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text().replace(/token=[^\s&]+/g, 'token=[redacted]')); });
  }
  await pageA.goto(urlA); await pageB.goto(urlB);
  const api = (page, action, input = {}) => page.evaluate(async ({ action, input }) => {
    const response = await fetch('/api/workspace-test/' + action, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
    return response.json();
  }, { action, input });
  const seedA = await api(pageA, 'seed'), seedB = await api(pageB, 'seed');
  assert.ok(seedA.sessionId && seedB.sessionId);
  await pageA.reload();
  await pageA.locator('[data-chrome-tab=local]').waitFor();
  const row = (page, id) => page.locator('[data-row-key="session:' + id + '"]');
  const notice = (page, id) => page.locator('[data-session-host-notice="' + id + '"]');
  const editor = (page) => page.locator('[data-composer-input=true]:visible');
  const ungrouped = pageA.getByText(/^(未分组|Ungrouped)$/);
  await ungrouped.waitFor();
  if (!await row(pageA, seedB.sessionId).isVisible()) await ungrouped.click();
  await row(pageA, seedB.sessionId).click();
  await pageA.getByText('Isolated cross-Host history fixture', { exact: true }).last().waitFor();
  assert.equal(await pageA.locator('[data-session-history],.wsh-session-host-indicator').count(), 0);
  assert.equal(await notice(pageA, seedB.sessionId).count(), 0);
  await editor(pageA).fill('First rejected message'); await editor(pageA).press('Enter');
  await notice(pageA, seedB.sessionId).getByRole('button', { name: /Open tab|打开页签/ }).waitFor();
  await editor(pageA).filter({ hasText: 'First rejected message' }).waitFor();
  assert.equal(await pageA.locator('[data-chrome-tab]').count(), 1);
  await editor(pageA).fill('Later edit kept in source');
  await pageA.getByText(/当前会话已被占用|This session is currently in use/).waitFor({ state: 'hidden', timeout: 15000 });
  await pageA.screenshot({ path: output + '/failure-notice-desktop.png' });
  await pageA.setViewportSize({ width: 390, height: 844 });
  await pageA.screenshot({ path: output + '/failure-notice-mobile.png' });
  const overflow = await notice(pageA, seedB.sessionId).evaluate((node) => node.scrollWidth > node.clientWidth + 1);
  assert.equal(overflow, false, 'notice must fit narrow layouts');
  const actions = await notice(pageA, seedB.sessionId).locator('button').evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().y));
  assert.equal(new Set(actions).size, 1, 'navigation and dismiss actions must stay on the same row');
  await pageA.setViewportSize({ width: 1280, height: 800 });
  await notice(pageA, seedB.sessionId).getByRole('button', { name: /Open tab|打开页签/ }).click();
  const guest = pageA.frameLocator('.wsh-workspace-surface[data-active=true] iframe');
  await row(guest, seedB.sessionId).and(guest.locator('[aria-selected=true]')).waitFor({ timeout: 40000 });
  await editor(guest).filter({ hasText: 'First rejected message' }).waitFor();
  assert.equal(await editor(guest).innerText(), 'First rejected message');
  await notice(guest, seedB.sessionId).getByText(/Review it|检查后发送/).waitFor();
  assert.equal((await api(pageB, 'inspect', seedB)).userMessages, 1, 'transfer must not send');
  await guest.getByText(/^(预览版说明|Preview Notice)$/).waitFor({ state: 'hidden' });
  await pageA.screenshot({ path: output + '/draft-arrived-desktop.png' });
  await pageA.setViewportSize({ width: 390, height: 844 });
  const targetNotice = notice(guest, seedB.sessionId);
  assert.equal(await targetNotice.evaluate((node) => node.scrollWidth > node.clientWidth + 1), false);
  const geometry = await targetNotice.evaluate(async (node) => {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const input = [...node.ownerDocument.querySelectorAll('[data-composer-input=true]')].find((element) => element.getClientRects().length);
    return { notice: node.getBoundingClientRect().toJSON(), input: input?.getBoundingClientRect().toJSON() };
  });
  assert.ok(geometry.input && geometry.notice.bottom <= geometry.input.top, 'target notice must not overlap the editor: ' + JSON.stringify(geometry));
  assert.ok(Math.abs(geometry.notice.x - geometry.input.x) <= 20, 'notice must align with the composer, not the full conversation width');
  await pageA.screenshot({ path: output + '/draft-arrived-mobile.png' });
  await pageA.setViewportSize({ width: 1280, height: 800 });
  console.log('Real writer-held failure, explicit attach and exact failed-text transfer passed');
  await editor(guest).fill('Existing target draft');
  await pageA.locator('[data-chrome-tab=local]').click();
  assert.equal(await editor(pageA).innerText(), 'Later edit kept in source');
  await notice(pageA, seedB.sessionId).getByRole('button', { name: /Go to tab|前往页签/ }).waitFor({ timeout: 10000 });
  await notice(pageA, seedB.sessionId).getByRole('button', { name: /Go to tab|前往页签/ }).click();
  await editor(guest).filter({ hasText: 'Existing target draft' }).waitFor();
  assert.equal(await editor(guest).innerText(), 'Existing target draft', 'same transfer must not append twice');
  await pageA.locator('[data-chrome-tab=local]').click();
  await editor(pageA).fill('Second rejected message'); await editor(pageA).press('Enter');
  await notice(pageA, seedB.sessionId).getByRole('button', { name: /Go to tab|前往页签/ }).waitFor();
  await editor(pageA).filter({ hasText: 'Second rejected message' }).waitFor();
  await notice(pageA, seedB.sessionId).getByRole('button', { name: /Go to tab|前往页签/ }).click();
  await editor(guest).filter({ hasText: 'Second rejected message' }).waitFor();
  assert.equal(await editor(guest).innerText(), 'Existing target draft\n\nSecond rejected message');
  assert.equal(await pageA.locator('[data-chrome-tab]').count(), 2);
  assert.equal((await api(pageB, 'inspect', seedB)).userMessages, 1);
  await row(guest, seedA.sessionId).click();
  await editor(guest).fill('Reverse rejected message'); await editor(guest).press('Enter');
  await notice(guest, seedA.sessionId).getByRole('button', { name: /Go to tab|前往页签/ }).waitFor();
  await notice(guest, seedA.sessionId).getByRole('button', { name: /Go to tab|前往页签/ }).click();
  await pageA.locator('[data-chrome-tab=local][data-active=true]').waitFor({ timeout: 15000 });
  await row(pageA, seedA.sessionId).and(pageA.locator('[aria-selected=true]')).waitFor();
  assert.equal(await editor(pageA).innerText(), 'Reverse rejected message');
  assert.equal((await api(pageA, 'inspect', seedA)).userMessages, 1);
  assert.deepEqual(errors, []);
  console.log('Existing draft append, retry deduplication, reverse transfer and no auto-send passed');
  await pageB.close();
  await stop(children[1]);
  // Real resolver acquires the kernel write lease without making a model request.
  const resumed = await api(pageA, 'resume', seedB);
  assert.equal(resumed.acquired, true, JSON.stringify(resumed));
  await row(pageA, seedB.sessionId).click();
  await editor(pageA).filter({ hasText: 'Second rejected message' }).waitFor();
  await notice(pageA, seedB.sessionId).getByRole('button', { name: /Go to tab|前往页签/ }).waitFor({ state: 'hidden', timeout: 12000 });
  console.log('Original Host exit releases ownership; current Host resumes with its draft intact');
  await writeFile(output + '/verification.json', JSON.stringify({ passed: true, completed: new Date().toISOString(), shellDirectory,
    checks: ['native history without preview', 'real writer-held error', 'no automatic navigation', 'original failed text, not later edit', 'exact existing Host attach', 'draft-only transfer', 'retry deduplication', 'existing target draft preserved', 'bidirectional navigation', 'Host-exit resume', 'narrow notice layout'], errors: [] }, null, 2) + '\n');
} catch (error) {
  if (debugPage) { await debugPage.screenshot({ path: output + '/failure.png' }).catch(() => {}); console.error('Isolated UI:', (await debugPage.locator('body').innerText()).slice(0, 6000)); }
  console.error('Browser errors:', [...new Set(errors.map((error) => error.split('\n')[0]))]);
  throw error;
} finally {
  await browser?.close();
  for (const child of children) await stop(child);
  await rm(home, { recursive: true, force: true });
}
