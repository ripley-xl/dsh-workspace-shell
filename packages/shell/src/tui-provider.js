// Parent owns Host RPC and runtime identity; the iframe receives only terminal messages.
export function createTuiProvider({ document, window, api, ownerId, locale = 'zh' }) {
  if (typeof api !== 'function' || typeof ownerId !== 'string' || !ownerId) throw new TypeError('Invalid TUI provider options');
  const origin = window.location.protocol === 'dsh-app:'
    ? window.location.protocol + '//' + window.location.host : window.location.origin;
  if (!origin || origin === 'null') throw new TypeError('A same-origin terminal document is required');
  const ignore = () => {};
  const safely = (fn) => {
    try {
      const result = fn();
      if (result && typeof result.then === 'function') Promise.resolve(result).catch(ignore);
      return result;
    } catch {}
  };
  const dimensions = (value) => value && Number.isInteger(value.cols) && value.cols > 0 && value.cols <= 1000
    && Number.isInteger(value.rows) && value.rows > 0 && value.rows <= 500
    ? { cols: value.cols, rows: value.rows } : null;
  const sameSize = (a, b) => a && b && a.cols === b.cols && a.rows === b.rows;
  const startupCode = (cause) => {
    const code = typeof cause === 'string' ? cause : cause?.code;
    return [
      'TUI_PROFILE_CONFLICT', 'PROFILE_HOST_CONFLICT', 'TUI_NOT_INSTALLED', 'VERSION_MISMATCH',
      'TUI_CONFIRM_REQUIRED', 'TUI_INVALID_SPEC', 'TUI_OPEN_FAILED', 'OPERATION_CANCELLED',
    ].includes(code) ? code : 'TUI_OPEN_FAILED';
  };
  function* splitInput(data) {
    let part = '';
    let bytes = 0;
    for (const character of data) {
      const point = character.codePointAt(0);
      const size = point <= 127 ? 1 : point <= 2047 ? 2 : point <= 65535 ? 3 : 4;
      if (bytes + size > 65536) { yield part; part = ''; bytes = 0; }
      part += character;
      bytes += size;
    }
    if (part) yield part;
  }

  return Object.freeze({
    open(spec, { container, signal, onReady, onError, onExit }) {
      if (spec?.confirmIndependentHost !== true) throw Object.assign(new Error('TUI_CONFIRM_REQUIRED'), { code: 'TUI_CONFIRM_REQUIRED' });
      if (typeof spec.profileId !== 'string' || !spec.profileId || !container) throw Object.assign(new Error('TUI_INVALID_SPEC'), { code: 'TUI_INVALID_SPEC' });
      const cancellation = new (window.AbortController || AbortController)();
      const iframe = document.createElement('iframe');
      let port;
      let transferredPort;
      let connected = false;
      let closed = false;
      let visible = true;
      let started = false;
      let ready = false;
      let running = false;
      let ended = false;
      let exitNotified = false;
      let runtimeId;
      let startup = Promise.resolve();
      let disposal;
      let timer;
      let reading = false;
      let awaitingAck;
      let cursor = 0;
      let outputId = 0;
      let desiredSize;
      let appliedSize;
      let resizing = false;
      let writing = false;
      const inputQueue = [];
      const stops = new Map();
      const stop = (id) => {
        if (!stops.has(id)) stops.set(id, Promise.resolve().then(() => api('/runtime/stop', { runtimeId: id, ownerId })).catch(ignore));
        return stops.get(id);
      };
      const clearTimer = () => {
        if (timer !== undefined) safely(() => window.clearTimeout(timer));
        timer = undefined;
      };
      const dispose = () => {
        if (disposal) return disposal;
        let done;
        disposal = new Promise((resolve) => { done = resolve; });
        closed = true;
        running = false;
        inputQueue.length = 0;
        awaitingAck = undefined;
        clearTimer();
        safely(() => cancellation.abort());
        safely(() => signal?.removeEventListener('abort', dispose));
        safely(() => iframe.removeEventListener('load', load));
        safely(() => port?.postMessage({ type: 'dispose' }));
        safely(() => { if (port) port.onmessage = null; });
        safely(() => port?.close());
        safely(() => transferredPort?.close());
        safely(() => iframe.remove());
        safely(() => { if (iframe.parentNode) iframe.parentNode.removeChild(iframe); });
        // Startup may ignore cancellation and return an ID after the surface has gone away.
        Promise.resolve(startup).catch(ignore).then(() => runtimeId ? stop(runtimeId) : undefined).then(done, done);
        return disposal;
      };
      const fail = (code) => {
        if (closed) return;
        dispose();
        safely(() => onError?.(code));
      };
      const send = (message) => {
        if (closed || !port) return false;
        try { port.postMessage(message); return true; } catch { fail('TUI_CHANNEL_FAILED'); return false; }
      };
      const scheduleRead = () => {
        clearTimer();
        if (!closed && running && !awaitingAck) timer = window.setTimeout(() => { timer = undefined; read(); }, visible ? 80 : 500);
      };
      const finishBatch = (message) => {
        if (closed || !awaitingAck || message.id !== awaitingAck.id) return;
        const batch = awaitingAck;
        awaitingAck = undefined;
        cursor = batch.nextSeq;
        if (batch.phase === 'exited' || batch.phase === 'error') {
          ended = true;
          running = false;
          inputQueue.length = 0;
          send({ type: 'exit', phase: batch.phase, ...(Number.isInteger(batch.exit?.exitCode) ? { code: batch.exit.exitCode } : {}) });
        }
        if (!ready) {
          ready = true;
          send({ type: 'ready' });
          if (!closed) safely(() => onReady?.());
        }
        if (!closed && !exitNotified && batch.phase === 'exited' && batch.exit?.exitCode === 0) {
          exitNotified = true;
          safely(() => onExit?.());
        }
        scheduleRead();
      };
      const read = async () => {
        if (closed || !running || reading || awaitingAck) return;
        reading = true;
        try {
          const result = await api('/terminal/read', { runtimeId, ownerId, afterSeq: cursor }, cancellation.signal);
          if (closed) return;
          if (!Array.isArray(result?.chunks) || result.chunks.length > 65536 || !Number.isSafeInteger(result.nextSeq) || result.nextSeq < cursor) throw new Error('Invalid output');
          let previous = cursor;
          let data = '';
          for (const chunk of result.chunks) {
            if (!Number.isSafeInteger(chunk.seq) || chunk.seq <= previous || chunk.seq > result.nextSeq || typeof chunk.data !== 'string') throw new Error('Invalid output');
            previous = chunk.seq;
            data += chunk.data;
          }
          if (new TextEncoder().encode(data).byteLength > 1048576) throw new Error('Output exceeds ring capacity');
          awaitingAck = { id: ++outputId, nextSeq: result.nextSeq, phase: result.phase, exit: result.exit };
          if (result.loss === true) send({ type: 'loss' });
          send({ type: 'output', id: outputId, data });
        } catch { if (!closed) fail('TUI_READ_FAILED'); }
        finally { reading = false; }
      };
      const resizeRuntime = async () => {
        if (resizing) return;
        resizing = true;
        try {
          while (!closed && running && visible && desiredSize && !sameSize(desiredSize, appliedSize)) {
            const size = desiredSize;
            await api('/terminal/resize', { runtimeId, ownerId, ...size }, cancellation.signal);
            appliedSize = size;
          }
        } catch { if (!closed) fail('TUI_RESIZE_FAILED'); }
        finally { resizing = false; }
      };
      const write = async () => {
        if (writing) return;
        writing = true;
        try {
          while (!closed && running && ready && visible && inputQueue.length) {
            const data = inputQueue.shift();
            await api('/terminal/write', { runtimeId, ownerId, data }, cancellation.signal);
          }
        } catch { if (!closed) fail('TUI_WRITE_FAILED'); }
        finally { writing = false; }
      };
      const begin = (size) => {
        if (closed || started) return;
        started = true;
        desiredSize = size;
        appliedSize = size;
        startup = Promise.resolve().then(async () => {
          if (closed) return;
          // The launcher may supply a parsed, bounded command string. It travels as a
          // single opaque field; the Host parses it into argv and never uses a shell.
          const command = typeof spec.command === 'string' && spec.command.trim().length > 0 && spec.command.length <= 4096
            && !/[\0\r\n]/u.test(spec.command) ? spec.command : undefined;
          const result = await api('/tui/open', { profileId: spec.profileId, ownerId, cwd: spec.cwd, ...size, confirmIndependentHost: true, ...(command ? { command } : {}) }, cancellation.signal);
          if (typeof result?.runtimeId !== 'string' || !result.runtimeId) throw new Error('Invalid runtime');
          runtimeId = result.runtimeId;
          if (closed) { await stop(runtimeId); return; }
          running = true;
          resizeRuntime();
          read();
        }).catch((cause) => { if (!closed) fail(startupCode(cause)); });
      };
      const receive = (event) => {
        if (closed || !event.data || typeof event.data !== 'object') return;
        const message = event.data;
        if (message.type === 'ready') { const size = dimensions(message); if (size) begin(size); }
        else if (message.type === 'ack') finishBatch(message);
        else if (message.type === 'input' && ready && running && visible && typeof message.data === 'string') {
          for (const part of splitInput(message.data)) inputQueue.push(part);
          write();
        } else if (message.type === 'resize' && visible) {
          const size = dimensions(message);
          if (size) { desiredSize = size; resizeRuntime(); }
        } else if (message.type === 'error') fail('TUI_DOCUMENT_FAILED');
      };
      const load = () => {
        if (closed || connected) return;
        connected = true;
        try {
          const channel = new window.MessageChannel();
          port = channel.port1;
          transferredPort = channel.port2;
          port.onmessage = receive;
          port.start();
          iframe.contentWindow.postMessage({ type: 'workspace-shell-terminal-init', version: 1, locale: locale === 'en' ? 'en' : 'zh' }, origin, [transferredPort]);
          transferredPort = undefined; // Ownership moved to the child document.
          send({ type: 'visible', value: visible });
        } catch { fail('TUI_DOCUMENT_FAILED'); }
      };
      const handle = Object.freeze({
        dispose,
        setVisible(value) {
          if (closed) return;
          visible = !!value;
          safely(() => { iframe.style.display = visible ? 'block' : 'none'; });
          if (!visible) inputQueue.length = 0;
          send({ type: 'visible', value: visible });
          if (visible) resizeRuntime();
          if (ready && !reading && !awaitingAck) scheduleRead();
        },
        focus() { if (!closed && visible && ready && !ended) send({ type: 'focus' }); },
        resize() { if (!closed && visible) send({ type: 'resize' }); },
      });
      try {
        iframe.src = '/api/workspace-shell/terminal';
        iframe.title = locale === 'en' ? 'Terminal' : '终端';
        iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin');
        Object.assign(iframe.style, { width: '100%', height: '100%', border: '0', display: 'block' });
        iframe.addEventListener('load', load);
        signal?.addEventListener('abort', dispose, { once: true });
        if (signal?.aborted) dispose();
        else container.appendChild(iframe);
      } catch { fail('TUI_DOCUMENT_FAILED'); }
      // Return the surface handle immediately, while real readiness remains callback-driven.
      return handle;
    },
  });
}
