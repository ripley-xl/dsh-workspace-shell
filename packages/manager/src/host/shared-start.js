import { operationCancelled } from './ssh/errors.js';

/**
 * One background start shared by several waiters (for example an SSH session
 * used by multiple Web profiles). Each waiter observes its own signal; the
 * shared work is only aborted once every waiter has given up.
 */
export class SharedStart {
  constructor(factory) {
    this.controller = new AbortController();
    this.waiters = new Set();
    this.settled = false;
    this.promise = Promise.resolve().then(() => factory(this.controller.signal));
    const settle = () => { this.settled = true; };
    this.promise.then(settle, settle);
    this.promise.catch(() => {});
  }

  get waiterCount() {
    return this.waiters.size;
  }

  abort(reason) {
    if (this.settled) return;
    for (const waiter of [...this.waiters]) waiter.abandon(reason ?? operationCancelled());
    if (this.waiters.size === 0) this.controller.abort(reason ?? operationCancelled());
  }

  join(signal) {
    const waiter = { abandon: null };
    this.waiters.add(waiter);
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = () => {
        done = true;
        this.waiters.delete(waiter);
        signal?.removeEventListener('abort', onAbort);
      };
      const fail = (error) => {
        if (done) return;
        finish();
        reject(error);
      };
      const onAbort = () => {
        fail(operationCancelled(signal));
        // Only the final waiter cancels the shared work.
        if (this.waiters.size === 0 && !this.settled) this.controller.abort(operationCancelled(signal));
      };
      waiter.abandon = (reason) => fail(reason);
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener('abort', onAbort, { once: true });
      this.promise.then(
        (value) => {
          if (done) return;
          finish();
          resolve(value);
        },
        (error) => {
          if (done) return;
          finish();
          reject(error);
        },
      );
    });
  }
}
