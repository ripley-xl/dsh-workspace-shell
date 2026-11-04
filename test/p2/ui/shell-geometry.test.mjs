import assert from 'node:assert/strict';
import test from 'node:test';
import { createPointerResize, solveFrame } from '../../../packages/shell/src/geometry.js';

const info = (overrides = {}) => ({ viewportWidth: 1440, sidebar: 280, rightbar: 360, narrowExpanded: false, rightbarShown: true, rightbarTrack: true, ...overrides });

for (const rail of [0, 56]) {
  test(`geometry respects 767/768/769 and 1023/1024/1025 boundaries with rail ${rail}`, () => {
    for (const width of [767, 768, 769, 1023, 1024, 1025]) {
      const g = solveFrame(info({ viewportWidth: width }), rail);
      const sidebar = width < 1024 ? rail : 280;
      const right = Math.min(360, width - sidebar - 400);
      assert.deepEqual(g, { width, collapsed: width < 1024, sidebar, right, normalRight: right, center: width - sidebar - right }, `width ${width}`);
    }
  });

  test(`collapsed sidebar preserves the ${rail}px platform rail and explicit rightbar zero`, () => {
    const input = Object.freeze(info({ sidebar: 0, rightbar: 0 }));
    assert.deepEqual(solveFrame(input, rail), { width: 1440, collapsed: true, sidebar: rail, right: 0, normalRight: 0, center: 1440 - rail });
    assert.equal(input.sidebar, 0);
    assert.equal(input.rightbar, 0);
  });

  test(`right panel needs at least 300px plus a 400px center with rail ${rail}`, () => {
    const threshold = rail + 700;
    assert.equal(solveFrame(info({ viewportWidth: threshold - 1, sidebar: 0 }), rail).right, 0);
    const boundary = solveFrame(info({ viewportWidth: threshold, sidebar: 0 }), rail);
    assert.equal(boundary.right, 300);
    assert.equal(boundary.center, 400);
    assert.equal(solveFrame(info({ viewportWidth: threshold + 1, sidebar: 0 }), rail).right, 301);
  });
}

test('default rail is 56 and desktop sidebar clamping/rounding honors explicit collapse', () => {
  assert.equal(solveFrame(info({ sidebar: 0 })).sidebar, 56);
  for (const [sidebar, expected] of [[1, 264], [263.8, 264], [280.49, 280], [280.5, 281], [420.5, 420], [1000, 420], [undefined, 280]]) {
    assert.equal(solveFrame(info({ sidebar })).sidebar, expected, `sidebar ${sidebar}`);
  }
});

test('rightbar track allocation is independent from normalRight, visibility, and fullscreen metadata', () => {
  const base = info({ rightbarTrack: false, rightbarShown: false });
  assert.deepEqual(solveFrame(base), { width: 1440, collapsed: false, sidebar: 280, right: 0, normalRight: 360, center: 1160 });
  assert.equal(solveFrame({ ...base, rightbarShown: true }).right, 0);
  const on = solveFrame({ ...base, rightbarTrack: true });
  assert.equal(on.right, 360);
  assert.equal(on.center, 800);
  assert.deepEqual(solveFrame({ ...base, rightbarFullscreen: true, rightbarInstant: true }), solveFrame(base));
});

test('narrow expansion overrides persisted sidebar collapse while desktop ignores narrow override', () => {
  assert.equal(solveFrame(info({ viewportWidth: 1023, sidebar: 350, narrowExpanded: false })).sidebar, 56);
  const narrow = solveFrame(info({ viewportWidth: 1023, sidebar: 0, narrowExpanded: true }));
  assert.equal(narrow.collapsed, false);
  assert.equal(narrow.sidebar, 280, 'expanded narrow mode uses the default when desktop preference is zero');
  assert.equal(solveFrame(info({ viewportWidth: 1023, sidebar: 350, narrowExpanded: true })).sidebar, 350);
  const desktop = solveFrame(info({ viewportWidth: 1024, sidebar: 0, narrowExpanded: true }));
  assert.equal(desktop.collapsed, true);
  assert.equal(desktop.sidebar, 56);
  assert.equal(solveFrame(info({ viewportWidth: 1024, sidebar: 350, narrowExpanded: false })).sidebar, 350);
});

