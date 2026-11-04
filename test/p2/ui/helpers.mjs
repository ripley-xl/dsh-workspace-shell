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

async function loadClient(path) {
  const source = await readFile(new URL(path, import.meta.url), 'utf8');
  let definition;
  const context = vm.createContext({
    window: { __ModuleLoader__: { load(value) { definition = value; } } },
    URL, Set, Map, Promise, JSON, Object, Array, Number, String, Boolean, Error, RegExp, Math,
  });
  vm.runInContext(source, context, { filename: path });
  return definition.factory((id) => {
    if (id === 'react') return react;
    throw new Error(`Unexpected Client dependency: ${id}`);
  });
}

export function loadStatusClient() {
  return loadClient('../../../packages/shell/ssh-remote/plugins/status/client.js');
}

export function plain(value) {
  return JSON.parse(JSON.stringify(value));
}
