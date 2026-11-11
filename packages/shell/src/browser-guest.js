// Browser Guest for dsh web. An iframe is the whole isolation boundary: no Native
// bridge, no Desktop profile, and no Node, download, or popup surface.
const ERROR_CODES = {
  container: 'BROWSER_GUEST_CONTAINER_UNAVAILABLE',
  load: 'BROWSER_GUEST_LOAD_FAILED',
  open: 'BROWSER_GUEST_OPEN_FAILED',
  url: 'BROWSER_GUEST_INVALID_URL',
};

const CWD_REQUEST = 'workspace-shell-cwd-request';
const CWD_RESPONSE = 'workspace-shell-cwd-response';
const CWD_VERSION = 1;
const CWD_TIMEOUT = 1000;
const CWD_PARENT_ORIGIN = 'workspaceShellParentOrigin';
const CWD_REQUEST_ID = /^[A-Za-z0-9_-]{16,128}$/;
const NOTIFY_EVENT = 'workspace-shell-notification';
const OPEN_SESSION_EVENT = 'workspace-shell-open-session';
const RESTART_REQUEST = 'workspace-shell-host-restart-request';
const RESTART_RESPONSE = 'workspace-shell-host-restart-response';
const RESTART_VERSION = 1;
const RESTART_TIMEOUT = 4000;
const RESTART_MODES = new Set(['now', 'wait']);
const CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
const NOTIFY_VERSION = 1;
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ORIGIN_PATTERN = /^[a-z][a-z0-9+.-]{1,31}:\/\/[^\s/?#@]{1,255}$/;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-modals';
const MAX_CWD_LENGTH = 4096;

function loopbackHttpUrl(value) {
  if (typeof value !== 'string' || !URL.canParse(value)) return null;
  const parsed = new URL(value);
  if (parsed.protocol !== 'http:') return null;
  if (parsed.username !== '' || parsed.password !== '') return null;
  if (!LOOPBACK_HOSTS.has(parsed.hostname)) return null;
  if (!parsed.port) return null;
  return parsed;
}

function validOrigin(value) {
  return typeof value === 'string' && ORIGIN_PATTERN.test(value);
}

function validCwd(value) {
  if (typeof value !== 'string' || value.length > MAX_CWD_LENGTH || value.includes('\u0000')) return null;
  return value.trim() ? value : null;
}

// The Guest answers with its own outcome. Anything else (an older Guest without
// the entry point, a torn-down document) reads as "unavailable".
function restartOutcome(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, code: 'HOST_RESTART_UNAVAILABLE' };
  if (value.ok === true) return { ok: true };
  const code = typeof value.code === 'string' && CODE_PATTERN.test(value.code) ? value.code : 'HOST_RESTART_UNAVAILABLE';
  return { ok: false, code };
}

function requestId(window) {
  try {
    const value = window?.crypto?.randomUUID?.();
    return typeof value === 'string' && CWD_REQUEST_ID.test(value) ? value : null;
  } catch {
    return null;
  }
}

