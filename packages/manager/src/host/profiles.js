import { SshRemoteError } from './ssh/errors.js';

export const DEFAULT_PROFILE_ID = 'web';
export const MAX_PROFILE_ID_LENGTH = 128;
const PROFILE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

export function defaultProfiles() {
  return [{ id: DEFAULT_PROFILE_ID, web: true }];
}

export function normalizeProfileId(value, fallback = DEFAULT_PROFILE_ID) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_PROFILE_ID_LENGTH
    || value === '.' || value === '..' || !PROFILE_ID.test(value)) {
    throw new SshRemoteError('INVALID_PROFILE_ID', 'profileId must be a profile identifier of at most 128 characters.', {
      details: { profileId: typeof value === 'string' ? value.slice(0, MAX_PROFILE_ID_LENGTH) : null },
    });
  }
  return value;
}

export function instanceProfileId(instance) {
  const value = instance?.profileId;
  return typeof value === 'string' && PROFILE_ID.test(value) ? value : DEFAULT_PROFILE_ID;
}

export function matchesProfile(entry, profileId) {
  return instanceProfileId(entry?.instance ?? entry) === profileId;
}

/** A legacy instance without a creator identity belongs to any runtime. */
export function instanceRuntimeMatches(instance, runtimeId) {
  if (typeof runtimeId !== 'string' || runtimeId.length === 0) return true;
  const createdBy = instance?.createdBy;
  if (typeof createdBy !== 'string' || createdBy.length === 0) return true;
  return createdBy === runtimeId;
}

/**
 * Normalizes a controller profiles response. The controller lists Web profile
 * ids as `{ profiles: ["web", "work"] }`; the agreed UI shape is
 * `{ profiles: [{ id, web: true }] }`, and both object entries and a bare array
 * are accepted. Unknown or malformed entries are dropped rather than failing
 * the whole list.
 */
export function normalizeProfiles(value) {
  const items = Array.isArray(value) ? value : Array.isArray(value?.profiles) ? value.profiles : [];
  const seen = new Set();
  const profiles = [];
  for (const item of items.slice(0, 256)) {
    if (typeof item !== 'string' && (!item || typeof item !== 'object')) continue;
    let id;
    let web = true;
    try {
      id = normalizeProfileId(typeof item === 'string' ? item : item.id);
    } catch {
      continue;
    }
    if (typeof item === 'object' && item.web === false) web = false;
    if (seen.has(id)) continue;
    seen.add(id);
    profiles.push({ id, web });
  }
  profiles.sort((left, right) => left.id.localeCompare(right.id));
  return value === undefined || value === null ? defaultProfiles() : profiles;
}

/**
 * Projects one controller instance entry to the safe fields the UI may see.
 * Never includes the endpoint, authenticated URL, workspace or credentials.
 */
export function publicProfileInstance(entry, profileId = null) {
  const instance = entry?.instance ?? entry ?? {};
  const id = instanceProfileId(instance);
  if (profileId && id !== profileId) return null;
  if (typeof instance.instanceId !== 'string' || instance.instanceId.length === 0) return null;
  const health = entry?.health && typeof entry.health === 'object' ? entry.health : {};
  return {
    profileId: id,
    instanceId: instance.instanceId,
    state: typeof instance.state === 'string' ? instance.state : typeof health.state === 'string' ? health.state : null,
    health: {
      known: true,
      healthy: health.healthy === true,
      hostAlive: health.hostAlive === true,
      supervisorAlive: health.supervisorAlive === true,
      reachable: health.reachable === true,
    },
    dshVersion: typeof instance.dshVersion === 'string' ? instance.dshVersion : null,
    buildId: typeof instance.buildId === 'string' ? instance.buildId : null,
    ...typeof instance.createdBy === 'string' && instance.createdBy ? { createdBy: instance.createdBy } : {},
    startedAt: typeof instance.startedAt === 'string' ? instance.startedAt : null,
    lastAttachAt: typeof instance.lastAttachAt === 'string' ? instance.lastAttachAt : null,
  };
}

export function normalizeInstanceList(value) {
  const items = Array.isArray(value) ? value : Array.isArray(value?.instances) ? value.instances : [];
  return items.slice(0, 256).map((entry) => publicProfileInstance(entry)).filter(Boolean);
}
