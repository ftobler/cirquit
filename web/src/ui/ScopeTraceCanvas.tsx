/**
 * One scope's trace canvas, the same in the dock and in a floating panel.
 *
 * The engine samples every timestep and aggregates into min/max columns, so
 * what is drawn here is the true waveform envelope rather than a 60 Hz
 * subsample of it. The canvas owns the scope's pointer interactions: the
 * settings wheel, the manual-scale plot drag, the time cursor, the wheel zoom
 * and the context menu. Docked, it also carries the grip, float and close
 * buttons in its corner.
 */

import { useCallback, useEffect, useRef } from 'react';
import { SimEngine } from '../engine/simulator';
import type { Scope, ScopePlot } from '../engine/scopeModel';
import {
  registerScopeWidth,
  unregisterScopeWidth,
  xToTime,
  inSettingsWheel,
} from '../scope/geometry';
import {
  MAN_DIVISIONS,
  drawScope,
  emptyCursor,
  isDrawable,
  selectPlotAt,
  triggerLevelAtY,
  triggerLineY,
  triggerTimeAnchor,
  visiblePlotsOf,
  type ScopeCursor,
} from '../scope/draw';
import { clearXYScale, dragPlotYPosition, scaleStateFor, seedManScale, wheelManScale } from '../scope/scale';
import { clearXYPersistence } from '../scope/xyPersistence';
import {
  DEFAULT_SCOPE_VIEW,
  isPanned,
  panByPixels,
  resetScopeView,
  setScopeView,
  viewFor,
  viewRightTime,
  viewSpeed,
  zoomAboutCursor,
  type ScopeView,
} from '../scope/view';
import { useStore } from '../state/store';
import { backingStoreSize } from './canvas/backingStoreSize';
import { elmInfoResolver } from './infoBoxLines';

