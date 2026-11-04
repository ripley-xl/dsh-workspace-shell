import { spawn } from 'node:child_process';
import { once } from 'node:events';

export const VM_NAME = 'dsh-ssh-remote-p0';

function boundedAppend(chunks, chunk, limit = 64 * 1024) {
  const current = Buffer.concat(chunks);
  if (current.length >= limit) return chunks;
  return [Buffer.concat([current, chunk]).subarray(0, limit)];
}

export function runVm(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('limactl', ['shell', VM_NAME, '--', ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = [];
    let stderr = [];
    const timer = setTimeout(() => child.kill('SIGKILL'), options.timeoutMs ?? 15_000);
    child.stdout.on('data', (chunk) => {
      stdout = boundedAppend(stdout, chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr = boundedAppend(stderr, chunk);
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      const result = {
        code,
        stderr: Buffer.concat(stderr).toString('utf8'),
        stdout: Buffer.concat(stdout).toString('utf8'),
      };
      if (code === 0) resolve(result);
      else reject(new Error(`VM command ${args[0]} exited with code ${code}.`));
    });
    child.stdin.end(options.input ?? '');
  });
}

async function daemonListening(child) {
  let output = '';
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('The isolated VM sshd did not start in time.'));
    }, 15_000);
    const cleanup = () => {
      clearTimeout(timer);
      child.stderr.off('data', onData);
      child.off('close', onClose);
      child.off('error', onClose);
    };
    const onData = (chunk) => {
      output = `${output}${chunk.toString('utf8')}`.slice(-64 * 1024);
      if (output.includes('Server listening on 127.0.0.1')) {
        cleanup();
        resolve();
      }
    };
    const onClose = () => {
      cleanup();
      reject(new Error('The isolated VM sshd exited before listening.'));
    };
    child.stderr.on('data', onData);
    child.once('close', onClose);
    child.once('error', onClose);
  });
}

export async function createIsolatedSshd() {
  const suffix = `${process.pid}${Date.now().toString().slice(-6)}`;
  const username = `dshp2${suffix}`.slice(0, 30);
  const password = `P2-test-${suffix}`;
  const root = `/tmp/dsh-p2-${suffix}`;
  const home = `/home/${username}`;
  const configPath = `${root}/sshd_config`;
  const pidPath = `${root}/sshd.pid`;
  const hostKeyPath = `${root}/ssh_host_ed25519_key`;
  const authorizedKeys = `${home}/.ssh/authorized_keys`;
  let daemon;

  const cleanup = async () => {
    if (daemon) {
      const pid = await runVm(['sudo', '-n', 'cat', pidPath]).then((result) => result.stdout.trim()).catch(() => '');
      if (/^\d+$/u.test(pid)) await runVm(['sudo', '-n', 'kill', pid]).catch(() => {});
      if (daemon.exitCode === null && daemon.signalCode === null) daemon.kill('SIGTERM');
      await Promise.race([
        waitForExit(daemon).catch(() => {}),
        new Promise((resolve) => {
          const timer = setTimeout(resolve, 1000);
          timer.unref?.();
        }),
      ]);
    }
    await runVm(['sudo', '-n', 'userdel', '-r', username]).catch(() => {});
    await runVm(['sudo', '-n', 'rm', '-rf', '--', root]).catch(() => {});
  };

  try {
    await runVm(['sudo', '-n', 'useradd', '--create-home', '--shell', '/bin/bash', username]);
    await runVm(['sudo', '-n', 'chpasswd'], { input: `${username}:${password}\n` });
    await runVm(['sudo', '-n', 'install', '-d', '-m', '700', root]);
    await runVm([
      'sudo', '-n', 'ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', hostKeyPath,
    ]);
    const portResult = await runVm([
      'python3',
      '-c',
      'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()',
    ]);
    const port = Number(portResult.stdout.trim());
    if (!Number.isSafeInteger(port) || port < 1024) throw new Error('The VM returned an invalid test port.');
    const config = [
      `Port ${port}`,
      'ListenAddress 127.0.0.1',
      `HostKey ${hostKeyPath}`,
      `PidFile ${pidPath}`,
      `AuthorizedKeysFile ${authorizedKeys}`,
      `AllowUsers ${username}`,
      'AllowTcpForwarding yes',
      'AllowAgentForwarding no',
      'KbdInteractiveAuthentication yes',
      'PasswordAuthentication yes',
      'PubkeyAuthentication yes',
      'UsePAM yes',
      'X11Forwarding no',
      'LogLevel VERBOSE',
      'Subsystem sftp internal-sftp',
      '',
    ].join('\n');
    await runVm(['sudo', '-n', 'tee', configPath], { input: config });
    await runVm(['sudo', '-n', 'chmod', '600', configPath]);
    await runVm(['sudo', '-n', '-u', username, 'install', '-d', '-m', '700', `${home}/.ssh`]);
    daemon = spawn('limactl', [
      'shell', VM_NAME, '--',
      'sudo', '-n', '/usr/sbin/sshd', '-D', '-e', '-f', configPath,
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    await daemonListening(daemon);
    daemon.stderr.resume();

    const hostPublicKey = await runVm(['sudo', '-n', 'cat', `${hostKeyPath}.pub`]);
    return {
      authorizedKeys,
      cleanup,
      configPath,
      daemon,
      home,
      hostPublicKey: hostPublicKey.stdout,
      password,
      port,
      root,
      username,
      writeAuthorizedKey: async (publicKey) => {
        await runVm(['sudo', '-n', '-u', username, 'tee', authorizedKeys], { input: publicKey });
        await runVm(['sudo', '-n', '-u', username, 'chmod', '600', authorizedKeys]);
      },
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

export async function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await once(child, 'close');
}
