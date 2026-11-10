// Guest-side cwd companion. The framing Shell asks for the effective working
// directory of the single main-view Session; the answer never leaves the Guest
// for any other consumer.
const GUEST_CWD_GLOBAL = '__workspaceShellGuestCwd';
const GUEST_CWD_REQUEST = 'workspace-shell-cwd-request';
const GUEST_CWD_RESPONSE = 'workspace-shell-cwd-response';
const GUEST_CWD_VERSION = 1;
const GUEST_CWD_PARENT_ORIGIN = 'workspaceShellParentOrigin';
const GUEST_CWD_ORIGIN = /^[a-z][a-z0-9+.-]{1,31}:\/\/[^\s/?#@]{1,255}$/u;
const GUEST_CWD_REQUEST_ID = /^[A-Za-z0-9_-]{16,128}$/u;

function guestCwdValue(ctx) {
  try {
    const snapshot = ctx.sessions.list.getSnapshot();
    const rows = Object.values(snapshot.byId).filter((row) => {
      const count = row?.retainedBy?.mainView;
      return typeof count === 'number' && Number.isFinite(count) && count > 0;
    });
    if (rows.length !== 1) return null;
    const value = rows[0].projectionValues?.workingDirectory;
    return typeof value === 'string' || value === null ? value : null;
  } catch {
    return null;
  }
}

function guestCwdParentOrigin(window) {
  try {
    const search = window.location?.search;
    if (typeof search !== 'string' || search.length === 0 || search.length > 8192) return null;
    const value = new URLSearchParams(search).get(GUEST_CWD_PARENT_ORIGIN);
    return typeof value === 'string' && GUEST_CWD_ORIGIN.test(value) ? value : null;
  } catch {
    return null;
  }
}

export function installGuestCwd(ctx, window) {
  const read = () => guestCwdValue(ctx);
  try {
    if (GUEST_CWD_GLOBAL in window) return;
    Object.defineProperty(window, GUEST_CWD_GLOBAL, { value: read, writable: false, configurable: true, enumerable: false });
  } catch {
    return;
  }
  let embedded = false;
  try {
    embedded = window.parent !== window;
  } catch {
    embedded = false;
  }
  if (!embedded) return;
  let expectedOrigin = guestCwdParentOrigin(window);
  let listening = false;
  const onMessage = (event) => {
    try {
      if (!listening) return;
      if (event.source !== window.parent) return;
      if (expectedOrigin && event.origin !== expectedOrigin) return;
      if (!expectedOrigin) {
        if (typeof event.origin !== 'string' || !GUEST_CWD_ORIGIN.test(event.origin)) return;
        expectedOrigin = event.origin;
      }
      const data = event.data;
      if (!data || typeof data !== 'object' || Array.isArray(data)) return;
      if (data.type !== GUEST_CWD_REQUEST || data.version !== GUEST_CWD_VERSION) return;
      if (typeof data.requestId !== 'string' || !GUEST_CWD_REQUEST_ID.test(data.requestId)) return;
      const value = read();
      window.parent.postMessage({
        type: GUEST_CWD_RESPONSE,
        version: GUEST_CWD_VERSION,
        requestId: data.requestId,
        cwd: typeof value === 'string' ? value : null,
      }, expectedOrigin);
    } catch {
      // Unanswered requests expire on the parent side; nothing is retried or logged.
    }
  };
  const cleanup = () => {
    if (!listening) return;
    listening = false;
    try {
      window.removeEventListener('message', onMessage);
    } catch {
      // Cleanup still removes the scalar global.
    }
    try {
      const current = Object.getOwnPropertyDescriptor(window, GUEST_CWD_GLOBAL);
      if (current?.value === read && current.configurable) Reflect.deleteProperty(window, GUEST_CWD_GLOBAL);
    } catch {
      // Unloading never removes or throws through a foreign replacement.
    }
  };
  try {
    window.addEventListener('message', onMessage);
    listening = true;
  } catch {
    listening = false;
  }
  ctx.effect(() => cleanup, 'workspace guest cwd scalar');
}
