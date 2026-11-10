// The guest package's Host entry. A Guest Web Host runs this plugin and nothing
// else of the workspace framework: it registers cross-Host session routes,
// publishes its Host card, and offers a self-restart.
//
// The Desktop Shell must not load this entry — it imports
// `dsh-workspace-guest/session-host` directly for session discovery, and a
// Desktop Host has no card to publish and no restart to offer.

import { apply as applySessionHost, inject } from './session-host/index.js';
import { applyHostLifecycle } from './src/host/host-lifecycle.js';

export { inject };

export async function apply(ctx) {
  await applySessionHost(ctx);
  await applyHostLifecycle(ctx);
}
