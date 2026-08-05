# falstad-cirquit

A port of [Falstad's CircuitJS1](https://github.com/pfalstad/circuitjs1) to React + TypeScript, with the simulation engine (MNA solver, Newton-Raphson, device models) in Rust compiled to WebAssembly. Static site, no server.

Build and run with [`just`](https://github.com/casey/just): `just setup`, `just wasm`, then `just dev`. See [OVERVIEW.md](OVERVIEW.md) for architecture and the porting roadmap.

Licensed GPL-2.0-or-later, matching upstream — see [COPYING](COPYING).
