const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

function assertLoopback(url, label) {
  if (!(url instanceof URL) || !LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error(`${label} must use a loopback host`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${label} must use HTTP or HTTPS`);
  }
}

export function rewriteAuthenticatedUrl(authenticatedUrl, gatewayOrigin) {
  const remote = new URL(authenticatedUrl);
  const gateway = new URL(gatewayOrigin);
  assertLoopback(remote, 'remote authenticated URL');
  assertLoopback(gateway, 'gateway origin');
  const rewritten = new URL(remote.href);
  rewritten.protocol = gateway.protocol;
  rewritten.host = gateway.host;
  return rewritten.href;
}

function cookiePairs(headers) {
  const values = typeof headers.getSetCookie === 'function'
    ? headers.getSetCookie()
    : headers.get('set-cookie') ? [headers.get('set-cookie')] : [];
  return values.map((value) => value.split(';', 1)[0]).filter((value) => value.includes('='));
}

async function readBoundedText(response, maxBytes) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error('remote response is too large');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

export class RemoteClient {
  #authenticatedUrl;
  #gatewayOrigin;
  #fetch;
  #cookie = null;
  #authentication = null;

  constructor({ authenticatedUrl, gatewayOrigin, fetchImpl = fetch }) {
    this.#authenticatedUrl = authenticatedUrl;
    this.#gatewayOrigin = gatewayOrigin;
    this.#fetch = fetchImpl;
  }

  get browserUrl() {
    return this.#authenticatedUrl && this.#gatewayOrigin
      ? rewriteAuthenticatedUrl(this.#authenticatedUrl, this.#gatewayOrigin)
      : null;
  }

  async #authenticate() {
    if (this.#cookie) return;
    if (this.#authentication) return this.#authentication;
    this.#authentication = (async () => {
      const browserUrl = this.browserUrl;
      if (!browserUrl) throw new Error('remote client is closed');
      const response = await this.#fetch(browserUrl, {
        redirect: 'manual',
        headers: { accept: 'text/html' },
      });
      await response.body?.cancel();
      if (response.status < 200 || response.status >= 400) {
        throw new Error(`remote authentication failed with HTTP ${response.status}`);
      }
      const pairs = cookiePairs(response.headers);
      if (pairs.length === 0) throw new Error('remote authentication did not issue a browser credential');
      this.#cookie = pairs.join('; ');
    })();
    try {
      await this.#authentication;
    } finally {
      this.#authentication = null;
    }
  }

  async request(path, { method = 'GET', body, maxBytes = 2 * 1024 * 1024 } = {}) {
    await this.#authenticate();
    const browserUrl = this.browserUrl;
    if (!browserUrl) throw new Error('remote client is closed');
    const url = new URL(path, browserUrl);
    const response = await this.#fetch(url, {
      method,
      redirect: 'manual',
      headers: {
        accept: 'application/json',
        cookie: this.#cookie,
        ...body === undefined ? {} : { 'content-type': 'application/json' },
      },
      ...body === undefined ? {} : { body: JSON.stringify(body) },
    });
    const text = await readBoundedText(response, maxBytes);
    let value = null;
    if (text.trim()) {
      try {
        value = JSON.parse(text);
      } catch {
        if (response.headers.get('content-type')?.includes('application/json')) {
          throw new Error('remote returned invalid JSON');
        }
        value = text;
      }
    }
    if (!response.ok) throw new Error(`remote request failed with HTTP ${response.status}`);
    return value;
  }

  post(path, body) {
    return this.request(path, { method: 'POST', body });
  }

  close() {
    this.#cookie = null;
    this.#authenticatedUrl = null;
    this.#gatewayOrigin = null;
  }
}
