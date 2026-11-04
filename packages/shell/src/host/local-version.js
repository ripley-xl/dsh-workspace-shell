import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const requireFromHere = createRequire(import.meta.url);

/**
 * Read the running DSH version from the install anchor the host reports in
 * `profileContext`. The remote runtime is installed at the same version, so this
 * value is not pinned in the plugin.
 *
 * @param profileContext — the host profile context (installAnchor points at the installed dsh package.json).
 * @returns the installed DSH version, or undefined when it cannot be read.
 */
export function resolveLocalDshVersion(profileContext) {
  const anchor = profileContext?.installAnchor;
  if (typeof anchor === 'string' && anchor.length > 0) {
    try {
      const version = JSON.parse(readFileSync(anchor, 'utf8'))?.version;
      if (typeof version === 'string' && version.length > 0) return version;
    } catch {}
  }
  try {
    const manifest = JSON.parse(readFileSync(requireFromHere.resolve('@deepseek-ai/dsh/package.json'), 'utf8'));
    if (typeof manifest.version === 'string' && manifest.version.length > 0) return manifest.version;
  } catch {}
  return undefined;
}
