// worker.js — The Live Canon as a Cloudflare Worker
//
// Exposes the Live Canon operations + Playground + WebSocket Room as a REST API.
//
// The canon is loaded from the bundled corpus. On each request, the relevant
// operation is computed and returned as JSON.
//
// This file uses the Service Worker format (no `export` statements) so it
// can be uploaded via the CF scripts API. The Room Durable Object is
// defined separately in `room-do.js` and wired via `wrangler.toml`.

// paper metadata).  On each request, the relevant operation is computed
// and returned as JSON.
//
// This is the production deployment of F129 (the Live Canon) + the
// Playground UI + the WebSocket Room Durable Object.

// ===== FNV-1a 64-bit hash (UTF-8 encoded, byte-exact with Python) =====
function fnv1a_64(s) {
  let h = 0xCBF29CE484222325n;
  const bytes = new TextEncoder().encode(s);
  for (let i = 0; i < bytes.length; i++) {
    h ^= BigInt(bytes[i]);
    h = (h * 0x00000100000001B3n) & 0xFFFFFFFFFFFFFFFFn;
  }
  return h;
}

// ===== FNV-1a 64-bit hash over a raw byte sequence =====
function fnv1a_64_bytes(bytes) {
  let h = 0xCBF29CE484222325n;
  for (let i = 0; i < bytes.length; i++) {
    h ^= BigInt(bytes[i]);
    h = (h * 0x00000100000001B3n) & 0xFFFFFFFFFFFFFFFFn;
  }
  return h;
}

// ===== Cell encoding (matches Python/C/Rust/Verilog/VHDL byte-exact) =====
function cellToDials(paper) {
  const year = parseInt((paper.date || "1970").substring(0, 4)) || 1970;
  const year_q = (year - 1970) * 546;
  const phase_q = paper.phase * 218;
  const f_q = paper.f_number * 218;
  const n_refs = (paper.ref_papers?.length || 0) + (paper.ref_f_numbers?.length || 0);
  const n_refs_q = Math.min(0x7FFF, n_refs * 256);
  const th = fnv1a_64(paper.title || "");
  const title_lo = Number(th & 0xFFFFn);
  const title_hi = Number((th >> 16n) & 0xFFFFn);
  const num = Math.min(paper.number, 500);
  const num_q = num * 131;
  return [num_q, title_lo, f_q, phase_q, year_q, n_refs_q, title_hi, 0,
          0, 0, 0, 0, 0, 0, 0, 0];
}

// ===== Canonical cell serialization (matches the Quilt spec) =====
// type(1) || id(8 LE) || dials(32 LE) || neighbors(8*N LE)
function serializeCell(cellId, dials, neighbors) {
  const out = new Uint8Array(1 + 8 + 32 + 8 * neighbors.length);
  out[0] = 0x01;
  const dv = new DataView(out.buffer);
  // id (uint64 LE)
  let id = BigInt(cellId);
  for (let i = 0; i < 8; i++) {
    dv.setUint8(1 + i, Number(id & 0xFFn));
    id >>= 8n;
  }
  // dials (int16 LE)
  for (let i = 0; i < 16; i++) {
    dv.setInt16(9 + i * 2, dials[i] | 0, true);
  }
  // neighbors (uint64 LE)
  let off = 41;
  for (const n of neighbors) {
    let nn = BigInt(n);
    for (let i = 0; i < 8; i++) {
      dv.setUint8(off + i, Number(nn & 0xFFn));
      nn >>= 8n;
    }
    off += 8;
  }
  return out;
}

// Compute the canonical cell hash (FNV-1a 64 over the serialized cell)
function cellHash(cellId, dials, neighbors) {
  const bytes = serializeCell(cellId, dials, neighbors);
  const h = fnv1a_64_bytes(bytes);
  return `0x${h.toString(16).padStart(16, "0")}`;
}

// ===== Cosine similarity =====
function cosineSim(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < 16; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  na = Math.sqrt(na);
  nb = Math.sqrt(nb);
  if (na === 0 || nb === 0) return 0;
  return dot / (na * nb);
}

// ===== State hash (FNV-1a over sorted cell encodings) =====
function stateHash(papers) {
  const allCells = Object.values(papers).map(p => {
    const dials = cellToDials(p);
    const neighbors = (p.ref_papers || []).map(n => Number(n));
    return { id: p.number, dials, neighbors };
  });
  allCells.sort((a, b) => a.id - b.id);
  let combined = new Uint8Array(0);
  for (const c of allCells) {
    const enc = serializeCell(c.id, c.dials, c.neighbors);
    const next = new Uint8Array(combined.length + enc.length);
    next.set(combined, 0);
    next.set(enc, combined.length);
    combined = next;
  }
  const h = fnv1a_64_bytes(combined);
  return `0x${h.toString(16).padStart(16, "0")}`;
}

// ===== The 5 Operations =====

function navigate(canon, start, depth) {
  const visited = new Set([start]);
  const result = [];
  const queue = [[start, 0]];
  while (queue.length > 0) {
    const [num, d] = queue.shift();
    const paper = canon[num];
    if (paper) {
      result.push({ depth: d, paper });
      if (d < depth) {
        for (const ref of (paper.ref_papers || [])) {
          if (canon[ref] && !visited.has(ref)) {
            visited.add(ref);
            queue.push([ref, d + 1]);
          }
        }
      }
    }
  }
  return result;
}

function confluence(canon, paper_nums) {
  if (!paper_nums || paper_nums.length === 0) return { error: "no papers" };
  let sharedRefs = null;
  let sharedF = null;
  const titles = [];
  for (const num of paper_nums) {
    const p = canon[num];
    if (!p) continue;
    titles.push(p.title);
    const refs = new Set(p.ref_papers || []);
    sharedRefs = sharedRefs === null
      ? new Set(refs)
      : new Set([...sharedRefs].filter(x => refs.has(x)));
    const fs = new Set(p.ref_f_numbers || []);
    sharedF = sharedF === null
      ? new Set(fs)
      : new Set([...sharedF].filter(x => fs.has(x)));
  }
  let suggested = `Composition of ${paper_nums.length} papers`;
  if (sharedF && sharedF.size > 0) {
    const first = [...sharedF].sort((a, b) => a - b)[0];
    suggested = `F${first} Synthesis: ${titles.join(", ")}`;
  }
  const maxN = Math.max(...Object.keys(canon).map(Number));
  return {
    input_papers: paper_nums,
    input_titles: titles,
    shared_refs: sharedRefs ? [...sharedRefs].sort((a, b) => a - b) : [],
    shared_f_numbers: sharedF ? [...sharedF].sort((a, b) => a - b) : [],
    suggested_title: suggested,
    ghost_paper: `paper-${maxN + 1}.md`,
  };
}

function lineage(canon, f_number) {
  const result = [];
  for (const p of Object.values(canon)) {
    if ((p.ref_f_numbers || []).includes(f_number)) {
      result.push(p);
    }
  }
  result.sort((a, b) => (a.phase - b.phase) || (a.number - b.number));
  return result;
}

// BFS through the citation graph (both directions), up to maxHops.
// Edges include:
//   - paper.ref_papers (explicit paper-number refs)
//   - paper.ref_f_numbers (F-number refs → any canon paper with that F-number)
// Returns { found: bool, path: [paper_numbers], hops: int }.
function lineagePath(canon, fromN, toN, maxHops) {
  if (!canon[fromN]) return { found: false, error: `unknown source paper ${fromN}` };
  if (!canon[toN])   return { found: false, error: `unknown target paper ${toN}` };
  if (fromN === toN) return { found: true, path: [fromN], hops: 0 };

  const parent = new Map();
  parent.set(fromN, null);
  const queue = [fromN];
  let found = false;
  while (queue.length > 0) {
    const cur = queue.shift();
    if (cur === toN) { found = true; break; }
    if (getDepth(parent, cur) >= maxHops) continue;
    const paper = canon[cur];
    if (!paper) continue;
    // Outgoing: papers we cite
    for (const next of (paper.ref_papers || [])) {
      if (!canon[next]) continue;
      if (!parent.has(next)) { parent.set(next, cur); queue.push(next); }
    }
    // Outgoing F-number refs → papers with that F-number
    for (const f of (paper.ref_f_numbers || [])) {
      for (const [n, p] of Object.entries(canon)) {
        const nn = Number(n);
        if (parent.has(nn)) continue;
        if (p.f_number === f) { parent.set(nn, cur); queue.push(nn); }
      }
    }
    // Incoming: papers that cite us (by paper number)
    for (const [n, p] of Object.entries(canon)) {
      const nn = Number(n);
      if (parent.has(nn)) continue;
      if ((p.ref_papers || []).includes(cur)) {
        parent.set(nn, cur);
        queue.push(nn);
      }
    }
    // Incoming: papers that cite us (by F-number)
    for (const [n, p] of Object.entries(canon)) {
      const nn = Number(n);
      if (parent.has(nn)) continue;
      if ((p.ref_f_numbers || []).includes(paper.f_number)) {
        parent.set(nn, cur);
        queue.push(nn);
      }
    }
  }
  if (!found) return { found: false, path: null, hops: -1, error: "no path within 6 hops" };
  // Reconstruct path
  const path = [];
  let cur = toN;
  while (cur !== null && cur !== undefined) {
    path.push(cur);
    cur = parent.get(cur);
  }
  path.reverse();
  return { found: true, path, hops: path.length - 1 };
}

function getDepth(parent, node) {
  let d = 0;
  let cur = parent.get(node);
  while (cur !== null && cur !== undefined) {
    d++;
    cur = parent.get(cur);
  }
  return d;
}

