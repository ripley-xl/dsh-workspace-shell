const SENSITIVE_FIELD = /(?:authenticated.?url|browser.?url|auth.?url|access.?token|refresh.?token|id.?token|api.?key|password|passphrase|private.?key|cookie|authorization|secret|credentials?|client.?lease|session.?key|env(?:ironment)?(?:vars)?)/iu;
const SENSITIVE_QUERY = /^(?:tkn|token|access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|key|code|auth|signature|sig)$/iu;
const MAX_STRING_LENGTH = 2048;
const MAX_DEPTH = 6;
const MAX_ENTRIES = 128;
const MAX_CONTROLLER_LOGS = 100;
const MAX_REPORT_BYTES = 128 * 1024;
const MAX_TEXT_BYTES = 128 * 1024;
const REDACTED = '[redacted]';

export const DIAGNOSTIC_LIMITS = Object.freeze({
  maxStringLength: MAX_STRING_LENGTH,
  maxDepth: MAX_DEPTH,
  maxEntries: MAX_ENTRIES,
  maxControllerLogs: MAX_CONTROLLER_LOGS,
  maxReportBytes: MAX_REPORT_BYTES,
  maxTextBytes: MAX_TEXT_BYTES,
});

function redactUrl(match) {
  try {
    const url = new URL(match);
    if (url.username || url.password || [...url.searchParams.keys()].some((key) => SENSITIVE_QUERY.test(key))) {
      return '[redacted-url]';
    }
  } catch {
    return '[redacted-url]';
  }
  return match;
}

function redactQuotedAssignment(match, prefix, quote) {
  return `${prefix}${quote}${REDACTED}${quote}`;
}

function redactUnquotedAssignment(match, prefix) {
  return `${prefix}${REDACTED}`;
}

export function safeMessage(value) {
  const sensitiveName = String.raw`(?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|password|passphrase|private[_-]?key|secret|token|tkn|cookie|authorization)`;
  let message = String(value instanceof Error ? value.message : value);
  message = message.replace(/-----BEGIN [^\r\n-]*PRIVATE KEY-----[\s\S]*?-----END [^\r\n-]*PRIVATE KEY-----/giu, '[redacted-private-key]');
  message = message.replace(/\b(?:https?|wss?):\/\/[^\s<>"']+/giu, redactUrl);
  message = message.replace(/\b(?:cookie|set-cookie|authorization|proxy-authorization)\s*:\s*[^\r\n]+/giu, (match) => `${match.split(':', 1)[0]}: ${REDACTED}`);
  message = message.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/giu, `Bearer ${REDACTED}`);
  message = message.replace(new RegExp(`(${sensitiveName}\\s*["']?\\s*[:=]\\s*)(["'])[\\s\\S]*?\\2`, 'giu'), redactQuotedAssignment);
  message = message.replace(new RegExp(`(${sensitiveName}\\s*["']?\\s*[:=]\\s*)[^\\s,;"'}&]+`, 'giu'), redactUnquotedAssignment);
  message = message.replace(/([?&](?:tkn|token|access_token|refresh_token|id_token|api_key|key|code|auth|signature|sig)=)[^&\s]+/giu, `$1${REDACTED}`);
  message = message.replace(/\bIdentityFile\s+[^\s\r\n]+/giu, `IdentityFile ${REDACTED}`);
  message = message.replace(/\bsk-[A-Za-z0-9_-]{8,}\b/giu, REDACTED);
  return message.slice(0, MAX_STRING_LENGTH);
}

function sanitize(value, depth, ancestors) {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    return Number.isFinite(value) || typeof value === 'boolean' || value === null ? value : String(value);
  }
  if (typeof value === 'string') return safeMessage(value);
  if (typeof value === 'bigint') return value.toString();
  if (depth >= MAX_DEPTH) return '[truncated]';
  if (value instanceof Error) {
    return {
      name: safeMessage(value.name),
      ...typeof value.code === 'string' ? { code: safeMessage(value.code) } : {},
      message: safeMessage(value),
      ...value.details && typeof value.details === 'object'
        ? { details: sanitize(value.details, depth + 1, ancestors) }
        : {},
    };
  }
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString();
  if (!value || typeof value !== 'object') return safeMessage(value);
  if (ancestors.has(value)) return '[circular]';
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const items = value.slice(0, MAX_ENTRIES).map((item) => sanitize(item, depth + 1, ancestors));
      if (value.length > MAX_ENTRIES) items.push(`[truncated ${value.length - MAX_ENTRIES} items]`);
      return items;
    }
    const result = {};
    let entries;
    try {
      entries = Object.entries(value);
    } catch (error) {
      return `[unavailable: ${safeMessage(error)}]`;
    }
    for (const [rawKey, item] of entries.slice(0, MAX_ENTRIES)) {
      const key = safeMessage(rawKey).slice(0, 128);
      if (['__proto__', 'prototype', 'constructor'].includes(key)) continue;
      result[key] = SENSITIVE_FIELD.test(key) ? REDACTED : sanitize(item, depth + 1, ancestors);
    }
    if (entries.length > MAX_ENTRIES) result['[truncated]'] = `${entries.length - MAX_ENTRIES} fields omitted`;
    return result;
  } finally {
    ancestors.delete(value);
  }
}

