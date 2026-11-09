import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyPatchOperations, alignBundles, alignDependencies, alignPatch, computeAlignPlan, computeSelfPlan,
  dependencySource, isDependencyName, isOfficialPackage, latestDependencyNames, unsafeDependencySpec,
} from '../../../packages/shell/src/host/desktop-align.js';

const HEADER = '# patch header\n# keep me\n\n';

function desktop(dependencies, bundles, patchText = `${HEADER}- id: ui-settings\n  name: "@deepseek-ai/dsh-client-ui-settings"\n  config:\n    enabled: true\n`) {
  return { dependencies, bundles, patchText };
}

function web(dependencies, bundles, patchText = HEADER) {
  return { dependencies, bundles, patchText };
}

test('dependency source classification only accepts the documented spec kinds', () => {
  assert.equal(dependencySource('1.2.3'), 'registry');
  assert.equal(dependencySource('^1.2.3'), 'registry');
  assert.equal(dependencySource('latest'), 'registry');
  assert.equal(dependencySource('github:owner/repo#sha'), 'git');
  assert.equal(dependencySource('git+https://example.com/repo.git'), 'git');
  assert.equal(dependencySource('file:../local-package'), 'path');
  assert.equal(dependencySource('link:/tmp/link'), 'path');
  assert.equal(dependencySource('https://example.com/pkg.tgz'), 'invalid');
  assert.equal(dependencySource('npm:@scope/pkg@1.0.0'), 'invalid');
  assert.equal(dependencySource('not a spec'), 'invalid');
  assert.equal(isDependencyName('@scope/pkg'), true);
  assert.equal(isDependencyName('plain-pkg'), true);
  assert.equal(isDependencyName('../escape'), false);
  assert.equal(isOfficialPackage('@deepseek-ai/dsh-base'), true);
  assert.equal(isOfficialPackage('dsh-context'), false);
  assert.equal(unsafeDependencySpec('github:owner/repo#sha'), false);
  assert.equal(unsafeDependencySpec('git+https://user:token@example.com/repo.git'), true);
  assert.equal(unsafeDependencySpec('https://example.com/x.tgz?token=abc'), true);
  assert.equal(unsafeDependencySpec('1.2.3 '), true);
});

test('dependency alignment keeps web entries, adds desktop ones and upgrades shared registry specs', () => {
  const result = alignDependencies({
    desktop: desktop({
      'dsh-context': '0.80.0',
      'dsh-codex-cua': 'github:owner/repo#sha',
      'dsh-only': '2.0.0',
      'dsh-workspace-shell': 'file:../shell.tgz',
      '@xmanrui/dsh-im': '5.10.0',
      '@deepseek-ai/dsh-subagent-codex': '0.2.1-rc.5',
    }, []),
    web: web({
      'dsh-context': '0.82.2',
      'dsh-recall-plugin': '2.6.5',
      'dsh-workspace-shell': 'file:../web-shell.tgz',
      '@deepseek-ai/dsh-subagent-codex': '0.2.1-rc.5',
    }, []),
    latest: { 'dsh-context': '0.82.2', 'dsh-only': '2.0.0', '@deepseek-ai/dsh-subagent-codex': '0.2.2-rc.2' },
    dshVersion: '0.2.2-rc.2',
  });
  assert.deepEqual(result.dependencies, {
    'dsh-context': '0.82.2',
    'dsh-recall-plugin': '2.6.5',
    'dsh-workspace-shell': 'file:../web-shell.tgz',
    '@deepseek-ai/dsh-subagent-codex': '0.2.2-rc.2',
    'dsh-codex-cua': 'github:owner/repo#sha',
    'dsh-only': '2.0.0',
  });
  const actions = new Map(result.changes.map((change) => [change.name, change]));
  assert.equal(actions.get('dsh-codex-cua').action, 'add');
  assert.equal(actions.get('dsh-only').action, 'add');
  assert.equal(actions.get('dsh-workspace-shell').reason, 'excluded');
  assert.equal(actions.get('@xmanrui/dsh-im').reason, 'excluded');
  assert.equal(actions.get('@deepseek-ai/dsh-subagent-codex').to, '0.2.2-rc.2');
  assert.equal(actions.size, 5, 'unchanged and additive dependencies are the only recorded actions');
});

