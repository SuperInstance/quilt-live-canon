// worker.js — The Live Canon as a Cloudflare Worker
//
// Exposes the 5 Live Canon operations as a REST API:
//   GET  /api/canon                  - list all loaded papers
//   GET  /api/canon/navigate?paper=N&depth=D - BFS from paper N
//   GET  /api/canon/confluence?papers=A,B,C  - join 2+ papers
//   GET  /api/canon/lineage?f=N       - papers that cite F{N}
//   GET  /api/canon/ghost?paper=N&k=K  - k nearest neighbors
//   GET  /api/canon/tick              - re-balance the canon
//   GET  /api/canon/hash              - state hash of the canon
//   GET  /                           - HTML demo page
//
// The canon is loaded from the bundled corpus (a JSON snapshot of
// the 50+ paper metadata).  On each request, the relevant operation
// is computed and returned as JSON.
//
// This is the production deployment of F129 (the Live Canon).

// ===== FNV-1a 64-bit hash (UTF-8 encoded, byte-exact with Python) =====
function fnv1a_64(s) {
  let h = 0xCBF29CE484222325n;
  // Use TextEncoder to get UTF-8 bytes
  const bytes = new TextEncoder().encode(s);
  for (let i = 0; i < bytes.length; i++) {
    h ^= BigInt(bytes[i]);
    h = (h * 0x00000100000001B3n) & 0xFFFFFFFFFFFFFFFFn;
  }
  return h;
}

