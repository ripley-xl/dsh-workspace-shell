// Guest-side notification monitor and bridge. Kept import-free for the concatenated Client build.
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
// Why the Turn ended. "other" covers aborted, interrupted, blocked and future kinds.
const NOTIFICATION_REASONS = new Set(['completed', 'error', 'max-tokens', 'aborted', 'interrupted', 'blocked', 'other']);
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
  const error = notificationField(value, 'error');
  if (title === null || detail === null || error === null) return null;
  const reason = value.reason === undefined ? 'completed' : value.reason;
  if (typeof reason !== 'string' || !NOTIFICATION_REASONS.has(reason)) return null;
  // Whether the Host actually answered the Turn-end question. An older Guest has
  // no answer at all, which is not the same as "the Turn produced no reply".
  const textKnown = value.textKnown === undefined ? false : value.textKnown;
  if (typeof textKnown !== 'boolean') return null;
  if (typeof value.viewing !== 'boolean') return null;
  return { event: value.event, kind: value.kind, sessionId: value.sessionId, title, detail, reason, error, textKnown, viewing: value.viewing };
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

// The detail line is the only line the body has, so a long reason must not push
// the notification past a readable size. The count suffix is appended afterwards
// and is never the part that gets cut.
const NOTIFICATION_DETAIL_LIMIT = 120;
const NOTIFICATION_DETAIL_COPY = {
  zh: {
    question: (index, count) => `第 ${index}/${count} 问`,
    options: (count) => `${count} 个选项`,
    wrap: (text) => '（' + text + '）',
    tool: (name) => `工具「${name}」`,
    sep: '：',
  },
  en: {
    question: (index, count) => `${index}/${count}`,
    options: (count) => `${count} options`,
    wrap: (text) => ' (' + text + ')',
    tool: (name) => `tool "${name}"`,
    sep: ': ',
  },
};

function notificationLocale(localeOf) {
  try {
    const active = localeOf?.()?.active;
    return typeof active === 'string' && /^zh/iu.test(active) ? 'zh' : 'en';
  } catch {
    return 'en';
  }
}

// `displayReason` arrives as a localized text map and is rendered through the
// page's locale service. A resolver that throws or answers with a non-string
// leaves the field empty so the next fallback wins.
function notificationResolved(value, resolveText) {
  if (typeof value === 'string') return value;
  if (value === null || typeof value !== 'object' || typeof resolveText !== 'function') return '';
  try {
    const resolved = resolveText(value);
    return typeof resolved === 'string' ? resolved : '';
  } catch {
    return '';
  }
}

