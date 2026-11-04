import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DIAGNOSTIC_LIMITS,
  createDiagnosticReport,
  formatDiagnosticReport,
  publicError,
  safeDetails,
  safeMessage,
} from '../../../packages/shell/ssh-remote/src/host/diagnostics.js';

const secrets = [
  'auth-secret',
  'browser-secret',
  'api-secret',
  'cookie-secret',
  'credential-secret',
  'log-auth-secret',
  'log-cookie-secret',
  'log-bearer-secret',
  'log-api-secret',
  'log-password-secret',
  'sk-live-secret-value',
  'private-key-secret',
];

function diagnosticInput() {
  return {
    generatedAt: '2026-11-02T06:00:00.000Z',
    localVersion: '0.2.1-rc.5',
    host: {
      id: 'host-1',
      hostAlias: 'p0-test',
      authenticatedUrl: 'http://127.0.0.1:4000/?tkn=auth-secret',
      browserUrl: 'http://localhost:4000/?tkn=browser-secret',
      apiKey: 'api-secret',
      cookie: 'dsh=cookie-secret',
    },
    instance: {
      instanceId: 'instance-1',
      endpoint: { host: '127.0.0.1', port: 41000 },
      credentials: { ref: 'TEST_KEY', value: 'credential-secret' },
    },
    phase: 'connected',
    syncReport: { ok: true, plugins: { updated: 2 }, settings: { appearance: true } },
    controllerLogs: [
      { instanceId: 'instance-1', stream: 'host', hasMore: false, text: 'host ready' },
      'authenticated at http://127.0.0.1:41000/?tkn=log-auth-secret',
      'Cookie: dsh=log-cookie-secret\r\nAuthorization: Bearer log-bearer-secret',
      'apiKey="log-api-secret" password=log-password-secret key=sk-live-secret-value',
      '-----BEGIN OPENSSH PRIVATE KEY-----\nprivate-key-secret\n-----END OPENSSH PRIVATE KEY-----',
    ],
    error: Object.assign(new Error('request failed with token=error-secret'), {
      code: 'TUNNEL_FAILED',
      details: { retryable: true, authorization: 'Bearer detail-secret' },
    }),
  };
}

test('diagnostic reports compose runtime sections and redact secrets from JSON and text', () => {
  const input = diagnosticInput();
  const before = JSON.stringify(input);
  const report = createDiagnosticReport(input);
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.generatedAt, '2026-11-02T06:00:00.000Z');
  assert.equal(report.localVersion, '0.2.1-rc.5');
  assert.equal(report.phase, 'connected');
  assert.equal(report.host.hostAlias, 'p0-test');
  assert.equal(report.host.authenticatedUrl, '[redacted]');
  assert.equal(report.instance.endpoint.port, 41000);
  assert.equal(report.instance.credentials, '[redacted]');
  assert.equal(report.sync.settings.appearance, true);
  assert.equal(report.controllerLogs[0].text, 'host ready');
  assert.equal(report.error.code, 'TUNNEL_FAILED');
  assert.equal(report.error.details.authorization, '[redacted]');
  assert.equal(JSON.stringify(input), before, 'input must not be mutated');

  const json = JSON.stringify(report);
  const text = formatDiagnosticReport(report);
  for (const secret of [...secrets, 'error-secret', 'detail-secret']) {
    assert.equal(json.includes(secret), false, `JSON contains ${secret}`);
    assert.equal(text.includes(secret), false, `text contains ${secret}`);
  }
  assert.equal(json.includes('?tkn='), false);
  assert.equal(text.includes('?tkn='), false);
  assert.match(text, /SSH Remote diagnostic report/u);
  assert.match(text, /Local version: 0\.2\.1-rc\.5/u);
  assert.match(text, /Controller logs:/u);
  assert.match(text, /host ready/u);
});

test('safeMessage redacts raw authentication URLs, headers, assignments, and key material', () => {
  const cases = [
    ['http://user:password-secret@example.com/path', 'password-secret'],
    ['wss://127.0.0.1/socket?access_token=url-secret', 'url-secret'],
    ['?tkn=query-secret&ok=1', 'query-secret'],
    ['Cookie: a=cookie-secret; b=other-secret', 'cookie-secret'],
    ['Set-Cookie: dsh=set-cookie-secret; HttpOnly', 'set-cookie-secret'],
    ['Authorization: Bearer header-secret', 'header-secret'],
    ['Proxy-Authorization: Basic proxy-secret', 'proxy-secret'],
    ['"apiKey": "quoted secret"', 'quoted secret'],
    ['access_token=unquoted-secret', 'unquoted-secret'],
    ['Bearer bearer-secret', 'bearer-secret'],
    ['IdentityFile /Users/name/private-secret', '/Users/name/private-secret'],
    ['key material sk-live-secret-value', 'sk-live-secret-value'],
  ];
  for (const [value, secret] of cases) {
    const cleaned = safeMessage(value);
    assert.equal(cleaned.includes(secret), false, `${value} leaked ${secret}: ${cleaned}`);
    assert.match(cleaned, /redacted/iu);
  }
  assert.equal(safeMessage('visit https://example.com/health?ok=1'), 'visit https://example.com/health?ok=1');
});

