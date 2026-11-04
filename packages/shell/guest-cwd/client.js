window.__ModuleLoader__.load({
  id: '@local/dsh-workspace-shell-guest-cwd',
  factory() {
    const GLOBAL_KEY = '__workspaceShellGuestCwd';
    const REQUEST_TYPE = 'workspace-shell-cwd-request';
    const RESPONSE_TYPE = 'workspace-shell-cwd-response';
    const VERSION = 1;
    const PARENT_ORIGIN_PARAM = 'workspaceShellParentOrigin';
    const ORIGIN_PATTERN = /^[a-z][a-z0-9+.-]{1,31}:\/\/[^\s/?#@]{1,255}$/;
    const REQUEST_ID = /^[A-Za-z0-9_-]{16,128}$/;

    // A serialized origin is accepted only when it is a bare scheme://host[:port].
    function validOrigin(value) {
      return typeof value === 'string' && ORIGIN_PATTERN.test(value);
    }

    // Only this exact parameter is read; the rest of the URL never leaves the guest.
    function declaredParentOrigin() {
      try {
        const search = window.location.search;
        if (typeof search !== 'string' || search.length === 0 || search.length > 8192) return null;
        const value = new URLSearchParams(search).get(PARENT_ORIGIN_PARAM);
        return validOrigin(value) ? value : null;
      } catch {
        return null;
      }
    }

    function embedded() {
      try {
        return window.parent !== window;
      } catch {
        return false;
      }
    }

    function apply(ctx) {
      const read = () => {
        try {
          const snapshot = ctx.sessions.list.getSnapshot();
          const rows = Object.values(snapshot.byId).filter((row) => {
            const count = row?.retainedBy?.mainView;
            return typeof count === 'number' && Number.isFinite(count) && count > 0;
          });
          if (rows.length !== 1) return null;
          const value = rows[0].projectionValues?.workingDirectory;
          return typeof value === 'string' || value === null ? value : null;
        } catch {
          return null;
        }
      };

      let expectedOrigin = embedded() ? declaredParentOrigin() : null;
      let installed = false;
      let listening = false;

      // Answers only the embedding parent, and only on the origin it declared in the URL.
      const onMessage = (event) => {
        try {
          if (!listening) return;
          if (event.source !== window.parent) return;
          if (expectedOrigin && event.origin !== expectedOrigin) return;
          if (!expectedOrigin) {
            if (!validOrigin(event.origin)) return;
            expectedOrigin = event.origin;
          }
          const data = event.data;
          if (!data || typeof data !== 'object' || Array.isArray(data)) return;
          if (data.type !== REQUEST_TYPE || data.version !== VERSION) return;
          if (typeof data.requestId !== 'string' || !REQUEST_ID.test(data.requestId)) return;
          const value = read();
          window.parent.postMessage({
            type: RESPONSE_TYPE,
            version: VERSION,
            requestId: data.requestId,
            cwd: typeof value === 'string' ? value : null,
          }, expectedOrigin);
        } catch {
          // Unanswered requests expire on the parent side; nothing is retried or logged.
        }
      };
      const stopListening = () => {
        if (!listening) return;
        listening = false;
        try {
          window.removeEventListener('message', onMessage);
        } catch {
          // Cleanup still removes the scalar global.
        }
      };
      const cleanup = () => {
        if (!installed && !listening) return;
        installed = false;
        stopListening();
        try {
          const current = Object.getOwnPropertyDescriptor(window, GLOBAL_KEY);
          if (current?.value === read && current.configurable) Reflect.deleteProperty(window, GLOBAL_KEY);
        } catch {
          // Unloading never removes or throws through a foreign replacement.
        }
      };

      try {
        if (GLOBAL_KEY in window) return;
        Object.defineProperty(window, GLOBAL_KEY, {
          value: read,
          writable: false,
          configurable: true,
          enumerable: false,
        });
        installed = Object.getOwnPropertyDescriptor(window, GLOBAL_KEY)?.value === read;
      } catch {
        installed = false;
      }
      if (!installed) return;

      // The scalar global stays for existing consumers; the message channel is additional.
      if (embedded()) {
        try {
          window.addEventListener('message', onMessage);
          listening = true;
        } catch {
          listening = false;
        }
      }

      try {
        ctx.effect(() => cleanup, 'workspace shell Guest cwd scalar');
      } catch {
        cleanup();
      }
    }

    return { inject: ['sessions'], apply };
  },
});
