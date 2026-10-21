/** The undo history, as pure data plus pure transitions. Nothing here imports
 *  the store or zustand: the store holds a `History` value and calls these
 *  functions, so the boundary rules (dedup, transaction nesting, the cap,
 *  the snapshot cache) are testable without a DOM and live in exactly one
 *  place. A transaction is how one gesture or one command lands as one entry:
 *  `begin` records the pre-state, the mutations run, `end` closes. */

import type { Snapshot } from './types';

/** Who asked for the step. `user` is the default for a menu click or a
 *  gesture; `agent` and `system` are reserved so a later MCP tool call can be
 *  told apart from a human edit, and so recovery can mark itself. */
export type HistorySource = 'user' | 'agent' | 'system';

/** One undo step: the pre-mutation snapshot, plus what it was for. The label
 *  is Edit-menu wording (`Add Resistor`, `Move`, `Delete`), so the UI and a
 *  later MCP history query name the same step. */
export interface HistoryEntry {
  snap: Snapshot;
  label: string;
  source: HistorySource;
}

/** The two stacks and the open transaction. The transaction is depth-counted:
 *  a nested `begin` joins the outer one, so a command that calls another
 *  command still lands as one step, and the entry keeps the label of the
 *  outermost `begin` that created it. */
export interface History {
  undo: HistoryEntry[];
  redo: HistoryEntry[];
  open: { label: string; source: HistorySource; depth: number; pushed: boolean } | null;
}

/** Undo entries beyond this cap fall off the front of the stack, silently and
 *  without touching the redo side. The push sites that can meet a full stack
 *  (checkpoint, pushExternal) slice; the redo push writes back onto a stack
 *  that just shrank by its pop, so the cap holds on its own there. */
export const UNDO_LIMIT = 100;

export const emptyHistory = (): History => ({ undo: [], redo: [], open: null });

/** A deep copy of everything undo restores. Kept beside the fingerprint
 *  because the two must agree on which fields the history owns: a new nested
 *  snapshot field without a clone line would let a snapshot alias the live
 *  state, and a new top-level field without a fingerprint line would let a
 *  change dedup away. */
export const clone = (s: Snapshot): Snapshot => ({
  elements: s.elements.map((e) => {
    const copy = { ...e, params: { ...e.params } };
    // A route is a nested array; without this a future in-place route mutator
    // would silently corrupt the undo snapshot.
    if (e.route) copy.route = e.route.map((r) => [...r]);
    // The embedded-scope interpretation nests a plot list and per-plot display
    // fields; clone them so a snapshot never aliases the live element, the
    // same rule the route and model payloads follow.
    if (e.embedded) {
      copy.embedded = {
        ...e.embedded,
        tokens: [...e.embedded.tokens],
        plots: e.embedded.plots.map((p) => ({ ...p })),
        display: {
          ...e.embedded.display,
          perPlot: e.embedded.display.perPlot.map((d) => ({ ...d })),
        },
      };
    }
    // A resolved device model is a nested object, and the custom-logic rules
    // vectors inside it are arrays; clone them so a snapshot can never alias
    // the live element. The OTA's model is the same carrier holding a string
    // array (the composite child-dump tokens), which clones as a plain copy.
    // The composite's own engine spec is the third payload shape: its external
    // and dump vectors are arrays too, and the `external` key is what tells the
    // two object payloads apart (a custom-logic model never carries one). The
    // battery's table is a plain string, immutable, so it passes through, while
    // the string-array child dumps still clone so a snapshot never aliases them.
    if (e.model !== undefined) {
      copy.model =
        typeof e.model === 'string'
          ? e.model
          : Array.isArray(e.model)
            ? [...e.model]
            : 'external' in e.model
              ? { ...e.model, external: [...e.model.external], dumps: [...e.model.dumps] }
              : {
                  ...e.model,
                  inputs: [...e.model.inputs],
                  outputs: [...e.model.outputs],
                  rulesLeft: [...e.model.rulesLeft],
                  rulesRight: [...e.model.rulesRight],
                };
    }
    return copy;
  }),
  // Plots and triggers are nested objects, so a shallow spread would alias the
  // live state into the undo snapshot. raw is an array of line tokens with the
  // same aliasing risk, so it is cloned like the sliders' raw.
  scopes: s.scopes.map((x) => ({
    ...x,
    raw: x.raw ? [...x.raw] : null,
    trigger: { ...x.trigger },
    // The measurement mask is a nested object like the trigger: clone it so a
    // snapshot can never alias the live plot's override.
    plots: x.plots.map((p) => ({
      ...p,
      measurements: p.measurements ? { ...p.measurements } : null,
    })),
  })),
  sliders: s.sliders.map((x) => ({ ...x, raw: [...x.raw] })),
  settings: { ...s.settings },
  view: { ...s.view },
  // The document's lines. A shallow copy is enough because the entries are
  // strings and small immutable records that the one mutator (the subcircuit
  // rename) replaces rather than edits in place.
  passthrough: [...s.passthrough],
  order: [...s.order],
  // Unreadable o lines carry the same nested shape as a resolved scope's raw
  // tokens and plot list, so they need the same deep copy or a future
  // in-place edit would alias the live state into the undo snapshot.
  unmatchedScopes: s.unmatchedScopes.map((x) => ({
    ...x,
    raw: [...x.raw],
    plots: x.plots.map((p) => ({ ...p })),
  })),
});

