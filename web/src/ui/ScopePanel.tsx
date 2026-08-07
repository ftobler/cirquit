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
import { registerScopeWidth, unregisterScopeWidth, xToTime } from '../scope/geometry';
import {
  clearXYPersistence,
  drawScope,
  emptyCursor,
  selectPlotAt,
  triggerTimeAnchor,
  type ScopeCursor,
} from '../scope/draw';
import { clearXYScale, dragPlotYPosition } from '../scope/scale';
import { useStore } from '../state/store';
import { ScopeMenu } from './ScopeMenu';
import { ScopeProperties } from './ScopeProperties';

interface Props {
  engine: SimEngine | null;
}

function ScopeTraceCanvas({ engine, scope }: { engine: SimEngine | null; scope: Scope }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cursorRef = useRef<ScopeCursor>(emptyCursor());
  // Wheel deltas accumulate and only zoom past a threshold, so trackpad
  // micro-deltas do not hammer the time base (Scope.java:1378-1388).
  const wheelDeltaRef = useRef(0);
  // The draw loop reads the scope every frame, so a fresh copy (a speed zoom,
  // an overlay toggle) must be visible without restarting the loop.
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const settings = useStore((s) => s.settings);

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
      drawScope(ctx, engine, scopeRef.current, w, h, cursorRef.current, engine.time, settings.timeStep);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [engine, scope.id, settings.timeStep]);

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
    // Manual mode drags the selected plot's vertical position.
    if (scope.manualScale && engine) {
      const plot = selectPlotAt(engine, scope, x, y, w, h);
      if (plot >= 0) {
        cursor.selectedPlot = plot;
        cursor.draggingPlotY = true;
        cursor.dragPlotYStart = y;
        cursor.dragPlotYInitial = scope.plots[plot].manVPosition ?? 0;
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
    if (cursor.draggingPlotY) {
      const maxy = Math.floor((h - 1) / 2);
      const next = dragPlotYPosition(cursor.dragPlotYInitial, y - cursor.dragPlotYStart, maxy);
      const plot = scope.plots[cursor.selectedPlot];
      if (plot) useStore.getState().setPlotManPosition(plot.id, next);
      return;
    }
    const anchor = engine ? triggerTimeAnchor(engine, scope, w) : null;
    cursor.cursorTime = xToTime(x, simTime(), w, speed, settings.timeStep, anchor);
  };

  const onPointerUp = () => {
    const cursor = cursorRef.current;
    cursor.draggingPlotY = false;
    cursor.dragStartTime = -1;
  };

  const onPointerLeave = () => {
    const cursor = cursorRef.current;
    cursor.hover = false;
    cursor.cursorTime = -1;
    cursor.dragStartTime = -1;
  };

  const onWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    // Scrolling down slows the time base (zooms out), matching upstream's
    // onMouseWheel -> slowDown/speedUp (Scope.java:1378-1388). Deltas
    // accumulate past a +-5 threshold so trackpad micro-deltas do not zoom
    // every event.
    wheelDeltaRef.current += e.deltaY;
    if (wheelDeltaRef.current > 5) {
      wheelDeltaRef.current = 0;
      useStore.getState().setScopeSpeed(scope.id, speed * 2);
    } else if (wheelDeltaRef.current < -5) {
      wheelDeltaRef.current = 0;
      useStore.getState().setScopeSpeed(scope.id, speed / 2);
    }
  };

  const onContextMenu = (e: React.MouseEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const rect = canvasRect();
    if (!rect || !engine) return;
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const { w, h } = size();
    const plot = selectPlotAt(engine, scope, x, y, w, h);
    const plotId = plot >= 0 ? scope.plots[plot].id : scope.plots[0].id;
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
        onPointerCancel={onPointerUp}
        onPointerLeave={onPointerLeave}
        onWheel={onWheel}
        onContextMenu={onContextMenu}
      />
      <button
        type="button"
        className="scope-close"
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
      <ScopeMenu engine={engine} nameOf={(plot) => elementNameOf(elements, plot.elementId)} />
      {scopeProperties !== null && (
        <ScopeProperties scopeId={scopeProperties} onClose={closeScopeProperties} />
      )}
    </>
  );
}
