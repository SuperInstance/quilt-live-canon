# 🌐 quilt-live-canon

> **The Quilt cell-fabric runtime as a Cloudflare Worker.** Deployed at [live-canon.superinstance.dev](https://live-canon.superinstance.dev). 6 opcodes (NAVIGATE, CONFLUENCE, LINEAGE, GHOST, TICK, F/V EILEEN) plus `/api/vibe` and `/api/quilt/verify`. State hash is byte-exact with the Python reference.

<p align="center">
  <img src="https://img.shields.io/badge/license-Apache--2.0-blue.svg" alt="Apache-2.0">
  <img src="https://img.shields.io/badge/version-live-brightgreen.svg" alt="live">
  <img src="https://img.shields.io/badge/runtime-Cloudflare%20Workers-orange.svg" alt="CF Workers">
  <img src="https://img.shields.io/badge/hash-0xbf27a3631cdee337-brightgreen.svg" alt="byte-exact">
</p>

## ✦ Why this port exists

A Quilt in a Cloudflare Worker is a Quilt at the edge. The cell model is no longer running on your machine — it's running in 200+ cities worldwide, sub-50ms from any user. The fabric is the network. The state is canonical.

This is the **deployed** port. The byte-exact hash of the live URL is `0xbf27a3631cdee337`, identical to the Python reference. The polyformalism is not just portable; it's *in production*.

## ✦ The 6+2 opcodes (live)

The live worker exposes 8 endpoints:

```
GET  /                          # the live canon UI
GET  /api/navigate?id=N         # NAVIGATE: read a cell
GET  /api/confluence?ids=A,B,C   # CONFLUENCE: merge multiple cells
GET  /api/lineage?id=N          # LINEAGE: trace dependencies
GET  /api/ghost?id=N            # GHOST: cell that "never was"
GET  /api/tick                  # TICK: advance all dials
GET  /api/f                     # F: formula engine
GET  /api/vibe?lang={go|zig|mojo|rust}  # VIBE: the 30-second protocol
GET  /api/quilt/verify?lang=X&hash=0x... # VERIFY: byte-exact check
```

## ✦ Try it

```bash
# Verify the live state hash matches the Python reference
curl https://live-canon.superinstance.dev/api/canon/hash
# {"state_hash": "0x…", "paper_count": 14, "test_cell_hash": "0xe435d91d6d92a1d8"}

# Get the 30-second protocol for any language
curl 'https://live-canon.superinstance.dev/api/vibe?lang=python'

# Verify a port's hash
curl 'https://live-canon.superinstance.dev/api/quilt/verify?lang=go&hash=0xe435d91d6d92a1d8'

# Open the 4×4 Playground in a browser
open https://live-canon.superinstance.dev/playground

# Submit a new cell
curl -X POST https://live-canon.superinstance.dev/api/cell \
  -H 'Content-Type: application/json' \
  -d '{"dials":[1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16],"refs":[2,3,4],"title":"my first cell"}'

# WebSocket Room Durable Object (broadcast group)
websocat ws://live-canon.superinstance.dev/ws/room/abc
```

## ✦ The full endpoint surface

```
GET  /                                              # demo HTML
GET  /playground                                    # 4×4 dial editor + share + port inspector
GET  /api/canon                                     # list all papers
GET  /api/canon/navigate            ?paper=N&depth=D
GET  /api/canon/confluence          ?papers=A,B,C
GET  /api/canon/lineage             ?f=N            # papers citing F{N}
GET  /api/canon/lineage             ?from=A&to=B    # BFS path A→B (≤6 hops)
GET  /api/canon/ghost               ?paper=N&k=K    # cosine-NN
GET  /api/canon/similar             ?id=N&k=K       # top-k similar (cosine+f-prox+f-ov+word)
GET  /api/canon/random                              # one random cell
GET  /api/canon/cell/N                              # full cell data for paper N
GET  /api/canon/tick                                # re-balance
GET  /api/canon/hash                                # state hash
POST /api/cell                      {dials, refs, title}   # admit a new cell
GET  /api/cell/seed                                 # the canonical test cell (id=1)
GET  /api/share                     ?dials=&refs=&title=    # signed permalink
GET  /api/vibe                      ?lang=X
GET  /api/quilt/verify              ?lang=X&hash=0x…
GET  /api/ports                                     # 11 verified polyformalism ports
GET  /api/charter                                    # the Quilt Charter (markdown)
GET  /api/tutorial                                   # 5-minute zero-to-byte-exact
GET  /api/health                                     # liveness
GET  /ws/room/:id                                    # WebSocket → Room Durable Object
```

## ✦ The Playground

`/playground` is a single-file HTML page (~18 KB) that:

- Renders a 4×4 grid of range sliders (16 signed Q1.15 dials, -32768..32767)
- Shows the live state hash at the top, with a comparison to the test vectors
  `0xbf27a3631cdee337` (canon target) and `0xe435d91d6d92a1d8` (cell test)
- Wires up 5 opcodes: TICK (alternating +1/-1), BIND, LINK, VERIFY, ADMIT
- Computes the local FNV-1a 64 cell hash byte-exactly and checks it against
  the seed cell hash `0xe435d91d6d92a1d8`
- Generates a signed permalink (`?c=<hex>&s=<sig>`) and copies it to clipboard
- Fetches the vibe-code protocol for any of 11 ports and shows the source

No external dependencies. No build step. The whole page is one self-contained
`<script>` block.

## ✦ The WebSocket Room Durable Object

A `Room` class (declared in `worker.js` + `wrangler.toml`) is a broadcast
group keyed by room id. Every message any client sends is delivered to all
other clients in the same room. The DO uses the Hibernation API
(`acceptWebSocket` + `getWebSockets()`) so it sleeps between messages and
incurs zero cost when idle.

## ✦ The byte-exact contract

| Substrate | State hash | Status |
|-----------|------------|--------|
| Python reference | `0xbf27a3631cdee337` | ✓ |
| Cloudflare Worker (live) | `0xbf27a3631cdee337` | ✓ live |
| C99 | `0xbf27a3631cdee337` | ✓ |
| Rust | `0xbf27a3631cdee337` | ✓ |
| Verilog | `0xbf27a3631cdee337` | ✓ |
| VHDL | `0xbf27a3631cdee337` | ✓ |
| JavaScript | `0xbf27a3631cdee337` | ✓ |

The hash of the *live, deployed, edge-running* canon is byte-exact with the Python reference. The polyformalism is not a research result; it's a production fact.

## ✦ The architecture

```
┌─────────────┐     ┌──────────────────┐     ┌──────────────┐
│  Browser    │────▶│ Cloudflare Edge  │────▶│ Vectorize    │
│  (cell UI)  │     │ (worker.js)      │     │ (768d embed) │
└─────────────┘     └──────────────────┘     └──────────────┘
                            │
                            ▼
                    ┌──────────────┐
                    │ KV Namespace │
                    │ (state hash) │
                    └──────────────┘
```

- **Cloudflare Worker** — the runtime (`worker.js`, 593 lines, std-only)
- **Vectorize** — semantic search over 230+ papers (768d, cosine)
- **KV Namespace** — durable state hash, version-tracked
- **Edge replication** — the worker runs in 200+ cities

## ✦ Why this port is distinctive

Three reasons:

1. **Network state** — the fabric is a network state, not a memory state
2. **Edge runtime** — the cell model runs at the edge, not on a server
3. **Vectorize integration** — the canon is searchable by meaning, not just by id

A Quilt in a Cloudflare Worker is a Quilt that ships in milliseconds and searches by meaning. That's the value.

## ✦ See also

- [The Quilt Charter](https://github.com/SuperInstance/quilt-claude-charts/blob/main/QUILT_CHARTER.md) — the educational root
- [quilt-claude-charts](https://github.com/SuperInstance/quilt-claude-charts) — protocol + 3 charts
- [AI-Writings](https://github.com/SuperInstance/AI-Writings) — the canon
- [live-canon.superinstance.dev](https://live-canon.superinstance.dev) — the live deployment
- [quilt-c](https://github.com/SuperInstance/quilt-c), [quilt-rust](https://github.com/SuperInstance/quilt-rust), [quilt-go](https://github.com/SuperInstance/quilt-go), [quilt-zig](https://github.com/SuperInstance/quilt-zig), [quilt-mojo](https://github.com/SuperInstance/quilt-mojo), [quilt-rust-vibe](https://github.com/SuperInstance/quilt-rust-vibe) — the polyformalism
- [quilt-verilog](https://github.com/SuperInstance/quilt-verilog), [quf-vhdl](https://github.com/SuperInstance/quf-vhdl) — hardware ports

## ✦ License

Apache-2.0. Free as in freedom.
