// canon-hash.test.mjs — the drift-closure contract.
// The bundled CANON must hash (under the worker's own stateHash) to the
// declared canon_target. If this fails, the drift front is OPEN again.
// Run: node test/canon-hash.test.mjs
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../worker.js', import.meta.url), 'utf8');
const grab = (name) => {
  const i = src.indexOf('const ' + name);
  let depth = 0;
  const j = src.indexOf('{', i);
  for (let k = j; k < src.length; k++) {
    if (src[k] === '{') depth++;
    if (src[k] === '}') { depth--; if (!depth) return src.slice(i, k + 1); }
  }
};
const fns = ['fnv1a_64', 'fnv1a_64_bytes', 'cellToDials', 'serializeCell', 'stateHash']
  .map(n => src.match(new RegExp(`function ${n}\\([\\s\\S]*?\\n\\}`, 'm'))[0]).join('\n');
const canonBlock = grab('CANON');
const target = src.match(/canon_target:\s*"(0x[0-9a-f]{16})"/)[1];

const { stateHash, CANON } = new Function(`${fns}\n${canonBlock}\nreturn { stateHash, CANON };`)();
const n = Object.keys(CANON).length;
const h = stateHash(CANON);

console.log(`papers: ${n}`);
console.log(`state_hash:   ${h}`);
console.log(`canon_target: ${target}`);
if (h !== target) {
  console.error(`FAIL — drift front open: ${h} ≠ ${target}`);
  process.exit(1);
}
if (n < 71) {
  console.error(`FAIL — corpus incomplete: ${n} papers bundled, ≥71 committed`);
  process.exit(1);
}
console.log('PASS — live state equals canon target; the front is closed by convergence.');