/** Canonical fingerprint of the snapshot state, mirroring upstream's dump
 *  comparison (UndoManager.java:50-53). The top-level object is built in a
 *  fixed property order so equal content always stringifies equally; the inner
 *  objects carry the insertion order they were constructed with, which is
 *  stable because every mutator spreads rather than reordering. */
export const snapshotKey = (s: Snapshot): string =>
  JSON.stringify({
    elements: s.elements,
    scopes: s.scopes,
    sliders: s.sliders,
    settings: s.settings,
    view: s.view,
    // The document's lines belong in the fingerprint too: a subcircuit rename
    // changes nothing else, so without them a second rename would dedup
    // against the first commit, the entry would never be pushed and undo would
    // skip a step.
    passthrough: s.passthrough,
    order: s.order,
    // Without this an unmatched-scope-only edit (recovering a file whose
    // unreadable o lines differ from the previous one) would dedup against
    // the top of the stack and undo would skip the step.
    unmatchedScopes: s.unmatchedScopes,
  });

/** Push-time fingerprint cache, keyed by snapshot identity. A fingerprint is
 *  a full-document stringify, megabytes on SRAM/ROM sheets, and checkpoint
 *  compares the live state against the stack top on every call; caching each
 *  pushed snapshot's key beside it makes that comparison a WeakMap lookup,
 *  so a checkpoint stringifies only the live state once. Snapshots are never
 *  mutated after they are pushed, so a cached key cannot go stale; snapshots
 *  pushed without a key already computed (undo/redo pushes, pushExternal)
 *  simply compute and cache theirs on the first comparison. Evicted entries
 *  drop out of the map with their snapshots. */
const snapshotKeyCache = new WeakMap<Snapshot, string>();

export function cachedSnapshotKey(s: Snapshot): string {
  const hit = snapshotKeyCache.get(s);
  if (hit !== undefined) return hit;
  const key = snapshotKey(s);
  snapshotKeyCache.set(s, key);
  return key;
}

/** Today's commit semantics: push `live` as an entry unless its fingerprint
 *  matches the top of the undo stack, and clear the redo future either way
 *  (upstream's pushUndo clears before its dedup check). Inside an open
 *  transaction this is a no-op, which is what retires the old `scopeGesture`
 *  and `skipCommit` guards: a setter can call this unconditionally and the
 *  transaction owns the boundary. */
export function checkpoint(
  h: History,
  live: Snapshot,
  label: string,
  source: HistorySource = 'user',
): History {
  if (h.open !== null) return h;
  const key = cachedSnapshotKey(live);
  const top = h.undo[h.undo.length - 1];
  if (top && key === cachedSnapshotKey(top.snap)) return { ...h, redo: [] };
  // The pushed clone holds the same content the key was computed from, so the
  // fingerprint travels with it and the next comparison never pays a second
  // stringify for the same bytes.
  const snap = clone(live);
  snapshotKeyCache.set(snap, key);
  return {
    undo: [...h.undo, { snap, label, source }].slice(-UNDO_LIMIT),
    redo: [],
    open: null,
  };
}

