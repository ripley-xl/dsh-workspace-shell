import { randomUUID } from 'node:crypto';

import { SshRemoteError } from './ssh/errors.js';

const MAX_HOSTS = 128;
const MAX_REFS = 128;
const MAX_STRING = 512;

function invalid(message) {
  return new SshRemoteError('INVALID_CONNECTION_RECORD', message);
}

function object(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw invalid(`${label} must be an object.`);
  }
  return value;
}

function string(value, label, { optional = false, max = MAX_STRING } = {}) {
  if (value === undefined && optional) return undefined;
  if (typeof value !== 'string' || value.length === 0 || value.length > max || /[\0\r\n]/u.test(value)) {
    throw invalid(`${label} must be a non-empty single-line string of at most ${max} characters.`);
  }
  return value;
}

function nullableString(value, label) {
  if (value === null) return null;
  return string(value, label);
}

function stringList(value, label, { max = MAX_REFS } = {}) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > max) throw invalid(`${label} must be an array with at most ${max} items.`);
  return [...new Set(value.map((item, index) => string(item, `${label}[${index}]`)))];
}

function credentialRef(value, index) {
  const ref = string(value, `syncPolicy.credentialRefs[${index}]`, { max: 128 });
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(ref)) {
    throw invalid('credential refs must be environment-variable-style names.');
  }
  return ref;
}

function syncPolicy(value = {}) {
  object(value, 'syncPolicy');
  if (value.appearance !== undefined && typeof value.appearance !== 'boolean') {
    throw invalid('syncPolicy.appearance must be boolean.');
  }
  if (value.allSupported !== undefined && typeof value.allSupported !== 'boolean') {
    throw invalid('syncPolicy.allSupported must be boolean.');
  }
  const credentialRefs = stringList(value.credentialRefs, 'syncPolicy.credentialRefs')
    .map((ref) => credentialRef(ref, 0));
  return {
    allSupported: value.allSupported ?? true,
    appearance: value.appearance ?? true,
    modelNamespaces: stringList(value.modelNamespaces, 'syncPolicy.modelNamespaces'),
    credentialRefs: [...new Set(credentialRefs)],
  };
}

