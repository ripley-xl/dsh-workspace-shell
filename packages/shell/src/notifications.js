// Desktop notifications for embedded and Local Web sessions.
//
// Every DSH Web page runs this Client. It watches its own Session status and reports
// two events: a Turn settling, and a pending interaction that needs the user. An
// embedded page sends them to its framing Shell; the top-level Shell turns them into
// native notifications. The framing Shell owns the tab identity, so the guest never
// names a tab and never gains a navigation primitive of its own.
export const NOTIFICATION_EVENT = 'workspace-shell-notification';
export const OPEN_SESSION_EVENT = 'workspace-shell-open-session';
export const NOTIFICATION_VERSION = 1;
const NOTIFICATION_KINDS = new Set(['turn-end', 'approval', 'question', 'plan-review', 'attention']);
const NOTIFICATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const NOTIFICATION_REQUEST_ID = /^[A-Za-z0-9_-]{16,128}$/;
const NOTIFICATION_FIELD_LIMIT = 1024;
const NOTIFICATION_TEXT_LIMIT = 200;
const NOTIFICATION_TAG = 'workspace-shell:';
// Chromium drops control characters and collapses whitespace in notification copy;
// normalize here so both the body layout and the tests see the same string.
function notificationText(value, limit = NOTIFICATION_TEXT_LIMIT) {
  if (typeof value !== 'string') return '';
  const normalized = value.replace(/[\u0000-\u001F\u007F-\u009F]/gu, ' ').replace(/\s+/gu, ' ').trim();
  return normalized.length > limit ? normalized.slice(0, limit - 1).trimEnd() + '…' : normalized;
}

function notificationObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

// A malformed or oversized field rejects the whole frame: partial messages would
// otherwise present a half-truth about which Session needs attention.
function notificationField(data, name) {
  const value = data[name];
  if (value === undefined) return '';
  if (typeof value !== 'string' || value.length > NOTIFICATION_FIELD_LIMIT) return null;
  return notificationText(value);
}

export function validNotificationEvent(data) {
  const value = notificationObject(data);
  if (!value || value.type !== NOTIFICATION_EVENT || value.version !== NOTIFICATION_VERSION) return null;
  if (value.event !== 'turn-end' && value.event !== 'attention') return null;
  if (typeof value.sessionId !== 'string' || !NOTIFICATION_ID.test(value.sessionId)) return null;
  if (typeof value.kind !== 'string' || !NOTIFICATION_KINDS.has(value.kind)) return null;
  if (value.event === 'turn-end' && value.kind !== 'turn-end') return null;
  if (value.event === 'attention' && value.kind === 'turn-end') return null;
  const title = notificationField(value, 'title');
  const detail = notificationField(value, 'detail');
  if (title === null || detail === null) return null;
  if (typeof value.viewing !== 'boolean') return null;
  return { event: value.event, kind: value.kind, sessionId: value.sessionId, title, detail, viewing: value.viewing };
}

export function validOpenSessionRequest(data) {
  const value = notificationObject(data);
  if (!value || value.type !== OPEN_SESSION_EVENT || value.version !== NOTIFICATION_VERSION) return null;
  if (typeof value.requestId !== 'string' || !NOTIFICATION_REQUEST_ID.test(value.requestId)) return null;
  if (typeof value.sessionId !== 'string' || !NOTIFICATION_ID.test(value.sessionId)) return null;
  return { requestId: value.requestId, sessionId: value.sessionId };
}

function notificationKindOf(pending) {
  if (!pending || typeof pending !== 'object') return 'attention';
  if (pending.kind === 'approval') return 'approval';
  if (pending.kind === 'question') return 'question';
  if (pending.kind === 'plan-review') return 'plan-review';
  return 'attention';
}

function notificationDetailOf(pending, kind) {
  if (!pending || typeof pending !== 'object') return '';
  if (kind === 'approval') {
    return [pending.toolName, pending.displayReason ?? pending.reason].filter((part) => typeof part === 'string' && part.trim()).join(' · ');
  }
  if (kind === 'question' || kind === 'plan-review') {
    const questions = Array.isArray(pending.questions) ? pending.questions : [];
    const first = questions[0];
    if (typeof first?.question === 'string' && first.question.trim()) return first.question;
    if (typeof first?.header === 'string' && first.header.trim()) return first.header;
    return '';
  }
  return typeof pending.kind === 'string' ? pending.kind : '';
}