export function safeDetails(value, depth = 0) {
  return sanitize(value, depth, new Set());
}

export function publicError(value) {
  if (!value) return null;
  return {
    code: typeof value.code === 'string' ? safeMessage(value.code).slice(0, 128) : 'REMOTE_OPERATION_FAILED',
    message: safeMessage(value),
    ...value.details && typeof value.details === 'object' ? { details: safeDetails(value.details) } : {},
  };
}

function generatedAt(value) {
  const date = value === undefined ? new Date() : new Date(value);
  return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString();
}

function reportSize(report) {
  return Buffer.byteLength(JSON.stringify(report));
}

function boundReport(report) {
  if (reportSize(report) <= MAX_REPORT_BYTES) return report;
  const bounded = { ...report, truncated: true };
  const sections = ['controllerLogs', 'sync', 'instance', 'host', 'error'];
  for (const section of sections) {
    const value = bounded[section];
    if (section === 'controllerLogs') bounded[section] = [];
    else if (section === 'error' && value !== null) {
      bounded[section] = { code: value.code, message: value.message };
    } else if (value !== null) bounded[section] = { truncated: safeMessage(JSON.stringify(value)) };
    if (reportSize(bounded) <= MAX_REPORT_BYTES) return bounded;
  }
  bounded.controllerLogs = [];
  bounded.sync = null;
  bounded.instance = null;
  bounded.host = null;
  bounded.error = null;
  return bounded;
}

export function createDiagnosticReport(input = {}) {
  const controllerLogs = input.controllerLogs ?? input.controllerLog ?? input.logs ?? [];
  const logs = Array.isArray(controllerLogs) ? controllerLogs : [controllerLogs];
  const report = {
    schemaVersion: 1,
    generatedAt: generatedAt(input.generatedAt),
    localVersion: input.localVersion == null ? null : safeMessage(input.localVersion).slice(0, 256),
    host: input.host == null ? null : safeDetails(input.host),
    instance: input.instance == null ? null : safeDetails(input.instance),
    phase: input.phase == null ? null : safeMessage(input.phase).slice(0, 128),
    sync: (input.sync ?? input.syncReport) == null ? null : safeDetails(input.sync ?? input.syncReport),
    controllerLogs: logs.slice(0, MAX_CONTROLLER_LOGS).map((entry) => safeDetails(entry)),
    error: publicError(input.error),
    limits: DIAGNOSTIC_LIMITS,
  };
  if (logs.length > MAX_CONTROLLER_LOGS) report.truncated = true;
  return boundReport(report);
}

function textSection(lines, label, value) {
  lines.push(`${label}:`);
  if (value === null || value === undefined) {
    lines.push('  unavailable');
    return;
  }
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  for (const line of text.split(/\r?\n/u)) lines.push(`  ${line}`);
}

function truncateText(value) {
  const text = Buffer.from(value);
  if (text.byteLength <= MAX_TEXT_BYTES) return value;
  const marker = '\n[truncated]\n';
  const markerBytes = Buffer.byteLength(marker);
  let prefix = text.subarray(0, MAX_TEXT_BYTES - markerBytes).toString('utf8');
  while (Buffer.byteLength(prefix) > MAX_TEXT_BYTES - markerBytes) prefix = prefix.slice(0, -1);
  return `${prefix}${marker}`;
}

export function formatDiagnosticReport(value = {}) {
  const report = createDiagnosticReport({
    generatedAt: value.generatedAt,
    localVersion: value.localVersion ?? value.local?.version,
    host: value.host,
    instance: value.instance,
    phase: value.phase,
    sync: value.sync ?? value.syncReport,
    controllerLogs: value.controllerLogs ?? value.controllerLog ?? value.logs,
    error: value.error,
  });
  const lines = [
    'SSH Remote diagnostic report',
    `Schema version: ${report.schemaVersion}`,
    `Generated at: ${report.generatedAt}`,
    `Local version: ${report.localVersion ?? 'unavailable'}`,
    `Phase: ${report.phase ?? 'unavailable'}`,
    `Truncated: ${report.truncated === true ? 'yes' : 'no'}`,
  ];
  textSection(lines, 'Host', report.host);
  textSection(lines, 'Instance', report.instance);
  textSection(lines, 'Synchronization', report.sync);
  textSection(lines, 'Error', report.error);
  lines.push('Controller logs:');
  if (!report.controllerLogs.length) lines.push('  unavailable');
  report.controllerLogs.forEach((entry, index) => {
    textSection(lines, `  Entry ${index + 1}`, entry);
  });
  return truncateText(`${lines.join('\n')}\n`);
}
