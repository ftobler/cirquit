/**
 * Docked oscilloscope traces.
 *
 * The engine samples every timestep and aggregates into min/max columns, so
 * what is drawn here is the true waveform envelope rather than a 60 Hz
 * subsample of it. Each scope is a panel with any number of plots; scopes
 * sharing a stacking position render into one column.
 */

import { useEffect, useRef } from 'react';
import type { Scope, SimEngine } from '../engine/simulator';
import { defFor } from '../model/registry';
import {
  registerScopeWidth,
  unregisterScopeWidth,
  xToTime,
  inSettingsWheel,
} from '../scope/geometry';
import {
  clearXYPersistence,
  drawScope,
  emptyCursor,
  isDrawable,
  selectPlotAt,
  triggerTimeAnchor,
  visiblePlotsOf,
  type ScopeCursor,
} from '../scope/draw';
import { clearXYScale, dragPlotYPosition } from '../scope/scale';
import { useStore } from '../state/store';
import { ScopeMenu } from './ScopeMenu';
import { ScopeProperties } from './ScopeProperties';
import { SimInfoPanel } from './SimInfoPanel';

interface Props {
  engine: SimEngine | null;
}

function ScopeTraceCanvas({ engine, scope }: { engine: SimEngine | null; scope: Scope }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cursorRef = useRef<ScopeCursor>(emptyCursor());
  // Whether the pointer press landed on the settings wheel. Only a press that
  // starts there opens the dialog on release, so a plot-Y or time drag that
  // began elsewhere and ends in the corner box does not.
  const settingsWheelPressRef = useRef(false);
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
      if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
        canvas.width = w * dpr;
        canvas.height = h * dpr;
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
        (id: number) => elementsRef.current.find((e) => e.id === id)?.kind ?? null,
      );
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [engine, scope.id, settings, dark]);

  const canvasRect = () => canvasRef.current?.getBoundingClientRect();
  const size = () => {
    const canvas = canvasRef.current;
    return { w: canvas?.clientWidth ?? 0, h: canvas?.clientHeight ?? 0 };
  };
  const speed = scope.speed;
  const simTime = () => engine?.time ?? 0;

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
    const anchor = engine ? triggerTimeAnchor(engine, scope, w) : null;
    cursor.dragStartTime = xToTime(x, simTime(), w, speed, settings.timeStep, anchor);
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
    if (cursor.draggingPlotY) {
      const maxy = Math.floor((h - 1) / 2);
      const next = dragPlotYPosition(cursor.dragPlotYInitial, y - cursor.dragPlotYStart, maxy);
      const plot = scope.plots.find((p) => p.id === cursor.dragPlotId);
      if (plot) useStore.getState().setPlotManPosition(plot.id, next);
      return;
    }
    const anchor = engine ? triggerTimeAnchor(engine, scope, w) : null;
    cursor.cursorTime = xToTime(x, simTime(), w, speed, settings.timeStep, anchor);
  };

  /** Shared reset for the end of a pointer gesture: up, cancel and leave all
   *  drop the drag and wheel state. */
  const endPointerInteraction = () => {
    const cursor = cursorRef.current;
    cursor.draggingPlotY = false;
    cursor.dragPlotId = -1;
    cursor.dragStartTime = -1;
    cursor.hoverSettingsWheel = false;
    settingsWheelPressRef.current = false;
    // Release the capture taken at drag start, wherever the pointer ended up.
    const pid = dragPointerIdRef.current;
    if (pid !== null) {
      canvasRef.current?.releasePointerCapture(pid);
      dragPointerIdRef.current = null;
    }
    // A plot-Y drag ends here, closing its single undo entry. A wheel burst is
    // ended by its own idle timer, so this is a no-op for those.
    useStore.getState().endScopeGesture();
  };

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
    // Remove Plot target is resolved through it too.
    const visible = visiblePlotsOf(scope).filter(isDrawable);
    const plot = selectPlotAt(engine, scope, x, y, w, h);
    const target = plot >= 0 ? visible[plot] : undefined;
    const plotId = target?.id ?? scope.plots[0].id;
    useStore.getState().openScopeMenu(e.clientX, e.clientY, scope.id, plotId);
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
        onPointerLeave={onPointerLeave}
        onWheel={onWheel}
        onContextMenu={onContextMenu}
      />
      <button
        type="button"
        className="scope-close"
        aria-label="Remove scope"
        onClick={() => useStore.getState().removeScope(scope.id)}
        title="Remove scope"
      >
        ×
      </button>
    </div>
  );
}

/** Name for a plot's element, used in CSV headers and scope titles. */
function elementNameOf(
  elements: ReturnType<typeof useStore.getState>['elements'],
  elementId: number,
): string {
  const element = elements.find((e) => e.id === elementId);
  return element ? (defFor(element.kind)?.label ?? element.kind) : 'missing';
}

export function ScopePanel({ engine }: Props) {
  const scopes = useStore((s) => s.scopes);
  const elements = useStore((s) => s.elements);
  const scopeProperties = useStore((s) => s.scopeProperties);
  const closeScopeProperties = useStore((s) => s.closeScopeProperties);

  if (scopes.length === 0) return null;

  // Group panels by stacking position; each position is one flex column.
  const positions = [...new Set(scopes.map((x) => x.position))].sort((a, b) => a - b);

  return (
    <>
      <div className="bottom-strip">
        <div className="scopes">
          {positions.map((pos) => (
            <div key={pos} className="scope-col">
              {scopes
                .filter((x) => x.position === pos)
                .map((scope) => (
                  <ScopeTraceCanvas key={scope.id} engine={engine} scope={scope} />
                ))}
            </div>
          ))}
        </div>
        <SimInfoPanel engine={engine} />
      </div>
      <ScopeMenu engine={engine} nameOf={(plot) => elementNameOf(elements, plot.elementId)} />
      {scopeProperties !== null && (
        <ScopeProperties scopeId={scopeProperties} onClose={closeScopeProperties} />
      )}
    </>
  );
}
