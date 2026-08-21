/**
 * The pointer-down gesture decision, extracted from the canvas hook so the
 * interaction rules stay headlessly testable (AGENTS.md: nothing testable
 * belongs inside a React component). The hook wires the store snapshot, the
 * hit element and the drag refs; this module decides what a press does: toggle
 * a running interactive part, select, place, pan, sweep or arm a drag.
 */

import {
  axisConstrained,
  defFor,
  dominantAxisSnap,
  postCountOf,
  postsOf,
  toolDef,
} from '../../model/registry';
import { rectContains } from '../../model/registry/shared';
import { GRID_SIZE } from '../../model/types';
import type { CircuitElement, Point } from '../../model/types';
import { wireSegments, type WireAxis } from '../../model/wirePlacement';

/** An element whose two ends sit on the same point is degenerate: it has no
 *  body to draw or simulate, and upstream never lets one serialize. Only
 *  point decorations (postCount 0, e.g. text or a drawn box) are exempt,
 *  because they are drawn at a single coordinate by design. Every element
 *  with at least one terminal, including single-post parts like a ground or
 *  logic input, must not collapse to a point. */
export function collapsedToPoint(e: CircuitElement): boolean {
  return postCountOf(e) >= 1 && e.x1 === e.x2 && e.y1 === e.y2;
}
import { turnPointAbout } from '../../model/transform';
import { grabbedHandle, nearestPost } from '../../render/geometry';
import { makeGhostElement, nextSwitchState, snap, useStore } from '../../state/store';
import type { AppState } from '../../state/types';

/** The armed gesture a pointer-down leaves behind. `gated` marks the touch
 *  path: a single finger must hold past DRAG_DELAY_MS (dragArmed) before these
 *  modes may move. Mouse and pen leave it unset and move immediately, so the
 *  desktop path is unchanged. */
export type Drag =
  | { mode: 'none' }
  | { mode: 'place'; start: Point; id: number }
  /** A wire drag. Nothing is in the store until the pointer lifts: a run is 0,
   *  1 or 2 wires depending on where the cursor ends up, so building it
   *  incrementally would mean adding and removing elements under the hand.
   *  `axis` latches the direction the drag first moved, which is what decides
   *  which way the L bends (model/wirePlacement.ts). */
  | { mode: 'wire'; start: Point; current: Point; axis: WireAxis | null }
  | { mode: 'move'; last: Point; moved: boolean; gated?: boolean }
  | {
      mode: 'dragpost';
      id: number;
      post: 1 | 2;
      moved: boolean;
      gated?: boolean;
      /** The fixed endpoint, the one not being dragged. The drag-derived
       *  params (a wattmeter's width) are computed against it. */
      start: Point;
    }
  | { mode: 'select'; start: Point; current: Point; shift: boolean }
  | {
      mode: 'rowcol';
      axis: 'row' | 'col';
      captured: { id: number; post: 0 | 1 }[];
      last: Point;
    }
  | { mode: 'pan'; startClient: Point; startView: Point };

/** The refs the gesture decision writes through, held by the hook. */
export interface PointerDownRefs {
  dragRef: { current: Drag };
  heldMomentaryRef: { current: number | null };
  heldMomentaryPointerRef: { current: number | null };
}

/** The pointer-down fields the decision reads: a structural subset of a
 *  `React.PointerEvent`, so the hook passes the real event straight through. */
export interface PointerDownInput {
  button: number;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  clientX: number;
  clientY: number;
  pointerId: number;
}

/** A momentary push switch returns to rest when the pointer that pressed it
 *  lifts, cancels or double-taps away; the mirror of the press's toggle
 *  (SwitchElm.mouseUp, SwitchElm.java:180-182). A different finger's lift
 *  must never release it. */
export function releaseHeldMomentary(pointerId: number, refs: PointerDownRefs): void {
  const { heldMomentaryRef, heldMomentaryPointerRef } = refs;
  if (heldMomentaryRef.current == null || heldMomentaryPointerRef.current !== pointerId) return;
  const id = heldMomentaryRef.current;
  heldMomentaryRef.current = null;
  heldMomentaryPointerRef.current = null;
  const e = useStore.getState().elements.find((q) => q.id === id);
  if (e) useStore.getState().setElementState(id, ((e.state ?? 0) + 1) % 2);
}

