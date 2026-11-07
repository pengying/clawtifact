// Read-only source declaration gate. Run the core owner's boundary tests as well.
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const [repository, revision, ...extra] = process.argv.slice(2);
if (!repository || !/^[a-f0-9]{40}$/i.test(revision ?? '') || extra.length) {
  console.error('Usage: node scripts/check-openclaw-compat.js <OpenClaw Git repository> <40-character commit>');
  process.exit(2);
}
const report = { repository: resolve(repository), revision: revision.toLowerCase(), compatible: false, checks: [], errors: [] };
const git = args => execFileSync('git', ['-C', report.repository, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 2 * 1024 * 1024 });
try {
  if (git(['rev-parse', '--verify', `${report.revision}^{commit}`]).trim() !== report.revision) throw new Error();
} catch {
  report.errors.push('Exact core revision unavailable in the selected Git repository');
}
if (!report.errors.length) {
  const contracts = [
    ['src/plugins/runtime/types-core.ts', [
      ['public target capture', /captureSessionEventTarget\s*:\s*typeof\s+import\(/],
      ['public immediate event enqueue', /enqueueSessionEvent\s*:\s*typeof\s+import\(/],
    ]],
    ['src/plugins/runtime/runtime-session-events.ts', [
      ['opaque expected target option', /expectedTarget\??\s*:\s*SessionEventTarget\b/],
    ]],
    ['src/auto-reply/reply/session-event-contract.ts', [
      ['admission receipt', /accepted\s*:\s*Promise</],
      ['settlement receipt', /settled\s*:\s*Promise</],
      ['confirmed delivery state', /delivered\s*:\s*boolean\b/],
      ['ambiguous delivery state', /deliveryAmbiguous\??\s*:\s*boolean\b/],
    ]],
  ];
  for (const [path, checks] of contracts) {
    let source;
    try { source = git(['show', `${report.revision}:${path}`]); }
    catch { report.errors.push(`Missing SDK contract source: ${path}`); continue; }
    for (const [name, pattern] of checks) {
      const present = pattern.test(source);
      report.checks.push({ name, present });
      if (!present) report.errors.push(`Missing ${name} declaration (${path})`);
    }
  }
}
report.compatible = report.errors.length === 0;
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.compatible ? 0 : 1;
