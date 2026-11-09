export const TUI_FLAVORS = Object.freeze({
  DSH: 'dsh-tui',
  PI: 'pi-tui',
  GENERIC: 'generic-tui',
});

const ADAPTERS = [
  {
    flavor: TUI_FLAVORS.DSH,
    packageName: '@deepseek-harness-tui/dsh-tui',
    defaultVersion: '0.18.0',
  },
  {
    flavor: TUI_FLAVORS.PI,
    packageName: '@xmoon76/dsh-pi-tui',
    defaultVersion: '0.5.5',
  },
];
const GENERIC_ADAPTER = Object.freeze({ flavor: TUI_FLAVORS.GENERIC, packageName: null });

function declarationName(value) {
  return typeof value === 'string' ? value : value?.name ?? value?.package ?? value?.spec;
}

function withoutVersion(value) {
  const index = value.lastIndexOf('@');
  return index > 0 ? value.slice(0, index) : value;
}

function hasTuiName(spec) {
  return typeof spec === 'string' && /tui/i.test(withoutVersion(spec));
}

export function tuiPackageName(spec) {
  if (typeof spec !== 'string') return null;
  for (const adapter of ADAPTERS) {
    if (spec === adapter.packageName || spec.startsWith(`${adapter.packageName}@`)) return adapter.packageName;
  }
  return null;
}

export function readTuiDeclaration(manifest) {
  const declared = manifest?.dsh?.profile?.bundles;
  const values = Array.isArray(declared) ? declared : declared && typeof declared === 'object' ? Object.keys(declared) : [];
  const flavors = new Set();
  let generic = false;
  for (const value of values) {
    const spec = declarationName(value);
    const packageName = tuiPackageName(spec);
    const adapter = ADAPTERS.find((item) => item.packageName === packageName);
    if (adapter) flavors.add(adapter.flavor);
    else if (hasTuiName(spec)) generic = true;
  }
  return {
    tui: flavors.size > 0 || generic,
    tuiFlavor: flavors.size === 1 ? [...flavors][0] : flavors.size === 0 && generic ? TUI_FLAVORS.GENERIC : null,
    tuiConflict: flavors.size > 1,
  };
}

export function tuiAdapter(flavor) {
  return flavor === TUI_FLAVORS.GENERIC ? GENERIC_ADAPTER : ADAPTERS.find((item) => item.flavor === flavor);
}

export function tuiEnvironment(flavor, { home, cwd }) {
  if (flavor === TUI_FLAVORS.PI || flavor === TUI_FLAVORS.GENERIC) {
    return { DSH_HOME: home };
  }
  if (flavor === TUI_FLAVORS.DSH) {
    return {
      DSH_HOME: home,
      DSH_TUI_BACKEND: 'dsh',
      DSH_TUI_WORKSPACE_TARGET: cwd,
      DSH_TUI_DISABLE_TERMINAL_IMAGES: '1',
      DSH_TUI_DISABLE_EXTENDED_KEYS: '1',
    };
  }
  throw new RangeError('Unknown TUI flavor.');
}
