/**
 * The schematic view: renders the circuit, runs the animation loop that drives
 * the engine, and handles all mouse editing.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { SimEngine } from '../engine/simulator';
import { defFor, postsOf } from '../model/registry';
import { GRID_SIZE, type CircuitElement, type DrawContext, type Point } from '../model/types';
import { dotPhaseStep, TOO_FAST, wrapPhase } from '../render/dots';
import { makeTheme } from '../render/draw';
import { makeElement, snap, useStore } from '../state/store';

/** How close the pointer must be to an element to hit it, in circuit units. */
const HIT_TOLERANCE = 8;

interface Props {
  engine: SimEngine | null;
}

type Drag =
  | { mode: 'none' }
  | { mode: 'place'; start: Point; id: number }
  | { mode: 'move'; last: Point; moved: boolean }
  | { mode: 'select'; start: Point; current: Point }
  | { mode: 'pan'; startClient: Point; startView: Point };

/** Shortest distance from `p` to the segment `a`-`b`. */
function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Distance from a point to an element, measured against all of its limbs. */
function distanceToElement(p: Point, e: CircuitElement): number {
  const posts = postsOf(e);
  if (posts.length <= 1) {
    return Math.hypot(p.x - e.x1, p.y - e.y1);
  }
  const body = distanceToSegment(p, { x: e.x1, y: e.y1 }, { x: e.x2, y: e.y2 });
  // Multi-terminal parts have limbs off the main axis, so also test each
  // terminal against the body line.
  const limbs = posts.map((q) => distanceToSegment(q, { x: e.x1, y: e.y1 }, { x: e.x2, y: e.y2 }));
  const nearPost = Math.min(...posts.map((q) => Math.hypot(p.x - q.x, p.y - q.y)));
  void limbs;
  return Math.min(body, nearPost);
}

