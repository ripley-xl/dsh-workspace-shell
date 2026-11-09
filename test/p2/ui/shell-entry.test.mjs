import test from "node:test";
import assert from "node:assert/strict";
import { createShellPlugin } from "../../../packages/shell/src/entry.js";

function mountEntry(dicts, { fail = false, embedded = false, fragmentEmbedded = false, trackLocale = true, notifications = false, guestBridge = false } = {}) {
  const effects = []; const calls = [];
  const context = {};
  const ctx = {
    effect(setup, label) { const release = setup(); if (typeof release === "function" && (trackLocale || label !== "workspace locale dictionaries")) effects.push(release); return release; },
    locale: { register(ns, value) {
      if (dicts.has(ns)) throw new Error("duplicate namespace: " + ns);
      dicts.set(ns, value);
      return () => { if (dicts.get(ns) === value) dicts.delete(ns); };
    } },
    provide() {},
    slots: { inject(_slot, setup) { return setup(); }, register(options) { calls.push(options.id); } },
    uiSession: { sessionStatus: { getSnapshot: () => new Map(), subscribe: () => () => {} } },
    sessions: { list: { getSnapshot: () => ({ byId: {} }) } },
  };
  const window = {
    location: { search: embedded ? "?workspaceShellEmbedded=1" : "", hash: fragmentEmbedded ? "#workspaceShellEmbedded=1" : "" },
    ...(notifications ? { dshDesktop: { browser: {} }, Notification: class {} } : {}),
  };
  const deps = { document: {}, window,
    createWorkspaceClient(input) {
      calls.push("workspace");
      context.onGuestNotification = input.onGuestNotification;
      return { tabs: {}, dispose() { calls.push("workspace disposed"); } };
    },
    ...(guestBridge ? {
      createGuestNotificationBridge(input) {
        calls.push("guest bridge");
        assert.equal(input.window, window);
        return { dispose() { calls.push("guest bridge disposed"); } };
      },
    } : {}),
    ...(notifications ? {
      createNotificationCenter(input) {
        calls.push("notifications");
        assert.equal(input.window, window);
        assert.equal(typeof input.openLocalSession, "function");
        return { reportHost: (payload) => calls.push(["host", payload]), reportGuest: (key, data) => calls.push(["guest", key, data]), dispose() { calls.push("notifications disposed"); } };
      },
      createSessionNotificationMonitor(input) {
        calls.push("monitor");
        assert.equal(typeof input.report, "function");
        return { dispose() { calls.push("monitor disposed"); } };
      },
    } : {}),
    createFrameViews() { return { makeView() {} }; },
    installFrameAdapter() { if (fail) throw new Error("adapter failed"); calls.push("adapter"); return { dispose() { calls.push("adapter disposed"); } }; },
  };
  return { calls, context, window, apply() { createShellPlugin({}, deps).apply(ctx); }, async dispose() { for (const release of effects.splice(0).reverse()) await release(); } };
}

test("entry reload releases its locale before the next instance registers", async () => {
  const dicts = new Map();
  for (let generation = 0; generation < 3; generation++) {
    const entry = mountEntry(dicts); entry.apply();
    assert.equal(dicts.size, 1);
    assert.equal(entry.calls.includes("workspace-shell-toggle"), false, "the sidebar layout entry is removed");
    await entry.dispose(); assert.equal(dicts.size, 0);
    assert.ok(entry.calls.includes("adapter disposed"));
    assert.ok(entry.calls.includes("workspace disposed"));
  }
});

test("legacy unowned locale residue reproduces failed reapplication before the footer", async () => {
  const dicts = new Map(); const old = mountEntry(dicts, { trackLocale: false });
  old.apply(); await old.dispose(); assert.equal(dicts.size, 1);
  const next = mountEntry(dicts);
  assert.throws(() => next.apply(), /duplicate namespace/);
  assert.equal(next.calls.length, 0);
  await next.dispose(); assert.equal(dicts.size, 1);
});

test("entry failure cleanup releases dictionaries and an acquired workspace", async () => {
  const dicts = new Map(); const entry = mountEntry(dicts, { fail: true });
  assert.throws(() => entry.apply(), /adapter failed/);
  await entry.dispose(); assert.equal(dicts.size, 0);
  assert.ok(entry.calls.includes("workspace disposed"));
});

