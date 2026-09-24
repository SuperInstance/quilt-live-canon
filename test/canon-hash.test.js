// test/canon-hash.test.js — the drift-closure contract for the worker surface.
// The embedded CANON must hash (under the worker's dial-serialization stateHash)
// to the fleet canon target. On 2026-09-23 the dial-hash of the 71-paper corpus
// was MEASURED to equal the package-surface canonical target — one target holds
// across all four surfaces (npm / pypi / gh / worker). If this fails, the drift
// front is OPEN again.
// Run: node test/canon-hash.test.js   (or: node --test test/)
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { stateHash, CANON } = require('../worker.js');

const CANON_TARGET = '0x445185a3a99fd2e7';
const n = Object.keys(CANON).length;
const h = stateHash(CANON);

console.log(`papers: ${n}`);
console.log(`worker state_hash: ${h}`);
console.log(`canon_target:      ${CANON_TARGET}`);

assert.strictEqual(n, 71, `corpus incomplete: ${n} papers embedded, expected 71`);
assert.strictEqual(h, CANON_TARGET, `FAIL — drift front open: worker surface ${h} ≠ ${CANON_TARGET}`);

// the API/HTML/client constants must serve the SAME target (no stranded pins)
const src = fs.readFileSync(path.join(__dirname, '..', 'worker.js'), 'utf8');
const served = src.match(/canon_target:\s*"([^"]+)"/);
assert.ok(served, 'worker serves a canon_target constant');
assert.strictEqual(served[1], CANON_TARGET, `served canon_target ${served[1]} is stranded — retarget to ${CANON_TARGET}`);
const targetRefs = src.split(CANON_TARGET).length - 1;
assert.ok(targetRefs >= 4, `target should appear in API + HTML + client constant + this doc (${targetRefs} refs)`);

console.log('PASS — worker surface equals the fleet canon target (all four surfaces one hash).');
