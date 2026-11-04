import { isAbsolute } from 'node:path';

const TOOL_NAME = 'workspace_runtime';
const OPERATIONS = ['list', 'start_web', 'start_tui', 'stop'];
const IMPACTFUL_OPERATIONS = new Set(['start_web', 'start_tui', 'stop']);
const INPUT_FIELDS = new Set(['operation', 'profile', 'cwd', 'id', 'cols', 'rows']);
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SAFE_ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/u;
const MAX_CATALOG_ITEMS = 128;
const MAX_PATH_LENGTH = 4096;
const TAB_HINT = 'Select this profile from the workspace tab strip. This tool does not open a GUI tab.';

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    status: { type: 'string', required: true, enum: ['ok', 'started', 'stopped', 'error'] },
    operation: { type: 'string', enum: OPERATIONS },
    code: { type: 'string' },
    id: { type: 'string' },
    profile: { type: 'string' },
    hint: { type: 'string' },
    currentProfile: { type: 'string' },
    defaultCwd: { type: 'string' },
    canStop: { type: 'boolean' },
    truncated: { type: 'boolean' },
    profiles: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          isCurrent: { type: 'boolean', required: true },
          web: { type: 'boolean', required: true },
          tui: { type: 'boolean', required: true },
        },
      },
    },
    runtimes: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          kind: { type: 'string', required: true, enum: ['web', 'tui'] },
          profileId: { type: 'string', required: true },
          phase: { type: 'string', required: true, enum: ['starting', 'running', 'stopping', 'exited', 'failed'] },
          canStop: { type: 'boolean' },
        },
      },
    },
  },
};

function identifier(value) {
  return typeof value === 'string' && IDENTIFIER.test(value) && value !== '.' && value !== '..';
}

function safePath(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_PATH_LENGTH
    && isAbsolute(value) && !/[\0\r\n]/u.test(value);
}

function errorResult(code) {
  return { status: 'error', code };
}

function safeError(error) {
  const code = error?.safe === true && typeof error?.code === 'string' && SAFE_ERROR_CODE.test(error.code)
    ? error.code
    : 'RUNTIME_OPERATION_FAILED';
  return errorResult(code);
}

function invalidUnless(value, condition) {
  return value === undefined || condition ? null : 'INVALID_INPUT';
}

function normalizeInput(args) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return { error: 'INVALID_INPUT' };
  for (const key of Object.keys(args)) if (!INPUT_FIELDS.has(key)) return { error: 'INVALID_INPUT' };
  if (!OPERATIONS.includes(args.operation)) return { error: 'INVALID_INPUT' };
  const operation = args.operation;
  const neutral = { ...args };
  for (const key of ['profile', 'cwd', 'id']) if (neutral[key] === '') delete neutral[key];
  if (operation !== 'start_tui') {
    if (neutral.cols === 80) delete neutral.cols;
    if (neutral.rows === 24) delete neutral.rows;
  }
  args = neutral;
  if (operation === 'list') {
    for (const key of ['profile', 'cwd', 'id', 'cols', 'rows']) {
      const error = invalidUnless(args[key], false);
      if (error) return { error };
    }
    return { operation };
  }
  if (operation === 'stop') {
    if (!identifier(args.id)) return { error: 'INVALID_INPUT' };
    for (const key of ['profile', 'cwd', 'cols', 'rows']) {
      const error = invalidUnless(args[key], false);
      if (error) return { error };
    }
    return { operation, id: args.id };
  }
  if (!identifier(args.profile) || args.id !== undefined) return { error: 'INVALID_INPUT' };
  if (operation === 'start_web') {
    for (const key of ['cwd', 'cols', 'rows']) {
      const error = invalidUnless(args[key], false);
      if (error) return { error };
    }
    return { operation, profile: args.profile };
  }
  if (!safePath(args.cwd)) return { error: 'INVALID_INPUT' };
  const cols = args.cols ?? 80;
  const rows = args.rows ?? 24;
  if (!Number.isInteger(cols) || cols < 1 || cols > 1000 || !Number.isInteger(rows) || rows < 1 || rows > 500) {
    return { error: 'INVALID_INPUT' };
  }
  return { operation, profile: args.profile, cwd: args.cwd, cols, rows };
}

