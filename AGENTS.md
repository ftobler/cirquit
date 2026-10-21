# Guidelines for agents

Read [OVERVIEW.md](OVERVIEW.md) first. It holds the architecture, the porting
roadmap, and the conventions that are easy to get wrong.

## What this is

A browser circuit simulator: a port of Falstad's CircuitJS1. Two halves joined
by a `kind` string per element type.

| Part     | Path      | Stack                                        |
| -------- | --------- | -------------------------------------------- |
| Engine   | `engine/` | Rust workspace to WebAssembly via `wasm-pack` |
| Frontend | `web/`    | React 19 + TypeScript + Vite                 |

Static site, no server, no backend. [`just`](https://github.com/casey/just) runs
everything; `just` on its own lists all recipes.

## Commands

### What `just` is

[`just`](https://github.com/casey/just) is a command runner. Think `make`, but
only for running tasks, with no build graph, no file-timestamp checks and no
tab-sensitive syntax. Tasks are called **recipes** and live in the `justfile` at
the repo root.

A recipe is a name, an optional dependency list after `:`, then indented shell
lines:

```just
# Comments above a recipe become its `--list` description.
test: wasm              # runs wasm first, then these lines
    cargo test --workspace
```

Usage:

- `just` lists every recipe with its description
- `just <recipe>` runs one; dependencies run first, and it stops on the first
  failing line
- `just --show <recipe>` prints a recipe without running it

Each line runs in its own shell, so `cd web` on one line does not carry to the
next. Recipes here chain with `&&` or use a `#!/usr/bin/env bash` shebang block
when they need multiple statements to share state. Recipes always run from the
repo root regardless of your current directory, so paths in the `justfile` are
root-relative.

Prefer the recipes over typing raw `cargo` or `npm` commands. They carry the
flags and ordering CI depends on.

### The gate

**"Run the gate" means `just ci`**: lint, then tests, then build, in the same
order CI runs them. It is the single check that must pass before any work is
called done. Run it before saying anything is finished.

| Command                         | What it does                                           |
| ------------------------------- | ------------------------------------------------------ |
| `just ci`                       | **The gate.** Lint + test + build, in CI order.         |
| `just dev`                      | Dev server; does not rebuild the wasm engine.           |
| `just build`                    | Production build into `web/dist`.                       |
| `just test`                     | Rust and TypeScript tests.                              |
| `just test-rust`                | Rust only, fast; use while working on the engine.       |
| `just test-web`                 | TypeScript only.                                        |
| `just lint`                     | `cargo fmt --check`, clippy, eslint, `tsc`.             |
| `just format`                   | Autoformat both halves.                                 |
| `just wasm`                     | Rebuild `web/src/wasm/` after an engine change.         |
| `just wasm-dev`                 | Same, with debug assertions and readable panics.        |
| `just setup`                    | One-time: toolchains, npm install, upstream reference.  |
| `just import-cirquits-upstream` | Refresh the bundled circuit library from upstream.      |

Changing anything in `engine/` requires `just wasm` before the frontend sees it.
`just dev` only starts Vite; it does not build the engine.

**Leave the dev server alone.** `just dev` is the owner's to run. Assume one may
already be running: do not start, stop, restart or kill it, and do not kill
whatever holds its port. Vite hot-reloads the frontend on its own, so edits show
up without help; after an engine change run `just wasm` and let the
running server pick it up. To verify work, use `just ci`, not by taking over the
dev server.

## Git

- **Do not commit or push unless the repository owner explicitly asks.** Leave
  finished work in the working tree and say it is ready.
- **No AI co-author trailers.** Never add `Co-Authored-By: Claude`, "Generated
  with" footers, or any similar attribution to commits or PR descriptions.
- Commit messages start as a normal sentence. Write `Fix sign error in the
  inductor companion model`, not `fix(engine): sign error...`. No
  conventional-commit prefixes.
- Write in the owner's voice: what changed and why, nothing about how it was
  produced.
- on UI only fixes consider a given permission to commit to be one-time. Unless the
  user is saying otherwise.

## Feature planning and implementing

The backlog lives in `feature/`, which is gitignored, so nothing in it is ever
committed to this repo. One file per feature, plus an index.

**When asked to plan a feature:**

- Read the existing `feature/*.md` files first, to know what is already in
  development.
- Read the codebase and do deep architectural research before writing.
- Write a detailed plan, including test specs.
- Put it in `feature/<topic>.md`.
- Do **not** execute the plan or touch any other file.
- Add a `pending` entry to `feature/overview.md` (see below) at the position
  it should be applied in.

**When asked to plan something "light" or "quick":**

- Do no research.
- Dump the user's intent plus whatever you already know into the plan file.
- Do not play the architect; that is the implementer's job.
- A mental note or a TODO item is enough.

**When asked to implement a feature:**

- Consult `feature/overview.md` to find the next feature in sequence.
- Read `feature/<topic>.md` and execute according to its content.
- Work in a worktree at `.worktrees/<topic>` on branch `feature/<topic>`,
  unless the owner says to work directly on `dev` or another branch. Whoever
  creates the worktree flips the entry to `in_flight`.
- Always write tests, especially for bugs.
- Code review using a subagent.
- Move lasting findings into `docs/` (see Knowledge tracking).
- When done, flip the entry in `feature/overview.md` to `shipped` and delete
  the `feature/<topic>.md` you implemented from.

### feature/overview.md

An index or a kanban board, not a history. Its job is to be scannable in
seconds.

- One line per entry, always. No continuation lines, no paragraph prose.
- Every entry starts with its state: `pending`, `in_flight`, `shipped` or
  `deferred`. In special circumstances `review`, `merge` or `blocked` are
  allowed, but avoid them.
- Findings, rationale and detail live in the plan, `docs/` or git, never
  here. A plan file is deleted once shipped, so the one-liner is all that
  remains.
- Formats:
  - `- [pending] topic (feature/<topic>.md): one-line intent.`
  - `- [in_flight] topic (feature/<topic>.md): one-line intent.` Some agent is
    working on it. Agents are ephemeral and have no name to track.
  - `- [shipped] <hash> topic (~~feature/<topic>.md~~): one-line outcome.` The
    hash is the tip commit on `dev`, or the batch tip for a multi-commit entry.
    In this state the worktree is removed and the branch merged to `dev`;
    cleanup is the job of whoever merges it.
  - `- [deferred] topic (feature/<topic>.md): one-line note.`
- Auto-prune: on every touch, collapse the file back to one line per entry and
  move anything that needs a second sentence into the plan, `docs/` or git.

## Knowledge tracking

Knowledge lives in three places, split by who needs it and how long it stays
true:

| Where                          | Tracked | Holds                                           |
| ------------------------------ | ------- | ----------------------------------------------- |
| `docs/`                        | yes     | Lasting project knowledge, for any contributor. |
| `feature/<topic>.md`           | no      | Working notes for one feature while in flight.  |
| `feature/knowledgebase.user.md` | no     | The owner's own statements, condensed.          |

Git history is the fourth place: what changed and when belongs in commit
messages, not in any file.

### docs/

The project's memory for contributors. If someone cloning the repo would need
it to avoid breaking something or re-hunting a question, it goes here.
[docs/README.md](docs/README.md) lists the files and what each one covers;
read it before writing.

What belongs:

- Invariants and rules future work must respect, with the failure they prevent.
- Deliberate divergences from upstream: what the port does, what upstream does
  (file and line in `reference/circuitjs1`), and why the port differs. Tag the
  entry **Diverges from upstream** so it can be searched.
- Non-obvious mechanisms: how a flow works across files, with real paths and
  symbol names (`web/src/state/store.ts` `loadNetlist`, not "the store").
- Values with a reason: tolerances, caps, magic constants, and where they come
  from.
- Traps: things that look wrong but are right, or look right but break.
- Owner policy decisions and open owner calls, in `docs/decisions.md`.

What does not belong:

- History. No batch logs, dates of landing, review rounds, test counts or
  "this used to be". Git holds that. A date is fine only on a decision.
- Process notes about agents, worktrees or loops.
- Anything `OVERVIEW.md` already says. Link to it instead; `OVERVIEW.md` stays
  the entry point for architecture, status, roadmap and the file format table.
- Restating what the code says. Say why, not what.

How to write it:

- Organise by topic, never by date. Find the section the knowledge belongs to
  and edit it in place; add a new section only when none fits.
- Present tense, current truth. When code changes make an entry false, fix or
  delete the entry in the same commit as the code.
- Short entries: a heading or a bold lead, then a few sentences. Code
  references as `path` plus symbol; line numbers only for upstream Java, which
  does not move.
- Same style rules as the rest of the repo: no em or en dashes.

When to write it:

- Implementing a feature: before marking it `shipped`, move every lasting
  finding from the plan and your working notes into `docs/`, in the same
  commit series as the code. The plan file is then deleted, so anything not
  moved is lost.
- Fixing a bug whose cause was non-obvious: add the trap to the topic file.
- Reviewing: a reviewer who finds a doc entry the change made false flags it.

### feature/knowledgebase.user.md

The owner's statements and decisions, condensed: not every utterance, not word
for word. Meaning must stay accurate, and one-off bug reports that have landed
belong in the git log, not here. Do not record statements verbatim at length.
When a statement sets project policy, also record the policy in
`docs/decisions.md`, without the conversation around it.

## Testing

- Test driven development. Write the test with the change, not after it.
- For each feature, try to make a test.
- Engine changes must pass `just test-rust`. Frontend changes must pass
  `just test-web`. Everything must pass `just ci` before it is done.
- **If the canvas were deleted, the logic should still pass its unit tests.**
  Simulation, netlist parsing, geometry and value formatting are all testable
  without a DOM, and must stay that way. Nothing that can be tested headlessly
  belongs inside a React component.
- Every new element needs a test in `engine/core/tests/circuits.rs` asserting an
  analytic result. That test is what catches stamping sign errors, so do not
  skip it.

## Architecture

- All simulation runs in Rust compiled to WebAssembly. There is no server and no
  backend; the site is static.
- The engine is blind and deaf. It knows nothing about pixels, symbols or the
  DOM, and communicates only through a circuit description in and flat typed
  arrays out, one call per animation frame. Do not add per-element calls across
  that boundary.
- Keep geometry out of the engine and simulation out of the UI.
- Every element is defined twice on purpose: a model in Rust, a registry entry
  in TypeScript, joined by a shared `kind` string.
- Terminal coordinates must match upstream exactly, or wires in loaded circuits
  will not connect.
- Preserve unknown netlist lines on load and save. Loading and saving a file
  must never lose data.
- Never edit `web/src/wasm/`; it is generated by `just wasm`.
- `reference/circuitjs1` is a gitignored upstream checkout, kept only to look up
  file-format details and terminal geometry. Do not copy code out of it; write
  original implementations of the standard algorithms.
- This is a GPL-2.0 derivative work. Keep the licence, and keep upstream
  attribution on the bundled circuit library.

## Code style

- **Do not use em dashes or en dashes.** Use a comma, a colon, or a full stop.
  This applies to code, comments, documentation and commit messages.
- Comments describe intent, not what the code already says. They are wanted
  wherever they carry knowledge the writer had: why a constant has that value,
  which failure a guard prevents, what a sign convention means. Default agent
  habits of stripping comments do not apply here.
- Two spaces before an inline comment: `let gmin = 1e-9;  // pins floating nodes`
- No banner comments or ASCII-art dividers. The one approved divider is a single
  line, in the host language's comment syntax:
  `// ─── Newton iteration ───`
- Keep files under about 1000 lines. A soft limit, not a hard one.
- Match the style of the surrounding file.

## Tmporary Directory

- if something needs temporary files, you must NOT use system wide `/tmp`.
  For temporary files use `tmp/` or `scratch/` inside the project.
- Do not access anything outside the project directory.

## Shell scope

- Every command's scope must be obvious at a glance. Pass the explicit
  working directory (the `workdir` parameter) instead of chaining
  `cd x && … ; cd .. && …`. A `cd ..` mid-command reads like leaving the
  project even when it does not, and has been rejected on sight before.
- This applies to the orchestrator and to every subagent alike: subagents
  must be told their worktree path up front and keep every call inside it.
- The shell resets to the repo root between calls; nothing needs a trailing
  `cd` back. Within one call, prefer two calls with explicit directories
  over one chained line.