function notificationFirstLine(value) {
  if (typeof value !== 'string') return '';
  for (const line of value.split(/\r?\n/u)) {
    const trimmed = line.replace(/^#+\s*/u, '').trim();
    if (trimmed) return trimmed;
  }
  return '';
}

// A question with several parts or options says so after the text. The suffix
// is built from the first question only, matching what the text shows.
function notificationQuestionSuffix(questions, localeKey) {
  const copy = NOTIFICATION_DETAIL_COPY[localeKey] ?? NOTIFICATION_DETAIL_COPY.en;
  const options = Array.isArray(questions[0]?.options) ? questions[0].options.length : 0;
  const parts = [];
  if (questions.length > 1) parts.push(copy.question(1, questions.length));
  if (options > 0) parts.push(copy.options(options));
  return parts.length > 0 ? copy.wrap(parts.join(' · ')) : '';
}

function notificationDetailOf(pending, kind, { resolveText, localeOf } = {}) {
  if (!pending || typeof pending !== 'object') return '';
  if (kind === 'approval') {
    const reason = (notificationResolved(pending.displayReason, resolveText) || notificationResolved(pending.reason, resolveText)).trim();
    const tool = typeof pending.toolName === 'string' ? pending.toolName.trim() : '';
    const copy = NOTIFICATION_DETAIL_COPY[notificationLocale(localeOf)] ?? NOTIFICATION_DETAIL_COPY.en;
    const label = tool ? copy.tool(tool) : '';
    if (label && reason) return notificationText(label + copy.sep + reason, NOTIFICATION_DETAIL_LIMIT);
    return notificationText(label || reason, NOTIFICATION_DETAIL_LIMIT);
  }
  const questions = Array.isArray(pending.questions) ? pending.questions : [];
  if (kind === 'question') {
    const first = questions[0] ?? {};
    const text = [first.question, first.header].find((value) => typeof value === 'string' && value.trim()) ?? '';
    return notificationText(text, NOTIFICATION_DETAIL_LIMIT) + notificationQuestionSuffix(questions, notificationLocale(localeOf));
  }
  if (kind === 'plan-review') {
    const first = questions[0] ?? {};
    const text = notificationFirstLine(first.detail) || [first.header, first.question].find((value) => typeof value === 'string' && value.trim()) || '';
    return notificationText(text, NOTIFICATION_DETAIL_LIMIT);
  }
  return typeof pending.kind === 'string' ? pending.kind : '';
}

// Snapshot-driven transition detector. Any first snapshot seeds the baseline so a
// page that opens long after a Turn ended does not replay history.
export function createSessionNotificationMonitor({ status, list, report, resolveText, localeOf, readTurnEnd }) {
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
  // A settling Turn has no content in the status store; ask the Host for the last
  // reply text and the end reason, but never hold the notification hostage to it.
  const NOTIFICATION_TURN_END_WAIT = 1200;
  const emitTurnEnd = (sessionId, turn) => emit({
    event: 'turn-end', kind: 'turn-end', sessionId, title: readTitle(sessionId),
    detail: notificationText(typeof turn?.text === 'string' ? turn.text : '', NOTIFICATION_DETAIL_LIMIT),
    reason: typeof turn?.reason === 'string' && NOTIFICATION_REASONS.has(turn.reason) ? turn.reason : 'completed',
    error: notificationText(typeof turn?.error === 'string' ? turn.error : '', NOTIFICATION_DETAIL_LIMIT),
    textKnown: turn !== null && typeof turn === 'object',
    viewing: isViewing(sessionId),
  });
  const reportTurnEnd = (sessionId) => {
    if (typeof readTurnEnd !== 'function') {
      emitTurnEnd(sessionId, null);
      return;
    }
    let settled = false;
    let timer = null;
    const finish = (turn) => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      emitTurnEnd(sessionId, turn);
    };
    try {
      Promise.resolve(readTurnEnd(sessionId)).then(finish, () => finish(null));
    } catch {
      finish(null);
    }
    timer = setTimeout(() => finish(null), NOTIFICATION_TURN_END_WAIT);
  };
  const sync = () => {
    if (disposed) return;
    let snapshot;
    try {
      snapshot = status?.getSnapshot?.();
    } catch {
      return;
    }
    // Duck-typed so a page whose Map constructor differs from the Shell's still reports.
    if (!snapshot || typeof snapshot.forEach !== 'function') return;
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
        emit({ event: 'attention', kind, sessionId, title: readTitle(sessionId), detail: notificationDetailOf(pending, kind, { resolveText, localeOf }), viewing: isViewing(sessionId) });
        continue;
      }
      if (!pending && running === false && before?.running === true && !isSubagent(sessionId)) {
        reportTurnEnd(sessionId);
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
  // The Shell Client and the remote companion may both load in one page; only the
  // first one installs a bridge, so one transition is never reported twice.
  const marker = '__workspaceShellNotificationBridge';
  try {
    if (window[marker] === true) return Object.freeze({ dispose() {} });
    window[marker] = true;
  } catch {
    // A window that refuses the marker still gets a working bridge.
  }
  let disposed = false;
  // Detail text follows the Guest page's own locale: localized approval reasons
  // and the question count suffix are rendered here, before the frame is sent.
  const locale = ctx?.locale;
  // The Host tracks what a finished Turn produced; the page asks for it after the
  // status store reports the settle. A missing route (older Host) answers null.
  const readTurnEnd = (sessionId) => {
    try {
      return window.fetch('/api/workspace-session-hosts/turn-end', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      }).then((response) => (response.ok ? response.json() : null)).then((payload) => (payload?.ok === true ? payload.result : null)).catch(() => null);
    } catch {
      return Promise.resolve(null);
    }
  };
  const monitor = createSessionNotificationMonitor({
    status: ctx?.uiSession?.sessionStatus,
    list: ctx?.sessions?.list,
    resolveText: (value) => { try { return locale?.resolveText?.(value) ?? ''; } catch { return ''; } },
    localeOf: () => { try { return locale?.getSnapshot?.(); } catch { return undefined; } },
    readTurnEnd,
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
      try {
        if (window[marker] === true) Reflect.deleteProperty(window, marker);
      } catch {
        // The page is going away with the bridge.
      }
    },
  });
}
