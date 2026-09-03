# quilt-live-canon

**The Live Canon as a Cloudflare Worker** — production deployment of F129.

## Live URL

🌐 **https://live-canon.superinstance.dev**

## Endpoints

| Path | Method | Description |
|---|---|---|
| `/` | GET | HTML demo page |
| `/api/health` | GET | Health check |
| `/api/canon` | GET | List all 9 bundled papers |
| `/api/canon/navigate?paper=N&depth=D` | GET | BFS through citations |
| `/api/canon/confluence?papers=A,B,C` | GET | Join 2+ papers, suggest synthesis |
| `/api/canon/lineage?f=N` | GET | Papers that cite F{N} |
| `/api/canon/ghost?paper=N&k=K` | GET | k nearest neighbors by dial-vector |
| `/api/canon/tick` | GET | Re-balance the canon |
| `/api/canon/hash` | GET | State hash of the canon |

## Live state (Sep 3 2026)

```json
{
  "state_hash": "0xbf27a3631cdee337",
  "paper_count": 9
}
```

The state hash is **byte-exact** with the Python reference implementation.

## Architecture

- **`worker.js`** (16.9KB) — The Cloudflare Worker
  - FNV-1a 64-bit hash (UTF-8 byte-exact with Python)
  - Cell encoding (16 x Q1.15 dials, byte-exact with Python/C/Rust/Verilog/VHDL)
  - 5 operations: NAVIGATE, CONFLUENCE, LINEAGE, GHOST, TICK
  - HTML demo page (dark theme, interactive buttons)
- **`test_substrates.py`** — verify byte-exact state hash across substrates
- **9 bundled papers** — the polyformalism cascade F115 → F130

## The 9 bundled papers

| Number | F-number | Phase | Title (truncated) |
|---|---|---|---|
| 425 | F115 | 237 | The Logical Routes: VHDL × Verilog × the QUF bit-exactness |
| 426 | F116 | 238 | The 5+1+1+1+1+1+1+1+1+1+1 Opcodes in 5 Substrates |
| 427 | F117 | 239 | The 5-Substrate Polyformalism |
| 428 | F118 | 240 | The Polyformalism in Production |
| 429 | F119 | 241 | The 6-Substrate Polyformalism: cell-runtime |
| 432 | F122 | 244 | The Shape Store: 5 Indices on Cloudflare Vectorize |
| 433 | F123 | 245 | The Composer Agent: 5 Cells, 80 Parameters |
| 439 | F129 | 251 | The Live Canon: Papers as Cells, Reading as Navigation |
| 440 | F130 | 251 | The Polyformal Live Canon: One Cell, Five Substrates |

## Related

- **`AI-Writings/paper-439.md`** — F129 (the concept)
- **`AI-Writings/paper-440.md`** — F130 (the polyformal proof)
- **`quilt-timesfm/live_canon.py`** — Python reference
- **`quilt-c/live_canon.c`** — C99 port
- **`quilt-rust/crates/live-canon/`** — Rust port
- **`quilt-verilog/rtl/live_canon.v`** — Verilog port
- **`quf-vhdl/rtl/live_canon.vhdl`** — VHDL port

## Deployment

```bash
# Deploy to Cloudflare
curl -X PUT \
  -H "Authorization: Bearer $CLOUDFLARE_TOKEN" \
  -H "Content-Type: application/javascript" \
  --data-binary @worker.js \
  "https://api.cloudflare.com/client/v4/accounts/049ff5e84ecf636b53b162cbb580aae6/workers/scripts/live-canon"
```

The route `live-canon.superinstance.dev/*` maps to this worker.

## Phase 251 of the polyformalism canon.

The chart grows because the cowboy rides. The Concept lives because the cell survives portability. The 6 substrates speak the same language. The cowboy rides the deployed canon.
