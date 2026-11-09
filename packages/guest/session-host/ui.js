export const sessionHostCss = `
.wsh-session-notice{display:flex;align-items:center;flex-wrap:wrap;gap:8px;width:calc(100% - var(--dsh-composer-side-clearance,16px) - var(--dsh-composer-side-clearance,16px));max-width:var(--dsh-composer-card-max-width,760px);margin:0 auto;box-sizing:border-box;padding:8px 0;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px;letter-spacing:0}
.wsh-session-notice>span{flex:1 1 180px;min-width:0;overflow-wrap:anywhere}
.wsh-session-actions{display:flex;gap:8px;flex:none;margin-left:auto}
.wsh-session-notice button{font:inherit;color:inherit;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:transparent;cursor:pointer;min-height:28px;padding:2px 8px;display:inline-flex;align-items:center;justify-content:center;gap:4px;flex:none}
.wsh-session-notice button[data-icon]{width:28px;padding:0;border-color:transparent}
.wsh-session-notice button:disabled{opacity:.5;cursor:default}
.wsh-session-notice button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.wsh-session-notice button:focus-visible{outline:2px solid var(--dsw-focus-ring-color);outline-offset:2px}
`;

export function createSessionHostPlugin(React, primitives, deps) {
  const h = React.createElement;
  return {
    inject: ['slots', 'sessions', 'uiWorkspace', 'layout', 'locale', 'conversation'],
    apply(ctx) {
      const subscribeLocale = (listener) => ctx.locale.subscribe(listener);
      const getLocale = () => ctx.locale.getSnapshot();
      const client = deps.createSessionHostClient({ ctx, window: deps.window, applyDraft: deps.applyTransferredDraft });
      ctx.effect(() => () => client.dispose(), 'workspace session navigation');
      ctx.effect(() => deps.observeSessionSubmissions(ctx.sessions, { failed: client.failed, succeeded: client.dismiss }), 'workspace send failures');
      ctx.provide('workspaceSessionNavigation', { context: client.context });
      ctx.inject(['workspaceShell'], (scope) => {
        scope.effect(() => scope.workspaceShell.registerSessionNavigation({ context: client.context }), 'workspace session registration');
      });
      function Notice({ sessionId, session, useSession }) {
        const snapshot = React.useSyncExternalStore(client.subscribe, client.getSnapshot, client.getSnapshot);
        const locale = React.useSyncExternalStore(subscribeLocale, getLocale, getLocale);
        const copy = (cn, en) => /^zh/.test(locale.active) ? cn : en;
        const id = sessionId ?? session?.sessionId;
        const failure = snapshot.failures[id];
        const incoming = snapshot.incoming[id];
        const current = useSession((value) => value);
        if (!incoming && (!failure || current?.promptError?.error?.code !== 'session/writer-held')) return null;
        const owner = failure?.owner;
        const errors = {
          SESSION_HOST_CHANGED: copy('Host 状态已变化，请在当前页签重新发送。', 'Host changed. Try sending here again.'),
          SESSION_HOST_NOT_ATTACHABLE: copy('无法接入此 Host，请在其原窗口继续。', 'This Host cannot be attached. Continue in its original window.'),
          SESSION_DRAFT_BLOCKED: copy('目标输入框正忙，文字尚未带入，请重试。', 'The target composer is busy. Text was not added. Retry.'),
          SESSION_DRAFT_TOO_LARGE: copy('文字过长，无法自动带入，原文已保留。', 'Text exceeds the transfer limit. The original is preserved.'),
        };
        const text = incoming ? copy('已带入未发送的文字，请检查后发送。', 'Unsent text added. Review it before sending.')
          : failure.transferred ? copy('文字已带入目标页签，原文仍保留在这里。', 'Text was added to the target tab. The original remains here.')
            : failure.error ? errors[failure.error] ?? copy('暂时无法跳转，原文已保留，请重试。', 'Unable to navigate. The original text is preserved. Retry.')
              : failure.checking ? copy('正在定位占用此会话的 Host…', 'Locating the Host using this session…')
                : owner?.state === 'foreign' ? copy(`此会话正在 ${owner.host.profile} Host 中使用。`, `This session is in use on ${owner.host.profile}.`)
                  : owner?.state === 'local' ? copy('当前 Host 已可继续此会话，请重新发送。', 'This Host can continue the session. Send again.')
                    : copy('暂未定位到占用者；原 Host 已退出时，可在这里重新发送。', 'Owner not located. If the original Host has exited, send again here.');
        return h('div', { className: 'wsh-session-notice', role: 'status', 'data-session-host-notice': id },
          h('span', null, text, failure?.attachments && !incoming ? copy(' 附件仍留在原页签。', ' Attachments remain in the original tab.') : null),
          h('div', { className: 'wsh-session-actions' },
          !incoming && owner?.state === 'foreign' && h('button', { disabled: failure.navigating, onClick: () => void client.navigate(id) },
            h(primitives.IconRightUpOutlineRegular, { size: 14 }), failure.action === 'open' ? copy('打开页签', 'Open tab') : copy('前往页签', 'Go to tab')),
          !incoming && owner?.state !== 'foreign' && h('button', { 'data-icon': true, title: copy('刷新', 'Refresh'), 'aria-label': copy('刷新', 'Refresh'), disabled: failure.checking, onClick: () => void client.refresh(id) }, h(primitives.IconRefreshOutlineRegular, { size: 14 })),
          h('button', { 'data-icon': true, title: copy('关闭提示', 'Dismiss'), 'aria-label': copy('关闭提示', 'Dismiss'), onClick: () => client.dismiss(id) }, h(primitives.IconCloseOutlineRegular, { size: 14 }))));
      }
      ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({ name: 'conversation.input.dock', id: 'workspace-session-host-notice' }, Notice));
      ctx.effect(() => {
        const style = deps.document.createElement('style'); style.textContent = deps.sessionHostCss; deps.document.head.append(style);
        return () => style.remove();
      }, 'workspace session notice styles');
    },
  };
}