export function CircuitCanvas({ engine }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragRef = useRef<Drag>({ mode: 'none' });
  const dotPhaseRef = useRef(new Map<number, number>());
  const lastFrameRef = useRef(performance.now());
  const loadedRevision = useRef(-1);
  const appliedParamRevision = useRef(-1);
  const [, forceRender] = useState(0);

  // Reading the store through refs keeps the animation loop off React's
  // render path; a 60 Hz setState would be ruinous.
  const stateRef = useRef(useStore.getState());
  useEffect(() => useStore.subscribe((s) => (stateRef.current = s)), []);

  const toCircuit = useCallback((clientX: number, clientY: number): Point => {
    const canvas = canvasRef.current;
    const { view } = stateRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    return {
      x: (clientX - rect.left) / view.scale + view.x,
      y: (clientY - rect.top) / view.scale + view.y,
    };
  }, []);

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
  }, []);

  // ---- the frame loop -----------------------------------------------------
  useEffect(() => {
    let raf = 0;

    // This loop redraws every frame, so a first frame painted in the fallback
    // face is replaced as soon as Roboto lands; no document.fonts.ready
    // invalidation is needed. If this ever becomes a draw-on-demand renderer,
    // the redraw has to be triggered from document.fonts.ready.
    const frame = () => {
      raf = requestAnimationFrame(frame);
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const now = performance.now();
      const elapsed = Math.min(0.1, (now - lastFrameRef.current) / 1000);
      lastFrameRef.current = now;

      const state = stateRef.current;
      const { elements, settings, view, selectedIds, dark, running, scopes } = state;

      // Reload the engine whenever the netlist changed.
      if (engine && loadedRevision.current !== state.revision) {
        loadedRevision.current = state.revision;
        // A new netlist invalidates every element's accumulated phase, and
        // clearing the map stops it growing across circuit loads.
        dotPhaseRef.current.clear();
        const err = engine.setCircuit(elements, settings, scopes);
        const warnings = err ? [err] : engine.warnings();
        useStore.getState().setProblem(warnings.length ? warnings.join(' ') : null);
        // The reload serialised the current elements, so any queued value
        // edits are already in effect. Mark them consumed and drop the queue,
        // or they would be replayed against the fresh circuit below.
        appliedParamRevision.current = state.paramRevision;
        if (state.pendingParams.size > 0 || state.pendingStates.size > 0) {
          state.clearPending();
        }
      }

      // Apply value-only edits through the engine's fast paths so the clock
      // and reactive-element state survive slider drags and switch throws.
      if (engine && appliedParamRevision.current !== state.paramRevision) {
        appliedParamRevision.current = state.paramRevision;
        let forceReload = false;
        for (const { id, name, value } of state.pendingParams.values()) {
          if (!engine.setParam(id, name, value)) forceReload = true;
        }
        for (const [id, s] of state.pendingStates) {
          if (!engine.setState(id, s)) forceReload = true;
        }
        if (forceReload) {
          // A param the engine cannot patch live (unknown id or name) would
          // otherwise read as a dead slider; rebuild the whole circuit.
          dotPhaseRef.current.clear();
          const err = engine.setCircuit(elements, settings, scopes);
          const warnings = err ? [err] : engine.warnings();
          useStore.getState().setProblem(warnings.length ? warnings.join(' ') : null);
        }
        state.clearPending();
      }

      // Advance the simulation.
      let currents: Float64Array | null = null;
      let nodeVoltages: Float64Array | null = null;
      let elementNodes: Uint32Array | null = null;
      if (engine) {
        if (running) {
          const stats = engine.run(settings.stepsPerFrame);
          if (!stats.converged && stats.error) {
            useStore.getState().setProblem(stats.error);
          }
        }
        currents = engine.elementCurrents();
        nodeVoltages = engine.nodeVoltages();
        elementNodes = engine.elementNodes();
      }

      // ---- render ----
      const dpr = window.devicePixelRatio || 1;
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
        canvas.width = width * dpr;
        canvas.height = height * dpr;
      }

      const theme = makeTheme(dark);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = theme.background;
      ctx.fillRect(0, 0, width, height);
      ctx.save();
      ctx.scale(view.scale, view.scale);
      ctx.translate(-view.x, -view.y);

      if (settings.showGrid && view.scale > 0.4) {
        drawGrid(ctx, view.x, view.y, width / view.scale, height / view.scale, theme.grid);
      }

      for (const e of elements) {
        const def = defFor(e.kind);
        if (!def) continue;

        const idx = engine?.indexOf(e.id);
        const offset = engine?.postOffset(e.id);
        const posts = def.posts(e);
        const voltages = posts.map((_, i) => {
          if (!nodeVoltages || !elementNodes || offset === undefined) return 0;
          const node = elementNodes[offset + i];
          return node === undefined ? 0 : (nodeVoltages[node] ?? 0);
        });
        const current = idx !== undefined && currents ? (currents[idx] ?? 0) : 0;

        // Phase is integrated per element so changing the speed or the current
        // mid-run cannot teleport the dots. Only advance while running, so a
        // pause freezes them in place.
        const step = dotPhaseStep(current, settings.currentSpeed, elapsed);
        const phase =
          step === TOO_FAST ? TOO_FAST : wrapPhase((dotPhaseRef.current.get(e.id) ?? 0) + step);
        if (running) dotPhaseRef.current.set(e.id, phase === TOO_FAST ? 0 : phase);

        const g: DrawContext = {
          ctx,
          theme,
          voltages,
          current,
          voltage: voltages.length >= 2 ? voltages[0] - voltages[1] : (voltages[0] ?? 0),
          dotPhase: phase,
          showCurrent: settings.showCurrent,
          showValues: settings.showValues,
          showVoltageColor: settings.showVoltageColor,
          selected: selectedIds.includes(e.id),
          voltageRange: settings.voltageRange,
          scale: view.scale,
        };
        def.draw(g, e);

        // Terminal dots make it obvious where things connect.
        ctx.fillStyle = theme.wire;
        for (const p of posts) {
          ctx.beginPath();
          ctx.arc(p.x, p.y, 1.8, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      // Rubber-band selection rectangle.
      const drag = dragRef.current;
      if (drag.mode === 'select') {
        ctx.strokeStyle = theme.selection;
        ctx.setLineDash([4, 3]);
        ctx.lineWidth = 1;
        ctx.strokeRect(
          Math.min(drag.start.x, drag.current.x),
          Math.min(drag.start.y, drag.current.y),
          Math.abs(drag.current.x - drag.start.x),
          Math.abs(drag.current.y - drag.start.y),
        );
        ctx.setLineDash([]);
      }

      ctx.restore();
    };

    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [engine]);

  // ---- pointer handling ---------------------------------------------------
  const onPointerDown = (ev: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    canvas?.setPointerCapture(ev.pointerId);
    const state = useStore.getState();
    const p = toCircuit(ev.clientX, ev.clientY);

    // Middle button, or space held, pans.
    if (ev.button === 1 || ev.shiftKey) {
      dragRef.current = {
        mode: 'pan',
        startClient: { x: ev.clientX, y: ev.clientY },
        startView: { x: state.view.x, y: state.view.y },
      };
      return;
    }

    if (state.tool) {
      const x = state.settings.snapToGrid ? snap(p.x) : Math.round(p.x);
      const y = state.settings.snapToGrid ? snap(p.y) : Math.round(p.y);
      const def = defFor(state.tool);
      const len = (def?.defaultLength ?? 0) * GRID_SIZE;
      const id = state.addElement(makeElement(state.tool, x, y, x + len, y));
      dragRef.current = { mode: 'place', start: { x, y }, id };
      state.select([id]);
      return;
    }

    const hit = hitTest(p);
    if (hit) {
      const def = defFor(hit.kind);
      // In run mode, clicking an interactive part operates it rather than
      // selecting it.
      if (def?.interactive && state.running && !ev.altKey) {
        const throwCount = Math.max(2, hit.params.throwCount ?? 2);
        const next = ((hit.state ?? 0) + 1) % (hit.kind === 'switch' ? 2 : throwCount);
        state.setElementState(hit.id, next);
        dragRef.current = { mode: 'none' };
        return;
      }
      if (!state.selectedIds.includes(hit.id)) {
        state.select(ev.ctrlKey ? [...state.selectedIds, hit.id] : [hit.id]);
      }
      state.commit();
      dragRef.current = { mode: 'move', last: p, moved: false };
      return;
    }

    state.select([]);
    dragRef.current = { mode: 'select', start: p, current: p };
  };

  const onPointerMove = (ev: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    if (drag.mode === 'none') return;
    const state = useStore.getState();
    const p = toCircuit(ev.clientX, ev.clientY);

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
        const x = state.settings.snapToGrid ? snap(p.x) : Math.round(p.x);
        const y = state.settings.snapToGrid ? snap(p.y) : Math.round(p.y);
        state.updateElement(drag.id, { x2: x, y2: y });
        break;
      }
      case 'move': {
        const gx = state.settings.snapToGrid ? snap(p.x) - snap(drag.last.x) : p.x - drag.last.x;
        const gy = state.settings.snapToGrid ? snap(p.y) - snap(drag.last.y) : p.y - drag.last.y;
        if (gx !== 0 || gy !== 0) {
          state.moveElements(state.selectedIds, gx, gy);
          dragRef.current = { mode: 'move', last: p, moved: true };
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
      const x0 = Math.min(drag.start.x, p.x);
      const x1 = Math.max(drag.start.x, p.x);
      const y0 = Math.min(drag.start.y, p.y);
      const y1 = Math.max(drag.start.y, p.y);
      const inside = state.elements
        .filter((e) => postsOf(e).every((q) => q.x >= x0 && q.x <= x1 && q.y >= y0 && q.y <= y1))
        .map((e) => e.id);
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
      }
      // Placing one element then returning to select mode matches how people
      // actually build a schematic.
      state.setTool(null);
    }

    dragRef.current = { mode: 'none' };
    canvasRef.current?.releasePointerCapture(ev.pointerId);
    forceRender((n) => n + 1);
  };

  const onWheel = (ev: React.WheelEvent<HTMLCanvasElement>) => {
    const state = useStore.getState();
    const p = toCircuit(ev.clientX, ev.clientY);
    const factor = ev.deltaY < 0 ? 1.12 : 1 / 1.12;
    const scale = Math.max(0.15, Math.min(6, state.view.scale * factor));
    // Zoom about the pointer so the point under the cursor stays put.
    state.setView({
      scale,
      x: p.x - (p.x - state.view.x) * (state.view.scale / scale),
      y: p.y - (p.y - state.view.y) * (state.view.scale / scale),
    });
  };

  return (
    <canvas
      ref={canvasRef}
      className="circuit-canvas"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onWheel={onWheel}
      onContextMenu={(e) => e.preventDefault()}
    />
  );
}

function drawGrid(
  ctx: CanvasRenderingContext2D,
  originX: number,
  originY: number,
  width: number,
  height: number,
  color: string,
): void {
  const startX = Math.floor(originX / GRID_SIZE) * GRID_SIZE;
  const startY = Math.floor(originY / GRID_SIZE) * GRID_SIZE;
  ctx.fillStyle = color;
  for (let x = startX; x < originX + width; x += GRID_SIZE) {
    for (let y = startY; y < originY + height; y += GRID_SIZE) {
      ctx.fillRect(x, y, 1, 1);
    }
  }
}
