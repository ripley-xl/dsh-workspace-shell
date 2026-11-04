import { SshRemoteError } from './ssh/errors.js';

async function command(channel, name, args, signal) {
  return channel.exec({
    command: name,
    args,
    signal,
    timeoutMs: 5_000,
    maxStdoutBytes: 4096,
    maxStderrBytes: 4096,
  });
}

export function normalizeRemoteArch(value) {
  if (value === 'x86_64' || value === 'amd64' || value === 'x64') return 'x64';
  if (value === 'aarch64' || value === 'arm64') return 'arm64';
  return value;
}

export async function probeRemoteTarget(channel, { signal } = {}) {
  const system = await command(channel, 'uname', ['-s'], signal);
  const architecture = await command(channel, 'uname', ['-m'], signal);
  const platform = system.stdout.trim().toLowerCase();
  if (system.code !== 0 || architecture.code !== 0 || !['linux', 'darwin'].includes(platform)) {
    throw new SshRemoteError('REMOTE_PLATFORM_UNSUPPORTED', 'SSH Remote supports only Linux and macOS remote hosts.');
  }
  const arch = normalizeRemoteArch(architecture.stdout.trim());
  if (!['x64', 'arm64'].includes(arch)) {
    throw new SshRemoteError('REMOTE_PLATFORM_UNSUPPORTED', `Remote architecture ${arch} is not supported.`);
  }
  if (platform === 'darwin') return { platform, arch, libc: 'none' };

  const libcResult = await command(channel, 'ldd', ['--version'], signal);
  const text = `${libcResult.stdout}\n${libcResult.stderr}`;
  if (/musl/iu.test(text)) return { platform, arch, libc: 'musl' };
  if (/glibc|gnu libc|gnu c library/iu.test(text)) return { platform, arch, libc: 'glibc' };
  throw new SshRemoteError('REMOTE_PLATFORM_UNSUPPORTED', 'Could not identify the remote Linux libc implementation.');
}
