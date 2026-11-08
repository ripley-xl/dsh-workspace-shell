// Reusable Chrome-style workspace tab strip.
// React, document and window are injected so this module stays import-free and
// can be concatenated by the Shell build without extra runtime dependencies.
// All colors come from official --dsw-* tokens or from the component's own
// --ct-* variables derived from those tokens; theme changes need no rebuild.

const DEFAULT_LABELS = Object.freeze({
  tablist: '工作区页签',
  newTab: '新建工作区',
  close: '关闭页签',
  edit: '编辑页签名称与彩色标记',
  connected: '已连接',
  disconnected: '未连接',
  moved: '已移动：',
  restored: '已恢复页签顺序',
});

// A press becomes a drag once it travels this far on either axis.
const DRAG_THRESHOLD = 4;
// Auto-scroll starts inside this distance from the strip viewport edges.
const EDGE_ZONE = 32;
const EDGE_STEP = 16;
// Reorder transition: long enough to read as motion, short enough to stay out
// of the way of the next midpoint crossing.
const FLIP_DURATION = 140;
const FLIP_EASING = 'cubic-bezier(.2,0,0,1)';
// The floating copy tilts with horizontal travel, capped so it stays readable.
const GHOST_TILT_MAX = 2;
const GHOST_TILT_DISTANCE = 60;

function measureRect(node) {
  if (!node || typeof node.getBoundingClientRect !== 'function') return null;
  try {
    const rect = node.getBoundingClientRect();
    if (!rect || !Number.isFinite(rect.left) || !Number.isFinite(rect.width) || rect.width < 0) return null;
    return rect;
  } catch {
    return null;
  }
}