test('narrow hidden rightbar capacity uses the collapsed rail, not the currently expanded sidebar', () => {
  const hidden = info({ viewportWidth: 900, narrowExpanded: true, rightbarShown: false, rightbarTrack: false });
  const g = solveFrame(hidden, 56);
  assert.deepEqual(g, { width: 900, collapsed: false, sidebar: 280, right: 0, normalRight: 360, center: 620 });
  assert.equal(solveFrame({ ...hidden, rightbarShown: true }, 56).normalRight, 0);
  const track = solveFrame({ ...hidden, rightbarTrack: true }, 56);
  assert.equal(track.right, 0, 'track still uses physical expanded sidebar and must not consume the center');
  assert.equal(track.normalRight, 360);
});

test('rightbar preference defaults only when absent, rounds, clamps, and never invents width for zero', () => {
  assert.equal(solveFrame(info({ rightbar: null })).right, 648);
  assert.equal(solveFrame(info({ rightbar: undefined })).right, 648);
  assert.equal(solveFrame(info({ rightbar: 0 })).right, 0);
  assert.equal(solveFrame(info({ rightbar: 1 })).right, 300);
  assert.equal(solveFrame(info({ rightbar: 360.49 })).right, 360);
  assert.equal(solveFrame(info({ rightbar: 360.5 })).right, 361);
  assert.equal(solveFrame(info({ rightbar: 10000 })).right, 760, 'reserve 400px for center');
  assert.equal(solveFrame(info({ viewportWidth: 3000, sidebar: 0, rightbar: 10000 }), 0).right, 2100, 'cap at 70% of viewport');
});

test('zero, negative, and missing viewport widths produce finite non-negative track geometry', () => {
  for (const width of [0, -1, undefined, NaN]) {
    for (const rail of [0, 56]) {
      const g = solveFrame(info({ viewportWidth: width, rightbar: 0 }), rail);
      assert.deepEqual(g, { width: 0, collapsed: true, sidebar: rail, right: 0, normalRight: 0, center: 0 });
      assert.ok(Object.values(g).every((value) => typeof value !== 'number' || Number.isFinite(value)));
    }
  }
  assert.equal(solveFrame(info({ viewportWidth: '1024' })).width, 1024);
});

// Deterministic rAF and capture probes test lifecycle semantics without a DOM or
// browser; these tests make no claim about native paint or pointer dispatch.
function pointerFixture() {
  const callbacks = new Map();
  const cancelled = [];
  const writes = [];
  const capture = new Set();
  const captured = [];
  const released = [];
  let nextId = 0;
  let ends = 0;
  let prevented = 0;
  const target = {
    setPointerCapture(id) { capture.add(id); captured.push(id); },
    hasPointerCapture(id) { return capture.has(id); },
    releasePointerCapture(id) { capture.delete(id); released.push(id); },
  };
  const resize = createPointerResize({
    request(fn) { const id = nextId++; callbacks.set(id, fn); return id; },
    cancel(id) { cancelled.push(id); callbacks.delete(id); },
    write(value) { writes.push(value); },
    end() { ends += 1; },
  });
  const event = (clientX, overrides = {}) => ({ button: 0, pointerId: 1, currentTarget: target, clientX, preventDefault() { prevented += 1; }, ...overrides });
  const flush = () => {
    const queued = [...callbacks];
    callbacks.clear();
    for (const [, callback] of queued) callback();
  };
  return { resize, callbacks, cancelled, writes, target, capture, captured, released, event, flush, get ends() { return ends; }, get prevented() { return prevented; } };
}

test('only a left-button start acquires capture and duplicate pointers do not replace the active drag', () => {
  const f = pointerFixture();
  assert.equal(f.resize.start(f.event(100, { button: 1 }), 280), false);
  assert.equal(f.resize.start(f.event(100, { button: 2 }), 280), false);
  assert.equal(f.prevented, 0);
  assert.deepEqual(f.captured, []);
  assert.equal(f.resize.start(f.event(100), 280), true);
  assert.deepEqual(f.captured, [1]);
  assert.equal(f.resize.start(f.event(0, { pointerId: 2 }), 900), false);
  assert.equal(f.resize.start(f.event(0), 900), false);
  assert.equal(f.prevented, 1);
  f.resize.move(f.event(500, { pointerId: 2 }));
  f.resize.finish(f.event(600, { pointerId: 2 }));
  f.resize.cancel(f.event(600, { pointerId: 2 }));
  assert.equal(f.callbacks.size, 0);
  assert.equal(f.ends, 0);
  assert.deepEqual([...f.capture], [1]);
  f.resize.finish(f.event(120));
  assert.deepEqual(f.writes, [300]);
  assert.deepEqual(f.released, [1]);
  assert.equal(f.ends, 1);
});

