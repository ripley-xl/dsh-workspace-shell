import { promises as fs } from 'node:fs';

import { SshRemoteError } from './errors.js';

async function defaultKeyParser() {
  const ssh2 = await import('ssh2');
  const parseKey = ssh2.utils?.parseKey ?? ssh2.default?.utils?.parseKey;
  if (!parseKey) throw new Error('The ssh2 package does not export utils.parseKey.');
  return parseKey;
}

export function interactiveAuthenticationAllowed(options) {
  return options.interactive === true && options.background !== true;
}

export function authenticationInteractionRequired(method) {
  return new SshRemoteError(
    'SSH_AUTH_INTERACTION_REQUIRED',
    `SSH ${method} authentication requires an explicit user action.`,
    { details: { method } },
  );
}

export async function authenticationCandidates(config, options) {
  const candidates = [];
  const env = options.env ?? process.env;
  const agent = config.identityAgent === undefined ? env.SSH_AUTH_SOCK : config.identityAgent;
  if (agent) candidates.push({ agent, type: 'agent' });
  const getKeyParser = options.keyParser
    ? async () => options.keyParser
    : defaultKeyParser;

  for (const identityFile of config.identityFiles ?? []) {
    let privateKey;
    try {
      privateKey = await fs.readFile(identityFile);
    } catch {
      continue;
    }
    const parseKey = await getKeyParser();
    const parsed = parseKey(privateKey);
    candidates.push({
      encrypted: parsed instanceof Error && encryptedKeyError(parsed),
      identityFile,
      privateKey,
      type: 'publickey',
    });
  }

  if (interactiveAuthenticationAllowed(options)) {
    if (typeof options.authCallbacks?.password === 'function') {
      candidates.push({ type: 'password' });
    }
    if (typeof options.authCallbacks?.keyboardInteractive === 'function') {
      candidates.push({ type: 'keyboard-interactive' });
    }
  }
  return candidates;
}

function encryptedKeyError(error) {
  return error instanceof Error && /encrypted.*(?:key|private)|passphrase/iu.test(error.message);
}

function clearSecret(secret) {
  if (Buffer.isBuffer(secret)) secret.fill(0);
}

function callbackContext(config, authentication, options, extra = {}) {
  return {
    alias: config.alias,
    hostname: config.hostname,
    port: config.port,
    signal: options.signal,
    username: config.user,
    ...extra,
  };
}

export function createAuthenticationHandler({
  authentication,
  config,
  fail,
  options,
  requestSecret,
}) {
  let used = false;
  const callbacks = options.authCallbacks ?? {};
  const getKeyParser = options.keyParser
    ? async () => options.keyParser
    : defaultKeyParser;

  return (authsLeft, partial, next) => {
    if (used) {
      next(false);
      return;
    }
    used = true;
    const method = authentication.type;
    if (Array.isArray(authsLeft) && !authsLeft.includes(method)) {
      next(false);
      return;
    }

    const run = async () => {
      if (method === 'agent') {
        next({ agent: authentication.agent, type: method, username: config.user });
        return;
      }
      if (method === 'publickey') {
        const parseKey = await getKeyParser();
        const parsed = parseKey(authentication.privateKey);
        if (parsed instanceof Error && !encryptedKeyError(parsed)) {
          next(false);
          return;
        }
        let passphrase;
        if (parsed instanceof Error) {
          const supplied = await requestSecret(
            'passphrase',
            callbacks.passphrase,
            callbackContext(config, authentication, options, {
              identityFile: authentication.identityFile,
            }),
          );
          passphrase = typeof supplied === 'string' ? Buffer.from(supplied) : supplied;
        }
        try {
          next({
            key: authentication.privateKey,
            passphrase,
            type: method,
            username: config.user,
          });
        } finally {
          clearSecret(passphrase);
        }
        return;
      }
      if (method === 'password') {
        const supplied = await requestSecret(
          'password',
          callbacks.password,
          callbackContext(config, authentication, options),
        );
        const password = typeof supplied === 'string' ? Buffer.from(supplied) : supplied;
        try {
          next({ password, type: method, username: config.user });
        } finally {
          clearSecret(password);
        }
        return;
      }
      if (method === 'keyboard-interactive') {
        next({
          prompt: (name, instructions, languageTag, prompts, finish) => {
            void requestSecret(
              'keyboardInteractive',
              callbacks.keyboardInteractive,
              callbackContext(config, authentication, options, {
                instructions,
                name,
                prompts: prompts.map(({ echo, prompt }) => ({ echo, prompt })),
              }),
            ).then((answers) => {
              finish(answers);
            }).catch(fail);
          },
          type: method,
          username: config.user,
        });
        return;
      }
      next(false);
    };

    void run().catch(fail);
  };
}

export function validateSecret(method, value, promptCount) {
  if (method === 'keyboardInteractive') {
    if (
      !Array.isArray(value)
      || value.length !== promptCount
      || value.some((answer) => typeof answer !== 'string')
    ) {
      throw new SshRemoteError(
        'SSH_AUTH_INTERACTION_FAILED',
        'The keyboard-interactive callback must return one string answer per prompt.',
      );
    }
    return value;
  }
  if (typeof value !== 'string' && !Buffer.isBuffer(value)) {
    throw new SshRemoteError(
      'SSH_AUTH_INTERACTION_FAILED',
      `The ${method} callback must return a string or Buffer.`,
    );
  }
  return value;
}