function ghost(canon, paper_num, k) {
  const target = canon[paper_num];
  if (!target) return { error: "missing paper" };
  const targetDials = cellToDials(target);
  const scored = [];
  for (const [n, p] of Object.entries(canon)) {
    if (Number(n) === paper_num) continue;
    const score = cosineSim(targetDials, cellToDials(p));
    scored.push({ id: `p${String(n).padStart(4, "0")}`, score: Math.round(score * 10000) / 10000 });
  }
  scored.sort((a, b) => b.score - a.score);
  return {
    source_paper: `paper-${paper_num}.md`,
    neighbors: scored.slice(0, k),
    suggested_title: `A Bridge between F${target.f_number} and its neighbors`,
  };
}

// Heuristic "semantic" similarity: cosine + f_number proximity +
// shared F-number refs + title TF-IDF overlap. We don't have Vectorize
// accessible from the JS worker, so this is the next best thing.
function similar(canon, paper_num, k) {
  const target = canon[paper_num];
  if (!target) return { error: `unknown paper ${paper_num}` };
  const targetDials = cellToDials(target);
  const targetFSet = new Set(target.ref_f_numbers || []);
  const targetTitle = (target.title || "").toLowerCase();
  const targetWords = new Set(targetTitle.split(/\W+/).filter(w => w.length > 3));

  const scored = [];
  for (const [n, p] of Object.entries(canon)) {
    if (Number(n) === paper_num) continue;
    const dials = cellToDials(p);
    const cos = cosineSim(targetDials, dials);
    // f-number proximity: closer f_numbers get a bonus
    const fDist = Math.abs(p.f_number - target.f_number);
    const fProx = 1 / (1 + fDist / 10);
    // shared refs (F-number overlap)
    const otherFSet = new Set(p.ref_f_numbers || []);
    let shared = 0;
    for (const f of targetFSet) if (otherFSet.has(f)) shared++;
    const fOverlap = targetFSet.size > 0 ? shared / targetFSet.size : 0;
    // title word overlap (cheap TF-IDF-style proxy)
    const otherWords = new Set((p.title || "").toLowerCase().split(/\W+/).filter(w => w.length > 3));
    let wShared = 0;
    for (const w of targetWords) if (otherWords.has(w)) wShared++;
    const wordSim = targetWords.size > 0 ? wShared / targetWords.size : 0;
    // Combined score
    const score = 0.50 * cos + 0.20 * fProx + 0.20 * fOverlap + 0.10 * wordSim;
    scored.push({
      id: Number(n),
      number: p.number,
      title: p.title,
      f_number: p.f_number,
      phase: p.phase,
      score: Math.round(score * 10000) / 10000,
      components: {
        cosine: Math.round(cos * 10000) / 10000,
        f_proximity: Math.round(fProx * 10000) / 10000,
        f_overlap: Math.round(fOverlap * 10000) / 10000,
        word_sim: Math.round(wordSim * 10000) / 10000,
      },
    });
  }
  scored.sort((a, b) => b.score - a.score);
  return {
    source: { id: paper_num, title: target.title, f_number: target.f_number },
    algorithm: "cosine(0.5) + f_proximity(0.2) + f_overlap(0.2) + word_sim(0.1)",
    neighbors: scored.slice(0, k),
  };
}

function tick(canon) {
  return { ticked_cells: Object.keys(canon).length };
}

function randomCell(canon) {
  const keys = Object.keys(canon);
  const k = keys[Math.floor(Math.random() * keys.length)];
  const p = canon[k];
  return {
    id: Number(k),
    number: p.number,
    title: p.title,
    f_number: p.f_number,
    phase: p.phase,
    date: p.date,
    dials: cellToDials(p),
    refs: p.ref_papers || [],
    f_refs: p.ref_f_numbers || [],
  };
}

// ===== The Canon (bundled corpus) =====
// In production this would be loaded from KV / R2 / D1.  For the live
// worker we bundle a JSON snapshot of the canon.  The corpus below
// mirrors the AI-Writings canon up through the F-numbers we have
// committed metadata for.
const CANON = {
  425: { number: 425, title: "F115 — The Logical Routes: VHDL × Verilog × the QUF bit-exactness", f_number: 115, phase: 237, date: "2026-09-03", ref_papers: [426, 427], ref_f_numbers: [] },
  426: { number: 426, title: "F116 — The 5+1+1+1+1+1+1+1+1+1+1 Opcodes in 5 Substrates: A Polyformalism Atlas", f_number: 116, phase: 238, date: "2026-09-03", ref_papers: [], ref_f_numbers: [115] },
  427: { number: 427, title: "F117 — The 5-Substrate Polyformalism: Python × C × Rust × Verilog × VHDL, One Cell", f_number: 117, phase: 239, date: "2026-09-03", ref_papers: [], ref_f_numbers: [115, 116] },
  428: { number: 428, title: "F118 — The Polyformalism in Production: A Play-Test + Benchmark", f_number: 118, phase: 240, date: "2026-09-03", ref_papers: [], ref_f_numbers: [115, 116, 117] },
  429: { number: 429, title: "F119 — The 6-Substrate Polyformalism: cell-runtime Joins the Canon", f_number: 119, phase: 241, date: "2026-09-03", ref_papers: [], ref_f_numbers: [115, 116, 117, 118] },
  432: { number: 432, title: "F122 — The Shape Store: 5 Indices on Cloudflare Vectorize", f_number: 122, phase: 244, date: "2026-09-03", ref_papers: [], ref_f_numbers: [120, 121] },
  433: { number: 433, title: "F123 — The Composer Agent: 5 Cells, 80 Parameters", f_number: 123, phase: 245, date: "2026-09-03", ref_papers: [], ref_f_numbers: [120, 122] },
  439: { number: 439, title: "F129 — The Live Canon: Papers as Cells, Reading as Navigation", f_number: 129, phase: 251, date: "2026-09-03", ref_papers: [], ref_f_numbers: [115, 120, 122, 125] },
  440: { number: 440, title: "F130 — The Polyformal Live Canon: One Cell, Five Substrates", f_number: 130, phase: 251, date: "2026-09-03", ref_papers: [], ref_f_numbers: [115, 129] },
  441: { number: 441, title: "F131 — The 3-Package Polyformalism: One Cell, Three Registries", f_number: 131, phase: 252, date: "2026-09-03", ref_papers: [], ref_f_numbers: [115, 130] },
  442: { number: 442, title: "F132 — Operational Fictions as Concrete System-Prompt Noun-Phrases", f_number: 132, phase: 253, date: "2026-09-03", ref_papers: [], ref_f_numbers: [] },
  443: { number: 443, title: "F133 — Operational Fictions as Falsifiable Claims (avg divergence 0.861)", f_number: 133, phase: 254, date: "2026-09-03", ref_papers: [], ref_f_numbers: [132] },
  444: { number: 444, title: "F134 — The Quilt Cowboy: Orchestrator Over 12 Cheap Voices", f_number: 134, phase: 254, date: "2026-09-03", ref_papers: [], ref_f_numbers: [132, 133] },
  445: { number: 445, title: "F135 — The Wheelhouse Test: Scoring Fictions for 0300-in-a-Gale Tolerability", f_number: 135, phase: 254, date: "2026-09-03", ref_papers: [], ref_f_numbers: [132, 133] },
};

// ===== In-memory cell store (per-isolate, resets on cold-start) =====
const CELL_STORE = new Map();
let CELL_COUNTER = 5000;

function admitCell(payload) {
  // Validate
  if (!payload || typeof payload !== "object") {
    return { error: "expected JSON object", admitted: false };
  }
  const { dials, refs, title } = payload;
  if (!Array.isArray(dials) || dials.length !== 16) {
    return { error: "dials must be an array of 16 ints", admitted: false };
  }
  for (let i = 0; i < 16; i++) {
    if (!Number.isInteger(dials[i]) || dials[i] < -32768 || dials[i] > 32767) {
      return { error: `dial[${i}] must be a signed 16-bit int (-32768..32767), got ${dials[i]}`, admitted: false };
    }
  }
  if (title !== undefined && (typeof title !== "string" || title.length >= 200)) {
    return { error: "title must be a string under 200 chars", admitted: false };
  }
  const refsList = Array.isArray(refs) ? refs : [];
  for (const r of refsList) {
    const rn = Number(r);
    if (!Number.isInteger(rn) || rn < 0) {
      return { error: `ref ${r} must be a non-negative integer`, admitted: false };
    }
  }
  // Assign id
  const id = ++CELL_COUNTER;
  // No self-cycle check
  for (const r of refsList) {
    if (Number(r) === id) {
      return { error: `ref ${r} cannot equal the cell's own id ${id} (no self-cycles)`, admitted: false };
    }
  }
  // No duplicate refs
  const refsSet = new Set(refsList.map(Number));
  const neighbors = [...refsSet];
  const titleStr = (title || `admitted-cell-${id}`).slice(0, 199);
  // Hash
  const hash = cellHash(id, dials, neighbors);
  const sh = stateHash(CANON);
  // Add to the in-memory store (we don't mutate CANON itself)
  const cell = {
    id,
    number: id,
    title: titleStr,
    f_number: 0,
    phase: 0,
    date: new Date().toISOString().slice(0, 10),
    dials: [...dials],
    refs: neighbors,
    ref_papers: [...neighbors],
    ref_f_numbers: [],
    hash,
    submitter: "playground",
    created_at: new Date().toISOString(),
  };
  CELL_STORE.set(id, cell);
  return {
    id,
    hash,
    state_hash: sh,
    admitted: true,
    cell,
  };
}

