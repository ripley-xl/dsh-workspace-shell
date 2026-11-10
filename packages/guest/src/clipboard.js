// Copy actions inside a Guest run in a cross-origin frame or a webview, where
// navigator.clipboard.writeText can reject on a Permissions Policy or focus
// check. DSH's copy path returns false on that rejection instead of falling
// back, so the Guest installs the fallback itself: try the modern API first and
// use a select+copy textarea only when it fails.
export function installClipboardFallback(window, document) {
  const mark = (installed, reason) => {
    try { window.__workspaceShellClipboard = { installed, reason }; } catch { /* Diagnostics only. */ }
  };
  let clipboard;
  try {
    clipboard = window.navigator?.clipboard;
  } catch {
    clipboard = null;
  }
  if (!clipboard || typeof clipboard.writeText !== 'function') { mark(false, clipboard ? 'no-write-text' : 'no-clipboard'); return false; }
  const original = clipboard.writeText.bind(clipboard);
  const fallback = (text) => {
    let area;
    try {
      area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', '');
      area.style.position = 'fixed';
      area.style.top = '0';
      area.style.left = '0';
      area.style.opacity = '0';
      document.body.appendChild(area);
      try { area.focus({ preventScroll: true }); } catch { /* A page without focus support still tries execCommand. */ }
      area.select();
      try { area.setSelectionRange(0, area.value.length); } catch { /* Selection API is best effort. */ }
      const copied = document.execCommand('copy');
      if (!copied) throw new Error('copy denied');
    } finally {
      try { area?.remove(); } catch { /* The detached area is already gone. */ }
    }
  };
  const writeText = async (text) => {
    try {
      return await original(text);
    } catch {
      fallback(typeof text === 'string' ? text : String(text));
    }
  };
  try {
    Object.defineProperty(clipboard, 'writeText', { configurable: true, value: writeText });
    const installed = clipboard.writeText === writeText;
    mark(installed, installed ? 'installed' : 'unchanged');
    return installed;
  } catch (error) {
    mark(false, 'define-failed:' + String(error?.name ?? error));
    return false;
  }
}
