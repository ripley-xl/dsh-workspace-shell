// The guest package's Host side registers the cross-Host Session routes on this
// Web Host. It has no frame, tab, notification surface, or SSH responsibilities.
export { apply, inject } from './session-host/index.js';
