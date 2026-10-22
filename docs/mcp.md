# MCP server

A headless [Model Context Protocol](https://modelcontextprotocol.io) server
that exposes the command and query tables as tools, so an AI agent can build,
simulate and measure circuits without a browser. It lives in `web/mcp/`, is
built separately from the site, and never ships in `web/dist`.

## What it is

The server is a developer tool in this repository, not part of the static site.
It runs the same store, netlist IO and wasm engine the browser runs, in Node,
with a `SimHost` that owns building and stepping instead of the frame loop. The
project's "if the canvas were deleted, the logic should still pass its unit
tests" rule is what makes this possible: nothing on the command, query, netlist
or simulation path needs a DOM.

One document per process, fresh at boot. `--load <file>` reads a netlist once
at startup; after that `circuit_loadText` replaces the document.

## Build and run

- `just mcp-build` builds the wasm engine and the artifact at
  `web/dist-mcp/cirquit-mcp.mjs`. It is also a dependency of `just build`, so a
  broken server entry fails `just ci`.
- `just mcp` runs the built artifact on stdio.
- Copy `.mcp.json.example` to `.mcp.json` (gitignored; only the example is
  committed) or point a host's stdio entry at
  `node web/dist-mcp/cirquit-mcp.mjs`.

The build is `web/vite.mcp.config.ts`, an SSR build that externalises the SDK
and other dependencies and copies the wasm file beside the bundle. It is a
separate config from `vite.config.ts`, so `@modelcontextprotocol/sdk` and
`web/mcp` cannot reach the site bundle. `@modelcontextprotocol/sdk` is a
devDependency.

## Tools

One MCP tool per command and per query. The name is the dotted id with dots
replaced by underscores (`element.add` becomes `element_add`); the id grammar is
pinned by `registry.test.ts`, and `tools.test.ts` pins that every name matches
the tool-name character set and that the listing is exactly the two tables. The
`inputSchema` is the definition's `args` object by reference: the registry's
hand-rolled JSON-Schema subset is plain JSON Schema, so it serialises straight
into a listing. Descriptions come from the definitions; a `history: 'step'`
command gets `Writes the document as one undo step.` appended.

Annotations carry what the definitions already say: every query is
`readOnlyHint`, and a `destructive: true` command (`circuit.new`,
`circuit.loadText`) is `destructiveHint`.

Dispatch is the one door the UI uses: `execute(id, args, { source: 'agent' })`
or `query(id, args)`. A success becomes a JSON text block plus
`structuredContent` (a non-object result is wrapped as `{ result }` so the
field is always an object). A refusal becomes `isError: true` with the error
code and message in the text and in `structuredContent`. An unknown name, an
invalid argument (the message carries the validator path, `args.kind`), a
disabled command and an unexpected throw all come back as results; no handler
throws out.

`schematic_svg` additionally returns an image block whose data is the SVG text
base64-encoded with `mimeType: image/svg+xml`, so a host that renders images can
show it. There is no rasterising and no native dependency; a truncated payload
(invalid XML) is left out of the image block.

## Resources

`cirquit://netlist` (the current text) and `cirquit://kinds` (the kind list) are
thin wrappers over `circuit.netlist` and `kinds.list` for hosts that prefer a
resource read over a tool call. A failed read comes back as error text, never a
throw.

## Value-only edits and run control

`sync` in `web/mcp/headlessHost.ts` does two jobs, mirroring the two engine
paths the browser frame loop drives. A revision change rebuilds the circuit. A
value-only edit (`element.update`, `slider.set`, `element.setState` or
`element.toggleSwitch`) bumps only `paramRevision`, so `sync` drains
`pendingParams` and `pendingStates` through `engine.setParam` and
`engine.setState`, with one full rebuild if a call refuses, then calls
`clearPending`. Without that drain the engine keeps solving the old value while
the store reports the new one, so `sim_step` and `element_readings` answer from
a stale part. Sync runs before every read, step and run control, and is a no-op
when nothing changed, so repeated reads neither rebuild nor move the clock.

The two run-control commands (`sim.reset`, `sim.dcOperatingPoint`) call
`simHost.sync()` before touching the engine (`createSimControls` in
`web/mcp/server.ts`). Without it, a command issued after `circuit_loadText`
resets or solves the previous document, because nothing else had built the new
one yet.

## The step budget

`sim_step` advances simulated time synchronously, in chunks, and honours two
limits in `web/mcp/headlessHost.ts`:

- `MAX_HEADLESS_STEPS` (50,000): a hard cap on steps per call, independent of
  the caller's `maxSteps`. A 1 ps timestep asked for 10 s needs 1e13 steps.
- `STEP_WALL_BUDGET_MS` (1,500): a wall-clock budget, checked between chunks.

When either limit truncates the run, the result carries a `stopped` reason
instead of blocking the stdio loop. A step error or an engine that makes no
progress also stops with a reason. `sim_run` and `sim_pause` only move the
store's `running` flag here; nothing advances the clock except `sim_step`, and
`sim.step` refuses while `running` is set, exactly as the browser host refuses
while the frame loop owns the engine.

## No filesystem access

Tools take and return netlist text; they never read or write files. The agent's
own file tools handle files, so the server needs no sandbox policy and cannot
reach outside what the agent already can. The only file read is `--load` at
startup, and the wasm binary at boot.