function timestamp(value, label, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  const result = string(value, label, { max: 64 });
  if (!Number.isFinite(Date.parse(result))) throw invalid(`${label} must be an ISO timestamp.`);
  return result;
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

export function validateConnectionRecord(value) {
  object(value, 'ConnectionRecord');
  if (value.autoConnect !== undefined && typeof value.autoConnect !== 'boolean') {
    throw invalid('autoConnect must be boolean.');
  }
  return {
    id: string(value.id, 'id', { max: 128 }),
    name: string(value.name, 'name', { max: 256 }),
    hostAlias: string(value.hostAlias, 'hostAlias', { max: 256 }),
    lastInstanceId: nullableString(value.lastInstanceId, 'lastInstanceId'),
    lastServerVersion: nullableString(value.lastServerVersion, 'lastServerVersion'),
    lastBuildId: nullableString(value.lastBuildId, 'lastBuildId'),
    // Auto-connect is the default; only an explicit `false` keeps a host quiet.
    autoConnect: value.autoConnect !== false,
    syncPolicy: syncPolicy(value.syncPolicy),
    lastConnectedAt: timestamp(value.lastConnectedAt, 'lastConnectedAt', { nullable: true }),
    lastSyncedAt: timestamp(value.lastSyncedAt, 'lastSyncedAt', { nullable: true }),
    createdAt: timestamp(value.createdAt, 'createdAt'),
    updatedAt: timestamp(value.updatedAt, 'updatedAt'),
  };
}

export const connectionDomainSpec = {
  name: 'ssh_remote',
  version: 1,
  layout: 'per-record',
  tables: {
    connections: {
      valueSchema: { parse: validateConnectionRecord },
    },
  },
};

function editable(input, existing, now, id) {
  object(input, 'host');
  const hostAlias = string(input.hostAlias ?? existing?.hostAlias, 'hostAlias', { max: 256 });
  const name = string(input.name ?? existing?.name ?? hostAlias, 'name', { max: 256 });
  return validateConnectionRecord({
    id,
    name,
    hostAlias,
    lastInstanceId: existing?.lastInstanceId ?? null,
    lastServerVersion: existing?.lastServerVersion ?? null,
    lastBuildId: existing?.lastBuildId ?? null,
    autoConnect: input.autoConnect === undefined ? existing?.autoConnect !== false : input.autoConnect,
    syncPolicy: input.syncPolicy === undefined ? existing?.syncPolicy : input.syncPolicy,
    lastConnectedAt: existing?.lastConnectedAt ?? null,
    lastSyncedAt: existing?.lastSyncedAt ?? null,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  });
}

export class ConnectionStore {
  constructor(storageDomain, { now = () => new Date().toISOString() } = {}) {
    this.storageDomain = storageDomain;
    this.now = now;
    this.domain = null;
    this.connections = null;
    this.opening = null;
  }

  async open() {
    if (this.connections) return this;
    if (!this.opening) {
      this.opening = (async () => {
        this.domain = await this.storageDomain.open(connectionDomainSpec);
        this.connections = this.domain.table('connections');
      })();
    }
    try {
      await this.opening;
    } catch (error) {
      this.opening = null;
      throw error;
    }
    return this;
  }

  list() {
    return [...this.connections.entries()].map(([, value]) => clone(value))
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  }

  get(id) {
    return clone(this.connections.get(id));
  }

  require(id) {
    const record = this.get(id);
    if (!record) throw new SshRemoteError('HOST_NOT_FOUND', `SSH host ${id} does not exist.`);
    return record;
  }

  byAlias(alias) {
    return this.list().find((record) => record.hostAlias === alias);
  }

  async upsert(input) {
    const requestedId = input.id === undefined ? undefined : string(input.id, 'id', { max: 128 });
    const byId = requestedId ? this.get(requestedId) : undefined;
    if (requestedId && !byId) throw new SshRemoteError('HOST_NOT_FOUND', `SSH host ${requestedId} does not exist.`);
    const alias = input.hostAlias ?? byId?.hostAlias;
    const byAlias = alias === undefined ? undefined : this.byAlias(alias);
    if (byAlias && requestedId && byAlias.id !== requestedId) {
      throw new SshRemoteError('HOST_ALIAS_EXISTS', `SSH alias ${byAlias.hostAlias} is already saved.`);
    }
    const existing = byId ?? byAlias;
    if (!existing && this.connections.size >= MAX_HOSTS) throw invalid(`At most ${MAX_HOSTS} SSH hosts may be saved.`);
    const record = editable(input, existing, this.now(), existing?.id ?? randomUUID());
    await this.connections.put(record.id, record);
    return clone(record);
  }

  async remove(id) {
    return this.connections.delete(id);
  }

  async update(id, mutate) {
    const current = this.require(id);
    const next = validateConnectionRecord({ ...mutate(clone(current)), id, createdAt: current.createdAt, updatedAt: this.now() });
    await this.connections.put(id, next);
    return clone(next);
  }

  markConnected(id, { instanceId, version, buildId }) {
    return this.update(id, (record) => ({
      ...record,
      lastInstanceId: instanceId,
      lastServerVersion: version,
      lastBuildId: buildId,
      lastConnectedAt: this.now(),
    }));
  }

  markSynced(id) {
    return this.update(id, (record) => ({ ...record, lastSyncedAt: this.now() }));
  }

  clearInstance(id) {
    return this.update(id, (record) => ({ ...record, lastInstanceId: null }));
  }

  async close() {
    await this.domain?.close();
    this.domain = null;
    this.connections = null;
    this.opening = null;
  }
}
