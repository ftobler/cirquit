# Project knowledge

What a contributor needs to know to change this code without breaking it:
invariants, deliberate divergences from upstream CircuitJS1, non-obvious
mechanisms and traps. Start with [OVERVIEW.md](../OVERVIEW.md) for the
architecture, porting status, roadmap and the file-format table; these pages
go deeper on one area each.

| File                               | Covers                                                                 |
| ---------------------------------- | ---------------------------------------------------------------------- |
| [decisions.md](decisions.md)       | Owner policy decisions and the judgement calls still open.             |
| [engine.md](engine.md)             | Matrix, closures, sparse LU, DC operating point, timestep, recovery.   |
| [elements.md](elements.md)         | Per-element models, upstream sources and quirks.                       |
| [netlist.md](netlist.md)           | Cross-cutting `.txt` format rules, model lines, sliders, XML import.   |
| [subcircuits.md](subcircuits.md)   | `.` models, `410` elements, composites, drill-in.                      |
| [buses.md](buses.md)               | Multi-bit buses across engine and frontend.                            |
| [scope.md](scope.md)               | Scope capture, the `o` line, scope drawing and windows.                |
| [editor.md](editor.md)             | Store, undo, gestures, placement, splitting, transforms.               |
| [commands.md](commands.md)         | The command registry: the public mutation API and its doors.           |
| [keyboard.md](keyboard.md)         | Shortcut matching, assignable keys, precedence.                        |
| [rendering.md](rendering.md)       | Canvas drawing conventions, symbols, dots and overlays.                |
| [ui.md](ui.md)                     | React UI, dialogs, menus, preferences, docs pages, deployment.         |
| [testing.md](testing.md)           | Test suites, corpus, benchmarks and test-writing traps.                |

## Conventions

- **Diverges from upstream** marks behaviour that differs from CircuitJS1 on
  purpose. Search for it before "fixing" something toward upstream.
- Upstream references are `File.java:line` in the `reference/circuitjs1`
  checkout (`just setup` fetches it). Port references are a path plus a
  symbol name, without line numbers.
- Entries describe the current code. When a change makes an entry false, fix
  the entry in the same commit. How and when to write here is in
  [AGENTS.md](../AGENTS.md) under "Knowledge tracking".