function coordinate(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

// Direct manipulation stays available when motion is reduced; only the cosmetic
// tilt and the reorder animation are dropped.
function prefersReducedMotion(win) {
  try {
    return typeof win?.matchMedia === 'function' && win.matchMedia('(prefers-reduced-motion: reduce)')?.matches === true;
  } catch {
    return false;
  }
}

// Interactive descendants (close button, add button, links, form controls) must
// never start a drag, even if a host forgets to stop propagation.
function isControlNode(start) {
  let node = start;
  for (let depth = 0; node && depth < 8; depth += 1) {
    const tag = typeof node.tagName === 'string' ? node.tagName.toUpperCase() : '';
    if (tag === 'BUTTON' || tag === 'A' || tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || tag === 'OPTION') return true;
    if (node.isContentEditable === true) return true;
    let role = null;
    let marker = false;
    try {
      role = typeof node.getAttribute === 'function' ? node.getAttribute('role') : null;
    } catch {
      role = null;
    }
    try {
      marker = typeof node.hasAttribute === 'function'
        && (node.hasAttribute('data-chrome-tab-close') || node.hasAttribute('data-chrome-tab-add') || node.hasAttribute('data-chrome-tab-edit'));
    } catch {
      marker = false;
    }
    if (role === 'button' || role === 'menuitem' || role === 'link' || marker) return true;
    node = node.parentElement ?? node.parentNode ?? null;
  }
  return false;
}

function encodeId(value) {
  try {
    return encodeURIComponent(String(value));
  } catch {
    return 'tab';
  }
}

function normalizedLabels(value) {
  const source = value && typeof value === 'object' ? value : {};
  const labels = {};
  for (const key of Object.keys(DEFAULT_LABELS)) {
    labels[key] = typeof source[key] === 'string' && source[key] ? source[key] : DEFAULT_LABELS[key];
  }
  return labels;
}

function tabTitle(tab, appearance) {
  if (appearance && typeof appearance.name === 'string' && appearance.name) return appearance.name;
  const title = tab?.title;
  return typeof title === 'string' && title.trim() ? title : String(tab?.id ?? '');
}

function appearanceOf(tab, resolver) {
  if (typeof resolver !== 'function') return null;
  let value;
  try { value = resolver(tab); } catch { return null; }
  return value && typeof value === 'object' ? value : null;
}

function canEditTab(tab, predicate, handler) {
  if (typeof handler !== 'function') return false;
  if (typeof predicate !== 'function') return true;
  try { return predicate(tab) === true; } catch { return false; }
}

function isClosable(tab) {
  if (!tab) return false;
  if (tab.id === 'local' || tab.kind === 'local') return false;
  return tab.closable !== false;
}

export function createChromeTabs(React, deps = {}) {
  if (!React || typeof React.createElement !== 'function') {
    throw new TypeError('createChromeTabs requires React with createElement');
  }
  const { useRef, useState, useEffect } = React;
  if (typeof useRef !== 'function' || typeof useState !== 'function' || typeof useEffect !== 'function') {
    throw new TypeError('createChromeTabs requires React hooks');
  }
  const h = React.createElement;
  // Layout effects are required to measure before paint; the fallback keeps the
  // factory importable in renderers that only expose useEffect.
  const useLayout = typeof React.useLayoutEffect === 'function' ? React.useLayoutEffect : useEffect;
  const doc = deps.document ?? globalThis.document ?? null;
  const win = deps.window ?? globalThis.window ?? null;
  const schedule = typeof win?.requestAnimationFrame === 'function'
    ? (callback) => win.requestAnimationFrame(callback)
    : (callback) => (typeof setTimeout === 'function' ? setTimeout(callback, 16) : 0);
  const unschedule = typeof win?.cancelAnimationFrame === 'function'
    ? (handle) => win.cancelAnimationFrame(handle)
    : (handle) => { if (typeof clearTimeout === 'function') clearTimeout(handle); };

  function ChromeTabStrip(props) {
    const options = props ?? {};
    const {
      tabs, activeId, onSelect, onClose, onAdd, onMove, getStatus, getAppearance, canEdit, onEdit, ids,
      idPrefix = 'chrome-tab', labels, dragRegion = true, className,
    } = options;
    const copy = normalizedLabels(labels);
    const list = Array.isArray(tabs) ? tabs : [];
    const prefix = typeof idPrefix === 'string' && idPrefix ? idPrefix : 'chrome-tab';
    const activeIndex = list.findIndex((tab) => tab.id === activeId);
    const tabbableId = activeIndex >= 0 ? activeId : list[0]?.id;

    const [draggingId, setDraggingId] = useState(null);
    const [announcement, setAnnouncement] = useState('');
    const mounted = useRef(false);
    const scrollerRef = useRef(null);
    const shells = useRef(new Map());
    const bodies = useRef(new Map());
    const dragRef = useRef(null);
    const suppressClick = useRef(false);
    const latest = useRef(null);
    const rootRef = useRef(null);
    const ghostRef = useRef(null);
    const positions = useRef(new Map());
    const order = useRef('');
    const animations = useRef(new Map());
    latest.current = { tabs: list, activeId, copy, onSelect, onClose, onAdd, onMove, getStatus, getAppearance, canEdit, onEdit, ids };

    // A reorder is the only layout change that should animate. Comparing the id
    // sequence filters out selection, status refreshes and window resizes, which
    // also change measured rects but must not animate.
    useLayout(() => {
      const current = latest.current.tabs;
      const next = new Map();
      const keys = [];
      for (const tab of current) {
        keys.push(String(tab.id));
        const rect = measureRect(shells.current.get(tab.id));
        if (rect) next.set(tab.id, rect);
      }
      for (const id of [...animations.current.keys()]) {
        if (next.has(id)) continue;
        const animation = animations.current.get(id);
        animations.current.delete(id);
        try {
          animation?.cancel?.();
        } catch {
          // A removed tab's animation is already gone.
        }
      }
      const currentOrder = keys.join('\u0000');
      const previousOrder = order.current;
      if (previousOrder && previousOrder !== currentOrder && !prefersReducedMotion(win)) {
        for (const tab of current) {
          const node = shells.current.get(tab.id);
          const before = positions.current.get(tab.id);
          const after = next.get(tab.id);
          if (!node || !before || !after) continue;
          const dx = before.left - after.left;
          const dy = before.top - after.top;
          if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
          if (typeof node.animate !== 'function') continue;
          const running = animations.current.get(tab.id);
          animations.current.delete(tab.id);
          try {
            running?.cancel?.();
          } catch {
            // The newer animation replaces it.
          }
          try {
            const animation = node.animate(
              [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'translate(0px, 0px)' }],
              { duration: FLIP_DURATION, easing: FLIP_EASING },
            );
            if (animation) animations.current.set(tab.id, animation);
          } catch {
            // Animation support is optional; the order has already changed.
          }
        }
      }
      order.current = currentOrder;
      positions.current = next;
      const drag = dragRef.current;
      if (drag && drag.started) positionGhost(drag);
    });

    useEffect(() => () => {
      for (const animation of animations.current.values()) {
        try {
          animation?.cancel?.();
        } catch {
          // Unmount continues.
        }
      }
      animations.current.clear();
      positions.current.clear();
    }, []);

    useEffect(() => {
      mounted.current = true;
      return () => {
        mounted.current = false;
        const drag = dragRef.current;
        if (drag) finishDrag(drag, 'cancel', { silent: true });
      };
    }, []);

    // A host may remove the dragged record while the pointer is still down.
    useEffect(() => {
      const drag = dragRef.current;
      if (!drag || drag.ended) return;
      if (!list.some((tab) => tab.id === drag.id)) finishDrag(drag, 'cancel');
    }, [list]);

    function focusBody(id) {
      const node = bodies.current.get(id);
      if (!node || typeof node.focus !== 'function') return;
      try {
        node.focus({ preventScroll: true });
      } catch {
        // Focus restoration is best effort; it must never break a gesture.
      }
    }

    function announceMove(id, index) {
      const tab = latest.current.tabs.find((item) => item.id === id);
      const title = tabTitle(tab ?? { id }, appearanceOf(tab, latest.current.getAppearance));
      const label = latest.current.copy.moved;
      const message = typeof label === 'function' ? label(title, index + 1) : `${label}${title}（${index + 1}）`;
      if (mounted.current) setAnnouncement(String(message));
    }

    // The destination index is expressed in the resulting array, i.e. after the
    // dragged tab has been removed from its current position.
    function computeTarget(clientX, draggedId) {
      const current = latest.current.tabs;
      let index = 0;
      for (const tab of current) {
        if (tab.id === draggedId) continue;
        const rect = measureRect(shells.current.get(tab.id));
        if (!rect) continue;
        if (clientX > rect.left + rect.width / 2) index += 1;
      }
      return Math.max(0, Math.min(index, Math.max(0, current.length - 1)));
    }

    function applyMove(id, index, announce) {
      const move = latest.current.onMove;
      if (typeof move === 'function') {
        try {
          move(id, index);
        } catch {
          // A host callback must not leave a captured pointer behind.
        }
      }
      if (announce) announceMove(id, index);
    }

    // The copy is positioned against the strip root, not the viewport, so an
    // ancestor with a transform or filter cannot move it.
    function ghostTransform(drag) {
      const root = measureRect(rootRef.current);
      const originLeft = root ? root.left : 0;
      const originTop = root ? root.top : 0;
      const x = drag.lastX - originLeft - drag.grabX;
      const y = drag.lastY - originTop - drag.grabY;
      const travel = drag.reduced
        ? 0
        : Math.max(-GHOST_TILT_MAX, Math.min(GHOST_TILT_MAX, (drag.lastX - drag.startX) / GHOST_TILT_DISTANCE));
      return `translate3d(${x}px, ${y}px, 0) rotate(${travel}deg)`;
    }

    function positionGhost(drag) {
      const node = ghostRef.current;
      if (!drag || !node || !node.style) return;
      try {
        node.style.transform = ghostTransform(drag);
      } catch {
        // The copy is cosmetic; a style failure must not break the gesture.
      }
    }

    function edgeSpeed(clientX) {
      const rect = measureRect(scrollerRef.current);
      if (!rect) return 0;
      const leftZone = rect.left + EDGE_ZONE;
      const rightZone = rect.right - EDGE_ZONE;
      if (clientX < leftZone) {
        const factor = Math.min(1, (leftZone - clientX) / EDGE_ZONE);
        return -Math.max(2, Math.round(EDGE_STEP * factor));
      }
      if (clientX > rightZone) {
        const factor = Math.min(1, (clientX - rightZone) / EDGE_ZONE);
        return Math.max(2, Math.round(EDGE_STEP * factor));
      }
      return 0;
    }

    function canScroll(scroller, delta) {
      if (!scroller) return false;
      const max = Math.max(0, coordinate(scroller.scrollWidth) - coordinate(scroller.clientWidth));
      if (max <= 0) return false;
      const current = Math.max(0, coordinate(scroller.scrollLeft));
      return delta < 0 ? current > 0 : current < max;
    }

    function stopAutoScroll(drag) {
      if (!drag || drag.frame == null) return;
      unschedule(drag.frame);
      drag.frame = null;
    }

    function stepAutoScroll(drag) {
      drag.frame = null;
      if (!drag || drag.ended || dragRef.current !== drag) return;
      const scroller = scrollerRef.current;
      if (!scroller) return;
      const speed = edgeSpeed(drag.lastX);
      if (!speed || !canScroll(scroller, speed)) return;
      const max = Math.max(0, coordinate(scroller.scrollWidth) - coordinate(scroller.clientWidth));
      const before = Math.max(0, coordinate(scroller.scrollLeft));
      const next = Math.max(0, Math.min(max, before + speed));
      if (next === before) return;
      scroller.scrollLeft = next;
      updateTarget(drag, drag.lastX);
      drag.frame = schedule(() => stepAutoScroll(drag));
    }

    function updateEdgeScroll(drag, clientX) {
      if (!drag || drag.ended) return;
      const speed = edgeSpeed(clientX);
      if (!speed) {
        stopAutoScroll(drag);
        return;
      }
      if (drag.frame != null) return;
      const scroller = scrollerRef.current;
      if (!canScroll(scroller, speed)) return;
      drag.frame = schedule(() => stepAutoScroll(drag));
    }

    function updateTarget(drag, clientX) {
      if (!drag || drag.ended || !drag.started) return;
      const target = computeTarget(clientX, drag.id);
      if (target === drag.lastTarget) return;
      drag.lastTarget = target;
      applyMove(drag.id, target, true);
    }

    function escapeListener(drag) {
      return (event) => {
        if (!drag || drag.ended) return;
        if (!event || event.key !== 'Escape') return;
        event.preventDefault?.();
        event.stopPropagation?.();
        finishDrag(drag, 'restore');
      };
    }

    function listenEscape(drag) {
      if (!doc || typeof doc.addEventListener !== 'function') return;
      drag.keyHandler = escapeListener(drag);
      doc.addEventListener('keydown', drag.keyHandler, true);
    }

    function unlistenEscape(drag) {
      if (!drag?.keyHandler) return;
      if (doc && typeof doc.removeEventListener === 'function') {
        doc.removeEventListener('keydown', drag.keyHandler, true);
      }
      drag.keyHandler = null;
    }

    function releaseCapture(drag) {
      const shell = drag?.shell;
      if (!shell || !drag.captured) return;
      drag.captured = false;
      try {
        if (typeof shell.hasPointerCapture !== 'function' || shell.hasPointerCapture(drag.pointerId)) {
          shell.releasePointerCapture?.(drag.pointerId);
        }
      } catch {
        // Capture is already gone; cleanup continues.
      }
    }

    function beginDrag(drag) {
      if (!drag || drag.started || drag.ended) return;
      drag.started = true;
      const rect = measureRect(drag.shell);
      drag.rect = rect;
      drag.grabX = rect ? drag.startX - rect.left : 0;
      drag.grabY = rect ? drag.startY - rect.top : 0;
      drag.reduced = prefersReducedMotion(win);
      try {
        drag.shell?.setPointerCapture?.(drag.pointerId);
        drag.captured = true;
      } catch {
        drag.captured = false;
      }
      listenEscape(drag);
      if (mounted.current) setAnnouncement('');
      if (mounted.current) setDraggingId(drag.id);
    }

    function finishDrag(drag, mode, config = {}) {
      if (!drag || drag.ended) return;
      const wasStarted = drag.started;
      if (wasStarted && mode === 'commit') {
        const target = computeTarget(drag.lastX, drag.id);
        if (target !== drag.lastTarget) {
          drag.lastTarget = target;
          applyMove(drag.id, target, true);
        }
      }
      if (wasStarted && mode === 'restore') {
        const current = latest.current.tabs.findIndex((tab) => tab.id === drag.id);
        const last = Math.max(0, latest.current.tabs.length - 1);
        const target = Math.max(0, Math.min(drag.originIndex, last));
        if (current >= 0 && current !== target) applyMove(drag.id, target, false);
      }
      drag.ended = true;
      stopAutoScroll(drag);
      unlistenEscape(drag);
      releaseCapture(drag);
      if (wasStarted) suppressClick.current = true;
      if (dragRef.current === drag) dragRef.current = null;
      if (config.silent || !mounted.current) return;
      setDraggingId(null);
      if (mode === 'cancel') setAnnouncement('');
      else if (mode === 'restore') setAnnouncement(latest.current.copy.restored);
    }

    function onPointerDown(tab, event) {
      if (!event) return;
      if (event.button !== 0 || event.isPrimary === false) return;
      if (isControlNode(event.target)) return;
      const existing = dragRef.current;
      if (existing) {
        if (existing.started && !existing.ended && existing.pointerId !== event.pointerId) return;
        finishDrag(existing, 'cancel');
      }
      const originIndex = list.findIndex((item) => item.id === tab.id);
      if (originIndex < 0) return;
      suppressClick.current = false;
      const clientX = coordinate(event.clientX);
      const clientY = coordinate(event.clientY);
      dragRef.current = {
        id: tab.id,
        pointerId: event.pointerId,
        startX: clientX,
        startY: clientY,
        lastX: clientX,
        lastY: clientY,
        originIndex,
        lastTarget: originIndex,
        shell: shells.current.get(tab.id) ?? event.currentTarget ?? null,
        started: false,
        ended: false,
        captured: false,
        frame: null,
        keyHandler: null,
      };
    }

    function onPointerMove(event) {
      if (!event) return;
      const drag = dragRef.current;
      if (!drag || drag.ended || event.pointerId !== drag.pointerId) return;
      drag.lastX = coordinate(event.clientX);
      drag.lastY = coordinate(event.clientY);
      if (!drag.started) {
        const distance = Math.max(Math.abs(drag.lastX - drag.startX), Math.abs(drag.lastY - drag.startY));
        if (distance < DRAG_THRESHOLD) return;
        beginDrag(drag);
        if (!drag.started) return;
      }
      event.preventDefault?.();
      positionGhost(drag);
      updateTarget(drag, drag.lastX);
      updateEdgeScroll(drag, drag.lastX);
    }

    function onPointerUp(event) {
      if (!event) return;
      const drag = dragRef.current;
      if (!drag || drag.ended || event.pointerId !== drag.pointerId) return;
      drag.lastX = coordinate(event.clientX);
      drag.lastY = coordinate(event.clientY);
      if (!drag.started) {
        finishDrag(drag, 'cancel');
        return;
      }
      event.preventDefault?.();
      finishDrag(drag, 'commit');
    }

    function onPointerCancel(event) {
      if (!event) return;
      const drag = dragRef.current;
      if (!drag || drag.ended || event.pointerId !== drag.pointerId) return;
      finishDrag(drag, 'cancel');
    }

    function onLostPointerCapture(event) {
      if (!event) return;
      const drag = dragRef.current;
      if (!drag || drag.ended || event.pointerId !== drag.pointerId) return;
      finishDrag(drag, 'cancel');
    }

    function onTabClick(tab, event) {
      if (!event) return;
      if (suppressClick.current) {
        suppressClick.current = false;
        event.preventDefault?.();
        event.stopPropagation?.();
        return;
      }
      if (isControlNode(event.target)) return;
      const select = latest.current.onSelect;
      if (typeof select === 'function') select(tab.id);
      focusBody(tab.id);
    }

    function onTabKeyDown(tab, event) {
      if (!event || event.defaultPrevented) return;
      if (event.nativeEvent?.isComposing === true) return;
      // Keyboard activation never follows a pointer drag; clear stale suppression
      // so a later Enter/Space on the close button is not swallowed.
      suppressClick.current = false;
      if (isControlNode(event.target)) return;
      if (event.key === 'F2' && canEditTab(tab, latest.current.canEdit, latest.current.onEdit)) {
        event.preventDefault?.();
        latest.current.onEdit(tab.id);
        return;
      }
      const current = latest.current.tabs;
      const index = current.findIndex((item) => item.id === tab.id);
      if (index < 0) return;
      const key = event.key;
      if (event.altKey && (key === 'ArrowLeft' || key === 'ArrowRight') && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
        const target = key === 'ArrowLeft' ? index - 1 : index + 1;
        if (target >= 0 && target < current.length && typeof latest.current.onMove === 'function') {
          event.preventDefault?.();
          applyMove(tab.id, target, true);
          focusBody(tab.id);
        }
        return;
      }
      if (event.ctrlKey || event.metaKey) return;
      const count = current.length;
      let targetIndex = -1;
      if (key === 'ArrowLeft') targetIndex = (index - 1 + count) % count;
      else if (key === 'ArrowRight') targetIndex = (index + 1) % count;
      else if (key === 'Home') targetIndex = 0;
      else if (key === 'End') targetIndex = count - 1;
      if (targetIndex >= 0) {
        event.preventDefault?.();
        const target = current[targetIndex];
        if (typeof latest.current.onSelect === 'function' && target.id !== latest.current.activeId) {
          latest.current.onSelect(target.id);
        }
        focusBody(target.id);
        return;
      }
      if (key === 'Enter' || key === ' ' || key === 'Spacebar') {
        event.preventDefault?.();
        if (typeof latest.current.onSelect === 'function') latest.current.onSelect(tab.id);
        focusBody(tab.id);
        return;
      }
      if (key === 'Delete' || key === 'Backspace') {
        if (!isClosable(tab) || typeof latest.current.onClose !== 'function') return;
        event.preventDefault?.();
        latest.current.onClose(tab.id);
      }
    }

    function statusFor(tab) {
      const provider = latest.current.getStatus;
      if (typeof provider !== 'function') return null;
      let status;
      try {
        status = provider(tab);
      } catch {
        return null;
      }
      if (!status || typeof status !== 'object' || status.source !== 'ssh') return null;
      const alias = typeof status.alias === 'string' ? status.alias.trim() : '';
      // Without a connection name there is nothing to order the dot against;
      // fall back to the plain title instead of an unlabelled indicator.
      if (!alias) return null;
      return { alias, connected: status.connected === true };
    }

    function domIdsFor(tab) {
      const encoded = encodeId(tab?.id ?? '');
      let custom = null;
      const resolver = latest.current.ids;
      if (typeof resolver === 'function') {
        try {
          custom = resolver(tab);
        } catch {
          custom = null;
        }
      }
      const tabId = custom && typeof custom.tab === 'string' && custom.tab ? custom.tab : `${prefix}-${encoded}`;
      const panelId = custom && typeof custom.panel === 'string' && custom.panel ? custom.panel : `${prefix}-panel-${encoded}`;
      return { tab: tabId, panel: panelId };
    }

    function tabContentNodes(tab, status, appearance) {
      const marker = appearance && typeof appearance.color === 'string' && appearance.color ? appearance.color : null;
      return [
        marker ? h('span', {
          key: 'marker', className: 'ct-marker', 'data-color': marker, 'aria-hidden': 'true',
        }) : null,
        status ? h('span', {
          key: 'dot', className: 'ct-dot', 'data-connected': status.connected ? 'true' : 'false', 'aria-hidden': 'true',
        }) : null,
        status ? h('span', { key: 'state', className: 'ct-sr-only' }, status.connected ? copy.connected : copy.disconnected) : null,
        status && status.alias ? h('span', { key: 'alias', className: 'ct-alias' }, status.alias) : null,
        h('span', { key: 'title', className: 'ct-title' }, tabTitle(tab, appearance)),
      ];
    }

    function renderTab(tab) {
      const selected = tab.id === activeId;
      const tabbable = tab.id === tabbableId;
      const closable = isClosable(tab);
      const editable = canEditTab(tab, canEdit, onEdit);
      const appearance = appearanceOf(tab, getAppearance);
      const status = statusFor(tab);
      const title = tabTitle(tab, appearance);
      const tooltip = status && status.alias ? `${status.alias} · ${title}` : title;
      const domIds = domIdsFor(tab);
      const marker = appearance && typeof appearance.color === 'string' && appearance.color ? appearance.color : null;
      const shortcuts = [closable ? 'Delete' : null, editable ? 'F2' : null, typeof onMove === 'function' ? 'Alt+ArrowLeft Alt+ArrowRight' : null]
        .filter(Boolean).join(' ');
      const content = tabContentNodes(tab, status, appearance);
      return h('div', {
        key: tab.id,
        role: 'presentation',
        className: 'ct-tab',
        title: tooltip,
        'data-chrome-tab': String(tab.id),
        'data-active': selected ? 'true' : undefined,
        'data-dragging': draggingId === tab.id ? 'true' : undefined,
        'data-closable': closable ? 'true' : undefined,
        'data-editable': editable ? 'true' : undefined,
        'data-custom-title': appearance && typeof appearance.name === 'string' && appearance.name ? 'true' : undefined,
        'data-appearance-color': marker ?? undefined,
        'data-kind': typeof tab.kind === 'string' ? tab.kind : undefined,
        ref: (node) => {
          if (node) shells.current.set(tab.id, node);
          else shells.current.delete(tab.id);
        },
        onPointerDown: (event) => onPointerDown(tab, event),
        onLostPointerCapture: (event) => onLostPointerCapture(event),
        onClick: (event) => onTabClick(tab, event),
        onDoubleClick: (event) => {
          if (!editable || suppressClick.current) return;
          if (isControlNode(event?.target)) return;
          latest.current.onEdit(tab.id);
        },
        onKeyDown: (event) => onTabKeyDown(tab, event),
      },
      h('div', {
        className: 'ct-tab-body',
        role: 'tab',
        id: domIds.tab,
        'aria-controls': domIds.panel,
        'aria-selected': selected ? 'true' : 'false',
        'aria-keyshortcuts': shortcuts || undefined,
        tabIndex: tabbable ? 0 : -1,
        'data-chrome-tab-body': String(tab.id),
        ref: (node) => {
          if (node) bodies.current.set(tab.id, node);
          else bodies.current.delete(tab.id);
        },
      }, content),
      editable ? h('button', {
        key: 'edit',
        type: 'button',
        className: 'ct-edit',
        'data-chrome-tab-edit': String(tab.id),
        'aria-label': `${copy.edit} ${title}`,
        title: copy.edit,
        onPointerDown: (event) => {
          event?.stopPropagation?.();
        },
        onClick: (event) => {
          event?.stopPropagation?.();
          event?.preventDefault?.();
          if (suppressClick.current) {
            suppressClick.current = false;
            return;
          }
          latest.current.onEdit(tab.id);
        },
      }, '✎') : null,
      closable ? h('button', {
        key: 'close',
        type: 'button',
        className: 'ct-close',
        'data-chrome-tab-close': String(tab.id),
        'aria-label': `${copy.close} ${title}`,
        title: copy.close,
        onPointerDown: (event) => {
          event?.stopPropagation?.();
        },
        onClick: (event) => {
          event?.stopPropagation?.();
          event?.preventDefault?.();
          // A click that follows a drag is the release of that gesture, never a
          // close request, even if the pointer happens to rest on this button.
          if (suppressClick.current) {
            suppressClick.current = false;
            return;
          }
          if (typeof onClose === 'function') onClose(tab.id);
        },
      }, '×') : null);
    }

    // The copy carries the tab's content but none of its interaction or identity:
    // no tab role, no tab id, no close button and no pointer events.
    function renderGhost() {
      const drag = dragRef.current;
      if (!drag || !drag.started || drag.ended || !drag.rect) return null;
      if (!(drag.rect.width > 0) || !(drag.rect.height > 0)) return null;
      const tab = latest.current.tabs.find((item) => item.id === drag.id);
      if (!tab) return null;
      return h('div', {
        key: 'ghost',
        className: 'ct-ghost',
        'data-chrome-tab-ghost': String(tab.id),
        'aria-hidden': 'true',
        ref: ghostRef,
        style: {
          width: `${drag.rect.width}px`,
          height: `${drag.rect.height}px`,
          transform: ghostTransform(drag),
          WebkitAppRegion: 'no-drag',
        },
      }, h('div', { className: 'ct-tab-body' }, tabContentNodes(tab, statusFor(tab), appearanceOf(tab, latest.current.getAppearance))));
    }

    const ghost = renderGhost();
    return h('div', {
      className: typeof className === 'string' && className.trim() ? `ct-root ${className.trim()}` : 'ct-root',
      'data-chrome-tabs': '',
      'data-dragging': draggingId != null ? 'true' : undefined,
      ref: rootRef,
    },
    h('div', {
      className: 'ct-tabs',
      // The space above tabs is a window drag region; individual tabs opt out.
      style: { WebkitAppRegion: dragRegion === false ? 'no-drag' : 'drag' },
      role: 'tablist',
      'aria-label': copy.tablist,
      'aria-orientation': 'horizontal',
      'data-chrome-tablist': '',
      ref: scrollerRef,
      onPointerMove,
      onPointerUp,
      onPointerCancel,
      onLostPointerCapture,
    }, list.map(renderTab)),
    ghost,
    typeof onAdd === 'function' ? h('button', {
      type: 'button',
      className: 'ct-add',
      'data-chrome-tab-add': '',
      'aria-label': copy.newTab,
      title: copy.newTab,
      onClick: (event) => {
        event?.stopPropagation?.();
        onAdd();
      },
    }, '+') : null,
    dragRegion === false ? null : h('div', {
      className: 'ct-blank',
      'data-window-drag': '',
      style: { WebkitAppRegion: 'drag' },
      'aria-hidden': 'true',
    }),
    h('span', {
      className: 'ct-sr-only',
      role: 'status',
      'aria-live': 'polite',
      'aria-atomic': 'true',
      'data-chrome-tab-status': '',
    }, announcement));
  }

  return { ChromeTabStrip, css };
}