// Snapshot-driven transition detector. Any first snapshot seeds the baseline so a
// page that opens long after a Turn ended does not replay history.
export function createSessionNotificationMonitor({ status, list, report }) {
  const previous = new Map();
  let seeded = false;
  let disposed = false;
  const readTitle = (sessionId) => {
    try {
      const row = list?.getSnapshot?.()?.byId?.[sessionId];
      return typeof row?.displayTitle === 'string' ? row.displayTitle : '';
    } catch {
      return '';
    }
  };
  const isSubagent = (sessionId) => {
    try {
      return list?.getSnapshot?.()?.byId?.[sessionId]?.origin === 'subagent';
    } catch {
      return false;
    }
  };
  const isViewing = (sessionId) => {
    try {
      const row = list?.getSnapshot?.()?.byId?.[sessionId];
      return (row?.retainedBy?.mainView ?? 0) > 0;
    } catch {
      return false;
    }
  };
  const emit = (payload) => {
    if (disposed || typeof report !== 'function') return;
    try {
      report({ ...payload, title: notificationText(payload.title), detail: notificationText(payload.detail), viewing: payload.viewing === true });
    } catch {
      // A framing Shell that cannot receive this event must not break the page.
    }
  };
  const sync = () => {
    if (disposed) return;
    let snapshot;
    try {
      snapshot = status?.getSnapshot?.();
    } catch {
      return;
    }
    if (!(snapshot instanceof Map)) return;
    const next = new Map();
    for (const [sessionId, value] of snapshot) {
      if (typeof sessionId !== 'string' || !NOTIFICATION_ID.test(sessionId)) continue;
      if (!value || typeof value !== 'object') continue;
      const pending = value.pendingInteraction;
      const pendingKey = typeof pending?.key === 'string' ? pending.key : null;
      const running = value.running === true;
      next.set(sessionId, { running, pendingKey });
      if (!seeded) continue;
      const before = previous.get(sessionId);
      if (pending && pendingKey !== before?.pendingKey) {
        const kind = notificationKindOf(pending);
        emit({ event: 'attention', kind, sessionId, title: readTitle(sessionId), detail: notificationDetailOf(pending, kind), viewing: isViewing(sessionId) });
        continue;
      }
      if (!pending && running === false && before?.running === true && !isSubagent(sessionId)) {
        emit({ event: 'turn-end', kind: 'turn-end', sessionId, title: readTitle(sessionId), detail: '', viewing: isViewing(sessionId) });
      }
    }
    previous.clear();
    for (const [sessionId, value] of next) previous.set(sessionId, value);
    seeded = true;
  };
  let unsubscribe = () => {};
  try {
    if (typeof status?.subscribe === 'function') unsubscribe = status.subscribe(sync) ?? (() => {});
  } catch {
    unsubscribe = () => {};
  }
  try {
    sync();
  } catch {
    // A failed baseline leaves the monitor unseeded and silent.
  }
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      try {
        unsubscribe();
      } catch {
        // Detaching from a disposed status source is best effort.
      }
      previous.clear();
    },
  };
}