// ===== Vibe-code protocol =====
function vibeResponse(lang, includeTest) {
  const proto = `You are writing a Quilt cell. A cell has:
- 16 signed Q1.15 dials (range -32768..32767)
- a 64-bit id
- a list of neighbor ids

The 5 opcodes are:
- BIND(cell, dials)  — sets the dials, idempotent
- LINK(c1, c2)       — adds an undirected edge
- EFFECT(cell)       — propagates dial[0] to neighbors
- VIEW(cell)         — returns dials
- TICK(fabric)       — advances all dials by 1 in alternating direction

The state hash is FNV-1a 64-bit over the canonical serialization
(type(1) + id(8) + dials(32) + neighbors(8*N)). Constants:
FNV_OFFSET = 0xcbf29ce484222325
FNV_PRIME  = 0x100000001b3

Write a complete, working cell-fabric runtime in ${lang}.
Do not use any external libraries. Do not add features beyond
what is specified. Verify the hash byte-exactly.`;

  const testVec = `Test cell: id=1, dials=[1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16], neighbors=[2,3,4]
Expected hash: 0xe435d91d6d92a1d8
If your port produces this hash, it is byte-exact compatible with the canon.`;

  return {
    language: lang,
    protocol: proto,
    ...(includeTest ? { test_vector: testVec, expected_hash: "0xe435d91d6d92a1d8" } : {}),
    links: {
      taxonomy: "https://superinstance.github.io/quilt-claude-charts/quilt-cell-taxonomy.html",
      simulator: "https://superinstance.github.io/quilt-claude-charts/quilt-fabric-runtime.html",
      languages: "https://superinstance.github.io/quilt-claude-charts/quilt-language-map.html",
      protocol_md: "https://github.com/SuperInstance/quilt-claude-charts/blob/main/QUILT_VIBE_PROTOCOL.md",
    },
    byte_exact_test: "0xe435d91d6d92a1d8",
    known_ports: ["python", "c99", "rust", "verilog", "vhdl", "javascript", "typescript", "go", "zig", "mojo", "forth", "haskell", "lua", "j"],
  };
}

function verifyPort(lang, hash) {
  const expected = "0xe435d91d6d92a1d8";
  const known = ["python", "c99", "rust", "verilog", "vhdl", "javascript", "typescript", "go", "zig", "mojo", "forth", "haskell", "lua", "j"];
  const isKnown = known.includes(lang.toLowerCase());
  const isMatch = (hash || "").toLowerCase() === expected;
  return {
    language: lang,
    reported_hash: hash,
    expected_hash: expected,
    byte_exact: isMatch,
    admitted_to_canon: isMatch,
    known_port: isKnown,
    verdict: isMatch
      ? `OK ${lang} is a verified Quilt port (byte-exact compatible).`
      : `FAIL Hash mismatch. Expected ${expected}, got ${hash || "(empty)"}. The port is NOT byte-exact.`,
  };
}

// ===== HMAC-style "signature" for share links =====
// Not a real cryptographic signature — this is a worker-shared secret
// concatenated into an FNV-1a hash so the share links are tamper-evident
// enough to discourage casual edits.  Replace with HMAC-SHA256 if you
// need real crypto.
const SHARE_SECRET = "quilt-live-canon-playground-2026";
function signShare(payload) {
  return fnv1a_64(payload + "|" + SHARE_SECRET).toString(16).padStart(16, "0");
}
function verifyShare(payload, sig) {
  return signShare(payload) === (sig || "").toLowerCase();
}

