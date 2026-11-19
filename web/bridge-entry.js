import './bridge.js';
import { initializeSnapshotBridge } from './snapshot.js';
// Bundled as a classic, server-owned script in the existing sandbox. No cookies,
// channel routes, CSRF, storage or new network permission are passed to it.
try { initializeSnapshotBridge({ origin: new URL(document.currentScript.src).origin }); } catch { /* Parent reports capture unavailable after its bounded wait. */ }
