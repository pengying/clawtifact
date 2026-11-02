import { build } from 'esbuild';
await build({ entryPoints: ['web/reader.js', 'web/claim.js', 'web/style.css'], bundle: true, outdir: 'dist', format: 'esm', minify: true, target: 'es2022', logLevel: 'info' });
