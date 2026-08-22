import { useCallback, useEffect, useRef, useState } from 'react';
import type { SimEngine } from '../../engine/simulator';
import {
  axisConstrained,
  constrainPostDrag,
  defFor,
} from '../../model/registry';
import { rectContains } from '../../model/registry/shared';
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
import { fieldLabel } from '../../model/types';
import { wireDragAxis } from '../../model/wirePlacement';
import { GRID_SIZE } from '../../model/types';
import { HIT_TOLERANCE_PX, hitTestElement, postAt, postPatch } from '../../render/geometry';
import { boxFromPoints, selectByBox } from '../../render/selection';
import { snap, useStore } from '../../state/store';
import type { AppState } from '../../state/types';
import { ZOOM_FACTOR, zoomAbout } from '../../state/view';
import { clearPaletteAnchor, setPaletteAnchor } from '../paletteAnchor';
import { DRAG_DELAY_MS, LONG_PRESS_MS, TouchGesture, type GestureAction } from '../gestures';
import {
  beginPointerGesture,
  collapsedToPoint,
  finishPlacement,
  finishPostDrag,
  finishWireDrag,
  placementPoint,
  releaseHeldMomentary,
  type Drag,
} from './pointerDown';
import { useStoreRef } from './useStoreRef';

export type { Drag } from './pointerDown';

/** The open mouse-wheel value popover, positioned at the cursor. */
export interface ScrollValuePopover {
  session: ScrollValueSession;
  /** The stepped field's display label, resolved at open (a dynamic label
   *  needs the element's state, which the session itself does not carry). */
  name: string;
  x: number;
  y: number;
}