/**
 * Where a placement drag's free end lands, given the grid-snapped cursor.
 *
 * The three steps are one function because their order is the whole point.
 * The quarter turns Space banked during the drag are applied first, about the
 * press anchor, so both the drag-derived params and the dominant-axis snap see
 * the turned point: applying the turn last would take a turned wattmeter's
 * width from the unturned cursor and could leave a multi-post part diagonal.
 * The anchor `(x1,y1)` never moves, so only the free end is returned.
 */
export function placementPoint(
  start: Point,
  snapped: Point,
  turns: number,
  placed: CircuitElement,
): { x2: number; y2: number; extra?: Record<string, number> } {
  const turned = turns === 0 ? snapped : turnPointAbout(snapped, start, turns);
  const def = defFor(placed.kind);
  // A drag-derived parameter (the wattmeter's width) is the weaker drag
  // component; the axis snap below discards it, so capture it from the turned
  // pointer first (WattmeterElm.java:75-89).
  const extra = def?.dragParams?.(start, turned);
  let { x: x2, y: y2 } = turned;
  if (axisConstrained(placed)) {
    // A multi-post part snaps to the dominant axis, so a transistor, op-amp or
    // SPDT cannot end up diagonal (CircuitElm.java:560-566).
    const axis = dominantAxisSnap(start, x2, y2);
    x2 = axis.x;
    y2 = axis.y;
  }
  return extra === undefined ? { x2, y2 } : { x2, y2, extra };
}

/** The pointer-up cleanup a placement owes: drop a zero-length element,
 *  split a wire whose end landed on another wire, and return to select mode.
 *  Shared by the normal up path and the abort paths (double-tap, a second
 *  finger landing mid-placement), so a placement can never leak a stray
 *  element that would serialize into the saved netlist. Extracted here,
 *  alongside beginPointerGesture, so the cancel path stays headlessly
 *  testable. */
export function finishPlacement(drag: Drag, state: AppState): void {
  if (drag.mode !== 'place') return;
  const e = state.elements.find((x) => x.id === drag.id);
  const def = e ? defFor(e.kind) : undefined;
  if (e && def && collapsedToPoint(e)) {
    state.select([e.id]);
    // skipCommit: the addElement commit at pointer-down is the single undo
    // baseline for this whole gesture. Without it, deleteSelected's own
    // commit would push a second entry holding the stray element, and the
    // first Ctrl+Z would resurrect it instead of undoing the placement, the
    // same one-gesture-one-undo-entry reasoning behind beginPointerGesture's
    // switch-toggle commit below.
    state.deleteSelected(true);
  } else if (e) {
    if (e.kind === 'wire') {
      // A wire end dropped on another wire's interior splits that wire so the
      // two connect, matching upstream's splitWireAt on placement
      // (MouseManager.java:597-613). The addElement commit at pointer-down is
      // the single undo baseline for the whole drop.
      state.placeWireEnd(e.id, e.x2, e.y2);
    }
    // Upstream splits at both endpoints of the element it is about to add,
    // parts as well as wires (endDrag, MouseManager.java:1276-1280), so a
    // resistor dropped with an end on a wire or on another part's lead comes
    // out connected. Only a real terminal splits, the same rule the post drag
    // follows: a ground's or rail's second control point carries no terminal,
    // and a drop there must connect nothing. The wire case above has already
    // split what it crossed, so the second call finds an endpoint there and
    // does nothing.
    const posts = postsOf(e);
    for (const q of [{ x: e.x1, y: e.y1 }, { x: e.x2, y: e.y2 }]) {
      if (posts.some((r) => r.x === q.x && r.y === q.y)) state.autoSplitAt(q, e.id);
    }
  }
  // Placing one element then returning to select mode matches how people
  // actually build a schematic.
  state.setTool(null);
}

/** The pointer-up cleanup a wire drag owes: insert the run the drag traced
 *  and return to select mode. Nothing was in the store during the drag, so a
 *  drag that never left its anchor inserts nothing and leaves no undo entry,
 *  and an abort (a cancelled pointer, a second finger) simply never calls
 *  this. Sits beside finishPlacement so both cleanups stay testable without a
 *  canvas. */
