import { createRequire } from 'node:module';

import { resolveSshConfig } from './config.js';
import {
  authenticationCandidates,
  authenticationInteractionRequired,
  createAuthenticationHandler,
  interactiveAuthenticationAllowed,
  validateSecret,
} from './authentication.js';
import { SshControlChannel } from './control-channel.js';
import {
  SshRemoteError,
  abortError,
  operationTimeout,
} from './errors.js';
import { sshKeyType, verifyHostKey } from './known-hosts.js';
import { openProxyCommandTransport, openProxyJumpTransport } from './proxy.js';

const DEFAULT_READY_TIMEOUT_MS = 20_000;
const DEFAULT_INTERACTION_TIMEOUT_MS = 5 * 60_000;
const MAX_PROXY_HOPS = 8;
const require = createRequire(import.meta.url);

async function defaultClientFactory() {
  // Read current CommonJS exports after HMR instead of a cached ESM namespace.
  let { Client } = require('ssh2');
  // Desktop HMR can retain an empty Client export while the constructor module is intact.
  if (typeof Client !== 'function') Client = require('ssh2/lib/client.js');
  if (typeof Client !== 'function') throw new Error('The ssh2 package does not export a Client constructor.');
  return new Client();
}

function authenticationFailed(cause) {
  return new SshRemoteError('SSH_AUTH_FAILED', 'No configured SSH authentication method succeeded.', {
    cause,
  });
}

function isAuthenticationError(error) {
  return error?.code === 'SSH_AUTH_FAILED' || error?.level === 'client-authentication';
}

async function openProxyTransport(config, options) {
  if (config.proxyCommand && config.proxyJump) {
    throw new SshRemoteError('SSH_CONFIG_INVALID', 'ProxyCommand and ProxyJump cannot be used together.');
  }
  if (config.proxyCommand) return openProxyCommandTransport(config, options);
  if (!config.proxyJump) return null;

  const chain = [...(options.proxyChain ?? []), config.alias ?? `${config.hostname}:${config.port}`];
  const jump = config.proxyJump;
  if (chain.length > MAX_PROXY_HOPS || chain.includes(jump.alias)) {
    throw new SshRemoteError('SSH_CONFIG_INVALID', 'The ProxyJump chain contains a loop or is too long.');
  }
  const resolver = options.resolveSshConfig ?? resolveSshConfig;
  const resolved = await resolver(jump.alias, options);
  const jumpConfig = {
    ...resolved,
    port: jump.port ?? resolved.port,
    user: jump.user ?? resolved.user,
  };
  let jumpChannel;
  try {
    jumpChannel = await connectResolvedSsh(jumpConfig, { ...options, proxyChain: chain });
    const transport = await openProxyJumpTransport(jumpChannel.client, config, options);
    const closeTransport = transport.close;
    transport.close = async () => {
      await closeTransport();
      await jumpChannel.close();
    };
    return transport;
  } catch (error) {
    if (jumpChannel) await jumpChannel.close().catch(() => {});
    throw error;
  }
}

