// Guest-side Client entry. A guest Web Host runs only this plugin: it registers
// its Session view for cross-Host navigation, answers the cwd question, and
// reports notification transitions to the framing Shell. It never mounts a
// frame, a tab strip, or Host management.
export function createGuestPlugin(React, deps) {
  const sessions = typeof deps.createSessionHostPlugin === 'function'
    ? deps.createSessionHostPlugin(React, deps.primitives, deps)
    : null;
  return {
    inject: [...new Set(['slots', 'locale', 'layout', 'sessions', 'uiWorkspace', 'uiSession', ...(sessions?.inject ?? [])])],
    apply(ctx) {
      sessions?.apply(ctx);
      installGuestCwd(ctx, deps.window);
      installClipboardFallback(deps.window, deps.document);
      // The framing Shell owns the restart entry (a workspace tab menu item);
      // this page only answers its command and reloads once the Host is back.
      const restart = createHostRestartControl({ window: deps.window, document: deps.document });
      try {
        restart.apply(ctx);
      } catch {
        restart.dispose();
      }
      const bridge = createGuestNotificationBridge({ window: deps.window, ctx });
      try {
        ctx.effect(() => () => bridge.dispose(), 'workspace guest notifications');
      } catch {
        bridge.dispose();
      }
    },
  };
}