export function finishWireDrag(drag: Drag, state: AppState): void {
  if (drag.mode !== 'wire') return;
  // No latched axis means the pointer never left the anchor cell: a click with
  // the wire tool armed draws nothing rather than dropping a default-length
  // wire, because a wire's length is the whole of what the user is choosing.
  const ids =
    drag.axis === null ? [] : state.addWires(wireSegments(drag.start, drag.current, drag.axis));
  if (ids.length > 0) state.select(ids);
  // Placing one run then returning to select mode, like every other placement.
  state.setTool(null);
}

/** The pointer-up cleanup a single post drag owes. Two outcomes, in upstream's
 *  order: a drag that collapsed the element to a point is undone whole, and
 *  otherwise the dropped post splits any wire it landed on so the two connect
 *  (endDrag, MouseManager.java:1244-1258). Only a post drag splits; moving
 *  whole elements, one or a selection, connects nothing, which is why this
 *  lives here and not in the move path. Extracted alongside finishPlacement so
 *  the rule stays testable without a canvas. */
export function finishPostDrag(drag: Drag, state: AppState): void {
  if (drag.mode !== 'dragpost') return;
  if (!drag.moved) return;
  const e = state.elements.find((x) => x.id === drag.id);
  if (!e) return;
  const def = defFor(e.kind);
  // A post dragged onto its partner leaves a zero-length element, which is
  // almost never meant. Do not delete mid-drag: the user may be passing
  // through on the way somewhere. On release, undo the whole drag and say why.
  if (def && collapsedToPoint(e)) {
    state.undo();
    state.setStatus('Reverted: that drag would have collapsed the element to a point.');
    return;
  }
  const pos = drag.post === 1 ? { x: e.x1, y: e.y1 } : { x: e.x2, y: e.y2 };
  // Only a real post connects. A ground or rail hangs its symbol off a second
  // control point that is draggable but carries no terminal, and dropping that
  // on a wire must not split it (upstream splits at getPost(draggingPost),
  // which such an end is not).
  if (!postsOf(e).some((q) => q.x === pos.x && q.y === pos.y)) return;
  // The split lands on the commit pointer-down took, so the move and the split
  // undo together as one drag.
  state.autoSplitAt(pos, e.id);
}

/**
 * The endpoint handle a plain press at `p` grabs on `hit`, or null when the
 * press takes the whole element instead. Upstream arms its post drag the same
 * way, straight from a select-mode press that landed close to a handle
 * (MouseManager.java:1146-1149); Ctrl is this port's extra override, not a
 * requirement. Exported so the frame loop can light up the very handle the
 * next press would grab, and the drawn affordance cannot promise a grab that
 * will not happen.
 */
export function armedHandle(p: Point, hit: CircuitElement, state: AppState): 1 | 2 | null {
  // With editing off or a tool armed the press is not an edit drag at all, so
  // no handle is live.
  if (!state.settings.editable || state.tool) return null;
  // A press inside a multi-element selection drags the whole group, even when
  // it lands on one member's endpoint: upstream gates its auto-grab on
  // anySelectedButMouse for the same reason (MouseManager.java:1147,1376).
  // Read from the caller's pre-press snapshot, which is what the press acts
  // on; only Ctrl grows the selection, and Ctrl takes the override path.
  if (state.selectedIds.length > 1 && state.selectedIds.includes(hit.id)) return null;
  return grabbedHandle(p, hit, state.view.scale);
}

/** A row or column sweep captures every stored endpoint on the line at
 *  pointer-down so a sweep cannot pick up elements it passes over, and only
 *  the stored endpoints count, never derived posts (MouseManager.java:1159-1187).
 *  One undo entry for the whole sweep. */
export function startRowCol(
  axis: 'row' | 'col',
  p: Point,
  state: AppState,
  dragRef: { current: Drag },
): void {
  const grid = GRID_SIZE;
  const x = snap(p.x, grid);
  const y = snap(p.y, grid);
  const captured: { id: number; post: 0 | 1 }[] = [];
  for (const e of state.elements) {
    if (axis === 'row') {
      if (e.y1 === y) captured.push({ id: e.id, post: 0 });
      if (e.y2 === y) captured.push({ id: e.id, post: 1 });
    } else {
      if (e.x1 === x) captured.push({ id: e.id, post: 0 });
      if (e.x2 === x) captured.push({ id: e.id, post: 1 });
    }
  }
  state.commit();
  dragRef.current = { mode: 'rowcol', axis, captured, last: { x, y } };
}