export function useCanvasInteractions(
  canvasRef: React.RefObject<HTMLCanvasElement | null>,
  dragRef: React.MutableRefObject<Drag>,
  pointerRef: React.MutableRefObject<Point | null>,
  hoverRef: React.MutableRefObject<Point | null>,
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

  /** Disarms the drag and lowers the store's gesture flag together. The two
   *  must never come apart: a stale `elementGesture` would make the next
   *  rotate skip its commit and silently cost the user an undo entry, so every
   *  teardown path (abort, double-tap, pointer-up, pointer-cancel) goes
   *  through here rather than assigning `mode: 'none'` on its own. */
  const clearDrag = (state: AppState) => {
    dragRef.current = { mode: 'none' };
    state.endElementGesture();
  };

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
          const down = touchDownClientRef.current;
          useStore
            .getState()
            .openContextMenu(down.x, down.y, target, toCircuit(down.x, down.y));
          touchArmedRef.current = false;
          clearDrag(useStore.getState());
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
      // wheelSensitivity is steps per notch, read live so a settings change
      // mid-session takes effect on the next wheel tick (ScrollValuePopup.java:214).
      const sensitivity = useStore.getState().settings.wheelSensitivity;
      const session = stepScrollValue(p.session, deltaY, sensitivity);
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

  const hitTest = useCallback(
    (p: Point, preferredId: number | null = null): CircuitElement | null => {
      const { elements, view } = stateRef.current;
      // The reach is a screen-pixel distance, converted per pointer event: the
      // circuit-space reach is the pixel tolerance over the scale, so the same
      // on-screen slop grabs the same element at zoom 0.15 and zoom 6. Both the
      // hover setter and the press paths pass the current hovered id so the
      // highlight sticks to the element the cursor was last over at a junction
      // shared by several elements, and the press grabs that same element
      // (the port of upstream's junction grab) rather than flipping to the
      // topmost by array order.
      return hitTestElement(p, elements, view.scale, HIT_TOLERANCE_PX, preferredId);
    },
    [stateRef],
  );

  // ---- pointer handling ---------------------------------------------------
  /** The refs the pointer-down gesture decision writes through, held here so
   *  the shared `beginPointerGesture` in `./pointerDown` stays pure and
   *  headlessly testable. */
  const gestureRefs = {
    dragRef,
    heldMomentaryRef,
    heldMomentaryPointerRef,
  };

  const onPointerDown = (ev: React.PointerEvent<HTMLCanvasElement>) => {
    const isTouch = ev.pointerType === 'touch';
    const canvas = canvasRef.current;
    canvas?.setPointerCapture(ev.pointerId);
    const state = useStore.getState();
    const p = toCircuit(ev.clientX, ev.clientY);
    pointerRef.current = toClient(ev.clientX, ev.clientY);

    if (isTouch) {
      // A finger has no hover, so the ghost stands down for the whole touch
      // gesture: tap-to-place still works, it just gets no preview.
      hoverRef.current = null;
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
        clearDrag(state);
        clearTouchTimers();
        touchArmedRef.current = false;
        pinchPrevMidRef.current = null;
        return;
      }
      // A third finger is tracked but ignored; nothing to do.
      if (!primary) return;

      touchArmedRef.current = false;
      touchDownClientRef.current = { x: ev.clientX, y: ev.clientY };
      // Prefer the element the cursor was last hovering so a press at a shared
      // junction grabs the highlighted one, not a different topmost pick.
      const hit = hitTest(p, state.hoveredId);
      touchTargetRef.current = hit?.id ?? null;
      beginPointerGesture(ev, p, state, hit, true, gestureRefs);
      scheduleTouchTimers();
      return;
    }

    // Prefer the element the cursor was last hovering so a press at a shared
    // junction grabs the highlighted one rather than an arbitrary topmost pick.
    beginPointerGesture(ev, p, state, hitTest(p, state.hoveredId), false, gestureRefs);
  };

  const onPointerMove = (ev: React.PointerEvent<HTMLCanvasElement>) => {
    const isTouch = ev.pointerType === 'touch';
    const drag = dragRef.current;
    const state = useStore.getState();
    const p = toCircuit(ev.clientX, ev.clientY);
    pointerRef.current = toClient(ev.clientX, ev.clientY);
    if (!isTouch) hoverRef.current = pointerRef.current;
    // The '/' key opens the palette menu where the cursor last was, so record
    // it in viewport pixels (what the menu is positioned with) alongside the
    // circuit point under it.
    setPaletteAnchor({ x: ev.clientX, y: ev.clientY }, p);
    const grid = GRID_SIZE;

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
      // Sticky hover: prefer the element already highlighted so a cursor that
      // settles on a junction shared by several elements keeps the one it was
      // last over, instead of flipping to whichever is topmost by array order.
      // The press path (below) passes the same id, so the highlighted element
      // is the one that gets grabbed.
      const hit = hitTest(p, state.hoveredId);
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
        const placed = state.elements.find((q) => q.id === drag.id);
        if (placed !== undefined) {
          // Space banks quarter turns while the placement is in flight, so the
          // endpoint is re-derived from the cursor and the banked turns on
          // every move; otherwise the next move would erase the turn.
          const { x2, y2, extra } = placementPoint(
            drag.start,
            { x: snap(p.x, grid), y: snap(p.y, grid) },
            state.elementGesture?.placeTurns ?? 0,
            placed,
          );
          // A no-op update would bump `revision` and make the engine reload
          // mid-cell, so only touch the store when the second post actually
          // moved or a drag-derived parameter (the wattmeter's width) really
          // changed while the axis lock held the endpoint still.
          const movedPost = placed.x2 !== x2 || placed.y2 !== y2;
          const paramsChanged =
            extra !== undefined &&
            Object.entries(extra).some(([k, v]) => placed.params[k] !== v);
          if (movedPost || paramsChanged) {
            const patch: { x2: number; y2: number; params?: Record<string, number> } = { x2, y2 };
            if (extra !== undefined) patch.params = { ...placed.params, ...extra };
            state.updateElement(drag.id, patch);
          }
        }
        break;
      }
      case 'wire': {
        // Nothing reaches the store here: the run is drawn from the drag state
        // by the frame loop and inserted on release, so a drag that wanders
        // does not add and remove elements under the hand. The axis latches
        // on the first move off the anchor and holds for the gesture, which is
        // what keeps the corner from flipping when the cursor crosses the
        // diagonal.
        const current = { x: snap(p.x, grid), y: snap(p.y, grid) };
        dragRef.current = {
          ...drag,
          current,
          axis: drag.axis ?? wireDragAxis(drag.start, current),
        };
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
        let x = snap(p.x, grid);
        let y = snap(p.y, grid);
        const e = state.elements.find((q) => q.id === drag.id);
        if (e !== undefined) {
          const def = defFor(e.kind);
          // A drag-derived parameter (the wattmeter's width) is the weaker
          // drag component against the fixed endpoint; the axis lock below
          // discards it, so capture it first (WattmeterElm.java:75-89).
          const extra = def?.dragParams?.(drag.start, { x, y });
          // A post drag of an axis-locked part can only stretch along the
          // body, never rotate it (upstream's movePoint, CircuitElm.java:661-666).
          if (axisConstrained(e)) {
            const constrained = constrainPostDrag(e, drag.post, x, y);
            x = constrained.x;
            y = constrained.y;
          }
          // A no-op update would bump `revision` and make the engine reload
          // mid-cell, so only touch the store when the endpoint actually moved
          // or a drag-derived parameter (the wattmeter's width) really changed
          // while the axis lock held the endpoint still. If the element
          // vanished mid-drag there is nothing to write either.
          const movedPost = !postAt(e, drag.post, x, y);
          const paramsChanged =
            extra !== undefined &&
            Object.entries(extra).some(([k, v]) => e.params[k] !== v);
          if (movedPost || paramsChanged) {
            const patch: {
              x1?: number;
              y1?: number;
              x2?: number;
              y2?: number;
              params?: Record<string, number>;
            } = postPatch(drag.post, x, y);
            if (extra !== undefined) patch.params = { ...e.params, ...extra };
            state.updateElement(drag.id, patch);
            dragRef.current = { ...drag, moved: movedPost || drag.moved };
          }
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
          // pointer, and never an interactive part's lever, which is a control
          // rather than something to edit, whether the sim runs or not.
          // Empty canvas does nothing. The lever region is the same switchRect
          // a single click toggles, so a double-tap on a lead selects like a
          // single tap does and the edit dialog is fair game there.
          const p = toCircuit(ev.clientX, ev.clientY);
          const hit = hitTest(p);
          if (hit) {
            const def = defFor(hit.kind);
            const rect = def?.switchRect?.(hit);
            const onLever = def?.interactive && (rect === undefined || rectContains(rect, p));
            if (!onLever) {
              if (!state.settings.editable) {
                state.setStatus('Editing disabled. Re-enable from the Options menu.');
              } else {
                state.requestEdit(hit.id);
              }
            }
          }
          // A double-tap early-returns before the shared up-handling below, so
          // the release a momentary switch's second press owes it runs here.
          releaseHeldMomentary(ev.pointerId, gestureRefs);
          clearDrag(state);
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
    finishWireDrag(drag, state);
    finishPostDrag(drag, state);

    // A row or column sweep can collapse an element to a point only by moving
    // both of its posts onto the same coordinate, exactly the degenerate case
    // the dragpost guard exists for, so reuse it.
    if (drag.mode === 'rowcol') {
      const collapsed = drag.captured.some((c) => {
        const e = state.elements.find((q) => q.id === c.id);
        return e !== undefined && collapsedToPoint(e);
      });
      if (collapsed) {
        state.undo();
        state.setStatus('Reverted: that drag would have collapsed the element to a point.');
      }
    }

    // A momentary switch returns to its resting position on release, the
    // mirror of the press's toggle (SwitchElm.mouseUp, SwitchElm.java:180-182).
    // If the switch vanished mid-hold there is nothing to toggle back.
    releaseHeldMomentary(ev.pointerId, gestureRefs);

    clearDrag(state);
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
    // wheel steps E12 values instead of zooming, but only while the Edit
    // Values With Mouse Wheel toggle is on (MouseManager.java:1306). A drag in
    // progress keeps the wheel bound to zoom, so a mid-move scroll cannot
    // misfire a value edit, and so does a recent zoom: once zooming starts,
    // the wheel stays zoom-only for a second so a sweep onto an element cannot
    // accidentally edit a value (MouseManager.java:1302-1304). The early
    // return stops propagation, so the zoom branch below never runs. Editing
    // disabled falls through to zoom: it must not step values or push undo
    // (MouseManager.java:1306).
    if (
      param !== undefined &&
      hit &&
      ev.deltaY !== 0 &&
      dragRef.current.mode === 'none' &&
      !isZoomOnly(zoomAtRef.current, now) &&
      state.settings.editable &&
      state.settings.mouseWheelEdit
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
      const session0 = openScrollValue(hit.kind, hit.id, hit.params[param] ?? 0);
      const session = stepScrollValue(
        session0,
        wheelPixels(ev.deltaY, ev.deltaMode),
        state.settings.wheelSensitivity,
      );
      state.setParam(session.id, session.param, selectionValue(session));
      // The title is the stepped field's label, resolved per element because a
      // dynamic label (the source's "Voltage"/"Max Voltage") needs the params.
      const def = defFor(hit.kind);
      const stepped = def?.fields?.find((f) => f.name === session.param);
      const titled = stepped ?? def?.fields?.[0];
      const name = titled ? fieldLabel(hit, titled) : session.param;
      setPopover({ session, name, x: ev.clientX, y: ev.clientY });
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
    const p = toCircuit(ev.clientX, ev.clientY);
    const hit = hitTest(p);
    // The store applies the selection-on-right-click rule; only the hit test
    // (which needs circuit coordinates) stays here. The circuit point travels
    // too, so Split Wire Manually can act at the click location.
    useStore.getState().openContextMenu(ev.clientX, ev.clientY, hit?.id ?? null, p);
  };

  const onDoubleClick = (ev: React.MouseEvent<HTMLCanvasElement>) => {
    const state = useStore.getState();
    const p = toCircuit(ev.clientX, ev.clientY);
    const hit = hitTest(p);
    if (!hit) return;
    // Upstream skips the edit dialog for switches; an interactive part's lever
    // is a control, not something to edit, whether the sim runs or not
    // (MouseManager.java:1024-1034). The skip only covers the lever, the same
    // switchRect a single click toggles: a double-click on a lead selects like
    // a single click does, so the edit dialog is fair game there.
    const def = defFor(hit.kind);
    const rect = def?.switchRect?.(hit);
    if (def?.interactive && (rect === undefined || rectContains(rect, p))) return;
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
      // The pointer is gone, so the crosshair and transient highlights go with
      // it, mirroring onPointerLeave and the shared up path.
      const state = useStore.getState();
      clearDrag(state);
      releaseHeldMomentary(ev.pointerId, gestureRefs);
      pointerRef.current = null;
      hoverRef.current = null;
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
    clearPaletteAnchor();
    pointerRef.current = null;
    hoverRef.current = null;
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