test('raw desktop specs override shared registry specs without version resolution', () => {
  const result = alignDependencies({
    desktop: desktop({ 'dsh-context': 'github:owner/context#sha' }, []),
    web: web({ 'dsh-context': '0.82.2' }, []),
    latest: { 'dsh-context': '9.9.9' },
  });
  assert.equal(result.dependencies['dsh-context'], 'github:owner/context#sha');
  assert.deepEqual(result.changes, [{ name: 'dsh-context', action: 'update', from: '0.82.2', to: 'github:owner/context#sha' }]);
});

test('official packages only follow a DSH version npm reports for that exact package', () => {
  const result = alignDependencies({
    desktop: desktop({ '@deepseek-ai/dsh-subagent-claude-code': '0.2.1-rc.5' }, []),
    web: web({
      '@deepseek-ai/dsh-subagent-claude-code': '0.2.1-rc.5',
      '@deepseek-ai/dsh-subagent-codex': '0.2.1-rc.5',
    }, []),
    latest: { '@deepseek-ai/dsh-subagent-claude-code': '0.2.2-rc.1', '@deepseek-ai/dsh-subagent-codex': '0.2.2-rc.2' },
    dshVersion: '0.2.2-rc.2',
  });
  assert.equal(result.dependencies['@deepseek-ai/dsh-subagent-claude-code'], '0.2.1-rc.5');
  assert.equal(result.dependencies['@deepseek-ai/dsh-subagent-codex'], '0.2.2-rc.2');
  const claude = result.changes.find((change) => change.name === '@deepseek-ai/dsh-subagent-claude-code');
  assert.equal(claude.reason, 'official-version-unavailable');
});

test('unsafe or malformed dependency specs are skipped with a reason', () => {
  const result = alignDependencies({
    desktop: desktop({ 'credentialed': 'git+https://user:token@example.com/repo.git', 'url': 'https://example.com/pkg.tgz' }, []),
    web: web({}, []),
    latest: {},
  });
  assert.deepEqual(result.dependencies, {});
  assert.deepEqual(result.changes.map((change) => [change.name, change.reason]), [
    ['credentialed', 'unsafe-spec'],
    ['url', 'unsupported-spec'],
  ]);
});

test('missing npm answers keep the web spec and never mark a change', () => {
  const result = alignDependencies({
    desktop: desktop({ 'dsh-context': '0.82.2' }, []),
    web: web({ 'dsh-context': '0.82.2' }, []),
    latest: { 'dsh-context': null },
  });
  assert.equal(result.dependencies['dsh-context'], '0.82.2');
  assert.deepEqual(result.changes, [{ name: 'dsh-context', action: 'skip', from: '0.82.2', reason: 'latest-unavailable' }]);
});

test('latestDependencyNames only lists packages the rules actually resolve', () => {
  const names = latestDependencyNames({
    desktop: desktop({ 'dsh-context': '0.1.0', 'raw': 'github:o/r#s', '@deepseek-ai/x': '0.2.1' }, []),
    web: web({ 'dsh-context': '0.2.0', 'web-only': '1.0.0', '@deepseek-ai/x': '0.2.1', '@deepseek-ai/y': '0.2.1' }, []),
    dshVersion: '0.2.2',
  });
  assert.deepEqual(names.sort(), ['@deepseek-ai/x', '@deepseek-ai/y', 'dsh-context']);
  const self = latestDependencyNames({ web: web({ 'dsh-context': '0.2.0', '@deepseek-ai/x': '0.2.1' }, []), dshVersion: null });
  assert.deepEqual(self, ['dsh-context']);
});