/** The pointer-down body shared by mouse, pen and touch: hit-test, toggle a
 *  running interactive part, select, arm the mode. `gated` marks the
 *  move/dragpost modes for touch, which must wait for dragArmed before they
 *  may move; place and empty-canvas select stay immediate because they are
 *  explicit drags, not taps. */
export function beginPointerGesture(
  ev: PointerDownInput,
  p: Point,
  state: AppState,
  hit: CircuitElement | null,
  gated: boolean,
  refs: PointerDownRefs,
): void {
  const { dragRef, heldMomentaryRef, heldMomentaryPointerRef } = refs;

  // Right-click belongs to the context menu, which fires its contextmenu
  // event after this pointerdown. Entering a drag or a pan here would commit
  // an undo step and leave a stale drag state behind the menu.
  if (ev.button === 2) return;

  // Alt+Shift sweeps every stored endpoint on the row, Alt+Meta the column;
  // checked before pan so the modifiers win (MouseManager.java:1087-1090).
  if (ev.button === 0 && ev.altKey && ev.shiftKey) {
    startRowCol('row', p, state, dragRef);
    return;
  }
  if (ev.button === 0 && ev.altKey && ev.metaKey) {
    startRowCol('col', p, state, dragRef);
    return;
  }

  // Middle button, or Alt held, pans (MouseManager.java:1093-1094). Shift no
  // longer pans: it is the box-add and net-highlight modifier. Touch never
  // carries these buttons, so on touch the two-finger pinch is the pan.
  if (ev.button === 1 || ev.altKey) {
    dragRef.current = {
      mode: 'pan',
      startClient: { x: ev.clientX, y: ev.clientY },
      startView: { x: state.view.x, y: state.view.y },
    };
    return;
  }

  // A switch is a run-mode control, not an edit: it must still throw when
  // editing is disabled, exactly as upstream's doSwitch runs before its
  // read-only forcing (MouseManager.java:1101). No running gate: a paused
  // circuit is still configured by throwing its switches, the keyboard path
  // (toggleSwitchByKey) already works paused and this must match it.
  if (hit) {
    const def = defFor(hit.kind);
    // A switch toggles only when the pointer lands on its lever: the
    // switchRect union of the body and the open handle, so clicking a lead or
    // a post selects and drags instead (MouseManager.java:314-318). Ctrl
    // bypasses the toggle outright and reaches the dragpost branch below: the
    // port's ctrl endpoint-grab gesture must work even on a running switch.
    // Alt pans and is kept as a documented hatch; it costs nothing. A def
    // without a rect keeps the whole element clickable so nothing regresses
    // silently.
    if (def?.interactive && !ev.altKey && !ev.ctrlKey) {
      const rect = def.switchRect?.(hit);
      if (rect === undefined || rectContains(rect, p)) {
        const momentary = hit.kind === 'switch' && (hit.params.momentary ?? 0) !== 0;
        // The next state respects the part's range: binary for a plain switch
        // and two-level logic input, `throwCount` throws for an SPDT, and the
        // three positions of a ternary logic input (nextSwitchState).
        const next = nextSwitchState(hit);
        // One click is one undo entry. Upstream does not push here (doSwitch
        // returns before the mouse-down pushUndo), this is a deliberate
        // divergence; the dedup in commit keeps repeat clicks from stacking.
        state.commit();
        if (momentary) {
          // A push switch is closed only while held: the press toggles it and
          // the pointer-up path toggles back (doSwitch + heldSwitchElm.mouseUp,
          // MouseManager.java:314-326, SwitchElm.java:180-182).
          heldMomentaryRef.current = hit.id;
          heldMomentaryPointerRef.current = ev.pointerId;
        }
        // A make-before-break switch fans its throw out to every switch in the
        // same Switch Group through the link-aware toggle; every other switch
        // is a plain single-element throw (MBBSwitchElm.java:182-195).
        if (hit.kind === 'mbbSwitch') {
          state.toggleSwitch(hit.id);
        } else {
          state.setElementState(hit.id, next);
        }
        dragRef.current = { mode: 'none' };
        return;
      }
    }
  }

  // With editing disabled, only pan (above), wheel zoom and the interactive
  // parts above stay live: no select, place, move, post-drag or rubber-band
  // (UIManager.java:1101).
  if (!state.settings.editable) {
    state.setStatus('Editing disabled. Re-enable from the Options menu.');
    return;
  }

  if (state.tool) {
    const grid = GRID_SIZE;
    const x = snap(p.x, grid);
    const y = snap(p.y, grid);
    if (toolDef(state.tool)?.kind === 'wire') {
      // A wire run is built on release, not on press: how many wires it is
      // (none, one, or the two of an L) is not known until the drag ends, and
      // there is nothing useful to select or turn in the meantime.
      dragRef.current = { mode: 'wire', start: { x, y }, current: { x, y }, axis: null };
      return;
    }
    // The same builder the ghost draws from, so the part cannot shift under
    // the cursor when the click lands, and every kind now gets a length: the
    // ~150 defs that declare none used to place as a point and be deleted
    // again by finishPlacement, which is what made a click look like nothing
    // happened.
    const id = state.addElement(makeGhostElement(state.tool, x, y, state.toolTurns));
    dragRef.current = { mode: 'place', start: { x, y }, id };
    // The addElement commit above is this gesture's whole undo baseline, so
    // raise the flag before anything else can commit: a Space rotate mid-drag
    // must fold into it, and it must turn about this press anchor.
    state.beginElementGesture('place');
    state.select([id]);
    return;
  }

  if (hit) {
    const def = defFor(hit.kind);
    if (!state.selectedIds.includes(hit.id)) {
      // Shift on an element does not join it to the selection: upstream has no
      // shift+click multi-select, it only makes the rubber band additive
      // (selectArea's `add`, MouseManager.java:381,645). Ctrl still adds, and
      // keeps its dragpost branch below.
      state.select(ev.ctrlKey ? [...state.selectedIds, hit.id] : [hit.id]);
    }
    state.commit();
    // A press that lands on an endpoint handle drags that endpoint; a press on
    // the body moves the element whole. Ctrl is the explicit override, and
    // grabs the nearer endpoint from anywhere on the element: it still reaches
    // a symbol too short to arm a handle and a running switch's lever, which
    // the interactive branch above hands over only for Ctrl. Ctrl+click
    // without a move stays the additive selection made above. The gate counts
    // draggable endpoints, not posts: a ground has one connectable post but
    // its symbol hangs off a second control point that must be stretchable
    // too.
    const post =
      ev.ctrlKey && (def?.draggablePosts ?? postCountOf(hit)) > 1
        ? nearestPost(p, hit)
        : armedHandle(p, hit, state);
    if (post !== null) {
      dragRef.current = {
        mode: 'dragpost',
        id: hit.id,
        post,
        moved: false,
        gated,
        // The fixed endpoint, the one not being dragged: drag-derived params
        // (a wattmeter's width) are computed against it.
        start: post === 1 ? { x: hit.x2, y: hit.y2 } : { x: hit.x1, y: hit.y1 },
      };
    } else {
      dragRef.current = { mode: 'move', last: p, moved: false, gated };
      // Same one-gesture-one-undo-entry reasoning as the placement above: the
      // state.commit() before this branch is the move's baseline, and a Space
      // rotate mid-move rides along with it. An endpoint drag raises nothing:
      // the next pointer-move drags that post straight back to the cursor, so
      // a turn there would have no meaning.
      state.beginElementGesture('move');
    }
    return;
  }

  // The rubber band is the only multi-select gesture, as upstream: a shift-drag
  // box adds to the selection, so the old one survives the pointer-down, and a
  // plain box replaces it and clears up front (selectArea's `add`,
  // MouseManager.java:381,645).
  if (!ev.shiftKey) state.select([]);
  dragRef.current = { mode: 'select', start: p, current: p, shift: ev.shiftKey };
}
