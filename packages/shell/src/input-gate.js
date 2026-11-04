// Private ShortcutsService adapter; this module owns neither commands nor preferences.
export function installInputGate(service) {
  const unsupported = () => Object.freeze({
    supported: false, setLocal: () => Promise.resolve(false), dispose: () => Promise.resolve(),
  });
  const object = (value) => value !== null && (typeof value === 'object' || typeof value === 'function');
  const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
  const validSnapshot = (value) => record(value) && typeof value.revision === 'string' && value.revision.length > 0
    && Number.isSafeInteger(value.sequence) && value.sequence >= 0
    && ['loading', 'ready', 'unreadable'].includes(value.status)
    && (value.error === null || typeof value.error === 'string')
    && record(value.document) && record(value.document.profiles) && typeof value.usingDefaults === 'boolean';
  const slot = (target, key) => {
    const own = Object.getOwnPropertyDescriptor(target, key);
    let descriptor = own;
    let prototype = target;
    while (!descriptor && (prototype = Object.getPrototypeOf(prototype))) descriptor = Object.getOwnPropertyDescriptor(prototype, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.writable || !own && !Object.isExtensible(target)) {
      throw new TypeError(`Unsupported writable shortcut field: ${key}`);
    }
    return { target, key, own, original: descriptor.value, wrapper: undefined };
  };
  let registry, adapter, config, originalGet;
  let definitions, dispatch, invoke, configure, fixed, adapterSlot;
  try {
    if (!object(service) || !['desktop', 'web'].includes(service.runtime) || service.active !== true || typeof service.connected !== 'boolean') return unsupported();
    registry = service.registry;
    adapter = service.adapter;
    config = service.config;
    if (!object(registry) || !object(adapter) || !object(config) || registry.config !== config
      || typeof config.getSnapshot !== 'function' || typeof adapter.get !== 'function' || !validSnapshot(config.getSnapshot())) return unsupported();
    definitions = slot(registry, 'definitions');
    dispatch = slot(registry, 'dispatch');
    invoke = slot(registry, 'invoke');
    configure = slot(registry, 'configure');
    fixed = slot(service, 'fixedInput');
    adapterSlot = slot(service, 'adapter');
    slot(service, 'connected');
    if ([definitions, dispatch, invoke, configure, fixed].some((entry) => typeof entry.original !== 'function')) return unsupported();
    originalGet = adapter.get;
    if (!Array.isArray(definitions.original.call(registry))) return unsupported();
  } catch { return unsupported(); }

  let mode = 'live';
  let desiredLocal = true;
  let executionOpen = true;
  let generation = 0;
  let observerFaults = 0;
  let lastError = null;
  let tail = Promise.resolve();
  let disposal;
  const patches = [definitions, dispatch, invoke, configure, fixed, adapterSlot];
  const detached = () => mode === 'disposed';
  const pass = () => ({ status: 'pass' });
  definitions.wrapper = function (...args) {
    return detached() || desiredLocal ? definitions.original.apply(this, args) : [];
  };
  dispatch.wrapper = function (...args) {
    return detached() || executionOpen ? dispatch.original.apply(this, args) : pass();
  };
  invoke.wrapper = function (...args) {
    if (detached() || executionOpen) return invoke.original.apply(this, args);
  };
  fixed.wrapper = function (input, ...args) {
    if (detached() || executionOpen || input?.type === 'reset') return fixed.original.call(this, input, ...args);
  };
  configure.wrapper = function (...args) {
    if (detached()) return configure.original.apply(this, args);
    try { return configure.original.apply(this, args); } catch {
      // Native subscriptions and the original void syncDefinitions must not leak observer failures.
      observerFaults += 1;
      executionOpen = false;
    }
  };
  const resetFixed = () => {
    try { fixed.original.call(service, { type: 'reset' }); } catch { observerFaults += 1; }
  };
  const unreadable = () => {
    try {
      if (service.active) registry.configure({ ...config.getSnapshot(), status: 'unreadable', error: 'read' });
    } catch { /* A failing observer must not reject a discarded continuation. */ }
  };
  const applySnapshot = (snapshot) => {
    if (!validSnapshot(snapshot) || !service.active) throw new Error('Shortcut configuration acknowledgement unavailable');
    const current = config.getSnapshot();
    if (!validSnapshot(current)) throw new Error('Invalid current shortcut configuration');
    service.connected = true;
    const faults = observerFaults;
    if (snapshot.sequence >= current.sequence) registry.configure(snapshot);
    if (observerFaults !== faults) throw new Error('Shortcut configuration observer failed');
    const accepted = config.getSnapshot();
    if (!validSnapshot(accepted) || accepted.sequence < snapshot.sequence) throw new Error('Shortcut configuration was not applied');
  };
  const enqueue = () => {
    const operation = tail.then(async () => {
      try {
        if (!service.active) throw new Error('Shortcut configuration acknowledgement unavailable');
        // Ignore supplied catalogs: queued register/unregister calls must use the current projection.
        const catalog = desiredLocal ? registry.definitions() : [];
        if (!Array.isArray(catalog)) throw new TypeError('Invalid shortcut definitions');
        const snapshot = await originalGet.call(adapter, catalog);
        applySnapshot(snapshot);
        lastError = null;
        return snapshot;
      } catch (error) {
        executionOpen = false;
        lastError = error instanceof Error ? error : new Error('Shortcut native request failed', { cause: error });
        unreadable();
        throw lastError;
      }
    });
    tail = operation.then(() => {}, () => {});
    // Preserve rejection for callers, but ignored adapter requests must not be unhandled.
    operation.catch(() => {});
    return operation;
  };
  const facade = Object.create(adapter);
  const get = function (...args) {
    if (detached()) return originalGet.apply(adapter, args);
    return enqueue();
  };
  Object.defineProperty(facade, 'get', { value: get, writable: true, configurable: true, enumerable: true });
  adapterSlot.wrapper = facade;
  const restore = () => {
    let failure;
    for (const entry of [...patches].reverse()) {
      try {
        const current = Object.getOwnPropertyDescriptor(entry.target, entry.key);
        if (!current || current.value !== entry.wrapper) continue;
        // Keep later changes to the adapter facade as well as later property replacements.
        if (entry === adapterSlot && (Reflect.ownKeys(facade).length !== 1 || Object.getOwnPropertyDescriptor(facade, 'get')?.value !== get)) continue;
        const restored = entry.own
          ? Reflect.defineProperty(entry.target, entry.key, entry.own)
          : Reflect.deleteProperty(entry.target, entry.key);
        if (!restored) throw new Error(`Could not restore shortcut field: ${entry.key}`);
      } catch (error) { failure ??= error; }
    }
    return failure;
  };
  try {
    for (const entry of patches) {
      const descriptor = entry.own ? { ...entry.own, value: entry.wrapper }
        : { value: entry.wrapper, writable: true, configurable: true, enumerable: false };
      if (!Reflect.defineProperty(entry.target, entry.key, descriptor) || Object.getOwnPropertyDescriptor(entry.target, entry.key)?.value !== entry.wrapper) {
        throw new Error(`Could not install shortcut field: ${entry.key}`);
      }
    }
  } catch {
    mode = 'disposed';
    restore();
    return unsupported();
  }

  return Object.freeze({
    supported: true,
    setLocal(enabled) {
      if (mode !== 'live' || typeof enabled !== 'boolean' || !service.active) return Promise.resolve(false);
      executionOpen = false;
      desiredLocal = enabled;
      const request = ++generation;
      const faults = observerFaults;
      resetFixed();
      const resetSucceeded = faults === observerFaults;
      const result = enqueue().then(() => {
        if (mode !== 'live' || request !== generation || !service.active || lastError !== null || !resetSucceeded) return false;
        executionOpen = enabled;
        return true;
      }, () => false);
      result.catch(() => {});
      return result;
    },
    dispose() {
      if (disposal) return disposal;
      let resolveDisposal, rejectDisposal;
      disposal = new Promise((resolve, reject) => { resolveDisposal = resolve; rejectDisposal = reject; });
      disposal.catch(() => {});
      mode = 'disposing';
      generation += 1;
      desiredLocal = true;
      executionOpen = false;
      resetFixed();
      enqueue();
      const drain = async () => {
        // Applying a snapshot can synchronously register another command and append a request.
        let observed;
        do { observed = tail; await observed; } while (observed !== tail);
        const error = lastError;
        mode = 'disposed';
        const restoreError = restore();
        if (error || restoreError) throw error ?? restoreError;
      };
      drain().then(resolveDisposal, rejectDisposal);
      return disposal;
    },
  });
}
