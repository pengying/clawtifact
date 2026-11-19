import { build } from 'esbuild';
const common = { bundle: true, outdir: 'dist', minify: true, target: 'es2022', logLevel: 'info' };
await build({ ...common, entryPoints: ['web/reader.js', 'web/claim.js', 'web/style.css', 'web/feedback.js', 'web/feedback.css'], format: 'esm' });
// This script is loaded as classic inside authored pages, not as a module.
// Isolate ALL bundled dependencies from the author's global lexical scope.
await build({ ...common, entryPoints: [{ in: 'web/bridge-entry.js', out: 'bridge' }], format: 'iife' });

// Offline React dependencies are isolated from authored lexical bindings, and
// exposed only through mount's explicit local require allowlist.
await build({ ...common, entryPoints: ['web/react-runtime.js'], format: 'iife', globalName: 'ClawtifactReactRuntime', define: { 'process.env.NODE_ENV': '"production"' } });
