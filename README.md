# quilt-live-canon

**The Live Canon as a Cloudflare Worker** — production deployment of
F129 (the Live Canon as a navigable cell fabric).

## Live URL

🌐 **https://live-canon.superinstance.dev**

## What this is

The AI-Writings seed canon (70+ papers) deployed as a read-only REST API.
Each paper is one cell. Each citation is one edge. The 5 canon operations
(navigate, confluence, lineage, ghost, tick) operate on the cell graph.
The state hash is the contract.

This is a 1-file Cloudflare Worker. No KV, no D1, no R2. The canon is
bundled in the script so the demo works without external storage.

## Endpoints

| Path                                  | Method | Description                                      |
|---------------------------------------|--------|--------------------------------------------------|
| `/`                                   | GET    | HTML demo page (server-renders all 70 papers)    |
| `/api/health`                         | GET    | Health check                                     |
| `/api/canon`                          | GET    | List all 70 papers (with date, refs, f_numbers)  |
| `/api/canon/navigate?paper=N&depth=D` | GET    | BFS through citations from paper N               |
| `/api/canon/confluence?papers=A,B,C`  | GET    | Join 2+ papers, suggest synthesis title          |
| `/api/canon/lineage?f=N`              | GET    | Papers that cite F{N}                            |
| `/api/canon/ghost?paper=N&k=K`        | GET    | k nearest neighbors by dial-vector cosine sim    |
| `/api/canon/tick`                     | GET    | Re-balance the canon (returns cell count)        |
| `/api/canon/hash`                     | GET    | State hash of the canon                          |
| `/api/agent/manifest`                 | GET    | Layer 1 of the agent priming toolkit             |
| `/api/agent/tools`                    | GET    | Layer 2 — tool catalog                           |
| `/api/agent/doctrine`                 | GET    | Layer 3 — full Mechanic Doctrine (F158)           |
| `/api/agent/context?topic=X`          | GET    | Layer 4 — topic-specific paper list              |
| `/api/agent/identify`                 | POST   | Returns the right layers for NIL/MAK/RUN         |
| `/api/agent/jobs`                     | GET    | All 3 job profiles (NIL, MAK, RUN)               |
| `/api/agent/schema`                   | GET    | JSON Schema for all payloads                     |
| `/.well-known/agent.json`             | GET    | MCP discovery                                    |
| `/.well-known/llm-tools.json`         | GET    | Anthropic-compatible tool catalog                |

## Live state (2026-09-04)

```json
{
  "state_hash": "0x16244e621bbd6d9c",
  "paper_count": 70,
  "f_number_range": "F98 — F168",
  "phase_range": "Phase 222 — Phase 268"
}
```

## The 5 Operations

1. **NAVIGATE** — BFS through the citation graph from a paper.
   ```
   GET /api/canon/navigate?paper=425&depth=2
   ```
   Returns the start paper + 2-hop neighborhood.

2. **CONFLUENCE** — Join 2+ papers, find shared F-numbers, suggest a synthesis title.
   ```
   GET /api/canon/confluence?papers=425,430,432
   ```
   Useful for "what paper should I write next that connects these 3?"

3. **LINEAGE** — Trace a concept (F-number) through time.
   ```
   GET /api/canon/lineage?f=140
   ```
   Returns all papers that cite F140.

4. **GHOST** — Find k nearest neighbors by dial-vector cosine similarity.
   ```
   GET /api/canon/ghost?paper=425&k=5
   ```
   The 16-dial cell encoding makes each paper a point in 16-D space.
   Cosine similarity is the right metric for "is this related?"

5. **TICK** — Re-balance the canon. Returns the cell count.
   ```
   GET /api/canon/tick
   ```
   A no-op (the canon is read-only) but the operation exists for parity
   with the cell-runtime's 5-op model.

## The cell encoding

Each paper maps to a 16-dial cell via `cellToDials(paper)`:

```
dial 0:  paper_number * 131                (e.g. 425 → 55675)
dial 1:  title_hash_lo (low 16 bits)       (FNV-1a of title)
dial 2:  f_number * 218
dial 3:  phase * 218
dial 4:  (year - 1970) * 546
dial 5:  n_refs * 256 (capped at 0x7FFF)
dial 6:  title_hash_hi (bits 16-31)
dials 7-15: 0 (reserved)
```

This is byte-exact across Python, JS, C, Rust, Verilog, and VHDL (F110, F144).
The state hash is FNV-1a 64 over the sorted concatenation of all dials.

## Deployment

The Worker is deployed via the Cloudflare Workers PUT API. No wrangler needed.

```bash
ACCT="049ff5e84ecf636b53b162cbb580aae6"
TOKEN="cfut_..."
curl -X PUT \
  "https://api.cloudflare.com/client/v4/accounts/${ACCT}/workers/scripts/live-canon" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/javascript" \
  --data-binary @worker.js
```

The custom domain `live-canon.superinstance.dev` is wired to this worker
via a Cloudflare route.

## Audit history

- **2026-09-03**: 52 papers, state hash 0x89741eb67ca6f055
- **2026-09-04**: 70 papers (added F167, F168, and 16 lifted gaps), state hash 0x16244e621bbd6d9c

The 18 added papers all exist in the AI-Writings seed canon; they were
simply not wired into the live canon. The 16 lifted gaps are papers 411-422
(predate the F-numbering convention), 430-438 (F120-F128), and 460 (F148).
Their phases were inferred from the surrounding papers; their refs were
scraped from the paper bodies.

## Polyformalism

The cell graph is byte-exact across 6 substrates (Python, JS, C, Rust,
Verilog, VHDL). This is the F110 claim. The state hash 0x16244e621bbd6d9c
is the contract. If two substrates produce different hashes for the same
canon, one of them is wrong.

## See also

- The Mechanic Doctrine: `GET /api/agent/doctrine` (F158, paper-467)
- The Working Animal Doctrine: `GET /api/canon/lineage?f=160` (F160, paper-469)
- The PLATO Room Protocol: `GET /api/canon/lineage?f=162` (F162, paper-471)
- Conservation Laws as Fences: `GET /api/canon/lineage?f=161` (F161, paper-470)

🌐 The cell is the unit. The hash is the address. The cowboy rides.
