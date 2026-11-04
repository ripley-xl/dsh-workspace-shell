// This document has no Host transport or runtime identifiers.
export function startTerminalDocument(window, document) {
  const origin = window.location.protocol === 'dsh-app:'
    ? window.location.protocol + '//' + window.location.host : window.location.origin;
  const safely = (fn) => {
    try {
      const result = fn();
      if (result && typeof result.then === 'function') Promise.resolve(result).catch(() => {});
      return result;
    } catch {}
  };
  let accepted = false;
  let closed = false;
  let port;
  let terminal;
  let addon;
  let observer;
  let dataSubscription;
  let frame;
  let visible = true;
  let initialized = false;
  let ready = false;
  let ended = false;
  let gap = false;
  let exitPhase;
  let exitCode;
  let english = false;
  let terminalElement;
  let statusElement;
  let lastSize;
  let writing = false;
  let lastOutput = 0;
  const send = (message) => {
    if (closed || !port) return;
    try { port.postMessage(message); } catch { dispose(); }
  };
  const status = () => {
    if (!statusElement) return;
    let text;
    if (ended) {
      text = exitPhase === 'error' ? (english ? 'Process failed.' : '进程异常退出。') : (english ? 'Process exited.' : '进程已退出。');
      if (Number.isInteger(exitCode)) text += ' (' + exitCode + ')';
    } else text = ready ? (english ? 'Connected' : '已连接') : (english ? 'Connecting…' : '正在连接…');
    if (gap) text += english ? ' Output was lost; resize the terminal to refresh.' : ' 部分输出已丢失；请调整窗口大小刷新。';
    statusElement.textContent = text;
  };
  const stdin = () => {
    if (terminal) safely(() => { terminal.options.disableStdin = !visible || !ready || ended; });
  };
  const dispose = () => {
    if (closed) return;
    closed = true;
    safely(() => window.removeEventListener('message', initialize));
    safely(() => window.removeEventListener('pagehide', dispose));
    if (frame !== undefined) safely(() => window.cancelAnimationFrame(frame));
    frame = undefined;
    safely(() => observer?.disconnect());
    safely(() => dataSubscription?.dispose());
    safely(() => terminal?.dispose());
    safely(() => { if (port) port.onmessage = null; });
    safely(() => port?.close());
  };
  const fail = (code) => { send({ type: 'error', code }); dispose(); };
  const size = () => {
    const cols = Math.min(1000, Math.floor(terminal.cols));
    const rows = Math.min(500, Math.floor(terminal.rows));
    return cols > 0 && rows > 0 ? { cols, rows } : null;
  };
  const fit = () => {
    frame = undefined;
    if (closed || !terminal || (initialized && !visible)) return;
    try {
      const rect = terminalElement.getBoundingClientRect();
      const positive = rect.width > 0 && rect.height > 0;
      if (positive) addon.fit();
      if (initialized && !positive) return;
      const next = size();
      if (!next) return;
      if (terminal.cols !== next.cols || terminal.rows !== next.rows) terminal.resize(next.cols, next.rows);
      if (!initialized) {
        initialized = true;
        lastSize = next;
        send({ type: 'ready', ...next });
      } else if (visible && (!lastSize || lastSize.cols !== next.cols || lastSize.rows !== next.rows)) {
        lastSize = next;
        send({ type: 'resize', ...next });
      }
    } catch { fail('TUI_FIT_FAILED'); }
  };
  const requestFit = () => {
    if (!closed && frame === undefined && (!initialized || visible)) frame = window.requestAnimationFrame(fit);
  };
  const input = (data) => {
    if (closed || !visible || !ready || ended || typeof data !== 'string') return;
    let part = '';
    let bytes = 0;
    for (const character of data) {
      const point = character.codePointAt(0);
      const count = point <= 127 ? 1 : point <= 2047 ? 2 : point <= 65535 ? 3 : 4;
      if (bytes + count > 65536) { send({ type: 'input', data: part }); part = ''; bytes = 0; }
      part += character;
      bytes += count;
    }
    if (part) send({ type: 'input', data: part });
  };
  const receive = (event) => {
    if (closed || !event.data || typeof event.data !== 'object') return;
    const message = event.data;
    if (message.type === 'output') {
      if (writing || !Number.isSafeInteger(message.id) || message.id <= lastOutput || typeof message.data !== 'string') return;
      writing = true;
      try {
        terminal.write(message.data, () => {
          writing = false;
          if (closed) return;
          lastOutput = message.id;
          send({ type: 'ack', id: message.id });
        });
      } catch { fail('TUI_OUTPUT_FAILED'); }
    } else if (message.type === 'loss') {
      gap = true;
      safely(() => terminal.reset());
      status();
    } else if (message.type === 'visible') {
      visible = message.value === true;
      stdin();
      if (visible) requestFit();
    } else if (message.type === 'ready') {
      ready = true;
      stdin();
      status();
    } else if (message.type === 'exit') {
      ended = true;
      exitPhase = message.phase === 'error' ? 'error' : 'exited';
      exitCode = Number.isInteger(message.code) ? message.code : undefined;
      stdin();
      status();
    } else if (message.type === 'focus') {
      if (visible && ready && !ended) safely(() => terminal.focus());
    } else if (message.type === 'resize') {
      if (visible) requestFit();
    } else if (message.type === 'dispose') dispose();
  };
  const initialize = (event) => {
    if (closed || accepted || !origin || origin === 'null' || event.source !== window.parent || event.origin !== origin
      || event.data?.type !== 'workspace-shell-terminal-init' || event.data.version !== 1 || !event.ports?.[0]) return;
    accepted = true;
    port = event.ports[0];
    english = event.data.locale === 'en';
    try {
      terminalElement = document.getElementById('terminal');
      statusElement = document.getElementById('status');
      if (!terminalElement || !statusElement) throw new Error('Missing terminal elements');
      terminal = new window.Terminal({
        cols: 80, rows: 24, disableStdin: true, scrollback: 5000, fontSize: 13,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        theme: { background: '#10141c', foreground: '#e6e9ef', cursor: '#e6e9ef' },
      });
      addon = new window.FitAddon.FitAddon();
      terminal.loadAddon(addon);
      terminal.open(terminalElement);
      dataSubscription = terminal.onData(input);
      port.onmessage = receive;
      port.start();
      observer = new window.ResizeObserver(requestFit);
      observer.observe(terminalElement);
      status();
      const rect = terminalElement.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) fit();
      else {
        // Hidden iframes can suspend rAF; report the positive initial grid without fitting.
        if (frame !== undefined) window.cancelAnimationFrame(frame);
        fit();
      }
    } catch { fail('TUI_TERMINAL_INIT_FAILED'); }
  };
  window.addEventListener('message', initialize);
  window.addEventListener('pagehide', dispose);
  return Object.freeze({ dispose });
}