test('bundle alignment keeps web order, appends missing desktop bundles and skips exclusions', () => {
  const result = alignBundles({
    desktop: desktop({}, ['@deepseek-ai/dsh-base', 'dsh-context', 'dsh-pet', 'dsh-codex-cua', '@local/dsh-ssh-remote', 'dsh-context']),
    web: web({}, ['@deepseek-ai/dsh-base', 'dsh-context', 'dshmarket']),
  });
  assert.deepEqual(result.bundles, ['@deepseek-ai/dsh-base', 'dsh-context', 'dshmarket', 'dsh-codex-cua']);
  assert.deepEqual(result.appended, ['dsh-codex-cua']);
  assert.deepEqual(result.skipped.map((item) => [item.name, item.reason]), [
    ['dsh-pet', 'excluded'],
    ['@local/dsh-ssh-remote', 'excluded'],
  ]);
});

const DESKTOP_PATCH = [
  HEADER,
  '- id: ui-settings',
  '  name: "@deepseek-ai/dsh-client-ui-settings"',
  '  config:',
  '    enabled: true',
  '- id: llm-deepseek-account',
  '  name: "@deepseek-ai/dsh-llm-deepseek-account"',
  '  config:',
  '    models: []',
  '- id: plugin-manager',
  '  name: "@deepseek-ai/dsh-plugin-manager"',
  '  config:',
  '    pnpmCommand: /Users/someone/.dsh/bin/pnpm11',
  '- id: excluded-entry',
  '  name: "dsh-pet"',
  '  config:',
  '    size: 1',
  '- id: desktop-only-entry',
  '  name: "dsh-only-plugin"',
  '  config:',
  '    x: 1',
  '- id: disabled-only',
  '  disabled: true',
  '- id: unchanged',
  '  name: "unchanged-plugin"',
  '  config:',
  '    same: true',
  '- id: to-append',
  '  name: "append-plugin"',
  '  config:',
  '    y: 2',
  '',
].join('\n');

const WEB_PATCH = [
  HEADER,
  '- id: unchanged',
  '  name: "unchanged-plugin"',
  '  config:',
  '    same: true',
  '- id: ui-settings',
  '  name: "@deepseek-ai/dsh-client-ui-settings"',
  '  config:',
  '    enabled: false',
  '  disabled: true',
  '',
].join('\n');

test('patch alignment only replaces config for eligible web entries and appends missing ones', () => {
  const combineIds = new Set(['ui-settings', 'llm-deepseek-account', 'plugin-manager', 'excluded-entry', 'disabled-only', 'unchanged', 'to-append']);
  const result = alignPatch({ desktopPatch: DESKTOP_PATCH, webPatch: WEB_PATCH, combineIds });
  assert.deepEqual(result.operations.map((operation) => [operation.kind, operation.id]), [
    ['replace', 'ui-settings'],
    ['append', 'to-append'],
  ]);
  const skipped = new Map(result.skipped.map((item) => [item.id, item.reason]));
  assert.equal(skipped.get('desktop-only-entry'), 'not-in-combine');
  assert.equal(skipped.get('llm-deepseek-account'), 'reserved');
  assert.equal(skipped.get('plugin-manager'), 'reserved');
  assert.equal(skipped.get('excluded-entry'), 'excluded');
  assert.equal(skipped.get('disabled-only'), 'no-config');
});

test('applying patch operations preserves the header, other entries and appended order', () => {
  const combineIds = new Set(['ui-settings', 'unchanged', 'to-append']);
  const { operations } = alignPatch({ desktopPatch: DESKTOP_PATCH, webPatch: WEB_PATCH, combineIds });
  const applied = applyPatchOperations(WEB_PATCH, operations);
  assert.ok(applied.startsWith(HEADER), 'header comment stays first');
  assert.match(applied, /- id: unchanged\n {2}name: "unchanged-plugin"\n {2}config:\n {4}same: true/u);
  assert.match(applied, /- id: ui-settings\n {2}name: "@deepseek-ai\/dsh-client-ui-settings"\n {2}config:\n {4}enabled: true\n {2}disabled: true/u,
    'the desktop config replaces only the config section and keeps disabled');
  assert.match(applied, /- id: to-append\n {2}name: "append-plugin"\n {2}config:\n {4}y: 2\s*$/u);
  assert.doesNotMatch(applied, /llm-deepseek-account|excluded-entry|desktop-only-entry|disabled-only/u);
});

