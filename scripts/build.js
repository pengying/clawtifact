import { build } from 'esbuild';
await build({ entryPoints: ['web/reader.js', 'web/claim.js', 'web/style.css', 'web/feedback.js', 'web/feedback.css', 'web/bridge.js'], bundle: true, outdir: 'dist', format: 'esm', minify: true, target: 'es2022', logLevel: 'info' });
