// Geometry only; the original DSH Store remains authoritative.
export function solveFrame(info, rail = 56) {
  const width = Math.max(0, Number(info.viewportWidth) || 0);
  const narrow = width < 1024;
  const collapsed = narrow ? !info.narrowExpanded : info.sidebar === 0;
  const preference = collapsed ? 0 : (info.sidebar || 280);
  const requested = info.rightbar ?? width * 0.45;
  const left = (value) => value ? Math.min(420, Math.max(264, Math.round(value))) : rail;
  const right = (sidebar, value) => {
    const room = width - sidebar - 400;
    return !value || room < 300 ? 0 : Math.min(room, width * 0.7, Math.max(300, Math.round(value)));
  };
  const sidebar = left(preference);
  const normalRight = right(left(narrow && !info.rightbarShown ? 0 : preference), requested);
  const track = right(sidebar, info.rightbarTrack ? requested : 0);
  return { width, collapsed, sidebar, right: track, normalRight, center: Math.max(0, width - sidebar - track) };
}
export function createPointerResize({ request, cancel, write, end }) {
  let drag;
  let pending;
  const flush = () => {
    pending = undefined;
    if (drag) write(drag.base + drag.direction * (drag.latest - drag.start));
  };
  const finish = (event, commit) => {
    if (!drag || (event && event.pointerId !== drag.id)) return;
    if (pending !== undefined) cancel(pending);
    pending = undefined;
    if (commit) { drag.latest = event.clientX; flush(); }
    const previous = drag;
    drag = undefined;
    try { if (previous.target.hasPointerCapture?.(previous.id)) previous.target.releasePointerCapture(previous.id); } catch {}
    end();
  };
  return {
    start(event, base, direction = 1) {
      if (event.button !== 0 || drag) return false;
      event.preventDefault();
      drag = { target: event.currentTarget, id: event.pointerId, base, direction, start: event.clientX, latest: event.clientX };
      try { drag.target.setPointerCapture(drag.id); } catch { drag = undefined; return false; }
      return true;
    },
    move(event) {
      if (!drag || event.pointerId !== drag.id) return;
      drag.latest = event.clientX;
      if (pending === undefined) pending = request(flush);
    },
    finish: (event) => finish(event, true),
    cancel: (event) => finish(event, false),
    dispose: () => finish(undefined, false),
  };
}