test('align plan reports pending only for real dependency, bundle or config changes', () => {
  const latest = { 'dsh-context': '0.82.2' };
  const base = {
    desktop: desktop({ 'dsh-context': '0.82.2' }, ['@deepseek-ai/dsh-base']),
    web: web({ 'dsh-context': '0.82.2' }, ['@deepseek-ai/dsh-base'], WEB_PATCH),
    combineIds: new Set(['ui-settings']),
    latest,
  };
  assert.equal(computeAlignPlan(base).pending, true, 'ui-settings config differs');

  const samePatch = `${HEADER}- id: ui-settings\n  name: "@deepseek-ai/dsh-client-ui-settings"\n  config:\n    enabled: true\n`;
  const settled = computeAlignPlan({
    ...base,
    desktop: desktop({ 'dsh-context': '0.82.2' }, ['@deepseek-ai/dsh-base'], samePatch),
    web: web({ 'dsh-context': '0.82.2' }, ['@deepseek-ai/dsh-base'], samePatch),
  });
  assert.equal(settled.pending, false);

  const versioned = computeAlignPlan({
    ...base,
    desktop: desktop({ 'dsh-context': '0.82.2' }, ['@deepseek-ai/dsh-base'], samePatch),
    web: web({ 'dsh-context': '0.82.2' }, ['@deepseek-ai/dsh-base'], samePatch),
    latest: { 'dsh-context': '0.83.0' },
  });
  assert.equal(versioned.pending, true);
  assert.deepEqual(versioned.dependencyChanges, [{ name: 'dsh-context', action: 'update', from: '0.82.2', to: '0.83.0' }]);
});

test('self plan only bumps existing registry dependencies to latest', () => {
  const result = computeSelfPlan({
    web: {
      dependencies: {
        'dsh-context': '0.82.2',
        'dsh-codex-cua': 'github:owner/repo#sha',
        '@deepseek-ai/dsh-base': '0.2.1-rc.5',
        'dsh-recall-plugin': '2.6.5',
      },
      bundles: ['@deepseek-ai/dsh-base'],
      patchText: HEADER,
    },
    latest: { 'dsh-context': '0.83.0', 'dsh-recall-plugin': '2.6.5', '@deepseek-ai/dsh-base': '0.2.2-rc.2' },
    dshVersion: '0.2.2-rc.2',
  });
  assert.deepEqual(result.dependencies, {
    'dsh-context': '0.83.0',
    'dsh-codex-cua': 'github:owner/repo#sha',
    '@deepseek-ai/dsh-base': '0.2.2-rc.2',
    'dsh-recall-plugin': '2.6.5',
  });
  assert.deepEqual(result.bundles, ['@deepseek-ai/dsh-base']);
  assert.deepEqual(result.patchOperations, []);
  assert.equal(result.pending, true);
  const replanned = computeSelfPlan({ web: { dependencies: result.dependencies, bundles: result.bundles, patchText: null }, latest: { 'dsh-context': '0.83.0', 'dsh-recall-plugin': '2.6.5', '@deepseek-ai/dsh-base': '0.2.2-rc.2' } });
  assert.equal(replanned.pending, false, 'replanning the target is a no-op');
  assert.equal(computeSelfPlan({ web: { dependencies: { 'dsh-markdown': '1.0.0' }, bundles: [], patchText: null }, latest: { 'dsh-markdown': '1.0.0' } }).pending, false);
});
