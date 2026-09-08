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
curl https://live-canon.superinstance.dev/api/tick
# {"state_hash": "0xbf27a3631cdee337"}

# Get the 30-second protocol for any language
curl 'https://live-canon.superinstance.dev/api/vibe?lang=python'

# Verify a port's hash
curl 'https://live-canon.superinstance.dev/api/quilt/verify?lang=go&hash=0xe435d91d6d92a1d8'
```

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
