// Copy actions inside a Guest run in a cross-origin frame or a webview, where
// navigator.clipboard.writeText can reject on a Permissions Policy or focus
// check. DSH's copy path returns false on that rejection instead of falling
// back, so the Guest installs the fallback itself: try the modern API first and
// use a select+copy textarea only when it fails.
export function installClipboardFallback(window, document) {
  let clipboard;
  try {
    clipboard = window.navigator?.clipboard;
  } catch {
    clipboard = null;
  }
  if (!clipboard || typeof clipboard.writeText !== 'function') return false;
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
      area.select();
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
    return clipboard.writeText === writeText;
  } catch {
    return false;
  }
}