async function attemptConnection(client, config, authentication, options, transport) {
  const signal = options.signal;
  if (signal?.aborted) throw abortError(signal);

  return new Promise((resolve, reject) => {
    let settled = false;
    let hostKeyError;
    let networkTimer;
    let interactionTimer;
    let waitingForInteraction = false;

    const stopNetworkTimer = () => clearTimeout(networkTimer);
    const startNetworkTimer = () => {
      stopNetworkTimer();
      if (settled || waitingForInteraction) return;
      networkTimer = setTimeout(() => {
        finish(operationTimeout('The SSH connection or authentication timed out.'));
      }, options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS);
      networkTimer.unref?.();
    };
    const cleanup = () => {
      stopNetworkTimer();
      clearTimeout(interactionTimer);
      signal?.removeEventListener('abort', onAbort);
      client.off('ready', onReady);
      client.off('error', onError);
      client.off('close', onClose);
    };
    const finish = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) {
        try {
          client.end();
        } catch {
          // The connection is already unusable.
        }
        client.destroy();
        Promise.resolve(transport?.close()).catch(() => {}).then(() => reject(error));
        return;
      }
      const channel = new SshControlChannel(client, config, {
        resources: transport ? [transport] : [],
      });
      resolve(channel);
    };
    const onAbort = () => finish(abortError(signal));
    const onReady = () => finish();
    const onError = (error) => {
      const prioritized = hostKeyError ?? transport?.error;
      if (prioritized || isAuthenticationError(error) || error instanceof SshRemoteError) {
        finish(prioritized ?? error);
      } else {
        finish(new SshRemoteError('SSH_CONNECTION_FAILED', 'The SSH transport failed before authentication completed.', {
          cause: error,
        }));
      }
    };
    const onClose = () => {
      finish(hostKeyError ?? transport?.error ?? new SshRemoteError(
        'SSH_CONNECTION_FAILED',
        'The SSH connection closed before authentication completed.',
      ));
    };
    const requestSecret = async (method, callback, context) => {
      if (!interactiveAuthenticationAllowed(options) || typeof callback !== 'function') {
        throw authenticationInteractionRequired(method);
      }
      if (settled) throw abortError(signal);
      waitingForInteraction = true;
      stopNetworkTimer();
      interactionTimer = setTimeout(() => {
        finish(new SshRemoteError(
          'SSH_AUTH_INTERACTION_TIMEOUT',
          `The SSH ${method} prompt was not answered in time.`,
          { details: { method } },
        ));
      }, options.interactionTimeoutMs ?? DEFAULT_INTERACTION_TIMEOUT_MS);
      interactionTimer.unref?.();
      try {
        const value = await Promise.resolve().then(() => callback({
          ...context,
          kind: method,
        }));
        if (settled) {
          if (Buffer.isBuffer(value)) value.fill(0);
          throw abortError(signal);
        }
        return validateSecret(method, value, context.prompts?.length);
      } catch (error) {
        if (error instanceof SshRemoteError) throw error;
        if (signal?.aborted || error?.name === 'AbortError') throw abortError(signal);
        throw new SshRemoteError(
          'SSH_AUTH_INTERACTION_FAILED',
          `The SSH ${method} callback failed.`,
          { details: { method } },
        );
      } finally {
        clearTimeout(interactionTimer);
        waitingForInteraction = false;
        startNetworkTimer();
      }
    };

    client.once('ready', onReady);
    client.once('error', onError);
    client.once('close', onClose);
    signal?.addEventListener('abort', onAbort, { once: true });
    startNetworkTimer();

    const hostVerifier = (key, callback) => {
      const verifier = options.hostKeyVerifier ?? verifyHostKey;
      Promise.resolve(verifier(key, {
        globalKnownHostsFiles: config.globalKnownHostsFiles,
        hostKeyAlias: config.hostKeyAlias,
        hostname: config.hostname,
        interactive: interactiveAuthenticationAllowed(options),
        keyType: sshKeyType(key),
        port: config.port,
        strictHostKeyChecking: config.strictHostKeyChecking,
        signal: options.signal,
        userKnownHostsFiles: config.userKnownHostsFiles,
      })).then(
        () => callback(true),
        (error) => {
          hostKeyError = error instanceof SshRemoteError
            ? error
            : new SshRemoteError('SSH_HOST_KEY_CHANGED', 'SSH host key verification failed.', {
              cause: error,
            });
          callback(false);
        },
      );
    };
    const authHandler = createAuthenticationHandler({
      authentication,
      config,
      fail: finish,
      options,
      requestSecret,
    });

    try {
      client.connect({
        agent: authentication.type === 'agent' ? authentication.agent : undefined,
        agentForward: false,
        authHandler,
        host: config.hostname,
        hostVerifier,
        password: undefined,
        passphrase: undefined,
        port: config.port,
        privateKey: authentication.type === 'publickey' && !authentication.encrypted
          ? authentication.privateKey
          : undefined,
        readyTimeout: 0,
        sock: transport?.stream,
        tryKeyboard: false,
        username: config.user,
      });
    } catch (error) {
      finish(authenticationFailed(error));
    }
  });
}

export async function connectResolvedSsh(config, options = {}) {
  const readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
  const interactionTimeoutMs = options.interactionTimeoutMs ?? DEFAULT_INTERACTION_TIMEOUT_MS;
  if (!Number.isSafeInteger(readyTimeoutMs) || readyTimeoutMs < 1) {
    throw new TypeError('The SSH ready timeout must be a positive integer.');
  }
  if (!Number.isSafeInteger(interactionTimeoutMs) || interactionTimeoutMs < 1) {
    throw new TypeError('The SSH interaction timeout must be a positive integer.');
  }
  const candidates = await authenticationCandidates(config, options);
  if (candidates.length === 0) {
    const hasCallbacks = Object.values(options.authCallbacks ?? {}).some((callback) => typeof callback === 'function');
    if (hasCallbacks && !interactiveAuthenticationAllowed(options)) {
      throw authenticationInteractionRequired('interactive');
    }
    throw authenticationFailed();
  }
  const clientFactory = options.clientFactory ?? defaultClientFactory;
  let lastAuthenticationError;

  for (const authentication of candidates) {
    if (options.signal?.aborted) throw abortError(options.signal);
    try {
      const client = await clientFactory();
      const transport = await openProxyTransport(config, options);
      return await attemptConnection(client, config, authentication, options, transport);
    } catch (error) {
      if (isAuthenticationError(error)) {
        lastAuthenticationError = error;
        continue;
      }
      throw error;
    }
  }
  throw authenticationFailed(lastAuthenticationError);
}

export async function connectSsh(alias, options = {}) {
  const config = await resolveSshConfig(alias, options);
  return connectResolvedSsh(config, options);
}
