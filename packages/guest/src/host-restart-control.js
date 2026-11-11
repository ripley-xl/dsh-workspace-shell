// Restart control for a Guest Web Host. The framing Shell owns the entry: a
// workspace tab offers "restart when idle" and "restart now", and this module
// runs the request on the Host's own origin before waiting for the Host to come
// back and reloading the page. A Guest opened outside a workspace tab installs
// nothing: without a tab there is no restart entry.

const STATUS_PATH = '/api/workspace-host/status';
const RESTART_PATH = '/api/workspace-host/restart';
const POLL_MS = 2_000;
const POLL_LIMIT_MS = 60_000;
// The Shell and the Guest share these names; they are duplicated on the Shell
// side because the two bundles never import each other.
const RESTART_REQUEST = 'workspace-shell-host-restart-request';
const RESTART_RESPONSE = 'workspace-shell-host-restart-response';
const RESTART_VERSION = 1;
const RESTART_GLOBAL = '__workspaceShellRestartHost';
const RESTART_MARKER = '__workspaceShellRestartControl';
const REQUEST_ID = /^[A-Za-z0-9_-]{16,128}$/u;
const ORIGIN = /^[a-z][a-z0-9+.-]{1,31}:\/\/[^\s/?#@]{1,255}$/u;
const PARENT_ORIGIN_PARAM = 'workspaceShellParentOrigin';
const EMBEDDED_PARAM = 'workspaceShellEmbedded';
const MODES = new Set(['now', 'wait']);
const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const MAX_SEEN = 32;

const MESSAGES = {
  zh: { restarting: '正在重启，等待 Host 回来…' },
  en: { restarting: 'Restarting — waiting for the Host to come back…' },
};

function dictionaryFor(document) {
  const lang = String(document?.documentElement?.getAttribute?.('lang') ?? '').toLowerCase();
  return lang.startsWith('en') ? MESSAGES.en : MESSAGES.zh;
}

function searchParams(window) {
  const params = new URLSearchParams();
  for (const value of [window?.location?.search, (window?.location?.hash ?? '').slice(1)]) {
    try {
      if (typeof value !== 'string' || value.length === 0) continue;
      for (const [key, item] of new URLSearchParams(value)) params.set(key, item);
    } catch {
      // Only a parseable location counts.
    }
  }
  return params;
}

function embeddedPage(window) {
  try {
    if (window.parent !== window) return true;
  } catch {
    return false;
  }
  return searchParams(window).get(EMBEDDED_PARAM) === '1';
}

function parentOriginOf(window) {
  const value = searchParams(window).get(PARENT_ORIGIN_PARAM);
  return typeof value === 'string' && ORIGIN.test(value) ? value : null;
}

function safeCode(value) {
  return typeof value === 'string' && ERROR_CODE.test(value) ? value : null;
}

function result(ok, code) {
  return ok ? { ok: true } : { ok: false, code: safeCode(code) ?? 'HOST_RESTART_UNAVAILABLE' };
}

/**
 * @param {{window: Window, document: Document}} deps
 */
export function createHostRestartControl(deps = {}) {
  const window = deps.window;
  const document = deps.document;
  const t = dictionaryFor(document);
  let disposed = false;
  let restarting = false;
  let timer = null;
  let reloadUntil = 0;
  let overlay = null;
  let listening = false;
  let exposed = false;
  let channel = null;
  let expectedOrigin = parentOriginOf(window);
  const seen = new Set();

  async function call(path, body) {
    const response = await window.fetch(path, body === undefined
      ? { credentials: 'same-origin', cache: 'no-store' }
      : { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    let payload = null;
    try { payload = await response.json(); } catch { payload = null; }
    if (!response.ok || payload?.ok !== true) {
      const code = safeCode(payload?.code) ?? 'HOST_RESTART_UNAVAILABLE';
      throw Object.assign(new Error(code), { code });
    }
    return payload;
  }

  function showOverlay(text) {
    if (disposed || !document?.body) return;
    try {
      if (!overlay) {
        overlay = document.createElement('div');
        overlay.setAttribute('data-workspace-restart', '');
        overlay.setAttribute('role', 'status');
        overlay.setAttribute('aria-live', 'polite');
        overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.45)';
        const card = document.createElement('div');
        card.setAttribute('data-workspace-restart-card', '');
        card.style.cssText = 'max-width:min(420px,90vw);padding:18px 20px;border-radius:12px;background:var(--dsh-surface,#1f2430);color:var(--dsh-text,#e6e8ee);font:13px/1.6 system-ui,sans-serif;box-shadow:0 18px 48px rgba(0,0,0,.45)';
        card.textContent = text;
        overlay.appendChild(card);
        document.body.appendChild(overlay);
      } else {
        const card = overlay.firstChild;
        if (card) card.textContent = text;
      }
    } catch {
      // A page that refuses the overlay still restarts.
    }
  }

  function pollForRecovery() {
    reloadUntil = Date.now() + POLL_LIMIT_MS;
    const tick = async () => {
      if (disposed) return;
      try {
        const response = await window.fetch('/', { cache: 'no-store', credentials: 'same-origin' });
        if (response.ok) {
          // The server answers before its plugin bundles have finished booting;
          // reloading on the first 200 gives a blank page. Give it a moment.
          window.setTimeout(() => window.location.reload(), 1_200);
          return;
        }
      } catch {
        // The Host is still down.
      }
      if (Date.now() < reloadUntil) timer = window.setTimeout(tick, POLL_MS);
    };
    timer = window.setTimeout(tick, POLL_MS);
  }

  async function restart(mode) {
    if (disposed) return result(false, 'HOST_RESTART_UNAVAILABLE');
    if (!MODES.has(mode)) return result(false, 'HOST_RESTART_INVALID_MODE');
    if (restarting) return result(false, 'HOST_RESTART_IN_PROGRESS');
    restarting = true;
    try {
      const status = await call(STATUS_PATH);
      if (status?.supervised === true) return result(false, 'HOST_RESTART_SUPERVISED');
      if (status?.allowRestart === false) return result(false, 'HOST_RESTART_DISABLED');
      const tasks = Number(status?.busy?.tasks) || 0;
      const jobs = Number(status?.busy?.jobs) || 0;
      // "Restart now" is the forced path: the menu offers it next to the
      // wait-for-idle path, so a busy Host must not refuse it.
      await call(RESTART_PATH, { mode, force: mode === 'now' && tasks + jobs > 0 });
      showOverlay(t.restarting);
      pollForRecovery();
      return result(true);
    } catch (error) {
      return result(false, error?.code);
    } finally {
      restarting = false;
    }
  }

  function installFrameChannel() {
    channel = (event) => {
      if (disposed || !listening) return;
      try {
        if (event.source !== window.parent) return;
        if (expectedOrigin) {
          if (event.origin !== expectedOrigin) return;
        } else {
          if (typeof event.origin !== 'string' || !ORIGIN.test(event.origin)) return;
          expectedOrigin = event.origin;
        }
        const data = event.data;
        if (!data || typeof data !== 'object' || Array.isArray(data)) return;
        if (data.type !== RESTART_REQUEST || data.version !== RESTART_VERSION) return;
        if (typeof data.requestId !== 'string' || !REQUEST_ID.test(data.requestId)) return;
        if (typeof data.mode !== 'string' || !MODES.has(data.mode)) return;
        if (seen.has(data.requestId)) return;
        seen.add(data.requestId);
        if (seen.size > MAX_SEEN) seen.delete(seen.values().next().value);
        const requestId = data.requestId;
        void restart(data.mode).then((value) => {
          if (disposed || !listening || !expectedOrigin) return;
          window.parent.postMessage({
            type: RESTART_RESPONSE,
            version: RESTART_VERSION,
            requestId,
            ok: value.ok === true,
            ...(value.ok === true ? {} : { code: value.code }),
          }, expectedOrigin);
        }, () => {
          if (disposed || !listening || !expectedOrigin) return;
          window.parent.postMessage({
            type: RESTART_RESPONSE, version: RESTART_VERSION, requestId, ok: false, code: 'HOST_RESTART_UNAVAILABLE',
          }, expectedOrigin);
        });
      } catch {
        // Malformed frames and navigation races leave the page usable.
      }
    };
    try {
      window.addEventListener('message', channel);
      listening = true;
    } catch {
      listening = false;
    }
  }

  function installGlobal() {
    const entry = (mode) => restart(mode);
    try {
      Object.defineProperty(window, RESTART_GLOBAL, { value: entry, writable: false, configurable: true, enumerable: false });
      exposed = window[RESTART_GLOBAL] === entry;
    } catch {
      exposed = false;
    }
  }

  function install() {
    if (disposed || !embeddedPage(window)) return;
    try {
      if (window[RESTART_MARKER] === true) return;
      window[RESTART_MARKER] = true;
    } catch {
      // A window that refuses the marker still gets a working channel.
    }
    let framed = false;
    try { framed = window.parent !== window; } catch { framed = false; }
    if (framed) installFrameChannel();
    else installGlobal();
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    if (timer !== null) {
      try { window.clearTimeout(timer); } catch { /* The page is going away. */ }
      timer = null;
    }
    if (listening) {
      listening = false;
      try { window.removeEventListener('message', channel); } catch { /* Detaching is best effort. */ }
    }
    if (exposed) {
      exposed = false;
      try { Reflect.deleteProperty(window, RESTART_GLOBAL); } catch { /* A foreign replacement is not removed. */ }
    }
    try { if (window[RESTART_MARKER] === true) Reflect.deleteProperty(window, RESTART_MARKER); } catch { /* Cleanup is best effort. */ }
    if (overlay) {
      try { overlay.remove(); } catch { /* The overlay may already be detached. */ }
      overlay = null;
    }
    seen.clear();
  }

  return Object.freeze({
    apply(ctx) {
      if (disposed) return;
      install();
      try {
        ctx?.effect?.(() => () => dispose(), 'workspace guest host restart');
      } catch {
        // A Host without effects keeps the channel until the page unloads.
      }
    },
    dispose,
  });
}