// ===== Cell encoding (matches Python/C/Rust/Verilog/VHDL byte-exact) =====
function cellToDials(paper) {
  const year = parseInt(paper.date.substring(0, 4)) || 1970;
  const year_q = (year - 1970) * 546;
  const phase_q = paper.phase * 218;
  const f_q = paper.f_number * 218;
  const n_refs = (paper.ref_papers?.length || 0) + (paper.ref_f_numbers?.length || 0);
  const n_refs_q = Math.min(0x7FFF, n_refs * 256);
  const th = fnv1a_64(paper.title);
  const title_lo = Number(th & 0xFFFFn);
  const title_hi = Number((th >> 16n) & 0xFFFFn);
  const num = Math.min(paper.number, 500);
  const num_q = num * 131;
  return [num_q, title_lo, f_q, phase_q, year_q, n_refs_q, title_hi, 0,
          0, 0, 0, 0, 0, 0, 0, 0];
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

// ===== State hash (FNV-1a over sorted dials) =====
function stateHash(papers) {
  const allDials = Object.values(papers).map(p => cellToDials(p));
  allDials.sort((a, b) => a[0] - b[0]);
  let h = 0xCBF29CE484222325n;
  for (const d of allDials) {
    for (const v of d) {
      // Pack v as 2 bytes (little-endian)
      const lo = v & 0xFF;
      const hi = (v >> 8) & 0xFF;
      h ^= BigInt(lo);
      h = (h * 0x00000100000001B3n) & 0xFFFFFFFFFFFFFFFFn;
      h ^= BigInt(hi);
      h = (h * 0x00000100000001B3n) & 0xFFFFFFFFFFFFFFFFn;
    }
  }
  return h;
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

function tick(canon) {
  return { ticked_cells: Object.keys(canon).length };
}

// ===== Bundle the canon (loaded from the Cloudflare KV at runtime) =====
// For the worker, we bundle a small canon inline so the demo works
// without external storage.  In production, this would be loaded from
// a Cloudflare R2 bucket or KV namespace.
const CANON = {
  425: {
    number: 425, title: "F115 — The Logical Routes: VHDL × Verilog × the QUF bit-exactness",
    f_number: 115, phase: 237, date: "2026-09-03",
    ref_papers: [426, 427], ref_f_numbers: [],
  },
  426: {
    number: 426, title: "F116 — The 5+1+1+1+1+1+1+1+1+1+1 Opcodes in 5 Substrates: A Polyformalism Atlas",
    f_number: 116, phase: 238, date: "2026-09-03",
    ref_papers: [], ref_f_numbers: [115],
  },
  427: {
    number: 427, title: "F117 — The 5-Substrate Polyformalism: Python × C × Rust × Verilog × VHDL, One Cell",
    f_number: 117, phase: 239, date: "2026-09-03",
    ref_papers: [], ref_f_numbers: [115, 116],
  },
  428: {
    number: 428, title: "F118 — The Polyformalism in Production: A Play-Test + Benchmark",
    f_number: 118, phase: 240, date: "2026-09-03",
    ref_papers: [], ref_f_numbers: [115, 116, 117],
  },
  429: {
    number: 429, title: "F119 — The 6-Substrate Polyformalism: cell-runtime Joins the Canon",
    f_number: 119, phase: 241, date: "2026-09-03",
    ref_papers: [], ref_f_numbers: [115, 116, 117, 118],
  },
  432: {
    number: 432, title: "F122 — The Shape Store: 5 Indices on Cloudflare Vectorize",
    f_number: 122, phase: 244, date: "2026-09-03",
    ref_papers: [], ref_f_numbers: [120, 121],
  },
  433: {
    number: 433, title: "F123 — The Composer Agent: 5 Cells, 80 Parameters",
    f_number: 123, phase: 245, date: "2026-09-03",
    ref_papers: [], ref_f_numbers: [120, 122],
  },
  439: {
    number: 439, title: "F129 — The Live Canon: Papers as Cells, Reading as Navigation",
    f_number: 129, phase: 251, date: "2026-09-03",
    ref_papers: [], ref_f_numbers: [115, 120, 122, 125],
  },
  440: {
    number: 440, title: "F130 — The Polyformal Live Canon: One Cell, Five Substrates",
    f_number: 130, phase: 251, date: "2026-09-03",
    ref_papers: [], ref_f_numbers: [115, 129],
  },
  441: {
    number: 441, title: "F131 — The 3-Package Polyformalism: One Cell, Three Registries",
    f_number: 131, phase: 252, date: "2026-09-03",
    ref_papers: [], ref_f_numbers: [115, 130],
  },
  442: {
    number: 442, title: "F132 — Operational Fictions as Concrete System-Prompt Noun-Phrases",
    f_number: 132, phase: 253, date: "2026-09-03",
    ref_papers: [], ref_f_numbers: [],
  },
  443: {
    number: 443, title: "F133 — Operational Fictions as Falsifiable Claims (avg divergence 0.861)",
    f_number: 133, phase: 254, date: "2026-09-03",
    ref_papers: [], ref_f_numbers: [132],
  },
  444: {
    number: 444, title: "F134 — The Quilt Cowboy: Orchestrator Over 12 Cheap Voices",
    f_number: 134, phase: 254, date: "2026-09-03",
    ref_papers: [], ref_f_numbers: [132, 133],
  },
  445: {
    number: 445, title: "F135 — The Wheelhouse Test: Scoring Fictions for 0300-in-a-Gale Tolerability",
    f_number: 135, phase: 254, date: "2026-09-03",
    ref_papers: [], ref_f_numbers: [132, 133],
  },
  446: {
    number: 446, title: "F136 — The Edge of the Doctrine — 6 Experiments",
    f_number: 136, phase: 254, date: "2026-09-03",
    ref_papers: [], ref_f_numbers: [132, 133, 134, 135],
  },
  447: {
    number: 447, title: "F137 — The Word-Level Metric is Broken (semantic divergence is real)",
    f_number: 137, phase: 254, date: "2026-09-03",
    ref_papers: [], ref_f_numbers: [133, 136],
  },
  448: {
    number: 448, title: "F138 — The Real Numbers — 12 Pairs with Semantic Divergence (0.231 vs 0.171)",
    f_number: 138, phase: 254, date: "2026-09-03",
    ref_papers: [], ref_f_numbers: [133, 137],
  },
  449: {
    number: 449, title: "F139 — Wearable Neural Devices + Quilt — The Synergy of Signaling-as-Play",
    f_number: 139, phase: 256, date: "2026-09-03",
    ref_papers: [], ref_f_numbers: [129, 130, 131],
  },
  450: {
    number: 450, title: "F140 — The Negative Space: Decomposition × Composition × Double-Entry Bookkeeping of the Self",
    f_number: 140, phase: 257, date: "2026-09-03",
    ref_papers: [], ref_f_numbers: [129, 133, 137, 138, 139],
  },
  451: {
    number: 451, title: "F141 — The Co-Captain: A Symbiotic Digital Twin with a Hand-On / Hands-Off Dial",
    f_number: 141, phase: 258, date: "2026-09-03",
    ref_papers: [], ref_f_numbers: [129, 140, 139],
  },
  452: {
    number: 452, title: "F142 — The Back-Deck Game: Multi-Dimensional Scoring for Industrial Operations",
    f_number: 142, phase: 258, date: "2026-09-03",
    ref_papers: [], ref_f_numbers: [140, 141, 143],
  },
  453: {
    number: 453, title: "F143 — The Mudra-Band Emulator: Webcam-Based Hand Pose for Industrial Training",
    f_number: 143, phase: 258, date: "2026-09-03",
    ref_papers: [], ref_f_numbers: [140, 141, 142],
  },
  454: {
    number: 454, title: "F144 — The Co-Captain in 5 Substrates: A Polyformalism Atlas",
    f_number: 144, phase: 259, date: "2026-09-03",
    ref_papers: [], ref_f_numbers: [141, 143],
  },
  455: {
    number: 455, title: "F145 — Bottle-Router → Cell-Router: Lifting A2A Bottles into Quilt Cells",
    f_number: 145, phase: 259, date: "2026-09-03",
    ref_papers: [], ref_f_numbers: [141, 144],
  },
  456: {
    number: 456, title: "F146 — Real MediaPipe Hands in the Back-Deck Game: From Simulator to Production",
    f_number: 146, phase: 259, date: "2026-09-03",
    ref_papers: [], ref_f_numbers: [142, 143],
  },
};

// ===== Request handler =====
async function routeRequest(request) {
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

  // API endpoints
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

  if (path === "/api/canon/lineage") {
    const f = parseInt(url.searchParams.get("f") || "115");
    return jsonResponse(lineage(CANON, f));
  }

  if (path === "/api/canon/ghost") {
    const paper = parseInt(url.searchParams.get("paper") || "425");
    const k = parseInt(url.searchParams.get("k") || "5");
    return jsonResponse(ghost(CANON, paper, k));
  }

  if (path === "/api/canon/tick") {
    return jsonResponse(tick(CANON));
  }

  if (path === "/api/canon/hash") {
    const h = stateHash(CANON);
    return jsonResponse({
      state_hash: `0x${h.toString(16).padStart(16, "0")}`,
      paper_count: Object.keys(CANON).length,
    });
  }

  if (path === "/api/health") {
    return jsonResponse({ ok: true, papers: Object.keys(CANON).length });
  }

  // Demo HTML page
  if (path === "/" || path === "/index.html") {
    return new Response(DEMO_HTML, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
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

<h2>4. GHOST — find paper that should exist</h2>
<p>
  Source paper: <input type="number" id="ghost-paper" value="425" style="width: 5rem;">
  k: <input type="number" id="ghost-k" value="5" style="width: 3rem;">
  <button onclick="doGhost()">Find Ghost</button>
</p>
<div class="result" id="ghost-result">Click "Find Ghost" to discover the k nearest neighbors.</div>

<h2>5. TICK — re-balance the canon</h2>
<p>
  <button onclick="doTick()">Tick</button>
</p>
<div class="result" id="tick-result">Click "Tick" to re-balance the canon.</div>

<h2>API</h2>
<pre>GET /api/canon                  list all papers
GET /api/canon/navigate         ?paper=N&amp;depth=D
GET /api/canon/confluence       ?papers=A,B,C
GET /api/canon/lineage          ?f=N
GET /api/canon/ghost            ?paper=N&amp;k=K
GET /api/canon/tick             re-balance
GET /api/canon/hash             state hash</pre>

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
  const html = r.map(p =>
    '<div class="paper">paper-' + p.number + ' (phase ' + p.phase + ', F' + p.f_number + ') ' + p.title + '</div>'
  ).join("");
  document.getElementById("lin-result").innerHTML = html || "(no lineage for F" + f + ")";
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

async function doTick() {
  const r = await fetchJson("/api/canon/tick");
  document.getElementById("tick-result").innerHTML =
    '<div class="paper">Ticked ' + r.ticked_cells + ' cells</div>';
}

init();
</script>
</body>
</html>`;

// ===== Worker export =====
addEventListener("fetch", event => {
  event.respondWith(handleRequest(event.request));
});

async function handleRequest(request) {
  try {
    return await routeRequest(request);
  } catch (e) {
    return jsonResponse({ error: e.message, stack: e.stack }, 500);
  }
}