export function createBrowserGuest({
  document,
  window,
  container,
  url,
  signal,
  onReady,
  onError,
  onGuestEvent,
  parentOrigin,
}) {
  const timers = window ?? globalThis;
  const target = loopbackHttpUrl(url);
  const ownOrigin = (() => {
    const declared = parentOrigin;
    if (validOrigin(declared)) return declared;
    try {
      return validOrigin(window?.location?.origin) ? window.location.origin : null;
    } catch {
      return null;
    }
  })();
  let closed = false;
  let invalidated = false;
  let visible = true;
  let ready = false;
  let started = null;
  let disposed = null;
  let frame = null;
  let loadListener = null;
  let errorListener = null;
  let messageAttached = false;
  let pending = null;
  let pendingRestart = null;

  const callSafely = (callback) => {
    if (typeof callback !== 'function') return;
    try {
      const result = callback();
      if (result && typeof result.then === 'function') Promise.resolve(result).catch(() => {});
    } catch {
      // Consumer callbacks cannot interrupt guest cleanup.
    }
  };
  const reportError = (code) => callSafely(() => onError?.({ code }));

  const frameUrl = (() => {
    if (!target || !ownOrigin) return null;
    const value = new URL(target.href);
    value.searchParams.set(CWD_PARENT_ORIGIN, ownOrigin);
    return value.href;
  })();

  const settle = (value) => {
    const current = pending;
    if (!current) return;
    pending = null;
    try {
      timers.clearTimeout(current.timer);
    } catch {
      // A dead timer must still settle the pending request.
    }
    current.resolve(value);
  };

  const settleRestart = (value) => {
    const current = pendingRestart;
    if (!current) return;
    pendingRestart = null;
    try {
      timers.clearTimeout(current.timer);
    } catch {
      // A dead timer must still settle the pending request.
    }
    current.resolve(value);
  };

  const currentFrameUrl = () => {
    try {
      const value = frame?.src;
      if (typeof value !== 'string' || !URL.canParse(value)) return null;
      return value;
    } catch {
      return null;
    }
  };

  const sameOrigin = () => {
    if (!frame || !frame.isConnected || closed || invalidated || !ready) return false;
    if (currentFrameUrl() !== frameUrl) return false;
    return true;
  };

  // One channel carries cwd replies and unsolicited guest events. The framed document
  // must still be the assigned URL; a later navigation is caught by the origin gate.
  const onChannelMessage = (event) => {
    try {
      if (!sameOrigin()) return;
      const source = frame?.contentWindow;
      if (!source || event.source !== source) return;
      if (event.origin !== target.origin) return;
      const data = event?.data;
      if (!data || typeof data !== 'object' || Array.isArray(data)) return;
      if (data.type === NOTIFY_EVENT) {
        if (data.version !== NOTIFY_VERSION) return;
        callSafely(() => onGuestEvent?.(data));
        return;
      }
      const restart = pendingRestart;
      if (restart) {
        if (data.type !== RESTART_RESPONSE || data.version !== RESTART_VERSION) return;
        if (data.requestId !== restart.requestId) return;
        settleRestart(restartOutcome(data));
        return;
      }
      const current = pending;
      if (!current) return;
      if (data.type !== CWD_RESPONSE || data.version !== CWD_VERSION) return;
      if (data.requestId !== current.requestId) return;
      settle(validCwd(data.cwd));
    } catch {
      // Cross-origin access revocation and malformed events both mean "no value".
    }
  };

  const attachChannel = () => {
    if (messageAttached) return;
    try {
      window?.addEventListener?.('message', onChannelMessage);
      messageAttached = true;
    } catch {
      messageAttached = false;
    }
  };

  const detachChannel = () => {
    settle(null);
    settleRestart({ ok: false, code: 'HOST_RESTART_UNAVAILABLE' });
    if (!messageAttached) return;
    messageAttached = false;
    try {
      window?.removeEventListener?.('message', onChannelMessage);
    } catch {
      // Cleanup continues with the iframe.
    }
  };

  const removeFrame = () => {
    detachChannel();
    try {
      signal?.removeEventListener?.('abort', onAbort);
    } catch {
      // Abort removal is best effort.
    }
    const current = frame;
    const attachedLoad = loadListener;
    const attachedError = errorListener;
    if (current && attachedLoad) {
      try {
        current.removeEventListener('load', attachedLoad);
      } catch {
        // Removal continues regardless of a stale listener.
      }
    }
    if (current && attachedError) {
      try {
        current.removeEventListener('error', attachedError);
      } catch {
        // Removal continues regardless of a stale listener.
      }
    }
    frame = null;
    loadListener = null;
    errorListener = null;
    ready = false;
    if (!current) return;
    try {
      if (typeof current.remove === 'function') current.remove();
      else current.parentNode?.removeChild(current);
    } catch {
      // The detached document is already gone.
    }
  };

  const dispose = () => {
    if (disposed) return disposed;
    closed = true;
    invalidated = true;
    ready = false;
    try {
      removeFrame();
    } catch {
      // Nothing depends on a successful DOM removal here.
    }
    disposed = Promise.resolve();
    return disposed;
  };

  const fail = (code) => {
    if (closed) return;
    invalidated = true;
    reportError(code);
    void dispose();
  };

  // Ready only when the framed document is still the workspace URL we assigned. A later
  // navigation cannot be inspected, so replies are instead gated on event.origin.
  const onLoad = () => {
    if (closed || invalidated || !frame || ready) return;
    if (currentFrameUrl() !== frameUrl) return;
    ready = true;
    callSafely(() => onReady?.());
  };

  const onAbort = () => {
    void dispose();
  };

  const create = () => {
    if (closed) return;
    if (signal?.aborted) {
      void dispose();
      return;
    }
    if (!frameUrl) {
      fail(ERROR_CODES.url);
      return;
    }
    if (!container || typeof container.appendChild !== 'function') {
      fail(ERROR_CODES.container);
      return;
    }
    try {
      const current = document.createElement('iframe');
      current.setAttribute('sandbox', SANDBOX);
      // Cross-origin frames need an explicit Permissions Policy delegation for
      // the Clipboard API; without it every copy action in the Guest fails.
      current.setAttribute('allow', 'clipboard-write; clipboard-read');
      current.setAttribute('referrerpolicy', 'no-referrer');
      Object.assign(current.style, {
        border: '0',
        display: 'block',
        height: '100%',
        minHeight: '0',
        minWidth: '0',
        pointerEvents: visible ? 'auto' : 'none',
        visibility: visible ? 'visible' : 'hidden',
        width: '100%',
      });
      loadListener = () => onLoad();
      errorListener = () => fail(ERROR_CODES.load);
      current.addEventListener('load', loadListener);
      current.addEventListener('error', errorListener);
      frame = current;
      container.appendChild(current);
      attachChannel();
      current.src = frameUrl;
      signal?.addEventListener?.('abort', onAbort, { once: true });
    } catch {
      fail(ERROR_CODES.open);
    }
  };

  const start = () => {
    if (started) return started;
    started = Promise.resolve().then(create);
    return started;
  };

  const setVisible = (value) => {
    visible = value === true;
    if (!frame) return;
    frame.style.visibility = visible ? 'visible' : 'hidden';
    frame.style.pointerEvents = visible ? 'auto' : 'none';
  };

  const focus = () => {
    if (!visible || closed || invalidated || !ready || !frame?.isConnected) return;
    try {
      frame.focus?.();
    } catch {
      // Focus is best effort; a cross-origin document refuses it.
    }
  };

  // CSS sizing owns the frame; there is no separate resize channel.
  const resize = () => {};

  const getWorkingDirectory = async () => {
    const current = frame;
    if (!sameOrigin() || !target) return null;
    if (pending) return null;
    const id = requestId(window);
    if (!id) return null;
    let source;
    try {
      source = current.contentWindow;
    } catch {
      return null;
    }
    if (!source || typeof source.postMessage !== 'function') return null;
    const value = await new Promise((resolve) => {
      pending = { requestId: id, resolve, timer: undefined };
      try {
        pending.timer = timers.setTimeout(() => settle(null), CWD_TIMEOUT);
      } catch {
        settle(null);
        return;
      }
      attachChannel();
      try {
        source.postMessage({
          type: CWD_REQUEST,
          version: CWD_VERSION,
          requestId: id,
        }, target.origin);
      } catch {
        settle(null);
      }
    });
    if (closed || invalidated || frame !== current) return null;
    if (!sameOrigin()) return null;
    return validCwd(value);
  };

  // Ask the guest to show one Session; the receiving page verifies the parent origin.
  const openSession = (sessionId) => {
    const current = frame;
    if (!sameOrigin() || !target) return false;
    if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) return false;
    const id = requestId(window);
    if (!id) return false;
    let source;
    try {
      source = current.contentWindow;
    } catch {
      return false;
    }
    if (!source || typeof source.postMessage !== 'function') return false;
    try {
      source.postMessage({
        type: OPEN_SESSION_EVENT,
        version: NOTIFY_VERSION,
        requestId: id,
        sessionId,
      }, target.origin);
      return true;
    } catch {
      return false;
    }
  };

  // Restart runs inside the framed Guest: only that document can call the
  // Host's own restart route, and it reloads itself once the Host is back.
  const restartHost = (mode) => {
    if (!sameOrigin() || !target) return Promise.resolve({ ok: false, code: 'HOST_RESTART_UNAVAILABLE' });
    if (!RESTART_MODES.has(mode)) return Promise.resolve({ ok: false, code: 'HOST_RESTART_INVALID_MODE' });
    if (pendingRestart) return Promise.resolve({ ok: false, code: 'HOST_RESTART_IN_PROGRESS' });
    const id = requestId(window);
    if (!id) return Promise.resolve({ ok: false, code: 'HOST_RESTART_UNAVAILABLE' });
    let source;
    try {
      source = frame.contentWindow;
    } catch {
      return Promise.resolve({ ok: false, code: 'HOST_RESTART_UNAVAILABLE' });
    }
    if (!source || typeof source.postMessage !== 'function') return Promise.resolve({ ok: false, code: 'HOST_RESTART_UNAVAILABLE' });
    return new Promise((resolve) => {
      pendingRestart = { requestId: id, resolve, timer: undefined };
      try {
        pendingRestart.timer = timers.setTimeout(() => settleRestart({ ok: false, code: 'HOST_RESTART_UNAVAILABLE' }), RESTART_TIMEOUT);
      } catch {
        settleRestart({ ok: false, code: 'HOST_RESTART_UNAVAILABLE' });
        return;
      }
      attachChannel();
      try {
        source.postMessage({
          type: RESTART_REQUEST,
          version: RESTART_VERSION,
          requestId: id,
          mode,
        }, target.origin);
      } catch {
        settleRestart({ ok: false, code: 'HOST_RESTART_UNAVAILABLE' });
      }
    });
  };

  return { start, setVisible, focus, resize, getWorkingDirectory, openSession, restartHost, dispose };
}
