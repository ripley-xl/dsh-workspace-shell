import { readFile } from 'node:fs/promises';

const PREFIX = '/api/workspace-shell';
const MAX_BODY = 128 * 1024;
const terminalHtml = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Workspace terminal</title><link rel="stylesheet" href="' + PREFIX + '/assets/xterm.css"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#11151d;color:#d8dee9;font:12px monospace}body{display:flex;flex-direction:column}#terminal{flex:1;min-width:0;min-height:0;padding:4px;box-sizing:border-box}#status{min-height:18px;padding:2px 7px;box-sizing:border-box;color:#aab5c5;white-space:pre-wrap}.xterm{height:100%}</style></head><body><div id="terminal"></div><div id="status" role="status"></div><script src="' + PREFIX + '/assets/xterm.js"></script><script src="' + PREFIX + '/assets/addon-fit.js"></script><script src="' + PREFIX + '/assets/terminal-document.js"></script></body></html>';
const common = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
function safeCode(error) { return error?.safe === true && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code) ? error.code : 'WORKSPACE_REQUEST_FAILED'; }
function invalid(code = 'INVALID_INPUT') { return Object.assign(new Error(code), { code, safe: true }); }
async function body(request) {
  if ((request.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase() !== 'application/json') throw invalid();
  const length = Number(request.headers.get('content-length'));
  if (Number.isFinite(length) && length > MAX_BODY) throw invalid('REQUEST_TOO_LARGE');
  const reader = request.body?.getReader();
  if (!reader) throw invalid();
  const chunks = []; let bytes = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > MAX_BODY) { await reader.cancel().catch(() => {}); throw invalid('REQUEST_TOO_LARGE'); }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  let value;
  try { value = JSON.parse(Buffer.concat(chunks, bytes).toString('utf8')); } catch { throw invalid(); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  return value;
}

export function registerShellRoutes(ctx, service, { assetRoot = new URL('../../assets/', import.meta.url) } = {}) {
  const releases = [];
  const handlers = {
    '/catalog': (input) => service.catalog({ ownerId: input.ownerId }),
    '/web/open': (input, signal) => service.openWeb({ profileId: input.profileId, ownerId: input.ownerId, confirmIndependentHost: input.confirmIndependentHost === true, signal }),
    '/web/attach': (input) => service.attachWeb({ runtimeId: input.runtimeId, ownerId: input.ownerId }),
    '/tui/open': (input, signal) => service.openTui({ profileId: input.profileId, ownerId: input.ownerId, cwd: input.cwd, cols: input.cols, rows: input.rows, confirmIndependentHost: input.confirmIndependentHost === true, command: input.command, signal }),
    '/terminal/read': (input) => service.readTerminal({ runtimeId: input.runtimeId, ownerId: input.ownerId, afterSeq: input.afterSeq }),
    '/terminal/write': (input) => service.writeTerminal({ runtimeId: input.runtimeId, ownerId: input.ownerId, data: input.data }),
    '/terminal/resize': (input) => service.resizeTerminal({ runtimeId: input.runtimeId, ownerId: input.ownerId, cols: input.cols, rows: input.rows }),
    '/runtime/stop': (input) => service.stop({ runtimeId: input.runtimeId, ownerId: input.ownerId }),
    '/runtime/close-owner': async (input) => {
      if (typeof input.ownerId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(input.ownerId)) throw invalid();
      if (!Array.isArray(input.runtimeIds) || input.runtimeIds.length > 1024 || input.runtimeIds.some((id) => typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id))) throw invalid();
      const ids = new Set(input.runtimeIds);
      const catalog = await service.catalog({ ownerId: input.ownerId });
      const owned = catalog.runtimes.filter((item) => ids.has(item.id) && item.canStop === true && item.kind === 'tui' && ['starting', 'running', 'stopping'].includes(item.phase));
      const results = await Promise.allSettled(owned.map((item) => service.stop({ runtimeId: item.id, ownerId: input.ownerId })));
      if (results.some((item) => item.status === 'rejected')) throw invalid('RUNTIME_STOP_FAILED');
      return { stopped: owned.length };
    },
  };
  let disposal;
  const dispose = () => {
    if (disposal) return disposal;
    disposal = Promise.allSettled(releases.splice(0).reverse().map((release) => Promise.resolve().then(release))).then((results) => { if (results.some((item) => item.status === 'rejected')) throw invalid('WORKSPACE_ROUTE_DISPOSE_FAILED'); });
    disposal.catch(() => {}); return disposal;
  };
  try {
    for (const [path, handler] of Object.entries(handlers)) releases.push(ctx.connection.fetch.register({ path: PREFIX + path, methods: ['POST'], requestBody: 'streaming', async fetch(request) {
      try {
        const input = await body(request);
        const result = await handler(input, request.signal);
        return Response.json({ ok: true, result: result ?? null }, { headers: common });
      } catch (error) {
        const code = safeCode(error);
        const status = code === 'REQUEST_TOO_LARGE' ? 413 : code === 'RUNTIME_OWNER_MISMATCH' ? 403 : code === 'WORKSPACE_REQUEST_FAILED' ? 500 : 400;
        return Response.json({ ok: false, error: { code } }, { status, headers: common });
      }
    } }));
    releases.push(ctx.connection.fetch.register({ path: PREFIX + '/terminal', methods: ['GET'], requestBody: 'buffered', async fetch() {
      return new Response(terminalHtml, { headers: { ...common, 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; connect-src 'none'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'", 'referrer-policy': 'no-referrer' } });
    } }));
    for (const [name, type] of Object.entries({ 'xterm.js': 'text/javascript', 'addon-fit.js': 'text/javascript', 'terminal-document.js': 'text/javascript', 'xterm.css': 'text/css' })) {
      releases.push(ctx.connection.fetch.register({ path: PREFIX + '/assets/' + name, methods: ['GET'], requestBody: 'buffered', async fetch() {
        try { return new Response(await readFile(new URL(name, assetRoot)), { headers: { ...common, 'content-type': type + '; charset=utf-8' } }); }
        catch { return new Response('Asset unavailable', { status: 503, headers: common }); }
      } }));
    }
  } catch (error) { dispose(); throw invalid('WORKSPACE_ROUTES_UNAVAILABLE'); }
  return dispose;
}
