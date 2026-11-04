import { SshRemoteError } from './ssh/errors.js';
import { CONTROLLER_VERSION } from '../../controller/src/constants.js';

const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+~-]{0,127}$/u;
const SUPPORTED_PLATFORMS = new Set(['linux', 'darwin']);
const SUPPORTED_ARCHES = new Set(['x64', 'arm64']);
const SUPPORTED_LIBC = new Set(['glibc', 'musl', 'none']);

function failure(code, message, details) {
  return new SshRemoteError(code, message, { details });
}

/**
 * The remote runtime is installed from npm, so the catalog no longer reads
 * prebuilt archives. It turns the local DSH version and the probed remote
 * target into the runtime identity the remote controller installs.
 */
export class RuntimeCatalog {
  constructor({ controllerVersion = CONTROLLER_VERSION } = {}) {
    this.controllerVersion = controllerVersion;
  }

  async list() {
    return [];
  }

  async select({ version, target }) {
    if (typeof version !== 'string' || !VERSION_PATTERN.test(version)) {
      throw failure('REMOTE_VERSION_MISMATCH', 'The local DSH version is unavailable, so no remote runtime can be selected.');
    }
    if (!target || !SUPPORTED_PLATFORMS.has(target.platform) || !SUPPORTED_ARCHES.has(target.arch) || !SUPPORTED_LIBC.has(target.libc)) {
      throw failure('REMOTE_PLATFORM_UNSUPPORTED', 'The remote runtime target must be Linux or macOS with a supported architecture and libc.');
    }
    const runtimeId = `${version}${this.controllerVersion ? `-controller-${this.controllerVersion}` : ''}-${target.platform}-${target.arch}-${target.libc}`;
    return {
      runtimeId,
      dshVersion: version,
      buildId: `npm:${version}`,
      controllerVersion: this.controllerVersion,
      installMode: 'npm',
      target: Object.freeze({ platform: target.platform, arch: target.arch, libc: target.libc }),
    };
  }
}