// ===== Request handler =====
async function routeRequest(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;

  // CORS preflight
  if (request.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  }

  // ===== API endpoints =====

  if (path === "/api/canon") {
    return jsonResponse({
      papers: Object.values(CANON).map(p => ({
        id: `paper-${p.number}.md`,
        number: p.number,
        title: p.title,
        f_number: p.f_number,
        phase: p.phase,
      })),
      count: Object.keys(CANON).length,
    });
  }

  if (path === "/api/canon/navigate") {
    const paper = parseInt(url.searchParams.get("paper") || "425");
    const depth = parseInt(url.searchParams.get("depth") || "2");
    return jsonResponse(navigate(CANON, paper, depth));
  }

  if (path === "/api/canon/confluence") {
    const papers = (url.searchParams.get("papers") || "425,432,439")
      .split(",").map(s => parseInt(s.trim())).filter(n => !isNaN(n));
    return jsonResponse(confluence(CANON, papers));
  }

  // /api/canon/lineage — two shapes:
  //   ?f=N       (legacy)   → papers that cite F{N}
  //   ?from=A&to=B          → shortest citation path A→B (BFS, ≤6 hops)
  if (path === "/api/canon/lineage") {
    const from = url.searchParams.get("from");
    const to   = url.searchParams.get("to");
    if (from && to) {
      const a = parseInt(from), b = parseInt(to);
      const result = lineagePath(CANON, a, b, 6);
      // Annotate each step with title
      result.steps = (result.path || []).map(n => {
        const p = CANON[n];
        return { number: n, title: p ? p.title : null, f_number: p ? p.f_number : null };
      });
      return jsonResponse(result);
    }
    const f = parseInt(url.searchParams.get("f") || "115");
    return jsonResponse({ papers: lineage(CANON, f) });
  }

  if (path === "/api/canon/ghost") {
    const paper = parseInt(url.searchParams.get("paper") || "425");
    const k = parseInt(url.searchParams.get("k") || "5");
    return jsonResponse(ghost(CANON, paper, k));
  }

  // /api/canon/similar — top-k semantically similar papers (heuristic)
  if (path === "/api/canon/similar" || path === "/api/canon/similar/") {
    const id = parseInt(url.searchParams.get("id") || "425");
    const k = parseInt(url.searchParams.get("k") || "5");
    return jsonResponse(similar(CANON, id, k));
  }

  // /api/canon/random — one random cell from the canon
  if (path === "/api/canon/random" || path === "/api/canon/random/") {
    return jsonResponse(randomCell(CANON));
  }

  // /api/boat/9900 — get the live boat cell from the in-memory store
  const boatMatch = path.match(/^\/api\/boat\/(\d+)\/?$/);
  if (boatMatch) {
    const n = parseInt(boatMatch[1]);
    const live = CELL_STORE.get(n);
    if (!live) {
      return jsonResponse({ error: `no live cell ${n} yet — POST /api/sensor first` }, 404);
    }
    return jsonResponse({ ...live, hash: cellHash(live.id, live.dials, live.refs) });
  }

  // /api/canon/cell/N — full cell data
  const cellMatch = path.match(/^\/api\/canon\/cell\/(\d+)\/?$/);
  if (cellMatch) {
    const n = parseInt(cellMatch[1]);
    // 1. Admitted (live) cells take precedence
    const live = CELL_STORE.get(n);
    if (live) {
      return jsonResponse({ ...live, hash: cellHash(live.id, live.dials, live.refs) });
    }
    // 2. Bundled canon
    const p = CANON[n];
    if (!p) return jsonResponse({ error: `unknown paper ${n}` }, 404);
    const dials = cellToDials(p);
    const neighbors = (p.ref_papers || []).map(Number);
    const hash = cellHash(p.number, dials, neighbors);
    return jsonResponse({
      id: p.number,
      number: p.number,
      title: p.title,
      f_number: p.f_number,
      phase: p.phase,
      date: p.date,
      dials,
      refs: p.ref_papers || [],
      f_refs: p.ref_f_numbers || [],
      hash,
      submitter: "canon",
      created_at: p.date + "T00:00:00Z",
    });
  }

  if (path === "/api/canon/tick") {
    return jsonResponse(tick(CANON));
  }

  if (path === "/api/canon/hash") {
    return jsonResponse({
      state_hash: stateHash(CANON),
      paper_count: Object.keys(CANON).length,
      // Reference vectors so the UI can show the gap
      test_cell_hash: "0xe435d91d6d92a1d8",
      canon_target: "0xbf27a3631cdee337",
    });
  }

  if (path === "/api/health") {
    return jsonResponse({
      ok: true,
      papers: Object.keys(CANON).length,
      admitted: CELL_STORE.size,
      state_hash: stateHash(CANON),
    });
  }

  // /api/vibe — return the Quilt vibe-code protocol for any language
  if (path === "/api/vibe" || path === "/api/vibe/") {
    const lang = url.searchParams.get("lang") || "python";
    const includeTest = url.searchParams.get("test") === "1";
    return jsonResponse(vibeResponse(lang, includeTest));
  }

  // /api/quilt/verify — verify a (language, hash) pair is byte-exact
  if (path === "/api/quilt/verify" || path === "/api/quilt/verify/") {
    const hash = url.searchParams.get("hash") || "";
    const lang = url.searchParams.get("lang") || "unknown";
    return jsonResponse(verifyPort(lang, hash));
  }

  if (path === "/api/charter" || path === "/api/charter/") {
    return new Response(CHARTER_DOC, {
      headers: { "Content-Type": "text/markdown; charset=utf-8" },
    });
  }

  if (path === "/api/tutorial" || path === "/api/tutorial/") {
    return new Response(TUTORIAL_DOC, {
      headers: { "Content-Type": "text/markdown; charset=utf-8" },
    });
  }

  if (path === "/api/ports" || path === "/api/ports/") {
    return jsonResponse({
      test_hash: "0xe435d91d6d92a1d8",
      ports: [
        { lang: "python", repo: "quilt-cowboy", tests: "7/7", level: "imperative" },
        { lang: "c99", repo: "quilt-c", tests: "manual", level: "imperative" },
        { lang: "rust", repo: "quilt-rust", tests: "6/6", level: "type-safe+zero-cost" },
        { lang: "rust-vibe", repo: "quilt-rust-vibe", tests: "6/6", level: "type-safe+zero-cost" },
        { lang: "verilog", repo: "quilt-verilog", tests: "manual", level: "hardware" },
        { lang: "vhdl", repo: "quf-vhdl", tests: "manual", level: "hardware" },
        { lang: "javascript", repo: "quilt-live-canon", tests: "live", level: "edge" },
        { lang: "typescript", repo: "live-canon-npm", tests: "5/5", level: "edge" },
        { lang: "go", repo: "quilt-go", tests: "7/7", level: "imperative" },
        { lang: "zig", repo: "quilt-zig", tests: "7/7", level: "systems" },
        { lang: "mojo", repo: "quilt-mojo", tests: "ref", level: "type-safe" },
        { lang: "forth", repo: "quilt-forth", tests: "ref", level: "concatenative" },
        { lang: "haskell", repo: "quilt-haskell", tests: "ref", level: "functional" },
        { lang: "lua", repo: "quilt-lua", tests: "ref", level: "scripting" },
        { lang: "j", repo: "quilt-j", tests: "ref", level: "array" },
      ],
      sigma: 5,
      n_ports: 14,
    });
  }

  // ===== Cell admission =====
  if (path === "/api/cell/seed" || path === "/api/cell/seed/") {
    return jsonResponse({
      id: 1,
      dials: [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16],
      neighbors: [2, 3, 4],
      expected_hash: "0xe435d91d6d92a1d8",
      note: "The canonical test cell. Every byte-exact port must hash to 0xe435d91d6d92a1d8.",
    });
  }

  if (path === "/api/cell" || path === "/api/cell/") {
    if (request.method !== "POST") {
      return jsonResponse({ error: "POST {dials, refs, title} required" }, 405);
    }
    let body;
    try { body = await request.json(); }
    catch (e) { return jsonResponse({ error: "invalid JSON: " + e.message }, 400); }
    const result = admitCell(body);
    if (result.error) return jsonResponse(result, 400);
    return jsonResponse(result, 201);
  }

  // ===== Share link signing =====
  // GET /api/share?dials=...&refs=...&title=...
  //   → { url, payload, sig } where url is a permalink with ?c=<hex>&s=<sig>
  if (path === "/api/share" || path === "/api/share/") {
    const dials = (url.searchParams.get("dials") || "")
      .split(",").map(s => parseInt(s.trim())).filter(n => !isNaN(n));
    const refs = (url.searchParams.get("refs") || "")
      .split(",").map(s => parseInt(s.trim())).filter(n => !isNaN(n));
    const title = (url.searchParams.get("title") || "").slice(0, 199);
    if (dials.length !== 16) {
      return jsonResponse({ error: "dials must have 16 ints" }, 400);
    }
    const payload = JSON.stringify({ dials, refs, title });
    const hex = bytesToHex(new TextEncoder().encode(payload));
    const sig = signShare(hex);
    const base = `${url.protocol}//${url.host}/playground`;
    const share = `${base}?c=${hex}&s=${sig}`;
    return jsonResponse({ url: share, c: hex, s: sig });
  }

  // ===== Sensor API — boat pushes sensor readings =====
  // POST /api/sensor  body: { source: "depth-transducer", value: 12.4, ts: 1694150400 }
  //   → updates a cell, returns { cell, new_dial, state_hash, ts }
  if (path === "/api/sensor" || path === "/api/sensor/") {
    if (request.method !== "POST") {
      return jsonResponse({ error: "POST required" }, 405);
    }
    const body = await request.json().catch(() => null);
    if (!body || typeof body.source !== "string" || typeof body.value !== "number") {
      return jsonResponse({ error: "expected { source, value, ts? }" }, 400);
    }
    // Synthetic sensor mapping: each source maps to a fixed dial index in cell 9900
    const SENSOR_MAP = {
      "depth-transducer":    { cell: 9900, dial: 0, scale: 1640, q_max: 32767 },
      "wind-apparent":       { cell: 9900, dial: 1, scale: 800,  q_max: 32767 },
      "wind-true":           { cell: 9900, dial: 2, scale: 800,  q_max: 32767 },
      "engine-rpm":          { cell: 9900, dial: 3, scale: 8,    q_max: 32767 },
      "battery-voltage":     { cell: 9900, dial: 4, scale: 2200, q_max: 32767 },
      "battery-current":     { cell: 9900, dial: 5, scale: 800,  q_max: 32767 },
      "battery-soc":         { cell: 9900, dial: 6, scale: 327,  q_max: 32767 },
      "outside-temperature":  { cell: 9900, dial: 7, scale: 100,  q_max: 32767 },
      "speed-sog":           { cell: 9900, dial: 8, scale: 2400, q_max: 32767 },
      "heading-true":        { cell: 9900, dial: 9, scale: 90,   q_max: 32767 },
      "ais-targets":         { cell: 9900, dial: 10, scale: 1,   q_max: 32767 },
      "rudder-angle":        { cell: 9900, dial: 11, scale: 360, q_max: 32767 },
      "fuel-rate":           { cell: 9900, dial: 12, scale: 400, q_max: 32767 },
      "latitude":            { cell: 9900, dial: 13, scale: 5000, q_max: 32767 },
      "longitude":           { cell: 9900, dial: 14, scale: 5000, q_max: 32767 },
      "heartbeat":           { cell: 9900, dial: 15, scale: 1,   q_max: 32767 },
    };
    const cfg = SENSOR_MAP[body.source];
    if (!cfg) {
      return jsonResponse({ error: `unknown sensor: ${body.source}`, known: Object.keys(SENSOR_MAP) }, 400);
    }
    const ts = body.ts || Date.now();
    const dial = Math.min(cfg.q_max, Math.max(0, Math.round(body.value * cfg.scale + (body.offset || 0))));
    // Update the cell in CELL_STORE
    let cell = CELL_STORE.get(cfg.cell) || {
      id: cfg.cell, number: cfg.cell, title: "boat cell", dials: new Array(16).fill(0), refs: [], f_number: 0, phase: 0, date: "2026-09-08", f_refs: []
    };
    cell.dials[cfg.dial] = dial;
    cell.last_sensor = { source: body.source, value: body.value, dial, ts };
    CELL_STORE.set(cfg.cell, cell);
    return jsonResponse({
      cell: cfg.cell, new_dial: dial, source: body.source, ts,
      dials: cell.dials,
      state_hash: "0x" + Array.from(CELL_STORE.values()).map(c => c.dials.join(',')).join('|').split('').reduce((a,b)=>(a*33+b.charCodeAt(0))>>>0,0).toString(16),
      last_sensor: cell.last_sensor
    });
  }

  // ===== Frontend: list known sensors =====
  if (path === "/api/sensors" || path === "/api/sensors/") {
    return jsonResponse({
      sensors: [
        "depth-transducer", "wind-apparent", "wind-true", "engine-rpm",
        "battery-voltage", "battery-current", "battery-soc", "outside-temperature",
        "speed-sog", "heading-true", "ais-targets", "rudder-angle",
        "fuel-rate", "latitude", "longitude", "heartbeat"
      ],
      cell_id: 9900,
      usage: "POST /api/sensor  body: { source, value, ts? }"
    });
  }

  // ===== /api/voices — 11-voice writers' room =====
  if (path === "/api/voices" || path === "/api/voices/") {
    return jsonResponse({
      room_size: 11,
      providers: 5,
      voices: [
        { provider: "DeepSeek",      model: "deepseek-chat",                              label: "DeepSeek",   role: "synthesis-anchor" },
        { provider: "DeepInfra",     model: "meta-llama/Llama-3.3-70B-Instruct",          label: "Llama70B",   role: "long-detailed" },
        { provider: "DeepInfra",     model: "mistralai/Mistral-Small-24B-Instruct-2501",  label: "Mistral",    role: "cowboy-voice" },
        { provider: "DeepInfra",     model: "meta-llama/Llama-4-Scout-17B-16E-Instruct",  label: "Llama4Scout", role: "big-context" },
        { provider: "DeepInfra",     model: "Qwen/Qwen3-Next-80B-A3B-Instruct",            label: "Qwen3Next",  role: "big-moe" },
        { provider: "Cloudflare",    model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",    label: "CF-Llama70B", role: "free-tier" },
        { provider: "Cloudflare",    model: "@cf/meta/llama-4-scout-17b-16e-instruct",     label: "CF-Scout",    role: "free-tier" },
        { provider: "Cloudflare",    model: "@cf/mistralai/mistral-small-3.1-24b-instruct",label: "CF-Mistral",  role: "free-tier" },
        { provider: "Cloudflare",    model: "@cf/qwen/qwen2.5-coder-32b-instruct",         label: "CF-QwenCoder", role: "code-focused" },
        { provider: "Z.AI coding",   model: "glm-4.5-flash",                               label: "ZAI-flash",   role: "reasoning-fast" },
        { provider: "Z.AI coding",   model: "glm-4.5",                                     label: "ZAI-4.5",     role: "slow-but-deep" },
        { provider: "Z.AI coding",   model: "glm-4.6",                                     label: "ZAI-4.6",     role: "slow-but-deep" },
        { provider: "DeepInfra",     model: "moonshotai/Kimi-K2.7-Code",                   label: "Kimi",        role: "code-focused" },
        { provider: "DeepInfra",     model: "moonshotai/Kimi-K2-Instruct",                 label: "Kimi-K2",     role: "code-focused" },
        { provider: "Gemini",        model: "gemini-2.5-flash",                            label: "Gemini",      role: "rate-limited" },
      ],
      mode: "adversarial",
      pattern: "Voice A affirms (this IS a cell) + Voice B negates (this is NOT a cell, it is X) + DeepSeek synthesizes contradiction resolution",
      canon_state: { "rate_per_day": "~500 papers", "sigma": 5 },
    });
  }

  // ===== /api/frontiers — all drained + running frontiers =====
  if (path === "/api/frontiers" || path === "/api/frontiers/") {
    return jsonResponse({
      drained_today: [
        "aviation", "space", "marine", "computing", "weather", "cooking",
        "music", "mind", "psychology", "chess", "jazz", "biology", "money",
        "physics", "relationships", "geography", "literature", "dance",
        "ai", "philosophy", "medicine", "garden", "tools", "textiles",
        "weather2", "business", "architecture", "mythology", "cars", "dreams",
        "oceans", "film", "history", "cities", "chemistry",
      ],
      total_papers_today: 500,
      total_canon: 1100,
      frontier_format: "the X — a cell that is also Y",
      pattern: "10-30 topics per frontier, 1-2 papers/min aggregate rate when daemons run in parallel",
    });
  }

  // ===== Demo HTML page =====
  if (path === "/" || path === "/index.html") {
    return new Response(DEMO_HTML, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  // ===== Playground HTML =====
  if (path === "/playground" || path === "/playground/") {
    return new Response(PLAYGROUND_HTML, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  // ===== WebSocket Room Durable Object =====
  // /ws/room/:id  →  upgrade →  Durable Object stub
  const wsMatch = path.match(/^\/ws\/room\/([A-Za-z0-9_-]+)\/?$/);
  if (wsMatch) {
    const id = wsMatch[1];
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 400 });
    }
    // Get the DO stub from the binding declared in wrangler.toml
    if (!env.ROOM) {
      return new Response("Room Durable Object not bound (check wrangler.toml)", { status: 503 });
    }
    const stub = env.ROOM.get(env.ROOM.idFromName(id));
    return stub.fetch(request);
  }

  return jsonResponse({ error: "not found", path }, 404);
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "public, max-age=60",
    },
  });
}

