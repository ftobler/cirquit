# falstad-cirquit

A port of [Falstad's CircuitJS1](https://github.com/pfalstad/circuitjs1) to React + TypeScript, with the simulation engine (MNA solver, Newton-Raphson, device models) in Rust compiled to WebAssembly. Static site, no server.

Live app: [https://ftobler.github.io/cirquit/](https://ftobler.github.io/cirquit/). Build and run with [`just`](https://github.com/casey/just): `just setup`, `just wasm`, then `just dev`. See [OVERVIEW.md](OVERVIEW.md) for architecture and the porting roadmap.

## MCP server

A headless [MCP](https://modelcontextprotocol.io) server lets an AI agent build and simulate circuits over stdio. Build it with `just mcp-build`, run it with `just mcp`, and register it from [`.mcp.json.example`](.mcp.json.example). See [docs/mcp.md](docs/mcp.md).

Licensed GPL-2.0-or-later, matching upstream.
