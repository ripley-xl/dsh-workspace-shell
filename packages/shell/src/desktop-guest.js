// Origin-checked scalar channel shared by the Native and browser Guests. The guest
// companion answers a random request id; the parent never evaluates guest script.
const WORKSPACE_SHELL_CWD_REQUEST = 'workspace-shell-cwd-request';
const WORKSPACE_SHELL_CWD_RESPONSE = 'workspace-shell-cwd-response';
const WORKSPACE_SHELL_CWD_VERSION = 1;
const WORKSPACE_SHELL_CWD_TIMEOUT = 1000;
const WORKSPACE_SHELL_CWD_PARENT_ORIGIN = 'workspaceShellParentOrigin';
const WORKSPACE_SHELL_CWD_REQUEST_ID = /^[A-Za-z0-9_-]{16,128}$/;
// A serialized origin: scheme://host[:port] with no credentials, path, query or fragment.
const WORKSPACE_SHELL_ORIGIN = /^[a-z][a-z0-9+.-]{1,31}:\/\/[^\s/?#@]{1,255}$/;

const ERROR_CODES = {
  acquire: 'DESKTOP_GUEST_ACQUIRE_FAILED',
  externalUrl: 'DESKTOP_GUEST_EXTERNAL_URL_REJECTED',
  lease: 'DESKTOP_GUEST_LEASE_INVALID',
  load: 'DESKTOP_GUEST_LOAD_FAILED',
  open: 'DESKTOP_GUEST_OPEN_FAILED',
  release: 'DESKTOP_GUEST_RELEASE_FAILED',
  render: 'DESKTOP_GUEST_RENDER_GONE',
  url: 'DESKTOP_GUEST_INVALID_URL',
  workspace: 'DESKTOP_GUEST_INVALID_WORKSPACE',
};

function validHttpUrl(value) {
  if (typeof value !== 'string' || !URL.canParse(value)) return false;
  const parsed = new URL(value);
  return ['http:', 'https:'].includes(parsed.protocol)
    && parsed.username === ''
    && parsed.password === '';
}

function abortedLoad(error) {
  return error?.errorCode === -3 || error?.code === -3;
}

function sameNavigationUrl(candidate, target) {
  return typeof candidate === 'string'
    && URL.canParse(candidate)
    && new URL(candidate).href === new URL(target).href;
}

function validParentOrigin(value) {
  return typeof value === 'string' && WORKSPACE_SHELL_ORIGIN.test(value);
}

function guestOriginOf(value) {
  if (!validHttpUrl(value)) return null;
  const origin = new URL(value).origin;
  return validParentOrigin(origin) ? origin : null;
}

function resolveParentOrigin(window, url) {
  const explicit = window?.location?.origin;
  if (validParentOrigin(explicit)) return explicit;
  return guestOriginOf(url);
}

function withParentOrigin(url, origin) {
  try {
    const target = new URL(url);
    target.searchParams.set(WORKSPACE_SHELL_CWD_PARENT_ORIGIN, origin);
    return target.href;
  } catch {
    return null;
  }
}

function validRequestId(value) {
  return typeof value === 'string' && WORKSPACE_SHELL_CWD_REQUEST_ID.test(value);
}

function newRequestId(window) {
  try {
    const value = window?.crypto?.randomUUID?.();
    return validRequestId(value) ? value : null;
  } catch {
    return null;
  }
}

function validCwd(value) {
  if (typeof value !== 'string' || value.length > 4096 || value.includes('\u0000')) return null;
  return value.trim() ? value : null;
}

function validLease(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && typeof value.lease === 'string'
    && value.lease.length > 0
    && typeof value.partition === 'string'
    && value.partition.length > 0;
}

export function createDesktopGuest({
  document,
  window,
  bridge,
  container,
  workspaceKey,
  url,
  signal,
  onReady,
  onError,
  openExternal,
  parentOrigin,
}) {
  const timers = window ?? globalThis;
  // Origin the embedded workspace is expected to keep. The parent origin is advertised to
  // the guest separately, so a guest on another origin is never trusted for cwd.
  const channelOrigin = guestOriginOf(url);
  const parentTarget = validParentOrigin(parentOrigin)
    ? parentOrigin
    : resolveParentOrigin(window, url);
  let pendingCwd = null;
  let closed = false;
  let invalidated = false;
  let visible = true;
  let ready = false;
  let loadStarted = false;
  let loadAborted = false;
  let released = false;
  let webview = null;
  let listeners = [];
  let unsubscribeOpen = null;
  let acquirePromise = null;
  let startPromise = null;
  let closePromise = null;
  let knownLease = null;
  let channelDetach = null;
  let loadTarget = null;

  const callSafely = (callback, value) => {
    if (typeof callback !== 'function') return;
    try {
      const result = callback(value);
      if (result && typeof result.then === 'function') {
        Promise.resolve(result).catch(() => {});
      }
    } catch {
      // Consumer callbacks cannot interrupt guest cleanup.
    }
  };
  const reportError = (code) => callSafely(onError, { code });

  const settleCwd = (value) => {
    const pending = pendingCwd;
    if (!pending) return;
    pendingCwd = null;
    try {
      timers.clearTimeout(pending.timer);
    } catch {
      // A dead timer must still settle the pending request.
    }
    pending.resolve(value);
  };
  const abandonCwd = () => settleCwd(null);

  // The answering origin is the guest document's own origin, and it must still belong to
  // the origin the workspace opened; a third-party navigation ends the channel silently.
  const guestOriginNow = () => {
    try {
      if (typeof webview?.getURL !== 'function') return null;
      const origin = guestOriginOf(webview.getURL());
      return origin === channelOrigin ? origin : null;
    } catch {
      return null;
    }
  };

  const onCwdMessage = (event) => {
    const pending = pendingCwd;
    if (!pending) return;
    try {
      const data = event?.data;
      if (!data || typeof data !== 'object' || Array.isArray(data)) return;
      if (data.type !== WORKSPACE_SHELL_CWD_RESPONSE) return;
      if (data.version !== WORKSPACE_SHELL_CWD_VERSION) return;
      if (data.requestId !== pending.requestId) return;
      if (closed || invalidated || !ready || !webview?.isConnected) return;
      if (event.source !== webview.contentWindow) return;
      if (event.origin !== channelOrigin) return;
      if (guestOriginNow() !== channelOrigin) return;
      settleCwd(validCwd(data.cwd));
    } catch {
      // Malformed events and revoked cross-origin access stay indistinguishable.
    }
  };

  const removeCwdListener = () => {
    abandonCwd();
    const detach = channelDetach;
    channelDetach = null;
    if (!detach) return;
    try {
      detach();
    } catch {
      // Cleanup continues with the guest DOM and native lease.
    }
  };

  const removeContained = () => {
    removeCwdListener();
    if (signal) {
      try {
        signal.removeEventListener?.('abort', onAbort);
      } catch {
        // Continue with the remaining owned resources.
      }
    }
    if (unsubscribeOpen) {
      const unsubscribe = unsubscribeOpen;
      unsubscribeOpen = null;
      try {
        unsubscribe();
      } catch {
        // Continue with DOM listeners and removal.
      }
    }
    const current = webview;
    webview = null;
    ready = false;
    const attachedListeners = listeners;
    listeners = [];
    if (current) {
      for (const [name, listener] of attachedListeners) {
        try {
          current.removeEventListener(name, listener);
        } catch {
          // Each listener gets its own removal attempt.
        }
      }
      try {
        if (typeof current.remove === 'function') current.remove();
        else current.parentNode?.removeChild(current);
      } catch {
        // Native release still runs after DOM removal failures.
      }
    }
  };

  const dispose = () => {
    if (closePromise) return closePromise;
    closed = true;
    invalidated = true;
    ready = false;
    loadStarted = true;
    closePromise = Promise.resolve().then(async () => {
      try {
        removeContained();
      } catch {
        // Unexpected cleanup failures must not skip the native lease release.
      }
      if (acquirePromise) {
        try {
          await acquirePromise;
        } catch {
          // A failed acquire has no lease unless one was already recorded.
        }
      }
      if (knownLease !== null && !released) {
        released = true;
        try {
          await bridge.release(knownLease);
        } catch {
          reportError(ERROR_CODES.release);
        }
      }
    });
    return closePromise;
  };

  const fail = (code) => {
    if (closed) return closePromise ?? Promise.resolve();
    invalidated = true;
    reportError(code);
    return dispose();
  };

  const onAbort = () => {
    void dispose();
  };

  const onDomReady = () => {
    if (closed || invalidated || loadStarted || !webview) return;
    const current = webview;
    loadStarted = true;
    let loading;
    try {
      loading = current.loadURL(loadTarget ?? url);
    } catch (error) {
      if (!abortedLoad(error)) fail(ERROR_CODES.load);
      return;
    }
    Promise.resolve(loading).then(() => {
      if (closed || invalidated || loadAborted || webview !== current) return;
      ready = true;
      callSafely(onReady);
    }).catch((error) => {
      if (abortedLoad(error) || closed) return;
      fail(ERROR_CODES.load);
    });
  };

  const onExternalRequest = (requestedUrl) => {
    if (closed || invalidated) return;
    if (!validHttpUrl(requestedUrl)) {
      reportError(ERROR_CODES.externalUrl);
      return;
    }
    callSafely(openExternal, requestedUrl);
  };

  const onNavigated = () => {
    // Navigation makes any in-flight response belong to the previous document.
    if (!closed && !invalidated) abandonCwd();
  };

  const attachListeners = (current, lease) => {
    listeners = [
      ['dom-ready', onDomReady],
      ['did-fail-load', (event) => {
        if (event?.isMainFrame !== true) return;
        if (event.errorCode === -3) {
          if (sameNavigationUrl(event.validatedURL, url)) loadAborted = true;
        } else fail(ERROR_CODES.load);
      }],
      ['render-process-gone', () => fail(ERROR_CODES.render)],
      ['did-navigate', onNavigated],
      ['did-navigate-in-page', onNavigated],
    ];
    for (const [name, listener] of listeners) current.addEventListener(name, listener);
    unsubscribeOpen = bridge.onOpenRequested(lease, onExternalRequest) ?? null;
    if (parentTarget) loadTarget = withParentOrigin(url, parentTarget) ?? url;
  };

  const runStart = async () => {
    if (closed) return;
    if (typeof workspaceKey !== 'string' || workspaceKey.length === 0 || workspaceKey.length > 4096) {
      await fail(ERROR_CODES.workspace);
      return;
    }
    if (!validHttpUrl(url)) {
      await fail(ERROR_CODES.url);
      return;
    }
    if (signal?.aborted) {
      await dispose();
      return;
    }
    signal?.addEventListener?.('abort', onAbort, { once: true });

    acquirePromise = Promise.resolve().then(() => bridge.acquire(workspaceKey)).then((value) => {
      if (value !== null && typeof value === 'object' && typeof value.lease === 'string' && value.lease.length > 0) {
        knownLease = value.lease;
      }
      return value;
    });
    let raw;
    try {
      raw = await acquirePromise;
    } catch (error) {
      if (!closed) await fail(ERROR_CODES.acquire);
      return;
    }
    if (closed) return;
    if (!validLease(raw)) {
      await fail(ERROR_CODES.lease);
      return;
    }

    try {
      const current = document.createElement('webview');
      webview = current;
      current.setAttribute('partition', raw.partition);
      current.setAttribute('name', raw.lease);
      current.setAttribute('src', `about:blank#${raw.lease}`);
      current.setAttribute('allowpopups', '');
      current.setAttribute(
        'webpreferences',
        'sandbox=yes,contextIsolation=yes,nodeIntegration=no,nodeIntegrationInWorker=no,nodeIntegrationInSubFrames=no',
      );
      Object.assign(current.style, {
        border: '0',
        display: 'flex',
        height: '100%',
        minHeight: '0',
        minWidth: '0',
        pointerEvents: visible ? 'auto' : 'none',
        visibility: visible ? 'visible' : 'hidden',
        width: '100%',
      });
      attachListeners(current, raw.lease);
      container.appendChild(current);
    } catch {
      await fail(ERROR_CODES.open);
    }
  };

  const start = () => {
    if (startPromise) return startPromise;
    if (closed) return closePromise ?? Promise.resolve();
    startPromise = Promise.resolve().then(runStart);
    return startPromise;
  };

  const setVisible = (value) => {
    visible = value === true;
    if (!webview) return;
    webview.style.visibility = visible ? 'visible' : 'hidden';
    webview.style.pointerEvents = visible ? 'auto' : 'none';
    if (!visible && typeof webview.blur === 'function') {
      try {
        webview.blur();
      } catch {
        // Visibility changes do not depend on the guest focus implementation.
      }
    }
  };

  const focus = () => {
    if (!visible || closed || invalidated || !ready || !webview?.isConnected) return;
    if (typeof webview.focus === 'function') webview.focus();
  };

  const resize = () => {};

  // A reply is trusted only when it comes from this guest's contentWindow, from the
  // guest's own origin, for this request id, while the guest is still current.
  const requestCwd = (target, requestId) => new Promise((resolve) => {
    pendingCwd = { requestId, resolve, timer: undefined };
    try {
      pendingCwd.timer = timers.setTimeout(() => settleCwd(null), WORKSPACE_SHELL_CWD_TIMEOUT);
    } catch {
      abandonCwd();
      return;
    }
    if (!channelDetach) {
      try {
        window?.addEventListener?.('message', onCwdMessage);
        channelDetach = () => window?.removeEventListener?.('message', onCwdMessage);
      } catch {
        channelDetach = null;
      }
    }
    try {
      target.postMessage({
        type: WORKSPACE_SHELL_CWD_REQUEST,
        version: WORKSPACE_SHELL_CWD_VERSION,
        requestId,
      }, channelOrigin);
    } catch {
      // A guest that cannot receive the request reports no value.
      abandonCwd();
    }
  });

  const getWorkingDirectory = async () => {
    const current = webview;
    const lease = knownLease;
    if (closed || invalidated || !ready || !lease || !current?.isConnected) return null;
    if (pendingCwd) return null;
    if (!channelOrigin || guestOriginNow() !== channelOrigin) return null;
    const requestId = newRequestId(window);
    if (!requestId) return null;
    let target;
    try {
      target = current.contentWindow;
    } catch {
      return null;
    }
    if (!target || typeof target.postMessage !== 'function') return null;
    const value = await requestCwd(target, requestId);
    if (closed || invalidated || !ready || webview !== current || knownLease !== lease) return null;
    if (guestOriginNow() !== channelOrigin) return null;
    return validCwd(value);
  };

  return { start, setVisible, focus, resize, getWorkingDirectory, dispose };
}
