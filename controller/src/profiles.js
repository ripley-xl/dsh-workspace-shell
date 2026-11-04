import { lstat, open, readdir, realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { MAX_PROFILE_ENTRIES, MAX_PROFILE_MANIFEST_BYTES, WEB_PROFILE_BUNDLE } from "./constants.js";
import { isProfileId, resolveDshHome } from "./util.js";

function contained(root, target) {
  return target === root || target.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

// The DSH CLI rejects `--profile desktop`; the Electron application owns it, so a
// remote Host could never boot it even when its manifest declares the Web app.
function bootsAsWebProfile(name) {
  return name.toLowerCase() !== "desktop";
}

function bundleSpecName(value) {
  const raw = typeof value === "string" ? value : value?.name ?? value?.package ?? value?.spec;
  if (typeof raw !== "string" || !raw || raw.length > 256 || raw.includes("\0") || /[\r\n]/u.test(raw)) return null;
  return raw;
}

export function declaresWebApp(manifest) {
  const declared = manifest?.dsh?.profile?.bundles;
  const bundles = Array.isArray(declared) ? declared : declared && typeof declared === "object" ? Object.keys(declared) : [];
  return bundles.some((entry) => {
    const name = bundleSpecName(entry);
    return name !== null && (name === WEB_PROFILE_BUNDLE || name.startsWith(`${WEB_PROFILE_BUNDLE}@`));
  });
}

async function readManifest(path) {
  const info = await lstat(path);
  if (!info.isFile() || info.size > MAX_PROFILE_MANIFEST_BYTES) return null;
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(info.size);
    if (info.size > 0) await handle.read(buffer, 0, info.size, 0);
    let manifest;
    try {
      manifest = JSON.parse(buffer.toString("utf8"));
    } catch {
      return null;
    }
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) return null;
    return manifest;
  } finally {
    await handle.close();
  }
}

async function webProfileId(root, name) {
  if (!isProfileId(name)) return null;
  const info = await lstat(resolve(root, name));
  if (!info.isDirectory()) return null;
  const directory = await realpath(resolve(root, name));
  if (!contained(root, directory)) return null;
  const manifest = await readManifest(resolve(directory, "package.json"));
  return manifest && declaresWebApp(manifest) && bootsAsWebProfile(name) ? name : null;
}

/**
 * List profile IDs under `<DSH_HOME>/profiles` whose manifest declares the Web
 * app bundle. Only each profile's package.json is opened; credentials, sessions
 * and other profile content are never read. Symlinked profiles and manifests,
 * oversized or unparsable manifests, and entries beyond the fixed limit are
 * skipped instead of failing the whole listing.
 */
export async function listWebProfiles(options = {}) {
  const home = resolveDshHome(options.dshHome);
  let root;
  try {
    root = await realpath(resolve(home, "profiles"));
  } catch (error) {
    if (error?.code === "ENOENT") return { profiles: [] };
    throw error;
  }
  if (!(await lstat(root)).isDirectory()) return { profiles: [] };
  const names = (await readdir(root)).filter((name) => isProfileId(name)).sort().slice(0, MAX_PROFILE_ENTRIES);
  const profiles = [];
  for (const name of names) {
    let id = null;
    try {
      id = await webProfileId(root, name);
    } catch {
      id = null;
    }
    if (id) profiles.push(id);
  }
  profiles.sort((left, right) => left.localeCompare(right));
  return { profiles };
}