function publicProfile(value) {
  if (!identifier(value?.id)) return null;
  return {
    id: value.id,
    isCurrent: value.isCurrent === true,
    web: value.web === true,
    tui: value.tui === true,
  };
}

function publicRuntime(value) {
  const phases = ['starting', 'running', 'stopping', 'exited', 'failed'];
  if (!identifier(value?.id) || !identifier(value?.profileId) || !['web', 'tui'].includes(value?.kind) || !phases.includes(value?.phase)) return null;
  return {
    id: value.id,
    kind: value.kind,
    profileId: value.profileId,
    phase: value.phase,
    ...typeof value.canStop === 'boolean' ? { canStop: value.canStop } : {},
  };
}

function publicCatalog(value) {
  const rawProfiles = Array.isArray(value?.profiles) ? value.profiles : [];
  const rawRuntimes = Array.isArray(value?.runtimes) ? value.runtimes : [];
  const result = {
    status: 'ok',
    operation: 'list',
    profiles: rawProfiles.slice(0, MAX_CATALOG_ITEMS).map(publicProfile).filter(Boolean),
    runtimes: rawRuntimes.slice(0, MAX_CATALOG_ITEMS).map(publicRuntime).filter(Boolean),
  };
  if (identifier(value?.currentProfile)) result.currentProfile = value.currentProfile;
  if (safePath(value?.defaultCwd)) result.defaultCwd = value.defaultCwd;
  if (typeof value?.canStop === 'boolean') result.canStop = value.canStop;
  if (rawProfiles.length > MAX_CATALOG_ITEMS || rawRuntimes.length > MAX_CATALOG_ITEMS) result.truncated = true;
  return result;
}

function askReason(args) {
  const operation = args?.operation;
  if (operation === 'stop') {
    const id = identifier(args?.id) ? ` "${args.id}"` : '';
    return {
      reason: `Stop the owned runtime${id}. This interrupts all Agents and foreground or parked sessions in that runtime.`,
      displayReason: {
        en: `Stop the owned runtime${id}? This interrupts all Agents and foreground or parked sessions in that runtime.`,
        zh: `停止此 Agent 拥有的运行时${id}？这会中断该运行时的全部 Agent、前台会话和暂存会话。`,
      },
    };
  }
  const profile = identifier(args?.profile) ? args.profile : 'the requested profile';
  if (operation === 'start_tui') {
    return {
      reason: `Start a new TUI runtime for profile "${profile}". Existing TUI runtimes stay running; profile settings and DSH_HOME data may be shared.`,
      displayReason: {
        en: `Start a new TUI runtime for profile "${profile}"? Existing TUI runtimes stay running; profile settings and DSH_HOME data may be shared.`,
        zh: `为 profile“${profile}”新建独立 TUI 实例？现有 TUI 实例继续运行；profile 设置和 DSH_HOME 中的数据可能共享。`,
      },
    };
  }
  return {
    reason: `Start a Web Host for profile "${profile}". Confirm that no other Web or TUI Host process serves this profile.`,
    displayReason: {
      en: `Start a Web Host for profile "${profile}"? Confirm that no other Web or TUI Host process serves this profile. The tool cannot discover external Host processes.`,
      zh: `为 profile“${profile}”启动 Web Host？请确认该 profile 没有其它 Web 或 TUI Host 进程。工具无法发现外部 Host 进程。`,
    },
  };
}

async function candidateFor(service, ownerId, profile, operation) {
  const catalog = await service.catalog({ ownerId });
  if (catalog?.currentProfile === profile) return { error: 'CURRENT_PROFILE_USE_LOCAL' };
  const candidate = Array.isArray(catalog?.profiles) ? catalog.profiles.find((item) => item?.id === profile) : null;
  if (!candidate) return { error: 'PROFILE_NOT_FOUND' };
  if (operation === 'start_web' && candidate.web !== true) return { error: 'PROFILE_NOT_FOUND' };
  if (operation === 'start_tui' && candidate.tui !== true) return { error: 'TUI_NOT_INSTALLED' };
  return { catalog };
}