// Login redirects drop the query but keep the fragment, so the framing Shell also
// advertises its origin there. Only this exact parameter is read.
function declaredParentOrigin(window) {
  const pattern = /^[a-z][a-z0-9+.-]{1,31}:\/\/[^\s/?#@]{1,255}$/u;
  for (const value of [window?.location?.search, (window?.location?.hash ?? '').slice(1)]) {
    try {
      if (typeof value !== 'string' || value.length === 0 || value.length > 8192) continue;
      const origin = new URLSearchParams(value).get('workspaceShellParentOrigin');
      if (typeof origin === 'string' && pattern.test(origin)) return origin;
    } catch {
      // The other source may still carry the parameter.
    }
  }
  return null;
}

function embeddedWindow(window) {
  try {
    return window.parent !== window;
  } catch {
    return false;
  }
}

// A Desktop Web Guest is a <webview>: it is its own top-level document, so
// `window.parent === window` and postMessage cannot reach the embedder. Both
// transports therefore share one payload; the embedder listens to console output
// and drives navigation with executeJavaScript.
const NOTIFICATION_CONSOLE_MARKER = '__workspace-shell-notification__';
const OPEN_SESSION_GLOBAL = '__workspaceShellOpenSession';

function embeddedPage(window) {
  if (embeddedWindow(window)) return true;
  for (const value of [window?.location?.search, (window?.location?.hash ?? '').slice(1)]) {
    try {
      if (typeof value === 'string' && new URLSearchParams(value).get('workspaceShellEmbedded') === '1') return true;
    } catch {
      // Only a parseable location counts.
    }
  }
  return false;
}

// Embedded side: report transitions and answer the framing Shell's open request.
// An iframe uses postMessage in both directions; a webview reports through the
// console marker and exposes one validated navigation entry point.
export function createGuestNotificationBridge({ window, ctx }) {
  if (!embeddedPage(window)) return Object.freeze({ dispose() {} });
  const parentOrigin = embeddedWindow(window) ? declaredParentOrigin(window) : null;
  const post = (message) => {
    try {
      window.parent.postMessage(message, parentOrigin);
    } catch {
      // A parent that navigated away has no channel left.
    }
  };
  const useConsole = !embeddedWindow(window);
  if (!useConsole && !parentOrigin) return Object.freeze({ dispose() {} });
  let disposed = false;
  const monitor = createSessionNotificationMonitor({
    status: ctx?.uiSession?.sessionStatus,
    list: ctx?.sessions?.list,
    report: (payload) => {
      if (disposed) return;
      const message = { type: NOTIFICATION_EVENT, version: NOTIFICATION_VERSION, ...payload };
      if (useConsole) {
        try {
          window.console?.log?.(NOTIFICATION_CONSOLE_MARKER + JSON.stringify(message));
        } catch {
          // A console that refuses the write has no other upward channel.
        }
      } else {
        post(message);
      }
    },
  });
  const seen = new Set();
  const open = (sessionId) => {
    if (disposed || typeof sessionId !== 'string' || !NOTIFICATION_ID.test(sessionId)) return false;
    try {
      ctx?.uiWorkspace?.openSession(sessionId);
      return true;
    } catch {
      return false;
    }
  };
  const onMessage = (event) => {
    if (disposed) return;
    try {
      if (event.source !== window.parent) return;
      if (event.origin !== parentOrigin) return;
      const request = validOpenSessionRequest(event.data);
      if (!request || seen.has(request.requestId)) return;
      seen.add(request.requestId);
      if (seen.size > 64) seen.delete(seen.values().next().value);
      open(request.sessionId);
    } catch {
      // Malformed frames and navigation races both leave the page usable.
    }
  };
  let listening = false;
  if (!useConsole) {
    try {
      window.addEventListener('message', onMessage);
      listening = true;
    } catch {
      listening = false;
    }
  }
  // The embedder calls this with executeJavaScript; the value never comes from a
  // frame or URL, and the identifier check keeps the call single-valued.
  let exposed = false;
  if (useConsole) {
    try {
      window[OPEN_SESSION_GLOBAL] = open;
      exposed = window[OPEN_SESSION_GLOBAL] === open;
    } catch {
      exposed = false;
    }
  }
  const remove = () => {
    if (listening) {
      listening = false;
      try {
        window.removeEventListener('message', onMessage);
      } catch {
        // Detaching from a torn-down window is best effort.
      }
    }
    if (!exposed) return;
    exposed = false;
    try {
      if (window[OPEN_SESSION_GLOBAL] === open) Reflect.deleteProperty(window, OPEN_SESSION_GLOBAL);
    } catch {
      // A foreign replacement is not removed.
    }
  };
  return Object.freeze({
    dispose() {
      if (disposed) return;
      disposed = true;
      monitor.dispose();
      remove();
      seen.clear();
    },
  });
}

const NOTIFICATION_COPY = {
  zh: {
    turnEnd: '回合结束', approval: '等待你确认', question: '等待你回答', planReview: '计划等待你确认', attention: '需要你处理', session: '会话',
  },
  en: {
    turnEnd: 'Turn finished', approval: 'Waiting for your approval', question: 'Waiting for your answer', planReview: 'Plan awaiting approval', attention: 'Needs your action', session: 'Session',
  },
};

function notificationCopy(locale) {
  const active = typeof locale?.active === 'string' ? locale.active : '';
  return /^zh/iu.test(active) ? NOTIFICATION_COPY.zh : NOTIFICATION_COPY.en;
}

// Top-level side: decides whether the user is already looking at the Session, and
// otherwise shows one native notification per Session. The tag keeps a burst of
// events for one Session at a single notification.
export function createNotificationCenter({ window, document, workspace, localeOf, openLocalSession, NotificationCtor, log }) {
  const Ctor = NotificationCtor ?? (typeof window?.Notification === 'function' ? window.Notification : null);
  const live = new Map();
  let windowFocused = true;
  let disposed = false;
  let warned = false;
  const warn = (message, error) => {
    try {
      if (typeof log === 'function') log(message, error);
      else console.warn('workspace-shell notifications: ' + message, error);
    } catch {
      // Diagnostics never change delivery.
    }
  };
  const text = (value) => typeof value === 'string' ? value : '';
  const tabOf = (tabId) => workspace.tabs.getSnapshot().tabs.find((tab) => tab.id === tabId) ?? null;
  const tabLabel = (tab) => {
    if (!tab) return '';
    try {
      const appearance = workspace.getTabAppearance?.(tab);
      if (typeof appearance?.name === 'string' && appearance.name.trim()) return appearance.name.trim();
    } catch {
      // Appearance is display-only; the tab title still identifies the tab.
    }
    return typeof tab.title === 'string' ? tab.title : '';
  };
  const isFocused = () => {
    try {
      if (windowFocused !== true) return false;
      return document?.visibilityState !== 'hidden';
    } catch {
      return windowFocused === true;
    }
  };
  // The framing page must not notify for the exact Session the user is reading.
  const suppressed = (entry) => isFocused() && workspace.tabs.getSnapshot().activeId === entry.tabId && entry.viewing;
  const bodyOf = (entry, copy) => {
    const label = {
      'turn-end': copy.turnEnd, attention: copy.attention, approval: copy.approval, question: copy.question, 'plan-review': copy.planReview,
    }[entry.kind] ?? copy.attention;
    const detail = text(entry.detail);
    const head = detail ? (copy === NOTIFICATION_COPY.zh ? label + '：' + detail : label + ': ' + detail) : label;
    const tab = text(entry.tabLabel);
    return tab ? head + ' · ' + tab : head;
  };
  // The click has to bring the tab forward first: a notification for a background
  // Session must land on the Session, not leave the user on whatever tab is active.
  const openTarget = (entry) => {
    try {
      window.focus?.();
    } catch {
      // Window activation is best effort and never blocks navigation.
    }
    Promise.resolve().then(() => workspace.activate(entry.tabId)).then((active) => {
      if (active === false) return;
      if (entry.tabId === 'local') {
        try {
          openLocalSession?.(entry.sessionId);
        } catch {
          // A Session that cannot open leaves the page where it was.
        }
        return;
      }
      workspace.openSessionInTab(entry.tabKey, entry.sessionId);
    }, () => {});
  };
  const show = (entry) => {
    if (disposed || !Ctor) return;
    if (suppressed(entry)) return;
    let permission;
    try {
      permission = Ctor.permission;
    } catch {
      permission = undefined;
    }
    if (permission === 'denied') {
      if (!warned) {
        warned = true;
        warn('notification permission is denied');
      }
      return;
    }
    const copy = notificationCopy(localeOf?.());
    const title = text(entry.title).trim() || copy.session;
    let notification;
    try {
      notification = new Ctor(title, { body: bodyOf(entry, copy), tag: NOTIFICATION_TAG + entry.sessionId });
    } catch (error) {
      if (!warned) {
        warned = true;
        warn('notification unavailable', error);
      }
      return;
    }
    const previous = live.get(entry.sessionId);
    if (previous && previous !== notification) {
      try {
        previous.close();
      } catch {
        // A stale notification is already gone.
      }
    }
    live.set(entry.sessionId, notification);
    try {
      notification.onclick = () => {
        try {
          notification.close();
        } catch {
          // Closing before navigation keeps the list tidy.
        }
        if (live.get(entry.sessionId) === notification) live.delete(entry.sessionId);
        openTarget(entry);
      };
      notification.onclose = () => {
        if (live.get(entry.sessionId) === notification) live.delete(entry.sessionId);
      };
    } catch {
      // Some implementations expose read-only event slots; delivery already happened.
    }
  };
  const resolveEntry = (tabKey, payload) => {
    const tab = workspace.tabs.getSnapshot().tabs.find((candidate) => candidate.key === tabKey);
    if (!tab) return null;
    return { ...payload, tabId: tab.id, tabKey: tab.key, tabLabel: notificationText(tabLabel(tab)) };
  };
  const reportHost = (payload) => {
    const value = notificationObject(payload);
    if (!value) return;
    const tab = tabOf('local');
    show({ ...value, tabId: 'local', tabKey: 'local', tabLabel: notificationText(tabLabel(tab)) });
  };
  const reportGuest = (tabKey, data) => {
    const payload = validNotificationEvent(data);
    if (!payload || typeof tabKey !== 'string') return;
    const entry = resolveEntry(tabKey, payload);
    if (entry) show(entry);
  };
  const onFocus = () => { windowFocused = true; };
  const onBlur = () => { windowFocused = false; };
  try {
    windowFocused = typeof document?.hasFocus === 'function' ? document.hasFocus() : true;
  } catch {
    windowFocused = true;
  }
  let listening = false;
  try {
    window?.addEventListener?.('focus', onFocus);
    window?.addEventListener?.('blur', onBlur);
    listening = true;
  } catch {
    listening = false;
  }
  return Object.freeze({
    reportHost,
    reportGuest,
    dispose() {
      if (disposed) return;
      disposed = true;
      if (listening) {
        try {
          window?.removeEventListener?.('focus', onFocus);
          window?.removeEventListener?.('blur', onBlur);
        } catch {
          // A torn-down window has no listeners left to remove.
        }
      }
      for (const notification of live.values()) {
        try {
          notification.close();
        } catch {
          // Each notification closes independently.
        }
      }
      live.clear();
    },
  });
}
