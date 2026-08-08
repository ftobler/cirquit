import { useCallback, useEffect, useRef, useState } from 'react';
import type { SimEngine } from '../../engine/simulator';
import { defFor, toolDef } from '../../model/registry';
import {
  isZoomOnly,
  openScrollValue,
  scrollableParam,
  selectionValue,
  stepScrollValue,
  wheelPixels,
} from '../../model/scrollValue';
import type { ScrollValueSession } from '../../model/scrollValue';
import type { CircuitElement, Point } from '../../model/types';
import { distanceToElement, nearestPost, postAt, postPatch } from '../../render/geometry';
import { boxFromPoints, selectByBox } from '../../render/selection';
import { gridSize, makeToolElement, nextSwitchState, snap, useStore } from '../../state/store';
import { ZOOM_FACTOR, zoomAbout } from '../../state/view';
import { DRAG_DELAY_MS, LONG_PRESS_MS, TouchGesture, type GestureAction } from '../gestures';
import { useStoreRef } from './useStoreRef';

/** How close the pointer must be to an element to hit it, in circuit units. */
const HIT_TOLERANCE = 8;

export type Drag =
  | { mode: 'none' }
  | { mode: 'place'; start: Point; id: number }
  // `gated` marks the touch path: a single finger must hold past DRAG_DELAY_MS
  // (dragArmed) before these modes may move. Mouse and pen leave it unset and
  // move immediately, so the desktop path is unchanged.
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

/** The open mouse-wheel value popover, positioned at the cursor. */
export interface ScrollValuePopover {
  session: ScrollValueSession;
  x: number;
  y: number;
}