/** Opens a transaction, recording the pre-state as the step's baseline. A
 *  nested begin only raises the depth: the outer transaction already pushed
 *  the baseline and owns the label. */
export function begin(
  h: History,
  live: Snapshot,
  label: string,
  source: HistorySource = 'user',
): History {
  if (h.open !== null) {
    return { ...h, open: { ...h.open, depth: h.open.depth + 1 } };
  }
  const next = checkpoint(h, live, label, source);
  return {
    ...next,
    // Whether the checkpoint actually pushed decides pruning at `end`; a
    // deduped baseline was already the stack top and must never be popped.
    open: { label, source, depth: 1, pushed: next.undo !== h.undo },
  };
}

/** Closes the innermost transaction. At depth zero the transaction closes,
 *  and a baseline the transaction never moved off is popped again: a click
 *  that only selected, or a drag that returned to where it started, must not
 *  leave an undo entry that does nothing. */
export function end(h: History, live: Snapshot): History {
  const open = h.open;
  if (open === null) return h;
  if (open.depth > 1) return { ...h, open: { ...open, depth: open.depth - 1 } };
  if (open.pushed) {
    const top = h.undo[h.undo.length - 1];
    if (top && cachedSnapshotKey(top.snap) === cachedSnapshotKey(live)) {
      return { undo: h.undo.slice(0, -1), redo: h.redo, open: null };
    }
  }
  return { ...h, open: null };
}

/** Closes any open transaction without touching either stack. Every revert
 *  (undo, redo, load, New, drill-in, revertToBaseline) aborts first, so a
 *  transaction can never outlive the baseline it was opened against. */
export function abort(h: History): History {
  if (h.open === null) return h;
  return { ...h, open: null };
}

/** The pop half of undo. The entry's label travels onto the redo side with
 *  the state being left behind, so a redo shows the same name the undo did.
 *  Returns null on an empty stack; the caller then leaves everything alone. */
export function stepBack(
  h: History,
  live: Snapshot,
): { history: History; restore: Snapshot } | null {
  const top = h.undo[h.undo.length - 1];
  if (top === undefined) return null;
  return {
    history: {
      undo: h.undo.slice(0, -1),
      redo: [...h.redo, { snap: clone(live), label: top.label, source: top.source }],
      open: null,
    },
    restore: top.snap,
  };
}

/** The push half of redo, symmetric with `stepBack`: the redone step's label
 *  rides onto the undo side. Returns null on an empty future. */
export function stepForward(
  h: History,
  live: Snapshot,
): { history: History; restore: Snapshot } | null {
  const top = h.redo[h.redo.length - 1];
  if (top === undefined) return null;
  return {
    history: {
      redo: h.redo.slice(0, -1),
      undo: [...h.undo, { snap: clone(live), label: top.label, source: top.source }],
      open: null,
    },
    restore: top.snap,
  };
}

/** The one sanctioned "push after the fact": recovery and the edited drill-in
 *  exit have a pre-state captured before a load wiped the stacks, and must
 *  land it as the next undo entry. The cap lives here so no hand-written push
 *  can forget it. */
export function pushExternal(
  h: History,
  pre: Snapshot,
  label: string,
  source: HistorySource = 'user',
): History {
  return {
    undo: [...h.undo, { snap: pre, label, source }].slice(-UNDO_LIMIT),
    redo: [],
    open: null,
  };
}

/** Kills the redo future without touching the undo past: every entry-free
 *  run-mode mutation (a keyboard throw, a momentary release, a settings
 *  write) must end with its future dead the way a checkpoint leaves it, or a
 *  later redo silently rewinds the mutation. */
export function clearFuture(h: History): History {
  return h.redo.length === 0 ? h : { ...h, redo: [] };
}

export const canUndo = (h: History): boolean => h.undo.length > 0;
export const canRedo = (h: History): boolean => h.redo.length > 0;
export const undoLabel = (h: History): string | null => h.undo[h.undo.length - 1]?.label ?? null;
export const redoLabel = (h: History): string | null => h.redo[h.redo.length - 1]?.label ?? null;