export const css = [
  '.ct-root{',
  '--ct-height:48px;',
  '--ct-tab-height:36px;',
  '--ct-tab-min-width:88px;',
  '--ct-tab-max-width:360px;',
  '--ct-gap:2px;',
  '--ct-inline-padding:8px;',
  '--ct-font-size:13px;',
  '--ct-font-size-compact:12px;',
  '--ct-radius:var(--dsw-radius-md, 8px);',
  '--ct-radius-sm:var(--dsw-radius-sm, 6px);',
  '--ct-bar-bg:var(--dsw-specific-sidebar-fill, var(--dsw-alias-bg-base));',
  '--ct-tab-active-bg:var(--dsw-alias-bg-base);',
  '--ct-fg:var(--dsw-alias-label-primary);',
  '--ct-fg-muted:var(--dsw-alias-label-secondary);',
  '--ct-fg-faint:var(--dsw-alias-label-tertiary);',
  '--ct-focus-ring:var(--dsw-focus-ring-color, var(--dsw-alias-brand-primary));',
  '--ct-focus-width:var(--dsw-focus-ring-width, 2px);',
  '--ct-dot-size:8px;',
  '--ct-dot-on:var(--dsw-alias-state-success-primary, var(--dsw-alias-brand-primary));',
  '--ct-dot-off:var(--dsw-alias-state-idle-primary, var(--dsw-alias-label-tertiary));',
  '--ct-hover-bg:color-mix(in srgb, var(--ct-fg) 7%, transparent);',
  '--ct-press-bg:color-mix(in srgb, var(--ct-fg) 12%, transparent);',
  '--ct-veil:color-mix(in srgb, var(--ct-fg) 14%, transparent);',
  '--ct-ghost-bg:var(--ct-tab-active-bg);',
  '--ct-ghost-shadow:var(--dsw-shadow-lv2, 0 12px 28px color-mix(in srgb, var(--ct-fg) 18%, transparent));',
  'box-sizing:border-box;display:flex;align-items:stretch;gap:2px;height:var(--ct-height);min-width:0;max-width:100%;padding:0 var(--ct-inline-padding);background:var(--ct-bar-bg);color:var(--ct-fg-muted);font-family:inherit;font-size:var(--ct-font-size);line-height:1;user-select:none;-webkit-user-select:none;position:relative;',
  '}',
  '.ct-tabs{display:flex;align-items:flex-end;gap:var(--ct-gap);flex:0 1 auto;min-width:0;height:100%;overflow-x:auto;overflow-y:hidden;scrollbar-width:none;overscroll-behavior-x:contain;touch-action:pan-x;-webkit-app-region:no-drag}',
  '.ct-tabs::-webkit-scrollbar{display:none;width:0;height:0}',
  '.ct-tab{position:relative;display:flex;align-items:center;flex:1 1 auto;min-width:var(--ct-tab-min-width);max-width:var(--ct-tab-max-width);height:var(--ct-tab-height);padding:0 4px 0 10px;box-sizing:border-box;border-radius:var(--ct-radius) var(--ct-radius) 0 0;background:transparent;color:var(--ct-fg-muted);cursor:default;touch-action:none;-webkit-app-region:no-drag}',
  '.ct-tab:not([data-active=true]):hover,.ct-tab:not([data-active=true]):focus-within{background:var(--ct-hover-bg)}',
  '.ct-tab[data-active=true]{background:var(--ct-tab-active-bg);color:var(--ct-fg)}',
  '.ct-tab[data-dragging=true]{opacity:.45;background:var(--ct-hover-bg);box-shadow:inset 0 0 0 1px var(--ct-veil)}',
  '.ct-tab[data-dragging=true] .ct-close{opacity:0;pointer-events:none}',
  '.ct-root[data-dragging=true]{cursor:grabbing}',
  '.ct-root[data-dragging=true] .ct-tab{cursor:grabbing}',
  '.ct-ghost{position:absolute;left:0;top:0;z-index:40;display:flex;align-items:center;box-sizing:border-box;padding:0 4px 0 10px;border-radius:var(--ct-radius) var(--ct-radius) 0 0;background:var(--ct-ghost-bg);color:var(--ct-fg);box-shadow:var(--ct-ghost-shadow),0 0 0 1px var(--ct-veil);pointer-events:none;will-change:transform;transform-origin:50% 0;overflow:hidden;-webkit-app-region:no-drag}',
  '.ct-tab-body{display:flex;align-items:center;gap:6px;flex:1 1 auto;min-width:0;height:100%;padding:0;border:0;border-radius:var(--ct-radius-sm);background:transparent;color:inherit;font:inherit;cursor:inherit;outline:none}',
  '.ct-tab-body:focus-visible{outline:var(--ct-focus-width) solid var(--ct-focus-ring);outline-offset:-2px}',
  '.ct-title{min-width:0;flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  '.ct-alias{flex:0 1 auto;min-width:0;max-width:60%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--ct-fg-faint);font-size:var(--ct-font-size-compact)}',
  '.ct-marker{flex:none;width:3px;height:14px;border-radius:2px;background:var(--dsw-alias-state-idle-primary)}',
  '.ct-marker[data-color=blue]{background:var(--dsw-alias-state-business-primary)}',
  '.ct-marker[data-color=green]{background:var(--dsw-alias-state-success-primary)}',
  '.ct-marker[data-color=amber]{background:var(--dsw-alias-state-warn-primary)}',
  '.ct-marker[data-color=red]{background:var(--dsw-alias-state-error-primary)}',
  '.ct-marker[data-color=gray]{background:var(--dsw-alias-state-idle-primary)}',
  '.ct-dot{flex:none;width:var(--ct-dot-size);height:var(--ct-dot-size);border-radius:50%;background:var(--ct-dot-off);box-shadow:0 0 0 1px var(--ct-veil)}',
  '.ct-dot[data-connected=true]{background:var(--ct-dot-on)}',
  '.ct-edit{flex:none;display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;margin-left:2px;padding:0;border:0;border-radius:50%;background:transparent;color:var(--ct-fg-faint);font-family:inherit;font-size:12px;line-height:1;cursor:pointer;opacity:0;pointer-events:none}',
  '.ct-tab:hover .ct-edit,.ct-tab:focus-within .ct-edit,.ct-tab[data-active=true] .ct-edit{opacity:1;pointer-events:auto}',
  '.ct-edit:hover{background:var(--ct-hover-bg);color:var(--ct-fg)}',
  '.ct-edit:active{background:var(--ct-press-bg)}',
  '.ct-edit:focus-visible{opacity:1;pointer-events:auto;outline:var(--ct-focus-width) solid var(--ct-focus-ring);outline-offset:0}',
  '.ct-close{flex:none;display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;margin-left:2px;padding:0;border:0;border-radius:50%;background:transparent;color:var(--ct-fg-faint);font-family:inherit;font-size:14px;line-height:1;cursor:pointer;opacity:0;pointer-events:none}',
  '.ct-tab:hover .ct-close,.ct-tab:focus-within .ct-close,.ct-tab[data-active=true] .ct-close{opacity:1;pointer-events:auto}',
  '.ct-close:hover{background:var(--ct-hover-bg);color:var(--ct-fg)}',
  '.ct-close:active{background:var(--ct-press-bg)}',
  '.ct-close:focus-visible{opacity:1;pointer-events:auto;outline:var(--ct-focus-width) solid var(--ct-focus-ring);outline-offset:0}',
  '.ct-add{flex:none;display:inline-flex;align-items:center;justify-content:center;align-self:center;width:24px;height:24px;margin:0 2px;padding:0;border:0;border-radius:50%;background:transparent;color:var(--ct-fg-muted);font-family:inherit;font-size:16px;line-height:1;cursor:pointer;-webkit-app-region:no-drag}',
  '.ct-add:hover{background:var(--ct-hover-bg);color:var(--ct-fg)}',
  '.ct-add:active{background:var(--ct-press-bg)}',
  '.ct-add:focus-visible{outline:var(--ct-focus-width) solid var(--ct-focus-ring);outline-offset:0}',
  '.ct-blank{flex:1 1 auto;min-width:8px;align-self:stretch;-webkit-app-region:drag}',
  '.ct-sr-only{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip-path:inset(50%);white-space:nowrap;border:0}',
  '@keyframes ct-ghost-in{from{opacity:0}to{opacity:1}}',
  '@media(prefers-reduced-motion:no-preference){.ct-tab,.ct-close,.ct-edit,.ct-add{transition:background-color 120ms ease,color 120ms ease,opacity 120ms ease,box-shadow 120ms ease}.ct-ghost{animation:ct-ghost-in 90ms ease-out}}',
  '@media(prefers-reduced-motion:reduce){.ct-tab,.ct-close,.ct-edit,.ct-add,.ct-ghost{transition:none!important;animation:none!important}}',
  '@media(max-width:640px){.ct-root{--ct-tab-min-width:72px;--ct-tab-max-width:240px;--ct-font-size:12px;--ct-font-size-compact:11px;--ct-inline-padding:6px}.ct-alias{max-width:50%}}',
].join('\n');