test('safeDetails bounds depth, entries, arrays, strings, and circular references', () => {
  const circular = { name: 'root' };
  circular.self = circular;
  const nested = { value: 'visible' };
  let deep = nested;
  for (let index = 0; index < 10; index += 1) deep = { next: deep };
  const wide = Object.fromEntries(Array.from({ length: 200 }, (_, index) => [`field-${index}`, index]));
  const result = safeDetails({
    circular,
    deep,
    wide,
    array: Array.from({ length: 300 }, (_, index) => index),
    text: 'x'.repeat(5000),
    nonFinite: Number.POSITIVE_INFINITY,
    bigint: 42n,
  });
  assert.equal(result.circular.self, '[circular]');
  assert.equal(result.text.length, DIAGNOSTIC_LIMITS.maxStringLength);
  assert.equal(result.array.length, DIAGNOSTIC_LIMITS.maxEntries + 1);
  assert.match(result.array.at(-1), /truncated/u);
  assert.equal(Object.keys(result.wide).length, DIAGNOSTIC_LIMITS.maxEntries + 1);
  assert.match(result.wide['[truncated]'], /72 fields omitted/u);
  assert.equal(result.nonFinite, 'Infinity');
  assert.equal(result.bigint, '42');
  assert.match(JSON.stringify(result.deep), /truncated/u);
});

test('report and text exports enforce entry and byte limits', () => {
  const report = createDiagnosticReport({
    generatedAt: 'invalid-date',
    localVersion: 'v'.repeat(1000),
    host: { text: 'h'.repeat(3000) },
    sync: { entries: Array.from({ length: 200 }, (_, index) => ({ index, text: 's'.repeat(1500) })) },
    controllerLogs: Array.from({ length: 150 }, (_, index) => `log-${index}-${'l'.repeat(1800)}`),
  });
  assert.equal(report.generatedAt, new Date(0).toISOString());
  assert.equal(report.localVersion.length, 256);
  assert.ok(report.controllerLogs.length <= DIAGNOSTIC_LIMITS.maxControllerLogs);
  assert.ok(Buffer.byteLength(JSON.stringify(report)) <= DIAGNOSTIC_LIMITS.maxReportBytes);
  assert.equal(report.truncated, true);

  const text = formatDiagnosticReport({
    localVersion: '1.0.0',
    controllerLogs: Array.from({ length: 150 }, () => ({ text: '日志'.repeat(1000) })),
  });
  assert.ok(Buffer.byteLength(text) <= DIAGNOSTIC_LIMITS.maxTextBytes);
  assert.match(text, /Truncated: yes|\[truncated\]/u);
});

test('publicError and direct text export sanitize untrusted errors and secret-bearing fields', () => {
  const error = new SshLikeError('TUNNEL_FAILED', 'failed api_key=raw-secret', {
    cookie: 'raw-cookie-secret',
    nested: { accessToken: 'raw-token-secret', safe: 'kept' },
  });
  const serialized = JSON.stringify(publicError(error));
  assert.equal(serialized.includes('raw-secret'), false);
  assert.equal(serialized.includes('raw-cookie-secret'), false);
  assert.equal(serialized.includes('raw-token-secret'), false);
  assert.match(serialized, /kept/u);

  const text = formatDiagnosticReport({
    host: { name: 'safe', browserUrl: 'http://localhost/?tkn=text-auth-secret' },
    controllerLogs: ['Cookie: dsh=text-cookie-secret', 'apiKey=text-api-secret'],
  });
  assert.equal(text.includes('text-auth-secret'), false);
  assert.equal(text.includes('text-cookie-secret'), false);
  assert.equal(text.includes('text-api-secret'), false);
  assert.match(text, /safe/u);
});

class SshLikeError extends Error {
  constructor(code, message, details) {
    super(message);
    this.code = code;
    this.details = details;
  }
}