async function execute(service, input, exec) {
  if (!exec?.agent) throw new Error('workspace_runtime requires an agent Session');
  const args = normalizeInput(input);
  if (args.error) return errorResult(args.error);
  const ownerId = `agent-${exec.agent.id}`;
  try {
    if (args.operation === 'list') return publicCatalog(await service.catalog({ ownerId }));
    if (args.operation === 'stop') {
      await service.stop({ runtimeId: args.id, ownerId });
      return { status: 'stopped', operation: 'stop', id: args.id };
    }
    const { error } = await candidateFor(service, ownerId, args.profile, args.operation);
    if (error) return errorResult(error);
    if (args.operation === 'start_web') {
      const opened = await service.openWeb({
        profileId: args.profile,
        ownerId,
        confirmIndependentHost: true,
        signal: exec.signal,
      });
      if (!identifier(opened?.runtimeId)) return errorResult('INVALID_RUNTIME_RESULT');
      return { status: 'started', operation: 'start_web', id: opened.runtimeId, profile: args.profile, hint: TAB_HINT };
    }
    const opened = await service.openTui({
      profileId: args.profile,
      ownerId,
      cwd: args.cwd,
      cols: args.cols,
      rows: args.rows,
      confirmIndependentHost: true,
      signal: exec.signal,
    });
    if (!identifier(opened?.runtimeId)) return errorResult('INVALID_RUNTIME_RESULT');
    return { status: 'started', operation: 'start_tui', id: opened.runtimeId, profile: args.profile, hint: TAB_HINT };
  } catch (error) {
    return safeError(error);
  }
}

export function registerWorkspaceRuntimeTool(ctx, service, { defineTool } = {}) {
  if (typeof defineTool !== 'function') throw new TypeError('defineTool is required');
  let unregisterTool;
  let unregisterMiddleware;
  try {
    unregisterMiddleware = ctx.on('tools/pre-execute', async (exec, next) => {
      if (exec?.name !== TOOL_NAME) return next();
      const operation = exec.arguments?.operation;
      if (operation === 'list') return next();
      if (!IMPACTFUL_OPERATIONS.has(operation)) return { kind: 'deny', reason: 'INVALID_INPUT' };
      return { kind: 'ask', ...askReason(exec.arguments) };
    });
    unregisterTool = ctx.tools.register(defineTool({
      name: TOOL_NAME,
      description: 'List or manage only plugin-owned local Host runtimes. Web Hosts are exclusive per profile. Each TUI start creates an independent PTY and may share profile settings and DSH_HOME data. Stopping an owned TUI runtime interrupts all its Agents and foreground or parked sessions. This tool never installs a TUI, runs arbitrary commands, returns terminal output, or opens a GUI tab.',
      parameters: {
        operation: { type: 'string', required: true, enum: OPERATIONS, description: 'list reads the catalog; start_web/start_tui prepare a Host runtime; stop terminates an owned runtime.' },
        profile: { type: 'string', description: 'Used for start_web/start_tui: an existing prepared profile id, not the current profile. Leave blank for list and stop.' },
        cwd: { type: 'string', description: 'Required for start_tui: an absolute working directory for this independent runtime. Not accepted for list, stop, or start_web.' },
        id: { type: 'string', description: 'Used for stop: a plugin-owned runtime id returned by list or a start operation. Leave blank for other operations.' },
        cols: { type: 'integer', description: 'Used for start_tui: terminal columns from 1 to 1000. Keep the default 80 for other operations.' },
        rows: { type: 'integer', description: 'Used for start_tui: terminal rows from 1 to 500. Keep the default 24 for other operations.' },
      },
      isConcurrencySafe: (args) => args?.operation === 'list',
      output: {
        schema: OUTPUT_SCHEMA,
        render: (_args, value) => [{
          type: 'text',
          text: value.status === 'error' ? `workspace_runtime failed: ${value.code ?? 'RUNTIME_OPERATION_FAILED'}` : JSON.stringify(value),
        }],
      },
      execute: (args, exec) => execute(service, args, exec),
    }));
  } catch (error) {
    unregisterTool?.();
    unregisterMiddleware?.();
    throw error;
  }
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    try {
      unregisterTool?.();
    } finally {
      unregisterMiddleware?.();
    }
  };
}