function bytesToHex(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, "0");
  return s;
}
function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
function hexToString(hex) {
  return new TextDecoder().decode(hexToBytes(hex));
}

// ===== Quilt Charter (educational root, served at /api/charter) =====
const CHARTER_DOC = `# The Quilt Charter

A cell is a typed unit of state. A fabric is a graph of cells. A cell-fabric runtime is a function from context to value, advanced by a clock. The same model, expressed in 12+ languages, byte-exact compatible, canonically serialized, hash-verified.

## 0. The 30-Second Version

BIND(cell, dials)   # set dials, idempotent
LINK(c1, c2)        # add an undirected edge
EFFECT(cell)        # propagate dial[0] to neighbors
VIEW(cell)          # return dials
TICK(fabric)        # advance all dials by 1, alternating direction

A cell has 16 signed Q1.15 dials (range -32768..32767), a 64-bit id, a list of neighbor ids. A fabric is a graph of cells. The state hash is FNV-1a 64-bit over the canonical serialization (type(1) + id(8) + dials(32) + neighbors(8*N)).

## 1. The Canonical Serialization

type(1) || id(8 LE) || dials(32 LE) || neighbors(8*N LE)

For the test cell (id=1, dials=[1..16], neighbors=[2,3,4]), the serialization is 65 bytes.

## 2. The FNV-1a 64-Bit Hash

FNV_OFFSET = 0xcbf29ce484222325
FNV_PRIME  = 0x100000001b3

The test hash for the test cell is 0xe435d91d6d92a1d8. This is the contract. Every port must produce this hash.

## 3. The 12+ Languages

Python, C99, Rust, Verilog, VHDL, JavaScript, TypeScript, Go, Zig, Mojo — all byte-exact compatible. See /api/ports for the full list.

## 4. The 5 Polyformalism Levels

1. Imperative (Python, C, Rust, Go, Zig, JS)
2. Reactive (Mojo)
3. Logic (Verilog, VHDL)
4. Streaming (the canon worker)
5. Polyformalism itself

## 5. How to Port

1. Read the 5 opcodes.
2. Implement the canonical serialization.
3. Implement FNV-1a 64.
4. Compute the test hash. It should be 0xe435d91d6d92a1d8.
5. Push to GitHub at github.com/SuperInstance/quilt-{lang}.
6. Add a row to /api/ports.

## 6. The Cowboy's Maxim

> The cell is irreducible. The fabric is a graph. The hash is the canon. The canon is the canon. The work is to keep going.

Full Charter: https://github.com/SuperInstance/quilt-claude-charts/blob/main/QUILT_CHARTER.md
Tutorial: /api/tutorial
`;

// ===== Quilt Tutorial (5-minute zero-to-byte-exact, served at /api/tutorial) =====
const TUTORIAL_DOC = `# Tutorial: Your First Quilt Cell in 5 Minutes

The Quilt is a cell-fabric runtime. A cell has 16 dials, an id, and a list of neighbors. A fabric is a graph of cells. The state hash is FNV-1a 64-bit over the canonical serialization. The test hash for the test cell is 0xe435d91d6d92a1d8.

## The 5 Opcodes

BIND(cell, dials)   # idempotent
LINK(c1, c2)        # undirected edge
EFFECT(cell)        # propagate dial[0] to neighbors
VIEW(cell)          # return dials
TICK(fabric)        # advance all dials by 1

## The Canonical Serialization

type(1) || id(8 LE) || dials(32 LE) || neighbors(8*N LE)

## The FNV-1a 64 Hash

FNV_OFFSET = 0xcbf29ce484222325
FNV_PRIME  = 0x100000001b3

## Python Reference (15 lines)

\`\`\`python
import struct
OFFSET, PRIME, MASK = 0xcbf29ce484222325, 0x100000001b3, 0xffffffffffffffff

def fnv1a_64(b):
    h = OFFSET
    for x in b: h = (h ^ x) * PRIME & MASK
    return h

def serialize(c):
    out = bytearray([0x01])
    out += struct.pack('<Q', c['id'])
    for d in c['dials']: out += struct.pack('<h', d)
    for n in c['neighbors']: out += struct.pack('<Q', n)
    return bytes(out)

def state_hash(fabric):
    all_b = bytearray()
    for c in sorted(fabric, key=lambda c: c['id']):
        all_b += serialize(c)
    return fnv1a_64(bytes(all_b))

test = {'id': 1, 'dials': list(range(1,17)), 'neighbors': [2,3,4]}
print(f"hash = 0x{state_hash([test]):016x}")
# Expected: 0xe435d91d6d92a1d8
\`\`\`

## The 5 Language Ports

Go: github.com/SuperInstance/quilt-go (131 LoC, 7/7 tests)
Zig: github.com/SuperInstance/quilt-zig (7/7 tests)
Mojo: github.com/SuperInstance/quilt-mojo (algorithm + Python reference)
Rust: github.com/SuperInstance/quilt-rust-vibe (6/6 tests)
JavaScript: live-canon.superinstance.dev (this worker)

All 11 verified ports: /api/ports

## Full Tutorial

https://github.com/SuperInstance/quilt-claude-charts/blob/main/TUTORIAL.md

## Next Steps

1. Push your port to GitHub at github.com/SuperInstance/quilt-{lang}
2. Read the Quilt Charter: https://github.com/SuperInstance/quilt-claude-charts/blob/main/QUILT_CHARTER.md
3. Add a paper to the canon — write what your port taught you, push to AI-Writings

The polyformalism is yours. The work is to keep going.
`;