test('moves batch into one rAF, use the latest dx, and accept scheduler handle zero', () => {
  const f = pointerFixture();
  f.resize.start(f.event(100), 280);
  f.resize.move(f.event(110));
  f.resize.move(f.event(135));
  f.resize.move(f.event(120));
  assert.deepEqual([...f.callbacks.keys()], [0]);
  assert.deepEqual(f.writes, []);
  f.flush();
  assert.deepEqual(f.writes, [300]);
  f.resize.move(f.event(150));
  assert.equal(f.callbacks.size, 1);
  f.flush();
  assert.deepEqual(f.writes, [300, 330]);
  f.resize.dispose();
});

test('pointer up commits the final unflushed dx, cancels rAF, and finishes exactly once', () => {
  const f = pointerFixture();
  f.resize.start(f.event(100), 280);
  f.resize.move(f.event(120));
  f.resize.finish(f.event(137));
  assert.deepEqual(f.cancelled, [0]);
  assert.equal(f.callbacks.size, 0);
  assert.deepEqual(f.writes, [317]);
  f.flush();
  f.resize.finish(f.event(200));
  f.resize.cancel(f.event(200));
  f.resize.dispose();
  assert.deepEqual(f.writes, [317]);
  assert.equal(f.ends, 1);
  assert.deepEqual(f.released, [1]);
});

test('right resize reverses dx and pointer up writes even without a move event', () => {
  const f = pointerFixture();
  f.resize.start(f.event(800), 360, -1);
  f.resize.finish(f.event(775));
  assert.deepEqual(f.writes, [385]);
  assert.deepEqual(f.cancelled, []);
  assert.equal(f.ends, 1);
});

test('cancellation discards unflushed motion, retains already written width, and allows a new drag', () => {
  const f = pointerFixture();
  f.resize.start(f.event(100), 280);
  f.resize.move(f.event(110));
  f.flush();
  f.resize.move(f.event(150));
  f.resize.cancel(f.event(180));
  f.flush();
  assert.deepEqual(f.writes, [290]);
  assert.deepEqual(f.cancelled, [1]);
  assert.equal(f.ends, 1);
  assert.equal(f.resize.start(f.event(200, { pointerId: 2 }), 290), true);
  f.resize.finish(f.event(220, { pointerId: 2 }));
  assert.deepEqual(f.writes, [290, 310]);
  assert.equal(f.ends, 2);
});

test('unmount disposal cancels outstanding work and releases capture without a final write', () => {
  const f = pointerFixture();
  f.resize.dispose();
  assert.equal(f.ends, 0);
  f.resize.start(f.event(100), 280);
  f.resize.move(f.event(200));
  const retainedCallback = [...f.callbacks.values()][0];
  f.resize.dispose();
  assert.deepEqual(f.cancelled, [0]);
  assert.deepEqual(f.released, [1]);
  retainedCallback();
  f.resize.move(f.event(300));
  f.resize.finish(f.event(300));
  f.resize.dispose();
  assert.deepEqual(f.writes, []);
  assert.equal(f.callbacks.size, 0);
  assert.equal(f.ends, 1);
});

test('failed capture leaves no active drag, write, or end callback and a later start may succeed', () => {
  const f = pointerFixture();
  const broken = { setPointerCapture() { throw new Error('detached target'); } };
  assert.equal(f.resize.start(f.event(100, { currentTarget: broken }), 280), false);
  f.resize.move(f.event(200));
  f.resize.finish(f.event(200));
  assert.deepEqual(f.writes, []);
  assert.equal(f.ends, 0);
  assert.equal(f.resize.start(f.event(100), 280), true);
  f.resize.dispose();
  assert.equal(f.ends, 1);
});

test('already-lost capture and throwing release still end a drag exactly once', () => {
  for (const lost of [true, false]) {
    const f = pointerFixture();
    f.resize.start(f.event(100), 280);
    if (lost) f.capture.clear();
    else f.target.releasePointerCapture = () => { throw new Error('target detached during release'); };
    assert.doesNotThrow(() => f.resize.cancel(f.event(150)));
    assert.equal(f.ends, 1);
    f.resize.dispose();
    assert.equal(f.ends, 1);
  }
});

test('lostpointercapture dispatched during release cannot double-finish a commit', () => {
  const f = pointerFixture();
  const release = f.target.releasePointerCapture;
  f.target.releasePointerCapture = (id) => { release.call(f.target, id); f.resize.cancel(f.event(150)); };
  f.resize.start(f.event(100), 280);
  f.resize.finish(f.event(120));
  assert.deepEqual(f.writes, [300]);
  assert.equal(f.ends, 1);
});