test("a Desktop entry wires one notification center and one Session monitor, then releases both", async () => {
  const dicts = new Map();
  const entry = mountEntry(dicts, { notifications: true });
  entry.apply();
  assert.ok(entry.calls.includes("notifications"));
  assert.ok(entry.calls.includes("monitor"));
  entry.context.onGuestNotification("local-web:alpha:1", { type: "workspace-shell-notification" });
  assert.deepEqual(entry.calls.filter((item) => Array.isArray(item)), [["guest", "local-web:alpha:1", { type: "workspace-shell-notification" }]]);
  await entry.dispose();
  assert.ok(entry.calls.indexOf("monitor disposed") < entry.calls.indexOf("notifications disposed"), "the source stops before the surface");
});

test("a plain browser entry installs no notification surface", async () => {
  const dicts = new Map();
  const entry = mountEntry(dicts, { notifications: false });
  entry.apply();
  assert.equal(entry.calls.includes("notifications"), false);
  assert.equal(entry.calls.includes("monitor"), false);
  await entry.dispose();
});

test("an embedded entry installs the guest bridge and mounts no frame", async () => {
  const dicts = new Map();
  const entry = mountEntry(dicts, { embedded: true, guestBridge: true });
  entry.apply();
  assert.deepEqual(entry.calls, ["guest bridge"]);
  assert.equal(dicts.size, 0);
  await entry.dispose();
  assert.deepEqual(entry.calls, ["guest bridge", "guest bridge disposed"]);
});

test("embedded entry stays inert and conflicting foreign dictionaries are untouched", async () => {
  const dicts = new Map(); const embedded = mountEntry(dicts, { embedded: true });
  embedded.apply(); await embedded.dispose();
  assert.equal(dicts.size, 0); assert.equal(embedded.calls.length, 0);
  const foreign = {}; dicts.set("workspace-shell", foreign);
  const entry = mountEntry(dicts); assert.throws(() => entry.apply(), /duplicate namespace/);
  await entry.dispose(); assert.equal(dicts.get("workspace-shell"), foreign);
});

test("login redirects preserving only the fragment still keep embedded Shell inert", async () => {
  const entry = mountEntry(new Map(), { fragmentEmbedded: true });
  entry.apply(); assert.equal(entry.calls.length, 0); await entry.dispose();
});

test("generated Shell build keeps per-module scopes and loads as a real Client factory", async () => {
  const { mkdtemp, rm, readFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const { spawnSync } = await import("node:child_process");
  const vm = (await import("node:vm")).default;
  const { React } = await import("./react-harness.mjs");
  const projectRoot = new URL("../../../", import.meta.url);
  const directory = await mkdtemp(path.join(tmpdir(), "wsh-build-smoke-"));
  try {
    const build = spawnSync(process.execPath, ["scripts/build-shell-client.mjs", "--out-dir", directory], { cwd: projectRoot, encoding: "utf8", timeout: 60000 });
    assert.equal(build.status, 0, build.stderr || build.stdout);
    const check = spawnSync(process.execPath, ["scripts/build-shell-client.mjs", "--out-dir", directory, "--check"], { cwd: projectRoot, encoding: "utf8", timeout: 60000 });
    assert.equal(check.status, 0, check.stderr || check.stdout);
    const source = await readFile(path.join(directory, "client.js"), "utf8");
    assert.doesNotMatch(source, /^\s*(import|export)\s/m);
    let definition;
    const window = { __ModuleLoader__: { load(value) { definition = value; } }, location: { search: "" } };
    const context = vm.createContext({
      window, document: { documentElement: { lang: "zh" } }, console, URL, URLSearchParams,
      setTimeout, clearTimeout, queueMicrotask, AbortController, TextEncoder,
    });
    vm.runInContext(source, context, { filename: "generated-client.js" });
    assert.equal(typeof definition?.factory, "function");
    const plugin = definition.factory((id) => {
      if (id === '@deepseek-ai/dsh-client-ui-primitives') return {};
      assert.equal(id, "react");
      return React;
    });
    assert.deepEqual(Object.keys(plugin).sort(), ["apply", "inject"]);
    assert.deepEqual([...plugin.inject], ["slots", "locale", "layout", "shortcuts", "sessions", "uiWorkspace", "conversation"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('core session navigation still activates in embedded views without a nested frame', () => {
  const calls = [];
  const plugin = createShellPlugin({}, {
    window: { location: { search: '?workspaceShellEmbedded=1' } },
    createSessionHostPlugin: () => ({ inject: ['sessions'], apply() { calls.push('sessions'); } }),
    createWorkspaceClient() { assert.fail('embedded frame must not mount'); },
  });
  plugin.apply({});
  assert.deepEqual(calls, ['sessions']);
});
