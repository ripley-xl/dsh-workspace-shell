// Pre-restart guards: is there work a restart would cut in half, and is a plugin
// install currently rewriting this profile? Both questions answer "unknown" as
// "not busy" — a probe that fails must not make the restart button useless.

import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';

/**
 * @returns {{available:boolean, active:boolean, tasks:number, jobs:number}}
 */
export function inspectActiveTasks(ctx) {
  const idle = { available: false, active: false, tasks: 0, jobs: 0 };
  try {
    const agents = typeof ctx?.get === 'function' ? ctx.get('agents') : undefined;
    const jobs = typeof ctx?.get === 'function' ? ctx.get('jobs') : undefined;
    if (!agents || !jobs || typeof agents.list !== 'function' || typeof jobs.list !== 'function') return idle;
    const live = agents.list() || [];
    const busyAgents = live.filter((agent) => {
      if (!agent) return false;
      if (agent.status === 'running') return true;
      const inbox = agent.inbox;
      if (!inbox) return false;
      const pendingTurns = Array.isArray(inbox.nextTurn) ? inbox.nextTurn.length : 0;
      const pendingSteps = Array.isArray(inbox.nextStep) ? inbox.nextStep.length : 0;
      return pendingTurns + pendingSteps > 0;
    });
    // A job can be listed both globally and per agent; count each one once.
    const seen = new Set();
    let busyJobs = 0;
    for (const scope of [undefined, ...live]) {
      let listed = [];
      try { listed = jobs.list(scope ? scope.id : undefined) || []; } catch { listed = []; }
      for (const job of listed) {
        if (!job || (job.status !== 'running' && job.status !== 'stopping')) continue;
        const key = job.id === undefined || job.id === null ? job : `id:${job.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        busyJobs += 1;
      }
    }
    return { available: true, active: busyAgents.length + busyJobs > 0, tasks: busyAgents.length, jobs: busyJobs };
  } catch {
    return idle;
  }
}

/**
 * The plugin manager writes `<profile>/.plugin-manager/run.json` while an
 * install runs. A dead pid means a crashed install left the file behind; that
 * must not lock the button forever.
 * @returns {{locked:boolean, pid?:number}}
 */
export function inspectInstallLock(profileDir, { fs = { existsSync, readFileSync, rmSync }, kill = (pid) => process.kill(pid, 0) } = {}) {
  if (typeof profileDir !== 'string' || !profileDir) return { locked: false };
  const runFile = path.join(profileDir, '.plugin-manager', 'run.json');
  try {
    if (!fs.existsSync(runFile)) return { locked: false };
  } catch {
    return { locked: false };
  }
  let record;
  try {
    record = JSON.parse(fs.readFileSync(runFile, 'utf8'));
  } catch {
    return { locked: false };
  }
  const pid = Number(record?.pid);
  if (!Number.isSafeInteger(pid) || pid <= 0) return { locked: false };
  let alive = false;
  try { kill(pid); alive = true; } catch (error) { alive = error?.code === 'EPERM'; }
  if (alive) return { locked: true, pid };
  try { fs.rmSync(runFile, { force: true }); } catch { /* stale lock, ignore */ }
  return { locked: false };
}
