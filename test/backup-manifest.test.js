import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
test('durable plugin state and pre-migration checkpoints are declared for host backups',()=>{
 const manifest=JSON.parse(readFileSync(new URL('../openclaw.plugin.json',import.meta.url)));
 assert.deepEqual(manifest.backupResources,[{disposition:'include',scope:'state',relativePath:'artifacts'}]);
 assert.equal(manifest.generationOverlap,undefined,'migration service must not overlap previous SQLite writer');
 for(const name of ['artifact_update','artifact_inspect','artifact_message'])assert.ok(manifest.contracts.tools.includes(name));
});