export function ScopeTraceCanvas({
  engine,
  scope,
  floating = false,
  onGrip,
}: {
  engine: SimEngine | null;
  scope: Scope;
  /** A floating panel carries its own title bar with dock and close, so the
   *  corner buttons are for the dock only. */
  floating?: boolean;
  /** Starts a drag-and-drop of this scope from its grip (docked only). */
  onGrip?: (scopeId: number, e: React.PointerEvent<HTMLElement>) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cursorRef = useRef<ScopeCursor>(emptyCursor());
  // Whether the pointer press landed on the settings wheel. Only a press that
  // starts there opens the dialog on release, so a plot-Y or time drag that
  // began elsewhere and ends in the corner box does not.
  const settingsWheelPressRef = useRef(false);
  // A drag of the horizontal trigger level marker.
  const triggerDragRef = useRef(false);
  // Wheel deltas accumulate and only zoom past a threshold, so trackpad
  // micro-deltas do not hammer the time base (Scope.java:1378-1388).
  const wheelDeltaRef = useRef(0);
  // A wheel burst (trackpad inertia, a held wheel) fires many events; the
  // gesture flag coalesces the whole burst into one undo entry, and this timer
  // ends it after a short idle so the next burst starts a fresh entry.
  const wheelGestureTimerRef = useRef<number | null>(null);
  // The pointer id captured for a plot-Y drag, so the capture can be released
  // on pointer-up regardless of where the release lands (Scope.java:1222).
  const dragPointerIdRef = useRef<number | null>(null);
  // The draw loop reads the scope every frame, so a fresh copy (a speed zoom,
  // an overlay toggle) must be visible without restarting the loop.
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  // The showElmInfo element-name line needs the element kinds, but the draw
  // loop must not restart when they change; a ref keeps the latest list
  // readable from the already-running loop.
  const elementsRef = useRef<ReturnType<typeof useStore.getState>['elements']>([]);
  elementsRef.current = useStore((s) => s.elements);
  const settings = useStore((s) => s.settings);
  const dark = useStore((s) => s.dark);
  // The paused view only applies while the simulation is stopped; resuming
  // snaps back to the live edge.
  const running = useStore((s) => s.running);
  // Watched so an undo or redo that force-clears the gesture flag mid-drag can
  // cancel the plot drag here; see the orphan check below.
  const scopeGesture = useStore((s) => s.scopeGesture);

  // Measure the canvas width and keep the geometry registry in step, so the
  // frame loop can size the engine ring without reading the DOM.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const measure = () => registerScopeWidth(scope.id, canvas.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(canvas);
    return () => {
      ro.disconnect();
      unregisterScopeWidth(scope.id);
      clearXYPersistence(scope.id);
      clearXYScale(scope.id);
    };
  }, [scope.id]);

  // The frame loop redraws every frame, so a first frame painted in the
  // fallback face is replaced as soon as Roboto lands; no document.fonts.ready
  // invalidation is needed.
  useEffect(() => {
    let raf = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const canvas = canvasRef.current;
      if (!canvas || !engine) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      const backing = backingStoreSize(w, h, dpr);
      if (canvas.width !== backing.width || canvas.height !== backing.height) {
        canvas.width = backing.width;
        canvas.height = backing.height;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawScope(
        ctx,
        engine,
        scopeRef.current,
        w,
        h,
        cursorRef.current,
        engine.time,
        settings.timeStep,
        dark,
        settings.decimalDigits,
        settings,
        // The Show Extended Info header draws the plotted element's full
        // getInfo lines, the same ones the hover box shows, so the two
        // surfaces cannot drift. Shared with the embedded 403 window and the
        // undocked window through one resolver.
        elmInfoResolver(elementsRef.current, engine),
        // The paused viewer's pan and zoom. While running the stored view is
        // ignored, so a resume shows live data without waiting for a reset.
        { view: running ? undefined : viewFor(scope.id) },
      );
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [engine, scope.id, settings, dark, running]);

  const canvasRect = () => canvasRef.current?.getBoundingClientRect();
  const size = () => {
    const canvas = canvasRef.current;
    return { w: canvas?.clientWidth ?? 0, h: canvas?.clientHeight ?? 0 };
  };
  const speed = scope.speed;
  const simTime = () => engine?.time ?? 0;
  // A paused pan in flight: the pointer, where it started, and the captured
  // column count frozen at press so a moving engine time cannot rescale it.
  const panRef = useRef<{
    pointerId: number;
    startX: number;
    startView: ScopeView;
    written: number;
  } | null>(null);
  // Ctrl+wheel accumulates separately from the time-base wheel so a vertical
  // zoom burst never triggers a speed change and vice versa.
  const ctrlWheelDeltaRef = useRef(0);

  const firstTraceIndex = (): number | undefined => {
    for (const plot of visiblePlotsOf(scope).filter(isDrawable)) {
      const index = engine?.scopeIndexOf(plot.id);
      if (index !== undefined) return index;
    }
    return undefined;
  };
  /** Captured columns in the first visible trace's ring. One crossing at the
   *  start of a pan or zoom gesture, never per frame. */
  const capturedColumns = (): number => {
    const index = firstTraceIndex();
    return index === undefined || !engine ? 0 : engine.scopeData(index).length / 2;
  };
  const activeView = () =>
    running ? DEFAULT_SCOPE_VIEW : viewFor(scope.id);
  /** The sim time at the canvas's right edge, moved back by a paused pan. */
  const drawTime = () => {
    const view = activeView();
    return isPanned(view) ? viewRightTime(simTime(), view, speed, settings.timeStep) : simTime();
  };
  /** Seconds per column for cursor conversions: the time base magnified by the
   *  paused view's zoom. */
  const timeSpeed = () => {
    const view = activeView();
    return isPanned(view) ? viewSpeed(view, speed) : speed;
  };
  const timeAtX = (
    x: number,
    w: number,
    anchor: { time: number } | null,
  ) => xToTime(x, drawTime(), w, timeSpeed(), settings.timeStep, anchor);

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return;
    const rect = canvasRect();
    if (!rect) return;
    const { w, h } = size();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const cursor = cursorRef.current;
    cursor.hover = true;
    cursor.mouseX = x;
    // The settings wheel's 36x36 corner box grabs the click, so it neither
    // drags a plot nor starts a time drag (Scope.java:557-563).
    if (inSettingsWheel(x, y, w, h)) {
      cursor.hoverSettingsWheel = true;
      settingsWheelPressRef.current = true;
      return;
    }
    // The horizontal dashed trigger level is draggable: a press within a few
    // pixels of it moves the level instead of starting a pan or a cursor.
    if (engine && scope.trigger.mode !== 'freeRun') {
      const lineY = triggerLineY(engine, scope, w, h);
      if (lineY !== null && Math.abs(y - lineY) <= 5) {
        triggerDragRef.current = true;
        dragPointerIdRef.current = e.pointerId;
        canvasRef.current?.setPointerCapture(e.pointerId);
        return;
      }
    }
    // Manual mode drags the selected plot's vertical position.
    if (scope.manualScale && engine) {
      // selectPlotAt returns an index into the visible-plot list, which the
      // showV/showI flags can shorten, so resolve through that list before
      // touching scope.plots (Scope.java:937-969).
      const visible = visiblePlotsOf(scope).filter(isDrawable);
      const plot = selectPlotAt(engine, scope, x, y, w, h);
      const target = plot >= 0 ? visible[plot] : undefined;
      if (target) {
        cursor.selectedPlot = plot;
        // Store the target by id: `plot` is a visible-list index, and the
        // full `scope.plots` list is longer when a plot is hidden, so reading
        // back through `scope.plots[selectedPlot]` would grab a different
        // (hidden) trace while this one stays put.
        cursor.dragPlotId = target.id;
        cursor.draggingPlotY = true;
        cursor.dragPlotYStart = y;
        cursor.dragPlotYInitial = target.manVPosition ?? 0;
        // Capture the pointer so moves keep arriving even if the cursor leaves
        // the canvas, then commit the pre-drag baseline once and let the moves
        // mutate without committing, like an element drag.
        dragPointerIdRef.current = e.pointerId;
        canvasRef.current?.setPointerCapture(e.pointerId);
        useStore.getState().beginScopeGesture();
        return;
      }
    }
    // While paused a plain drag pans the captured history. Shift+drag keeps
    // the two-cursor measurement, which is otherwise the running-mode drag.
    if (!running && !e.shiftKey) {
      panRef.current = {
        pointerId: e.pointerId,
        startX: x,
        startView: viewFor(scope.id),
        written: capturedColumns(),
      };
      canvasRef.current?.setPointerCapture(e.pointerId);
      cursor.dragStartTime = -1;
      return;
    }
    const anchor = engine ? triggerTimeAnchor(engine, scope, w) : null;
    cursor.dragStartTime = timeAtX(x, w, anchor);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = canvasRect();
    if (!rect) return;
    const { w, h } = size();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const cursor = cursorRef.current;
    cursor.hover = true;
    cursor.mouseX = x;
    cursor.hoverSettingsWheel = inSettingsWheel(x, y, w, h);
    if (triggerDragRef.current && engine) {
      const level = triggerLevelAtY(engine, scope, w, h, y);
      // Preview only: the store write on release is what rebuilds the engine,
      // so dragging across the capture does not wipe it.
      if (level !== null) cursor.triggerLevel = level;
      return;
    }
    const pan = panRef.current;
    if (pan && pan.pointerId === e.pointerId) {
      setScopeView(
        scope.id,
        panByPixels(pan.startView, x - pan.startX, w, pan.written),
      );
      return;
    }
    // The revert may land between two moves, before the effect above runs;
    // tear the orphaned drag down here rather than mutate past its baseline.
    if (cursor.draggingPlotY && !useStore.getState().scopeGesture) {
      endPointerInteraction();
      return;
    }
    if (cursor.draggingPlotY) {
      const maxy = Math.floor((h - 1) / 2);
      const next = dragPlotYPosition(cursor.dragPlotYInitial, y - cursor.dragPlotYStart, maxy);
      const plot = scope.plots.find((p) => p.id === cursor.dragPlotId);
      if (plot) useStore.getState().setPlotManPosition(plot.id, next);
      return;
    }
    const anchor = engine ? triggerTimeAnchor(engine, scope, w) : null;
    cursor.cursorTime = timeAtX(x, w, anchor);
  };

  /** Shared reset for the end of a pointer gesture: up, cancel and leave all
   *  drop the drag and wheel state. Reads only refs and the store, so it stays
   *  referentially stable for the effect below. */
  const endPointerInteraction = useCallback(() => {
    const cursor = cursorRef.current;
    cursor.draggingPlotY = false;
    cursor.dragPlotId = -1;
    // A trigger-level drag commits once, on release: one undo entry and one
    // engine rebuild for the whole gesture.
    if (triggerDragRef.current && cursor.triggerLevel !== null) {
      useStore.getState().setScopeTrigger(scopeRef.current.id, { level: cursor.triggerLevel });
    }
    cursor.triggerLevel = null;
    triggerDragRef.current = false;
    cursor.dragStartTime = -1;
    cursor.hoverSettingsWheel = false;
    settingsWheelPressRef.current = false;
    // Release the capture taken at drag start, wherever the pointer ended up.
    const pid = dragPointerIdRef.current;
    if (pid !== null) {
      canvasRef.current?.releasePointerCapture(pid);
      dragPointerIdRef.current = null;
    }
    const pan = panRef.current;
    if (pan !== null) {
      canvasRef.current?.releasePointerCapture(pan.pointerId);
      panRef.current = null;
    }
    // A plot-Y drag ends here, closing its single undo entry. A wheel burst is
    // ended by its own idle timer, so this is a no-op for those.
    useStore.getState().endScopeGesture();
  }, []);

  // An undo or redo mid-drag reverts state and force-clears the gesture flag,
  // because a live gesture cannot survive a revert. Dragging on would then
  // commit per move against the stale press-time anchor, splitting one gesture
  // into many entries, so an orphaned drag cancels like a pointer cancel.
  useEffect(() => {
    if (!scopeGesture && cursorRef.current.draggingPlotY) endPointerInteraction();
  }, [scopeGesture, endPointerInteraction]);

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const pressedWheel = settingsWheelPressRef.current;
    endPointerInteraction();
    // Only the primary button opens the dialog, matching upstream's mouse-down
    // button guard (MouseManager.java:1071-1072), and only when the press
    // landed on the wheel: a gesture that started elsewhere must not open it
    // (MouseManager.java:1104-1117).
    if (e.button !== 0 || !pressedWheel) return;
    useStore.getState().openScopeProperties(scope.id);
  };

  const onPointerCancel = () => {
    // A cancelled gesture never opens the dialog, but it still ends the drag.
    endPointerInteraction();
  };

  const onPointerLeave = () => {
    const cursor = cursorRef.current;
    cursor.hover = false;
    cursor.cursorTime = -1;
    cursor.dragStartTime = -1;
    cursor.hoverSettingsWheel = false;
    settingsWheelPressRef.current = false;
    // With pointer capture set at drag start, a plot-Y drag keeps receiving
    // moves and ends on pointer-up, so leaving the canvas needs no gesture
    // flag handling here.
  };

  // A wheel burst is one undo gesture: open it on the first zoom of the burst
  // and keep it open until the burst goes idle, so the whole burst is one
  // entry rather than one per threshold crossing.
  const extendWheelGesture = () => {
    const st = useStore.getState();
    if (!st.scopeGesture) st.beginScopeGesture();
    if (wheelGestureTimerRef.current !== null) clearTimeout(wheelGestureTimerRef.current);
    wheelGestureTimerRef.current = window.setTimeout(() => {
      // Only end the wheel gesture: a plot-Y drag is still in flight and must
      // keep its single undo entry until pointer-up releases it.
      if (!cursorRef.current.draggingPlotY) useStore.getState().endScopeGesture();
      wheelGestureTimerRef.current = null;
    }, 500);
  };

  const onWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const rect = canvasRect();
    const { w, h } = size();
    const x = rect ? e.clientX - rect.left : 0;
    const y = rect ? e.clientY - rect.top : 0;
    // A wheel-up notch (negative deltaY) zooms in and a down notch out.
    const notch = (delta: number): 1 | -1 | 0 => (delta < 0 ? 1 : delta > 0 ? -1 : 0);

    // Ctrl+wheel is vertical zoom on the plot under the pointer, switching to
    // manual scale so the zoomed units per division are what the grid draws.
    if (e.ctrlKey || e.metaKey) {
      ctrlWheelDeltaRef.current += e.deltaY * settings.wheelSensitivity;
      if (Math.abs(ctrlWheelDeltaRef.current) <= 5) return;
      const dir = notch(ctrlWheelDeltaRef.current);
      ctrlWheelDeltaRef.current = 0;
      if (dir === 0 || !engine) return;
      const visible = visiblePlotsOf(scope).filter(isDrawable);
      const plot = selectPlotAt(engine, scope, x, y, w, h);
      const target = plot >= 0 ? visible[plot] : undefined;
      if (!target) return;
      extendWheelGesture();
      const divisions = scope.manDivisions || MAN_DIVISIONS;
      const seed = (value: ScopePlot['value']) =>
        seedManScale(scaleStateFor(scope.id, value).gridMax, divisions);
      if (!scope.manualScale) {
        // Entering manual mode seeds every trace that has no hand-set scale,
        // exactly like the properties dialog's Manual choice.
        for (const p of scope.plots) {
          if (p.manScale === null) useStore.getState().setPlotManScale(p.id, seed(p.value));
        }
        useStore.getState().setScopeFlags(scope.id, { manualScale: true, maxScale: false });
      }
      const current = target.manScale ?? seed(target.value);
      useStore.getState().setPlotManScale(target.id, wheelManScale(current, dir));
      return;
    }

    // Paused, the wheel magnifies time about the pointer instead of changing
    // the saved time base, so the capture's history stays inspectable.
    if (!running) {
      wheelDeltaRef.current += e.deltaY * settings.wheelSensitivity;
      if (Math.abs(wheelDeltaRef.current) <= 5) return;
      const dir = notch(wheelDeltaRef.current);
      wheelDeltaRef.current = 0;
      if (dir === 0) return;
      const factor = dir > 0 ? 1.25 : 0.8;
      setScopeView(
        scope.id,
        zoomAboutCursor(viewFor(scope.id), factor, x, w, capturedColumns()),
      );
      return;
    }

    // Scrolling down slows the time base (zooms out), matching upstream's
    // onMouseWheel -> slowDown/speedUp (Scope.java:1378-1388). Deltas are
    // scaled by the wheel sensitivity and accumulate past a +-5 threshold so
    // trackpad micro-deltas do not zoom every event.
    wheelDeltaRef.current += e.deltaY * settings.wheelSensitivity;
    if (wheelDeltaRef.current > 5) {
      wheelDeltaRef.current = 0;
      extendWheelGesture();
      useStore.getState().setScopeSpeed(scope.id, speed * 2);
    } else if (wheelDeltaRef.current < -5) {
      wheelDeltaRef.current = 0;
      extendWheelGesture();
      useStore.getState().setScopeSpeed(scope.id, speed / 2);
    }
  };

  // Resuming the simulation snaps back to the live edge: a pan that stayed
  // would hide the data the run is producing. A fresh capture (reset) also
  // starts live.
  useEffect(() => {
    if (running) {
      resetScopeView(scope.id);
      wheelDeltaRef.current = 0;
    }
  }, [running, scope.id]);

  // An unmount (panel closed, circuit reloaded) during a drag or wheel burst
  // must not strand the gesture flag, so the cleanup ends the gesture and
  // clears the wheel timer.
  useEffect(() => {
    return () => {
      if (wheelGestureTimerRef.current !== null) clearTimeout(wheelGestureTimerRef.current);
      useStore.getState().endScopeGesture();
    };
  }, []);

  const onContextMenu = (e: React.MouseEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const rect = canvasRect();
    if (!rect || !engine) return;
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const { w, h } = size();
    // selectPlotAt indexes the visible-plot list, like the drag path, so the
    // Remove Plot target is resolved through it too. No fallback: a click in
    // the margin names no plot, and -1 matches nothing so the menu item sits
    // disabled instead of aiming at a plot the user never pointed at.
    const visible = visiblePlotsOf(scope).filter(isDrawable);
    const plot = selectPlotAt(engine, scope, x, y, w, h);
    const target = plot >= 0 ? visible[plot] : undefined;
    useStore.getState().openScopeMenu(e.clientX, e.clientY, scope.id, target?.id ?? -1);
  };

  return (
    <div className="scope">
      <canvas
        ref={canvasRef}
        className="scope-canvas"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        // A capture lost without a pointerup must still end a plot-Y drag,
        // or its gesture flag would merge later edits into one undo entry.
        onLostPointerCapture={() => {
          if (dragPointerIdRef.current !== null || panRef.current !== null) endPointerInteraction();
        }}
        onPointerLeave={onPointerLeave}
        onWheel={onWheel}
        onContextMenu={onContextMenu}
      />
      {!floating && (
        <>
          {/* The drag grip: grab it to move the scope to another column, a
              new column, or out over the schematic. A div, not a button: it
              has no click action, and keyboard users have the menu rows. */}
          <div
            className="scope-grip"
            title="Drag to move this scope"
            aria-hidden="true"
            onPointerDown={(e) => onGrip?.(scope.id, e)}
          >
            ⠿
          </div>
          <button
            type="button"
            className="scope-undock"
            aria-label="Float scope"
            onClick={() => useStore.getState().floatScope(scope.id)}
            title="Float over the schematic"
          >
            ⧉
          </button>
          <button
            type="button"
            className="scope-close"
            aria-label="Remove scope"
            onClick={() => useStore.getState().removeScope(scope.id)}
            title="Remove scope"
          >
            ×
          </button>
        </>
      )}
    </div>
  );
}
