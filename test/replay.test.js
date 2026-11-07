import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const script = fileURLToPath(new URL('../scripts/check-openclaw-compat.js', import.meta.url));

test('feedback replay check requires a repository and exact commit pin', () => {
  for (const args of [[], ['.', 'main'], ['.', '--help'], ['.', 'a'.repeat(40), 'extra']]) {
    const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Usage:.*40-character commit/);
  }
});

test('feedback replay check rejects a revision absent from the selected repository', () => {
  const result = spawnSync(process.execPath, [script, '.', '0'.repeat(40)], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  const report = JSON.parse(result.stdout);
  assert.equal(report.compatible, false);
  assert.match(report.errors.join(' '), /revision unavailable/);
});
