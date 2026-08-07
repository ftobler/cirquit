import { useCallback, useRef, useState } from 'react';
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
import { GRID_SIZE, type CircuitElement, type Point } from '../../model/types';
import { distanceToElement, nearestPost, postAt, postPatch } from '../../render/geometry';
import { boxFromPoints, selectByBox } from '../../render/selection';
import { makeToolElement, snap, useStore } from '../../state/store';
import { ZOOM_FACTOR, zoomAbout } from '../../state/view';
import { useStoreRef } from './useStoreRef';

/** How close the pointer must be to an element to hit it, in circuit units. */
const HIT_TOLERANCE = 8;

export type Drag =
  | { mode: 'none' }
  | { mode: 'place'; start: Point; id: number }
  | { mode: 'move'; last: Point; moved: boolean }
  | { mode: 'dragpost'; id: number; post: 1 | 2; moved: boolean }
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
  // When the last zoom happened; the wheel stays zoom-only for a second
  // after, so a sweep from empty canvas onto an element cannot accidentally
  // edit a value (MouseManager.java:1302-1304).
  const zoomAtRef = useRef<number | null>(null);
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
    const x = snap(p.x);
    const y = snap(p.y);
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
  const onPointerDown = (ev: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    canvas?.setPointerCapture(ev.pointerId);
    const state = useStore.getState();
    const p = toCircuit(ev.clientX, ev.clientY);

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
    // longer pans: it is the box-add and net-highlight modifier.
    if (ev.button === 1 || ev.altKey) {
      dragRef.current = {
        mode: 'pan',
        startClient: { x: ev.clientX, y: ev.clientY },
        startView: { x: state.view.x, y: state.view.y },
      };
      return;
    }

    const hit = hitTest(p);
    // A switch is a run-mode control, not an edit: it must still throw when
    // editing is disabled, exactly as upstream's doSwitch runs before its
    // read-only forcing (MouseManager.java:1101).
    if (hit) {
      const def = defFor(hit.kind);
      if (def?.interactive && state.running && !ev.altKey) {
        const momentary = hit.kind === 'switch' && (hit.params.momentary ?? 0) !== 0;
        const throwCount = Math.max(2, hit.params.throwCount ?? 2);
        const next = ((hit.state ?? 0) + 1) % (hit.kind === 'switch' ? 2 : throwCount);
        // One click is one undo entry. Upstream does not push here (doSwitch
        // returns before the mouse-down pushUndo), this is a deliberate
        // divergence; the dedup in commit keeps repeat clicks from stacking.
        state.commit();
        if (momentary) {
          // A push switch is closed only while held: the press toggles it and
          // the pointer-up path toggles back (doSwitch + heldSwitchElm.mouseUp,
          // MouseManager.java:314-326, SwitchElm.java:180-182).
          heldMomentaryRef.current = hit.id;
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
      const x = snap(p.x);
      const y = snap(p.y);
      const def = toolDef(state.tool);
      const len = (def?.defaultLength ?? 0) * GRID_SIZE;
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
        dragRef.current = { mode: 'dragpost', id: hit.id, post: nearestPost(p, hit), moved: false };
      } else {
        dragRef.current = { mode: 'move', last: p, moved: false };
      }
      return;
    }

    // A shift-drag box adds to the selection, so the old one survives the
    // pointer-down; a plain box replaces it and clears up front.
    if (!ev.shiftKey) state.select([]);
    dragRef.current = { mode: 'select', start: p, current: p, shift: ev.shiftKey };
  };

  const onPointerMove = (ev: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    const state = useStore.getState();
    const p = toCircuit(ev.clientX, ev.clientY);

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
        let x2 = snap(p.x);
        let y2 = snap(p.y);
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
        const gx = snap(p.x) - snap(drag.last.x);
        const gy = snap(p.y) - snap(drag.last.y);
        if (gx !== 0 || gy !== 0) {
          state.moveElements(state.selectedIds, gx, gy);
          dragRef.current = { mode: 'move', last: p, moved: true };
        }
        break;
      }
      case 'dragpost': {
        // Snap to absolute grid coordinates, not to a delta: a group keeps
        // its internal spacing, a single post should land exactly on the grid
        // so the dragged end can connect to a wire that ends there.
        const x = snap(p.x);
        const y = snap(p.y);
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
        const x = snap(p.x);
        const y = snap(p.y);
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
    const drag = dragRef.current;
    const state = useStore.getState();

    if (drag.mode === 'select') {
      const p = toCircuit(ev.clientX, ev.clientY);
      const inside = selectByBox(state.elements, boxFromPoints(drag.start, p), drag.shift, state.selectedIds);
      state.select(inside);
    }

    if (drag.mode === 'place') {
      // A click without a drag leaves a zero-length element; drop it unless
      // the type is a single-terminal symbol.
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
    }

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
    if (heldMomentaryRef.current != null) {
      const id = heldMomentaryRef.current;
      heldMomentaryRef.current = null;
      const e = state.elements.find((q) => q.id === id);
      if (e) state.setElementState(id, ((e.state ?? 0) + 1) % 2);
    }

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
    // here so the value stepper stays disabled for a second after. The factor
    // and clamp are shared with the keyboard path via zoomAbout.
    zoomAtRef.current = now;
    state.setView(zoomAbout(state.view, p.x, p.y, ev.deltaY < 0 ? ZOOM_FACTOR : 1 / ZOOM_FACTOR));
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
    state.editElement(hit.id);
  };

  const onPointerLeave = () => {
    // The pointer is gone, so both transient highlights must go with it.
    const state = useStore.getState();
    state.setHovered(null);
    state.setHighlightedNode(null);
  };

  return {
    onPointerDown,
    onPointerMove,
    onPointerUp,
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