export function useCanvasInteractions(
  canvasRef: React.RefObject<HTMLCanvasElement | null>,
  dragRef: React.MutableRefObject<Drag>,
  pointerRef: React.MutableRefObject<Point | null>,
  forceRender: React.Dispatch<React.SetStateAction<number>>,
  engine: SimEngine | null,
) {
  const stateRef = useStoreRef();

  // The value popover session. A ref mirrors the state so the wheel handler
  // can step an open session without a stale closure, while the state drives
  // the render.
  const popoverRef = useRef<ScrollValuePopover | null>(null);
  const [popover, setPopoverState] = useState<ScrollValuePopover | null>(null);
  // A momentary switch held down: its id, until the pointer comes back up.
  const heldMomentaryRef = useRef<number | null>(null);
  // Which pointer id pressed that switch, so a second finger's lift during a
  // pinch cannot release a momentary the first finger is still holding.
  const heldMomentaryPointerRef = useRef<number | null>(null);
  // When the last zoom happened; the wheel stays zoom-only for a second
  // after, so a sweep from empty canvas onto an element cannot accidentally
  // edit a value (MouseManager.java:1302-1304).
  const zoomAtRef = useRef<number | null>(null);

  // ---- touch gesture state ------------------------------------------------
  // The recognizer is pure and stateful; the component owns the timers and the
  // refs that tell the shared handlers what the recognizer decided.
  const gestureRef = useRef<TouchGesture | null>(null);
  if (gestureRef.current === null) gestureRef.current = new TouchGesture();
  const longPressTimerRef = useRef<number | null>(null);
  const dragDelayTimerRef = useRef<number | null>(null);
  const touchArmedRef = useRef(false);
  const pinchPrevMidRef = useRef<Point | null>(null);
  // The hit element and client point of the primary touch-down: the long-press
  // opens the context menu there.
  const touchTargetRef = useRef<number | null>(null);
  const touchDownClientRef = useRef<Point>({ x: 0, y: 0 });

  // A system gesture (notification shade, incoming call) cancels the pointer
  // mid-gesture; the recognizer's cancel drops the state and the timers must
  // go with it. The cleanup covers an unmount with a gesture in flight.
  useEffect(() => () => {
    if (longPressTimerRef.current !== null) clearTimeout(longPressTimerRef.current);
    if (dragDelayTimerRef.current !== null) clearTimeout(dragDelayTimerRef.current);
  }, []);

  const clearTouchTimers = () => {
    if (longPressTimerRef.current !== null) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
    if (dragDelayTimerRef.current !== null) {
      clearTimeout(dragDelayTimerRef.current);
      dragDelayTimerRef.current = null;
    }
  };

  /** A momentary push switch returns to rest when the pointer that pressed it
   *  lifts, cancels or double-taps away; the mirror of the press's toggle
   *  (SwitchElm.mouseUp, SwitchElm.java:180-182). A different finger's lift
   *  must never release it. */
  const releaseHeldMomentary = (pointerId: number) => {
    if (heldMomentaryRef.current == null || heldMomentaryPointerRef.current !== pointerId) return;
    const id = heldMomentaryRef.current;
    heldMomentaryRef.current = null;
    heldMomentaryPointerRef.current = null;
    const e = useStore.getState().elements.find((q) => q.id === id);
    if (e) useStore.getState().setElementState(id, ((e.state ?? 0) + 1) % 2);
  };

  /** The pointer-up cleanup a placement owes: drop a zero-length element,
   *  split a wire whose end landed on another wire, and return to select mode.
   *  Shared by the normal up path and the abort paths (double-tap, a second
   *  finger landing mid-placement), so a placement can never leak a stray
   *  element that would serialize into the saved netlist. */
  const finishPlacement = (drag: Drag, state: ReturnType<typeof useStore.getState>) => {
    if (drag.mode !== 'place') return;
    const e = state.elements.find((x) => x.id === drag.id);
    const def = e ? defFor(e.kind) : undefined;
    if (e && def && def.postCount > 1 && e.x1 === e.x2 && e.y1 === e.y2) {
      state.select([e.id]);
      state.deleteSelected();
    } else if (e && e.kind === 'wire') {
      // A wire end dropped on another wire's interior splits that wire so
      // the two connect, matching upstream's splitWireAt on placement
      // (MouseManager.java:597-613). The addElement commit at pointer-down
      // is the single undo baseline for the whole drop.
      state.placeWireEnd(e.id, e.x2, e.y2);
    }
    // Placing one element then returning to select mode matches how people
    // actually build a schematic.
    state.setTool(null);
  };

  /** Both timers, validated by the recognizer when they fire: a timer that
   *  fires after the finger lifted or a second finger landed is a no-op. */
  const scheduleTouchTimers = () => {
    const g = gestureRef.current!;
    clearTouchTimers();
    longPressTimerRef.current = window.setTimeout(() => {
      longPressTimerRef.current = null;
      const actions = g.timerFired('longPress');
      for (const a of actions) {
        if (a.type === 'longPress') {
          // The long-press opens the same context menu as a right-click, at
          // the finger (MouseManager.java:139-141). The drag it armed is
          // abandoned: the finger is a menu trigger, not a drag.
          const target = touchTargetRef.current;
          useStore.getState().openContextMenu(touchDownClientRef.current.x, touchDownClientRef.current.y, target);
          touchArmedRef.current = false;
          dragRef.current = { mode: 'none' };
          pinchPrevMidRef.current = null;
        }
      }
    }, LONG_PRESS_MS);
    dragDelayTimerRef.current = window.setTimeout(() => {
      dragDelayTimerRef.current = null;
      const actions = g.timerFired('dragDelay');
      for (const a of actions) {
        if (a.type === 'dragArmed') touchArmedRef.current = true;
      }
    }, DRAG_DELAY_MS);
  };

  /** A two-finger move: pan by the midpoint travel and zoom by the incremental
   *  ratio in one setView, so the pinch content tracks the fingers. The circuit
   *  point under the previous midpoint stays fixed through the zoom, then
   *  follows the midpoint's travel (zoomAbout's clamp is ours, [0.15, 6]). */
  const applyPinch = (a: Extract<GestureAction, { type: 'twoFingerMove' }>) => {
    const state = useStore.getState();
    const prev = pinchPrevMidRef.current;
    // A pinch is a zoom, so the wheel stays zoom-only for a second after, the
    // same guard the wheel zoom sets for itself: a sweep onto an element
    // cannot accidentally edit a value (MouseManager.java:1302-1304).
    zoomAtRef.current = performance.now();
    if (prev) {
      const c = toCircuit(prev.x, prev.y);
      const zoomed = zoomAbout(state.view, c.x, c.y, a.scale);
      state.setView({
        ...zoomed,
        x: zoomed.x - (a.midX - prev.x) / zoomed.scale,
        y: zoomed.y - (a.midY - prev.y) / zoomed.scale,
      });
    } else {
      // First move of a pinch: nothing to pan from, zoom about the midpoint.
      const c = toCircuit(a.midX, a.midY);
      state.setView(zoomAbout(state.view, c.x, c.y, a.scale));
    }
    pinchPrevMidRef.current = { x: a.midX, y: a.midY };
  };
  const setPopover = useCallback(
    (p: ScrollValuePopover | null) => {
      popoverRef.current = p;
      setPopoverState(p);
    },
    [],
  );

  const stepPopover = useCallback(
    (deltaY: number) => {
      const p = popoverRef.current;
      if (!p) return;
      const session = stepScrollValue(p.session, deltaY);
      useStore.getState().setParam(session.id, session.param, selectionValue(session));
      setPopover({ ...p, session });
    },
    [setPopover],
  );

  const closePopover = useCallback(() => setPopover(null), [setPopover]);

  const revertPopover = useCallback(() => {
    const p = popoverRef.current;
    if (!p) return;
    // Restore the opening value. The undo baseline taken on open keeps the
    // whole session one undo step either way (ScrollValuePopup.close(false)).
    useStore.getState().setParam(p.session.id, p.session.param, p.session.original);
    setPopover(null);
  }, [setPopover]);

  const toCircuit = useCallback((clientX: number, clientY: number): Point => {
    const canvas = canvasRef.current;
    const { view } = stateRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    return {
      x: (clientX - rect.left) / view.scale + view.x,
      y: (clientY - rect.top) / view.scale + view.y,
    };
    // Both refs are stable for the life of the component.
  }, [canvasRef, stateRef]);

  /** The pointer in canvas-relative client pixels, the crosshair's stored
   *  position. Kept view-independent so the frame loop can re-project it
   *  through the current view: a keyboard zoom or Center Circuit moves the
   *  circuit point under a stationary cursor, and the guides must follow. */
  const toClient = useCallback((clientX: number, clientY: number): Point => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    return { x: clientX - rect.left, y: clientY - rect.top };
  }, [canvasRef]);

  const hitTest = useCallback((p: Point): CircuitElement | null => {
    const { elements } = stateRef.current;
    let best: CircuitElement | null = null;
    let bestDist = HIT_TOLERANCE;
    // Later elements are drawn on top, so search back to front.
    for (let i = elements.length - 1; i >= 0; i--) {
      const d = distanceToElement(p, elements[i]);
      if (d <= bestDist) {
        bestDist = d;
        best = elements[i];
        break;
      }
    }
    return best;
  }, [stateRef]);

  const startRowCol = (axis: 'row' | 'col', p: Point) => {
    const state = useStore.getState();
    const grid = gridSize(state.settings);
    const x = snap(p.x, grid);
    const y = snap(p.y, grid);
    const captured: { id: number; post: 0 | 1 }[] = [];
    // Capture at pointer-down so a sweep cannot pick up elements it passes
    // over, and only the stored endpoints count, never derived posts
    // (MouseManager.java:1159-1187).
    for (const e of state.elements) {
      if (axis === 'row') {
        if (e.y1 === y) captured.push({ id: e.id, post: 0 });
        if (e.y2 === y) captured.push({ id: e.id, post: 1 });
      } else {
        if (e.x1 === x) captured.push({ id: e.id, post: 0 });
        if (e.x2 === x) captured.push({ id: e.id, post: 1 });
      }
    }
    // One undo entry for the whole sweep.
    state.commit();
    dragRef.current = { mode: 'rowcol', axis, captured, last: { x, y } };
  };

  // ---- pointer handling ---------------------------------------------------
  /** The pointer-down body shared by mouse, pen and touch: hit-test, toggle a
   *  running interactive part, select, arm the mode. `gated` marks the
   *  move/dragpost modes for touch, which must wait for dragArmed before they
   *  may move; place and empty-canvas select stay immediate because they are
   *  explicit drags, not taps. */
  const beginPointerGesture = (
    ev: React.PointerEvent<HTMLCanvasElement>,
    p: Point,
    state: ReturnType<typeof useStore.getState>,
    hit: CircuitElement | null,
    gated: boolean,
  ) => {
    // Right-click belongs to the context menu, which fires its contextmenu
    // event after this pointerdown. Entering a drag or a pan here would commit
    // an undo step and leave a stale drag state behind the menu.
    if (ev.button === 2) return;

    // Alt+Shift sweeps every stored endpoint on the row, Alt+Meta the column;
    // checked before pan so the modifiers win (MouseManager.java:1087-1090).
    if (ev.button === 0 && ev.altKey && ev.shiftKey) {
      startRowCol('row', p);
      return;
    }
    if (ev.button === 0 && ev.altKey && ev.metaKey) {
      startRowCol('col', p);
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
    // read-only forcing (MouseManager.java:1101).
    if (hit) {
      const def = defFor(hit.kind);
      if (def?.interactive && state.running && !ev.altKey) {
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

    // With editing disabled, only pan (above), wheel zoom and the interactive
    // parts above stay live: no select, place, move, post-drag or rubber-band
    // (UIManager.java:1101).
    if (!state.settings.editable) {
      state.setStatus('Editing disabled. Re-enable from the Options menu.');
      return;
    }

    if (state.tool) {
      const grid = gridSize(state.settings);
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
      if (ev.ctrlKey && (def?.draggablePosts ?? def?.postCount ?? 0) > 1) {
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
  };

  const onPointerDown = (ev: React.PointerEvent<HTMLCanvasElement>) => {
    const isTouch = ev.pointerType === 'touch';
    const canvas = canvasRef.current;
    canvas?.setPointerCapture(ev.pointerId);
    const state = useStore.getState();
    const p = toCircuit(ev.clientX, ev.clientY);
    pointerRef.current = toClient(ev.clientX, ev.clientY);

    if (isTouch) {
      const g = gestureRef.current!;
      const { actions } = g.down(ev.pointerId, ev.clientX, ev.clientY);
      let primary = false;
      let twoFinger = false;
      for (const a of actions) {
        if (a.type === 'primaryDown') primary = true;
        if (a.type === 'twoFingerStart') twoFinger = true;
      }
      if (twoFinger) {
        // A second finger abandons the single-finger gesture: no armed drag
        // may keep moving and the timers must not fire (the recognizer already
        // dropped its long-press and tap state). A placement in flight still
        // owes its up-time cleanup, or the half-placed element would serialize
        // into the saved netlist.
        const drag = dragRef.current;
        if (drag.mode === 'place') finishPlacement(drag, state);
        dragRef.current = { mode: 'none' };
        clearTouchTimers();
        touchArmedRef.current = false;
        pinchPrevMidRef.current = null;
        return;
      }
      // A third finger is tracked but ignored; nothing to do.
      if (!primary) return;

      touchArmedRef.current = false;
      touchDownClientRef.current = { x: ev.clientX, y: ev.clientY };
      const hit = hitTest(p);
      touchTargetRef.current = hit?.id ?? null;
      beginPointerGesture(ev, p, state, hit, true);
      scheduleTouchTimers();
      return;
    }

    beginPointerGesture(ev, p, state, hitTest(p), false);
  };

  const onPointerMove = (ev: React.PointerEvent<HTMLCanvasElement>) => {
    const isTouch = ev.pointerType === 'touch';
    const drag = dragRef.current;
    const state = useStore.getState();
    const p = toCircuit(ev.clientX, ev.clientY);
    pointerRef.current = toClient(ev.clientX, ev.clientY);
    const grid = gridSize(state.settings);

    if (isTouch) {
      const g = gestureRef.current!;
      const { actions, cancelLongPress } = g.move(ev.pointerId, ev.clientX, ev.clientY);
      // Travel past the tolerance cancels the pending long-press; the
      // drag-delay timer is deliberately left running.
      if (cancelLongPress && longPressTimerRef.current !== null) {
        clearTimeout(longPressTimerRef.current);
        longPressTimerRef.current = null;
      }
      for (const a of actions) {
        if (a.type === 'twoFingerMove') {
          applyPinch(a);
          return;
        }
      }
      // A single-finger move falls through to the shared drag switch, whose
      // gated move/dragpost cases wait for dragArmed.
    }

    // Hover tracking only applies when nothing is being dragged.
    if (drag.mode === 'none') {
      const hit = hitTest(p);
      state.setHovered(hit?.id ?? null);
      // Shift-hover over a wire highlights the whole net: every element on the
      // wire's node draws with theme.highlight (MouseManager.java:689-693).
      let node: number | null = null;
      if (hit?.kind === 'wire' && ev.shiftKey && engine) {
        const idx = engine.indexOf(hit.id);
        const off = engine.postOffset(hit.id);
        const nodes = engine.elementNodes();
        if (idx !== undefined && off !== undefined) node = nodes[off] ?? null;
      }
      state.setHighlightedNode(node);
      return;
    }

    switch (drag.mode) {
      case 'pan': {
        const scale = state.view.scale;
        state.setView({
          ...state.view,
          x: drag.startView.x - (ev.clientX - drag.startClient.x) / scale,
          y: drag.startView.y - (ev.clientY - drag.startClient.y) / scale,
        });
        break;
      }
      case 'place': {
        let x2 = snap(p.x, grid);
        let y2 = snap(p.y, grid);
        const def = state.tool ? toolDef(state.tool) : undefined;
        if (def?.noDiagonal) {
          // Upstream snaps the drag to the dominant axis, so a transistor,
          // op-amp or SPDT cannot end up diagonal (CircuitElm.java:560-566).
          if (Math.abs(x2 - drag.start.x) < Math.abs(y2 - drag.start.y)) x2 = drag.start.x;
          else y2 = drag.start.y;
        }
        state.updateElement(drag.id, { x2, y2 });
        break;
      }
      case 'move': {
        // A touch move may not apply until the recognizer armed the drag, so a
        // tap on an element never drags it (MouseManager.java:383-386). The
        // delay applies to the whole group move; place and box-select are
        // explicit drags and stay immediate.
        if (isTouch && drag.gated && !touchArmedRef.current) break;
        const gx = snap(p.x, grid) - snap(drag.last.x, grid);
        const gy = snap(p.y, grid) - snap(drag.last.y, grid);
        if (gx !== 0 || gy !== 0) {
          state.moveElements(state.selectedIds, gx, gy);
          dragRef.current = { ...drag, last: p, moved: true };
        }
        break;
      }
      case 'dragpost': {
        if (isTouch && drag.gated && !touchArmedRef.current) break;
        // Snap to absolute grid coordinates, not to a delta: a group keeps
        // its internal spacing, a single post should land exactly on the grid
        // so the dragged end can connect to a wire that ends there.
        const x = snap(p.x, grid);
        const y = snap(p.y, grid);
        const e = state.elements.find((q) => q.id === drag.id);
        // A no-op update would bump `revision` and make the engine reload
        // mid-cell, so only touch the store when the endpoint actually moved.
        // If the element vanished mid-drag there is nothing to write either.
        if (e !== undefined && !postAt(e, drag.post, x, y)) {
          state.updateElement(drag.id, postPatch(drag.post, x, y));
          dragRef.current = { ...drag, moved: true };
        }
        break;
      }
      case 'rowcol': {
        const x = snap(p.x, grid);
        const y = snap(p.y, grid);
        // Only the along-axis delta moves anything; the other axis is locked,
        // so a row sweep cannot drift a vertical post (MouseManager.java:
        // 450-466). The captured list is frozen at pointer-down.
        const d = drag.axis === 'row' ? y - drag.last.y : x - drag.last.x;
        if (d !== 0) {
          for (const c of drag.captured) {
            state.movePoint(c.id, c.post, drag.axis === 'row' ? 0 : d, drag.axis === 'row' ? d : 0);
          }
          dragRef.current = { ...drag, last: { x, y } };
        }
        break;
      }
      case 'select': {
        dragRef.current = { ...drag, current: p };
        break;
      }
    }
  };

  const onPointerUp = (ev: React.PointerEvent<HTMLCanvasElement>) => {
    const isTouch = ev.pointerType === 'touch';
    const drag = dragRef.current;
    const state = useStore.getState();

    if (isTouch) {
      const g = gestureRef.current!;
      const { actions } = g.up(ev.pointerId, ev.clientX, ev.clientY);
      for (const a of actions) {
        if (a.type === 'doubleTap') {
          clearTouchTimers();
          touchArmedRef.current = false;
          pinchPrevMidRef.current = null;
          // The second tap's pointerdown may have placed an element (a tool
          // active, the tap qualifying as a double-tap against a previous
          // nearby tap). The early return below skips the shared up-handling,
          // so the placement's cleanup still owes here or a stray zero-length
          // element would serialize into the saved netlist.
          finishPlacement(drag, state);
          // Double-tap means edit this element, like upstream's onDoubleClick
          // (MouseManager.java:1024-1034): only when something is under the
          // pointer, and never a running interactive part, which is a control
          // rather than something to edit. Empty canvas does nothing.
          const hit = hitTest(toCircuit(ev.clientX, ev.clientY));
          if (hit && !(defFor(hit.kind)?.interactive && state.running)) {
            if (!state.settings.editable) {
              state.setStatus('Editing disabled. Re-enable from the Options menu.');
            } else {
              state.requestEdit(hit.id);
            }
          }
          // A double-tap early-returns before the shared up-handling below, so
          // the release a momentary switch's second press owes it runs here.
          releaseHeldMomentary(ev.pointerId);
          dragRef.current = { mode: 'none' };
          canvasRef.current?.releasePointerCapture(ev.pointerId);
          forceRender((n) => n + 1);
          return;
        }
      }
      // The gesture is over (tap, completed drag, long-press lift or pinch
      // lift): the timers must not fire afterwards, and no drag may stay armed.
      clearTouchTimers();
      touchArmedRef.current = false;
      pinchPrevMidRef.current = null;
      // A plain tap needs no extra work: pointer-down already selected or
      // toggled. Fall through so the armed-mode up-handling (place, box-select,
      // dragpost collapse) runs as today.
    }

    if (drag.mode === 'select') {
      const p = toCircuit(ev.clientX, ev.clientY);
      const inside = selectByBox(state.elements, boxFromPoints(drag.start, p), drag.shift, state.selectedIds);
      state.select(inside);
    }

    finishPlacement(drag, state);

    if (drag.mode === 'dragpost') {
      const e = state.elements.find((x) => x.id === drag.id);
      const def = e ? defFor(e.kind) : undefined;
      // A post dragged onto its partner leaves a zero-length element, which is
      // almost never meant. Do not delete mid-drag: the user may be passing
      // through on the way somewhere. On release, undo the whole drag and say
      // why.
      if (drag.moved && e && def && def.postCount > 1 && e.x1 === e.x2 && e.y1 === e.y2) {
        state.undo();
        state.setStatus('Reverted: that drag would have collapsed the element to a point.');
      }
    }

    // A row or column sweep can collapse an element to a point only by moving
    // both of its posts onto the same coordinate, exactly the degenerate case
    // the dragpost guard exists for, so reuse it.
    if (drag.mode === 'rowcol') {
      const collapsed = drag.captured.some((c) => {
        const e = state.elements.find((q) => q.id === c.id);
        return e !== undefined && (defFor(e.kind)?.postCount ?? 0) > 1 && e.x1 === e.x2 && e.y1 === e.y2;
      });
      if (collapsed) {
        state.undo();
        state.setStatus('Reverted: that drag would have collapsed the element to a point.');
      }
    }

    // A momentary switch returns to its resting position on release, the
    // mirror of the press's toggle (SwitchElm.mouseUp, SwitchElm.java:180-182).
    // If the switch vanished mid-hold there is nothing to toggle back.
    releaseHeldMomentary(ev.pointerId);

    dragRef.current = { mode: 'none' };
    canvasRef.current?.releasePointerCapture(ev.pointerId);
    forceRender((n) => n + 1);
  };

  const onWheel = (ev: React.WheelEvent<HTMLCanvasElement>) => {
    const state = useStore.getState();
    const now = performance.now();
    const p = toCircuit(ev.clientX, ev.clientY);
    const hit = hitTest(p);
    const param = hit ? scrollableParam(hit.kind) : undefined;

    // Over a resistor/capacitor/inductor with nothing else happening, the
    // wheel steps E12 values instead of zooming. A drag in progress keeps the
    // wheel bound to zoom, so a mid-move scroll cannot misfire a value edit,
    // and so does a recent zoom: once zooming starts, the wheel stays
    // zoom-only for a second so a sweep onto an element cannot accidentally
    // edit a value (MouseManager.java:1302-1304). The early return stops
    // propagation, so the zoom branch below never runs. Editing disabled falls
    // through to zoom: it must not step values or push undo
    // (MouseManager.java:1306).
    if (
      param !== undefined &&
      hit &&
      ev.deltaY !== 0 &&
      dragRef.current.mode === 'none' &&
      !isZoomOnly(zoomAtRef.current, now) &&
      state.settings.editable
    ) {
      ev.stopPropagation();
      // The pointer drifted back off the popover onto the canvas mid-session:
      // step the open session rather than opening a second one.
      if (popoverRef.current?.session.id === hit.id) {
        stepPopover(wheelPixels(ev.deltaY, ev.deltaMode));
        return;
      }
      // The first scroll of a session is one undo step, exactly as upstream's
      // ScrollValuePopup constructor pushes the undo stack before applying the
      // opening deltaY (ScrollValuePopup.java:59, :76). commit's dedup drops a
      // session that never changes anything.
      state.commit();
      const session0 = openScrollValue(hit.kind, hit.id, param, hit.params[param] ?? 0);
      const session = stepScrollValue(session0, wheelPixels(ev.deltaY, ev.deltaMode));
      state.setParam(session.id, session.param, selectionValue(session));
      setPopover({ session, x: ev.clientX, y: ev.clientY });
      return;
    }

    // Zoom about the pointer so the point under the cursor stays put. Stamped
    // here so the value stepper stays disabled for a second after. The clamp
    // is shared with the keyboard path via zoomAbout; wheelSensitivity scales
    // the per-notch exponent, and at 1 the factor is exactly today's 1.12 or
    // 1/1.12 (MouseManager.java:1317-1331).
    zoomAtRef.current = now;
    const s = state.settings.wheelSensitivity;
    const factor = Math.exp(Math.sign(ev.deltaY) * -Math.log(ZOOM_FACTOR) * s);
    state.setView(zoomAbout(state.view, p.x, p.y, factor));
  };

  const onContextMenu = (ev: React.MouseEvent<HTMLCanvasElement>) => {
    ev.preventDefault();
    const hit = hitTest(toCircuit(ev.clientX, ev.clientY));
    // The store applies the selection-on-right-click rule; only the hit test
    // (which needs circuit coordinates) stays here.
    useStore.getState().openContextMenu(ev.clientX, ev.clientY, hit?.id ?? null);
  };

  const onDoubleClick = (ev: React.MouseEvent<HTMLCanvasElement>) => {
    const state = useStore.getState();
    const hit = hitTest(toCircuit(ev.clientX, ev.clientY));
    if (!hit) return;
    // Upstream skips the edit dialog for switches; an interactive part in run
    // mode is a control, not something to edit (MouseManager.java:1024-1034).
    if (defFor(hit.kind)?.interactive && state.running) return;
    // Editing disabled drops the edit dialog, like upstream's readOnly gate
    // (MouseManager.java:1032).
    if (!state.settings.editable) {
      state.setStatus('Editing disabled. Re-enable from the Options menu.');
      return;
    }
    state.requestEdit(hit.id);
  };

  const onPointerCancel = (ev: React.PointerEvent<HTMLCanvasElement>) => {
    if (ev.pointerType === 'touch') {
      // A system gesture took the pointers away (notification shade, incoming
      // call): the recognizer must drop its state and the timers must not fire
      // afterwards. A held momentary switch returns to rest too, or it would
      // stay closed with no finger on it.
      gestureRef.current?.cancel();
      clearTouchTimers();
      touchArmedRef.current = false;
      pinchPrevMidRef.current = null;
      dragRef.current = { mode: 'none' };
      releaseHeldMomentary(ev.pointerId);
      // The pointer is gone, so the crosshair and transient highlights go with
      // it, mirroring onPointerLeave and the shared up path.
      const state = useStore.getState();
      pointerRef.current = null;
      state.setHovered(null);
      state.setHighlightedNode(null);
      canvasRef.current?.releasePointerCapture(ev.pointerId);
      forceRender((n) => n + 1);
      return;
    }
    // Mouse and pen cancels are rare; treating them as an up keeps no stale
    // drag state behind.
    onPointerUp(ev);
  };

  const onPointerLeave = () => {
    // The pointer is gone, so the transient highlights and the crosshair guide
    // must go with it.
    const state = useStore.getState();
    pointerRef.current = null;
    state.setHovered(null);
    state.setHighlightedNode(null);
  };

  return {
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel,
    onWheel,
    onContextMenu,
    onDoubleClick,
    onPointerLeave,
    popover,
    stepPopover,
    closePopover,
    revertPopover,
  };
}