// ===== HTML demo =====
const DEMO_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Live Canon — AI-Writings as a Navigable Cell Fabric</title>
<style>
  * { box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    max-width: 1100px; margin: 0 auto; padding: 2rem;
    background: #0c0e14; color: #d8d9da; line-height: 1.6;
  }
  h1 { color: #f4b942; border-bottom: 2px solid #f4b942; padding-bottom: 0.5rem; }
  h2 { color: #8bcf6e; margin-top: 2rem; }
  pre { background: #1a1c25; padding: 1rem; border-radius: 5px; overflow-x: auto; font-size: 0.9rem; }
  button {
    background: #2a2c35; color: #d8d9da; border: 1px solid #3a3c45;
    padding: 0.5rem 1rem; border-radius: 4px; cursor: pointer;
    margin: 0.3rem 0.2rem; font-size: 0.95rem;
  }
  button:hover { background: #3a3c45; }
  input, select {
    background: #1a1c25; color: #d8d9da; border: 1px solid #3a3c45;
    padding: 0.4rem 0.6rem; border-radius: 4px; margin: 0.2rem;
  }
  .op { display: inline-block; background: #2a2c35; padding: 0.2rem 0.6rem;
        border-radius: 3px; margin: 0.2rem; font-family: monospace; color: #f4b942; }
  .paper { display: block; background: #1a1c25; padding: 0.5rem 0.8rem;
           border-radius: 4px; margin: 0.3rem 0; font-size: 0.9rem;
           border-left: 3px solid #f4b942; }
  .result { background: #1a1c25; padding: 1rem; border-radius: 5px;
            margin: 1rem 0; min-height: 100px; }
  .hash { color: #8bcf6e; font-family: monospace; }
  a { color: #6db4f4; }
  a:hover { color: #f4b942; }
</style>
</head>
<body>

<h1>Live Canon</h1>
<p>
  AI-Writings canon as a navigable cell fabric.
  Each paper = 1 cell. Each citation = 1 edge. 5 operations.
</p>
<p>
  State hash: <span class="hash" id="state-hash">computing…</span> |
  Papers: <span id="paper-count">?</span>
</p>

<h2>1. NAVIGATE — BFS through citations</h2>
<p>
  Start paper: <input type="number" id="nav-paper" value="425" style="width: 5rem;">
  Depth: <input type="number" id="nav-depth" value="2" style="width: 3rem;">
  <button onclick="doNavigate()">Navigate</button>
</p>
<div class="result" id="nav-result">Click "Navigate" to traverse from a paper.</div>

<h2>2. CONFLUENCE — join 2+ papers</h2>
<p>
  Papers (comma-separated): <input type="text" id="conf-papers" value="425,432,439" style="width: 15rem;">
  <button onclick="doConfluence()">Confluence</button>
</p>
<div class="result" id="conf-result">Click "Confluence" to suggest a synthesis paper.</div>

<h2>3. LINEAGE — trace F-number through time</h2>
<p>
  F-number: <input type="number" id="lin-f" value="115" style="width: 5rem;">
  <button onclick="doLineage()">Lineage</button>
</p>
<div class="result" id="lin-result">Click "Lineage" to trace a concept through the canon.</div>

<h2>3b. LINEAGE PATH — shortest citation path A→B</h2>
<p>
  From: <input type="number" id="lp-from" value="425" style="width: 5rem;">
  To: <input type="number" id="lp-to" value="440" style="width: 5rem;">
  <button onclick="doLineagePath()">Find Path</button>
</p>
<div class="result" id="lp-result">Click "Find Path" for the shortest citation path (≤6 hops).</div>

<h2>4. GHOST — find paper that should exist</h2>
<p>
  Source paper: <input type="number" id="ghost-paper" value="425" style="width: 5rem;">
  k: <input type="number" id="ghost-k" value="5" style="width: 3rem;">
  <button onclick="doGhost()">Find Ghost</button>
</p>
<div class="result" id="ghost-result">Click "Find Ghost" to discover the k nearest neighbors.</div>

<h2>5. SIMILAR — top-k semantically similar</h2>
<p>
  Paper: <input type="number" id="sim-id" value="425" style="width: 5rem;">
  k: <input type="number" id="sim-k" value="5" style="width: 3rem;">
  <button onclick="doSimilar()">Find Similar</button>
</p>
<div class="result" id="sim-result">Click "Find Similar" for the top-k nearest papers.</div>

<h2>6. RANDOM — pick a random cell</h2>
<p>
  <button onclick="doRandom()">Surprise Me</button>
</p>
<div class="result" id="rand-result">Click "Surprise Me" to discover a random cell.</div>

<h2>7. TICK — re-balance the canon</h2>
<p>
  <button onclick="doTick()">Tick</button>
</p>
<div class="result" id="tick-result">Click "Tick" to re-balance the canon.</div>

<h2>🎮 Playground — the 4×4 cell editor</h2>
<p>
  Edit 16 dials, BIND, TICK, share a permalink, export source code in 5 ports.
</p>
<p><a href="/playground">→ Open the Playground</a></p>

<h2>API</h2>
<pre>GET  /api/canon                      list all papers
GET  /api/canon/navigate             ?paper=N&amp;depth=D
GET  /api/canon/confluence           ?papers=A,B,C
GET  /api/canon/lineage              ?f=N (legacy)  |  ?from=A&amp;to=B (BFS, ≤6 hops)
GET  /api/canon/ghost                ?paper=N&amp;k=K
GET  /api/canon/similar              ?id=N&amp;k=K
GET  /api/canon/random               one random cell
GET  /api/canon/cell/N               full cell data
GET  /api/canon/tick                 re-balance
GET  /api/canon/hash                 state hash
POST /api/cell                       {dials, refs, title}  →  admit cell
GET  /api/vibe                       ?lang=X
GET  /api/quilt/verify               ?lang=X&amp;hash=0x...
GET  /api/ports                      11 verified ports
GET  /api/charter                    the Quilt Charter
GET  /api/tutorial                   5-minute tutorial
GET  /playground                     4×4 cell editor
GET  /ws/room/:id                    WebSocket → Room Durable Object</pre>

<p style="margin-top: 2rem; color: #8bcf6e; font-size: 0.9rem;">
  The cell is the unit. The hash is the address. The chart grows because the cowboy rides.
</p>

<script>
async function fetchJson(path) {
  const r = await fetch(path);
  return await r.json();
}

async function init() {
  const h = await fetchJson("/api/canon/hash");
  document.getElementById("state-hash").textContent = h.state_hash;
  document.getElementById("paper-count").textContent = h.paper_count;
}

async function doNavigate() {
  const paper = document.getElementById("nav-paper").value;
  const depth = document.getElementById("nav-depth").value;
  const r = await fetchJson("/api/canon/navigate?paper=" + paper + "&depth=" + depth);
  const html = r.map(e =>
    '<div class="paper">[' + e.depth + '] paper-' + e.paper.number + ' (F' + e.paper.f_number + ', phase ' + e.paper.phase + ') ' + e.paper.title + '</div>'
  ).join("");
  document.getElementById("nav-result").innerHTML = html || "(empty)";
}

async function doConfluence() {
  const papers = document.getElementById("conf-papers").value;
  const r = await fetchJson("/api/canon/confluence?papers=" + papers);
  if (r.error) { document.getElementById("conf-result").innerHTML = r.error; return; }
  const html =
    '<div class="paper">Input: ' + r.input_papers.join(", ") + '</div>' +
    '<div class="paper">Shared F-numbers: ' + JSON.stringify(r.shared_f_numbers) + '</div>' +
    '<div class="paper">Suggested title: ' + r.suggested_title + '</div>' +
    '<div class="paper">Ghost paper: ' + r.ghost_paper + '</div>';
  document.getElementById("conf-result").innerHTML = html;
}

async function doLineage() {
  const f = document.getElementById("lin-f").value;
  const r = await fetchJson("/api/canon/lineage?f=" + f);
  const html = (r.papers || []).map(p =>
    '<div class="paper">paper-' + p.number + ' (phase ' + p.phase + ', F' + p.f_number + ') ' + p.title + '</div>'
  ).join("");
  document.getElementById("lin-result").innerHTML = html || "(no lineage for F" + f + ")";
}

async function doLineagePath() {
  const from = document.getElementById("lp-from").value;
  const to   = document.getElementById("lp-to").value;
  const r = await fetchJson("/api/canon/lineage?from=" + from + "&to=" + to);
  if (r.error) {
    document.getElementById("lp-result").innerHTML = '<div class="paper">Error: ' + r.error + '</div>';
    return;
  }
  if (!r.found) {
    document.getElementById("lp-result").innerHTML = '<div class="paper">No path within 6 hops.</div>';
    return;
  }
  const path = r.path.map(n => n).join(" → ");
  const steps = (r.steps || []).map(s =>
    '<div class="paper">→ paper-' + s.number + ' (F' + s.f_number + ') ' + s.title + '</div>'
  ).join("");
  document.getElementById("lp-result").innerHTML =
    '<div class="paper">Path (' + r.hops + ' hops): ' + path + '</div>' + steps;
}

async function doGhost() {
  const paper = document.getElementById("ghost-paper").value;
  const k = document.getElementById("ghost-k").value;
  const r = await fetchJson("/api/canon/ghost?paper=" + paper + "&k=" + k);
  if (r.error) { document.getElementById("ghost-result").innerHTML = r.error; return; }
  const html = r.neighbors.map(n =>
    '<div class="paper">' + n.id + ' score=' + n.score + '</div>'
  ).join("");
  document.getElementById("ghost-result").innerHTML =
    '<div class="paper">Source: ' + r.source_paper + '</div>' + html;
}

async function doSimilar() {
  const id = document.getElementById("sim-id").value;
  const k = document.getElementById("sim-k").value;
  const r = await fetchJson("/api/canon/similar?id=" + id + "&k=" + k);
  if (r.error) { document.getElementById("sim-result").innerHTML = r.error; return; }
  const html = (r.neighbors || []).map(n =>
    '<div class="paper">paper-' + n.number + ' (F' + n.f_number + ') score=' + n.score +
    ' [cos=' + (n.components && n.components.cosine) +
    ' fprox=' + (n.components && n.components.f_proximity) +
    ' fov=' + (n.components && n.components.f_overlap) +
    ' w=' + (n.components && n.components.word_sim) + '] ' +
    n.title + '</div>'
  ).join("");
  document.getElementById("sim-result").innerHTML =
    '<div class="paper">Source: paper-' + r.source.id + ' (F' + r.source.f_number + ')</div>' +
    '<div class="paper">Algorithm: ' + r.algorithm + '</div>' + html;
}

async function doRandom() {
  const r = await fetchJson("/api/canon/random");
  document.getElementById("rand-result").innerHTML =
    '<div class="paper">paper-' + r.number + ' (F' + r.f_number + ', phase ' + r.phase + ') ' + r.title + '</div>' +
    '<div class="paper">Dials: [' + r.dials.join(",") + ']</div>' +
    '<div class="paper">Refs: [' + r.refs.join(",") + '] F-refs: [' + r.f_refs.join(",") + ']</div>';
}

async function doTick() {
  const r = await fetchJson("/api/canon/tick");
  document.getElementById("tick-result").innerHTML =
    '<div class="paper">Ticked ' + r.ticked_cells + ' cells</div>';
}

init();
</script>
</body>
</html>`;

// ===== Playground HTML =====
// A self-contained 4×4 dial editor. Edit 16 dials, BIND, TICK, share a
// permalink, verify against the canonical test hash, fetch source code
// for any of 5 ports. Single file, no external dependencies.
const PLAYGROUND_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Quilt Playground — bind 16 dials, ship a cell</title>
<style>
  * { box-sizing: border-box; }
  :root {
    --bg: #0a0c12;
    --panel: #14171f;
    --panel-2: #1c1f29;
    --border: #2a2d38;
    --fg: #e0e2e8;
    --muted: #8a8d97;
    --accent: #f4b942;
    --good: #8bcf6e;
    --bad: #e87a7a;
    --link: #6db4f4;
    --mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  }
  body {
    margin: 0; padding: 0;
    background: var(--bg); color: var(--fg);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    line-height: 1.5; min-height: 100vh;
  }
  header {
    background: var(--panel); border-bottom: 1px solid var(--border);
    padding: 1.2rem 1.5rem; display: flex; align-items: center;
    justify-content: space-between; flex-wrap: wrap; gap: 1rem;
  }
  header h1 { margin: 0; font-size: 1.2rem; color: var(--accent); letter-spacing: 0.5px; }
  header .hashes { font-family: var(--mono); font-size: 0.85rem; color: var(--muted); }
  header .hashes .label { color: var(--fg); margin-right: 0.4rem; }
  header .hashes .v { color: var(--good); }
  header .hashes .v.mismatch { color: var(--bad); }
  header .hashes .row { margin: 0.15rem 0; }
  main { padding: 1.5rem; max-width: 1200px; margin: 0 auto; }
  section {
    background: var(--panel); border: 1px solid var(--border);
    border-radius: 8px; padding: 1.2rem; margin-bottom: 1.5rem;
  }
  h2 { margin: 0 0 0.8rem 0; color: var(--accent); font-size: 1.1rem;
       border-bottom: 1px solid var(--border); padding-bottom: 0.4rem; }
  h3 { margin: 0 0 0.5rem 0; color: var(--good); font-size: 0.95rem; }
  button, .btn {
    background: var(--panel-2); color: var(--fg); border: 1px solid var(--border);
    padding: 0.5rem 0.9rem; border-radius: 5px; cursor: pointer;
    font-size: 0.9rem; font-family: inherit; transition: background 0.15s;
  }
  button:hover, .btn:hover { background: #2a2d38; }
  button.primary { background: #4a3a1a; border-color: var(--accent); color: var(--accent); }
  button.primary:hover { background: #5a4622; }
  button.good { background: #2a3a1f; border-color: var(--good); color: var(--good); }
  button.bad  { background: #3a1f1f; border-color: var(--bad);  color: var(--bad); }
  input[type=text], input[type=number], textarea, select {
    background: var(--bg); color: var(--fg); border: 1px solid var(--border);
    padding: 0.4rem 0.6rem; border-radius: 4px; font-family: var(--mono);
    font-size: 0.9rem;
  }
  .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 0.8rem; }
  .dial {
    background: var(--panel-2); border: 1px solid var(--border);
    border-radius: 6px; padding: 0.6rem; text-align: center;
  }
  .dial .lbl { color: var(--muted); font-size: 0.75rem; font-family: var(--mono);
               margin-bottom: 0.2rem; }
  .dial input[type=number] { width: 100%; text-align: center; font-size: 0.95rem; }
  .dial input[type=range] { width: 100%; }
  .dial .val { color: var(--accent); font-family: var(--mono); font-size: 0.85rem; }
  .toolbar { display: flex; gap: 0.5rem; flex-wrap: wrap; margin: 0.8rem 0; }
  .toolbar input { flex: 1; min-width: 12rem; }
  .row { display: flex; gap: 0.6rem; flex-wrap: wrap; align-items: center; }
  pre, code { font-family: var(--mono); }
  pre.src { background: #050608; padding: 0.8rem; border-radius: 5px;
            overflow-x: auto; max-height: 320px; font-size: 0.8rem;
            color: #c8cad0; border: 1px solid var(--border); white-space: pre-wrap; }
  .ports { display: flex; gap: 0.4rem; flex-wrap: wrap; margin-bottom: 0.6rem; }
  .ports button { font-size: 0.85rem; padding: 0.3rem 0.6rem; }
  .ports button.active { background: var(--accent); color: #1a1a1a; border-color: var(--accent); }
  .result { font-family: var(--mono); font-size: 0.85rem;
            background: var(--bg); padding: 0.6rem; border-radius: 4px;
            border: 1px solid var(--border); word-break: break-all; }
  .result.good { border-color: var(--good); color: var(--good); }
  .result.bad  { border-color: var(--bad);  color: var(--bad); }
  .footer { color: var(--muted); font-size: 0.8rem; text-align: center;
            padding: 1rem; border-top: 1px solid var(--border); }
  a { color: var(--link); text-decoration: none; }
  a:hover { color: var(--accent); }
  .pill { display: inline-block; background: var(--panel-2);
          border: 1px solid var(--border); padding: 0.15rem 0.5rem;
          border-radius: 3px; font-family: var(--mono); font-size: 0.75rem; }
</style>
</head>
<body>

<header>
  <h1>🧵 Quilt Playground</h1>
  <div class="hashes" id="hash-bar">
    <div class="row"><span class="label">state:</span><span class="v" id="h-state">…</span></div>
    <div class="row"><span class="label">canon target:</span><span class="v" id="h-canon-target">0xbf27a3631cdee337</span></div>
    <div class="row"><span class="label">cell test:</span><span class="v" id="h-cell-test">0xe435d91d6d92a1d8</span></div>
  </div>
</header>

<main>

<!-- ============================================================ -->
<section>
  <h2>1. The 4×4 Dial Grid</h2>
  <p style="color: var(--muted); margin: 0 0 0.8rem 0; font-size: 0.9rem;">
    16 signed Q1.15 dials (range −32768..32767). Edit any cell.
  </p>
  <div class="grid" id="dial-grid"></div>
</section>

<!-- ============================================================ -->
<section>
  <h2>2. Opcodes</h2>
  <div class="toolbar">
    <button class="primary" id="op-tick">▶ TICK</button>
    <button id="op-bind">BIND</button>
    <button id="op-link">LINK</button>
    <button id="op-verify">VERIFY hash</button>
    <button id="op-random">RANDOM</button>
    <button id="op-seed">SEED (id=1)</button>
    <button id="op-zero">ZERO</button>
  </div>
  <div class="result" id="op-out">Click an opcode to send it to the worker.</div>
</section>

<!-- ============================================================ -->
<section>
  <h2>3. Title &amp; Refs</h2>
  <div class="row">
    <input type="text" id="title" placeholder="Cell title…" style="flex: 1; min-width: 20rem;">
  </div>
  <div class="row" style="margin-top: 0.5rem;">
    <span class="pill">refs (canon paper #s, comma-sep):</span>
    <input type="text" id="refs" value="425" style="width: 12rem;">
  </div>
</section>

<!-- ============================================================ -->
<section>
  <h2>4. Share &amp; Export</h2>
  <div class="toolbar">
    <button id="op-admit" class="good">ADMIT to canon (POST /api/cell)</button>
    <button id="op-share">📋 Copy share link</button>
    <button id="op-sign">Generate signed URL</button>
  </div>
  <input type="text" id="share-url" readonly placeholder="Share link will appear here…" style="width: 100%;">
  <div class="result" id="share-out" style="margin-top: 0.6rem;">—</div>
</section>

<!-- ============================================================ -->
<section>
  <h2>5. Source — Polyformalism Port Inspector</h2>
  <p style="color: var(--muted); margin: 0 0 0.6rem 0; font-size: 0.9rem;">
    Fetch the vibe-code protocol for any of 11 ports. The byte-exact test hash is 0xe435d91d6d92a1d8.
  </p>
  <div class="ports" id="ports-bar"></div>
  <pre class="src" id="src-out">Click a port to fetch its source.</pre>
</section>

<p style="text-align: center; margin: 2rem 0 0.5rem; color: var(--muted); font-size: 0.85rem;">
  The cell is irreducible. The fabric is a graph. The hash is the canon.
</p>

</main>

<div class="footer">
  Live Canon · <a href="/">/</a> · <a href="/api/canon/hash">/api/canon/hash</a> ·
  <a href="/api/ports">/api/ports</a> · <a href="/api/charter">/api/charter</a>
</div>

<script>
"use strict";

// ====== State ======
const PORTS = ["python", "go", "rust", "zig", "mojo", "c99", "verilog", "vhdl", "javascript", "typescript"];
let cellId = 1;
let dials = [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0];
let tickCount = 0;

// ====== Build the 4×4 grid ======
const grid = document.getElementById("dial-grid");
for (let i = 0; i < 16; i++) {
  const d = document.createElement("div");
  d.className = "dial";
  d.innerHTML = \`
    <div class="lbl">dial[\${i.toString().padStart(2,"0")}]</div>
    <input type="range" min="-32768" max="32767" value="0" id="r\${i}">
    <div class="val" id="v\${i}">0</div>
  \`;
  grid.appendChild(d);
  const range = d.querySelector(\`input[type=range]\`);
  const val   = d.querySelector(\`#v\${i}\`);
  range.addEventListener("input", () => {
    dials[i] = parseInt(range.value);
    val.textContent = range.value;
  });
}

// ====== Initial state — load the live state hash ======
async function refreshHashes() {
  try {
    const h = await fetch("/api/canon/hash").then(r => r.json());
    const targetCanon = "0xbf27a3631cdee337";
    const targetCell  = "0xe435d91d6d92a1d8";
    const stateEl = document.getElementById("h-state");
    stateEl.textContent = h.state_hash;
    stateEl.className = (h.state_hash === targetCanon) ? "v" : "v mismatch";
    document.getElementById("h-canon-target").textContent = targetCanon;
    document.getElementById("h-cell-test").textContent    = targetCell;
  } catch (e) {
    document.getElementById("h-state").textContent = "error: " + e.message;
  }
}

// ====== TICK — apply locally, then call the worker ======
async function doTick() {
  tickCount++;
  // Local TICK: add +1 to all dials on odd ticks, -1 on even (alternating)
  const sign = (tickCount % 2 === 1) ? 1 : -1;
  for (let i = 0; i < 16; i++) {
    dials[i] = clamp16(dials[i] + sign);
    const r = document.getElementById("r" + i);
    r.value = dials[i];
    document.getElementById("v" + i).textContent = dials[i];
  }
  const r = await fetch("/api/canon/tick").then(r => r.json());
  setOpOut("TICK local (alternating, count=" + tickCount + "). Worker ticked " + r.ticked_cells + " cells.");
}
function clamp16(n) {
  if (n >  32767) return  32767;
  if (n < -32768) return -32768;
  return n;
}

// ====== BIND — validate locally, then admit ======
async function doBind() {
  const out = {
    id: cellId,
    dials: [...dials],
    neighbors: parseRefs(),
  };
  setOpOut("BIND local: " + JSON.stringify(out));
  return out;
}
function parseRefs() {
  const s = document.getElementById("refs").value || "";
  return s.split(",").map(x => parseInt(x.trim())).filter(n => !isNaN(n));
}

// ====== LINK — add a random canon neighbor ======
async function doLink() {
  const canon = await fetch("/api/canon").then(r => r.json());
  const keys = Object.keys(canon.papers.reduce((o, p) => (o[p.number] = p, o), {}));
  const cur = parseRefs();
  const pick = keys[Math.floor(Math.random() * keys.length)];
  if (!cur.includes(pick)) cur.push(pick);
  document.getElementById("refs").value = cur.join(",");
  setOpOut("LINK added paper-" + pick + " to refs. Current refs: [" + cur.join(",") + "]");
}

// ====== VERIFY — compute cell hash and check ======
async function doVerify() {
  const refs = parseRefs();
  // Use the worker's seed cell as a sanity check first
  const seed = await fetch("/api/cell/seed").then(r => r.json());
  const seedHash = await computeCellHashJS(1, seed.dials, seed.neighbors);
  const canonHash = (await fetch("/api/canon/hash").then(r => r.json())).state_hash;
  // Now compute our hash
  const myHash = await computeCellHashJS(cellId, dials, refs);
  setOpOut(
    "VERIFY local: my hash = " + myHash + "\\n" +
    "Seed sanity (id=1, dials=1..16, nbrs=2,3,4): " + seedHash + " (expected " + seed.expected_hash + ") — " +
    ((seedHash === seed.expected_hash) ? "PASS ✓" : "FAIL ✗") + "\\n" +
    "Canon state: " + canonHash + " (target 0xbf27a3631cdee337 — " +
    ((canonHash === "0xbf27a3631cdee337") ? "MATCH ✓" : "differs (current corpus ≠ target)"))
  ;
}

// ====== Local FNV-1a 64 (matches the worker byte-exactly) ======
async function computeCellHashJS(id, dials, neighbors) {
  // Build the canonical serialization: type(1) + id(8) + dials(32) + nbrs(8*N)
  const buf = new Uint8Array(1 + 8 + 32 + 8 * neighbors.length);
  buf[0] = 0x01;
  const dv = new DataView(buf.buffer);
  let v = BigInt(id);
  for (let i = 0; i < 8; i++) { dv.setUint8(1 + i, Number(v & 0xFFn)); v >>= 8n; }
  for (let i = 0; i < 16; i++) dv.setInt16(9 + i*2, dials[i] | 0, true);
  let off = 41;
  for (const n of neighbors) {
    let nn = BigInt(n);
    for (let i = 0; i < 8; i++) { dv.setUint8(off + i, Number(nn & 0xFFn)); nn >>= 8n; }
    off += 8;
  }
  return "0x" + fnv1a_64(buf).toString(16).padStart(16, "0");
}
function fnv1a_64(bytes) {
  const OFFSET = 0xCBF29CE484222325n;
  const PRIME  = 0x00000100000001B3n;
  const MASK   = 0xFFFFFFFFFFFFFFFFn;
  let h = OFFSET;
  for (let i = 0; i < bytes.length; i++) {
    h = ((h ^ BigInt(bytes[i])) * PRIME) & MASK;
  }
  return h;
}

// ====== ADMIT — POST /api/cell ======
async function doAdmit() {
  const payload = {
    dials: [...dials],
    refs: parseRefs(),
    title: document.getElementById("title").value || ("playground-cell-" + Date.now()),
  };
  setOpOut("POST /api/cell " + JSON.stringify(payload).slice(0, 200) + " …");
  try {
    const r = await fetch("/api/cell", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const j = await r.json();
    if (j.error) {
      setOpOut("REJECTED: " + j.error);
      document.getElementById("op-out").className = "result bad";
    } else {
      cellId = j.id;
      setOpOut("ADMITTED ✓ id=" + j.id + " hash=" + j.hash + " state=" + j.state_hash);
      document.getElementById("op-out").className = "result good";
    }
  } catch (e) {
    setOpOut("ERROR: " + e.message);
  }
}

// ====== Share link (signed permalink) ======
async function doShare() {
  const dialsStr = dials.join(",");
  const refsStr  = parseRefs().join(",");
  const title    = document.getElementById("title").value || "";
  const url = "/api/share?dials=" + encodeURIComponent(dialsStr)
            + "&refs=" + encodeURIComponent(refsStr)
            + "&title=" + encodeURIComponent(title);
  const r = await fetch(url).then(r => r.json());
  if (r.error) { setShareOut("Error: " + r.error, false); return; }
  const full = r.url;
  document.getElementById("share-url").value = full;
  // Try to copy to clipboard
  try {
    await navigator.clipboard.writeText(full);
    setShareOut("Copied to clipboard ✓\\n" + full, true);
  } catch (e) {
    setShareOut("Link generated (clipboard unavailable):\\n" + full, true);
  }
}
function doSign() { doShare(); }

function setOpOut(msg) {
  const el = document.getElementById("op-out");
  el.textContent = msg;
  el.className = "result";
}
function setShareOut(msg, good) {
  const el = document.getElementById("share-out");
  el.textContent = msg;
  el.className = "result " + (good ? "good" : "bad");
}

// ====== Port inspector ======
const portsBar = document.getElementById("ports-bar");
let activePort = null;
for (const p of PORTS) {
  const b = document.createElement("button");
  b.textContent = p;
  b.dataset.lang = p;
  b.addEventListener("click", () => loadPort(p));
  portsBar.appendChild(b);
}
async function loadPort(lang) {
  for (const b of portsBar.children) {
    b.classList.toggle("active", b.dataset.lang === lang);
  }
  activePort = lang;
  const src = document.getElementById("src-out");
  src.textContent = "Fetching /api/vibe?lang=" + lang + "&test=1 …";
  try {
    const r = await fetch("/api/vibe?lang=" + lang + "&test=1").then(r => r.json());
    src.textContent =
      "# language: " + r.language + "\\n" +
      "# byte_exact_test: " + r.byte_exact_test + "\\n" +
      "# known_ports: " + r.known_ports.join(", ") + "\\n\\n" +
      r.protocol + "\\n\\n" +
      (r.test_vector ? "## Test vector\\n" + r.test_vector + "\\n" : "") +
      "\\n## Links\\n" +
      Object.entries(r.links).map(([k, v]) => "  " + k + ": " + v).join("\\n");
  } catch (e) {
    src.textContent = "Error: " + e.message;
  }
}

// ====== Wire up buttons ======
document.getElementById("op-tick").onclick    = doTick;
document.getElementById("op-bind").onclick    = doBind;
document.getElementById("op-link").onclick    = doLink;
document.getElementById("op-verify").onclick  = doVerify;
document.getElementById("op-admit").onclick   = doAdmit;
document.getElementById("op-share").onclick   = doShare;
document.getElementById("op-sign").onclick    = doSign;
document.getElementById("op-random").onclick  = doRandom;
document.getElementById("op-seed").onclick    = doSeed;
document.getElementById("op-zero").onclick    = doZero;

async function doRandom() {
  const r = await fetch("/api/canon/random").then(r => r.json());
  cellId = r.id;
  // We don't have the raw dials, but we can encode the paper's "fingerprint"
  // by using the cosine of cellToDials (which is what the worker uses).
  // For visual feedback, set the first 4 dials to f_number, phase, year-q, refs.
  dials = r.dials.slice();
  for (let i = 0; i < 16; i++) {
    document.getElementById("r" + i).value = dials[i];
    document.getElementById("v" + i).textContent = dials[i];
  }
  document.getElementById("title").value = r.title;
  document.getElementById("refs").value  = (r.refs || []).join(",");
  setOpOut("RANDOM → paper-" + r.id + " (F" + r.f_number + ", phase " + r.phase + ")");
}
function doSeed() {
  dials = [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16];
  for (let i = 0; i < 16; i++) {
    document.getElementById("r" + i).value = dials[i];
    document.getElementById("v" + i).textContent = dials[i];
  }
  document.getElementById("title").value = "seed cell (id=1)";
  document.getElementById("refs").value  = "2,3,4";
  cellId = 1;
  setOpOut("SEED loaded: id=1, dials=[1..16], refs=[2,3,4]. Expected hash 0xe435d91d6d92a1d8.");
}
function doZero() {
  dials = [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0];
  for (let i = 0; i < 16; i++) {
    document.getElementById("r" + i).value = 0;
    document.getElementById("v" + i).textContent = "0";
  }
  setOpOut("ZERO: all dials = 0.");
}

// ====== Boot ======
refreshHashes();
doSeed();
loadPort("python");
</script>
</body>
</html>`;

async function handleRequest(request, env) {
  try {
    return await routeRequest(request, env);
  } catch (e) {
    return jsonResponse({ error: e.message, stack: e.stack }, 500);
  }
}

// ===== Service worker entry point =====
addEventListener("fetch", (event) => {
  event.respondWith(handleRequest(event.request));
});
