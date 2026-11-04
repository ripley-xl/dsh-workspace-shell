import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const react = {
  createElement(type, props, ...children) { return { type, props: props ?? {}, children }; },
  useCallback(value) { return value; },
  useEffect() {},
  useMemo(value) { return value(); },
  useRef(value) { return { current: value }; },
  useState(value) { return [value, () => {}]; },
};

export async function loadClient(path) {
  const source = await readFile(new URL(path, import.meta.url), 'utf8');
  let definition;
  const context = vm.createContext({
    window: { __ModuleLoader__: { load(value) { definition = value; } } },
    URL, Set, Map, Promise, JSON, Object, Array, Number, String, Boolean, Error, RegExp, Math,
  });
  vm.runInContext(source, context, { filename: path });
  if (!definition) throw new Error(`Client module did not register: ${path}`);
  return definition.factory((id) => {
    if (id === 'react') return react;
    throw new Error(`Unexpected Client dependency: ${id}`);
  });
}

export function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

export function errorShape(error) {
  return { code: error.code, phase: error.phase, hint: error.hint, requestId: error.requestId, message: error.message };
}

export function registrationContext() {
  const locales = [];
  const slots = [];
  const ctx = {
    locale: {
      register(...args) { locales.push(args); return () => {}; },
      bind() { return (key) => key; },
    },
    slots: {
      inject(_owner, callback) { callback(); },
      register(options, component) { slots.push({ options, component }); return () => {}; },
    },
    effect(callback) { return callback(); },
  };
  return { ctx, locales, slots };
}
