/**
 * The pointer-down gesture decision, extracted from the canvas hook so the
 * interaction rules stay headlessly testable (AGENTS.md: nothing testable
 * belongs inside a React component). The hook wires the store snapshot, the
 * hit element and the drag refs; this module decides what a press does: toggle
 * a running interactive part, select, place, pan, sweep or arm a drag.
 */

import { defFor, postCountOf, toolDef } from '../../model/registry';
import { rectContains } from '../../model/registry/shared';
import { GRID_SIZE } from '../../model/types';
import type { CircuitElement, Point } from '../../model/types';
import { nearestPost } from '../../render/geometry';
import { makeToolElement, nextSwitchState, snap, useStore } from '../../state/store';
import type { AppState } from '../../state/types';

/** The armed gesture a pointer-down leaves behind. `gated` marks the touch
 *  path: a single finger must hold past DRAG_DELAY_MS (dragArmed) before these
 *  modes may move. Mouse and pen leave it unset and move immediately, so the
 *  desktop path is unchanged. */
export type Drag =
  | { mode: 'none' }
  | { mode: 'place'; start: Point; id: number }
  | { mode: 'move'; last: Point; moved: boolean; gated?: boolean }
  | { mode: 'dragpost'; id: number; post: 1 | 2; moved: boolean; gated?: boolean }
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
        state.setElementState(hit.id, next);
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
    const def = toolDef(state.tool);
    const len = (def?.defaultLength ?? 0) * grid;
    // Grounds and voltage sources drop vertically, the rest horizontally,
    // matching upstream's getDragVertical override.
    const x2 = def?.vertical ? x : x + len;
    const y2 = def?.vertical ? y + len : y;
    const id = state.addElement(makeToolElement(state.tool, x, y, x2, y2));
    dragRef.current = { mode: 'place', start: { x, y }, id };
    state.select([id]);
    return;
  }

  if (hit) {
    const def = defFor(hit.kind);
    if (!state.selectedIds.includes(hit.id)) {
      // Shift adds like ctrl, then starts a plain move of the whole group;
      // ctrl alone keeps its dragpost branch below.
      state.select(ev.ctrlKey || ev.shiftKey ? [...state.selectedIds, hit.id] : [hit.id]);
    }
    state.commit();
    // Ctrl does two things depending on whether the pointer moves: without
    // a move it is a plain additive selection, done above; with one it
    // grabs the nearer endpoint and drags only that post, stretching or
    // rotating the element. The additive selection from pointer-down stays
    // either way. The gate counts draggable endpoints, not posts: a ground
    // has one connectable post but its symbol hangs off a second control
    // point that must be stretchable too.
    if (ev.ctrlKey && (def?.draggablePosts ?? postCountOf(hit)) > 1) {
      dragRef.current = { mode: 'dragpost', id: hit.id, post: nearestPost(p, hit), moved: false, gated };
    } else {
      dragRef.current = { mode: 'move', last: p, moved: false, gated };
    }
    return;
  }

  // A shift-drag box adds to the selection, so the old one survives the
  // pointer-down; a plain box replaces it and clears up front.
  if (!ev.shiftKey) state.select([]);
  dragRef.current = { mode: 'select', start: p, current: p, shift: ev.shiftKey };
}
