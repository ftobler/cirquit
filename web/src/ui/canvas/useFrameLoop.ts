import { useEffect, useRef } from 'react';
import type { SimEngine } from '../../engine/simulator';
import { scopeParamsFingerprint } from '../../engine/simulator';
import { defFor } from '../../model/registry';
import type { DrawContext, Point } from '../../model/types';
import { dotPhaseStep, TOO_FAST, wrapPhase } from '../../render/dots';
import { makeTheme } from '../../render/draw';
import { drawGrid } from '../../render/grid';
import { invalidDropPoint } from '../../render/geometry';
import { postDotPoints, shouldDrawDot } from '../../render/junction';
import { scopeWidth } from '../../scope/geometry';
import { pruneScaleStates, pruneXYScales } from '../../scope/scale';
import { gridSize } from '../../state/helpers';
import { useStore } from '../../state/store';
import { useStoreRef } from './useStoreRef';
import type { Drag } from './useCanvasInteractions';

/** Resolves each scope's measured canvas width, for engine ring sizing. */
const widthOf = (id: number): number | undefined => scopeWidth(id);

export function useFrameLoop(
  canvasRef: React.RefObject<HTMLCanvasElement | null>,
  engine: SimEngine | null,
  dragRef: React.MutableRefObject<Drag>,
  pointerRef: React.MutableRefObject<Point | null>,
): void {
  const dotPhaseRef = useRef(new Map<number, number>());
  const lastFrameRef = useRef(performance.now());
  const loadedRevision = useRef(-1);
  const appliedParamRevision = useRef(-1);
  const appliedScopeFp = useRef('');
  const stateRef = useStoreRef();

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
      const { elements, settings, view, selectedIds, running, scopes, hoveredId, highlightedNode } =
        state;

      // Drop sticky auto-scale state for plots that no longer exist (a removed
      // scope), keeping the map bounded across a session.
      pruneScaleStates(scopes.flatMap((s) => s.plots.map((p) => p.id)));
      pruneXYScales(scopes.map((s) => s.id));

      // Reload the engine whenever the netlist changed.
      if (engine && loadedRevision.current !== state.revision) {
        loadedRevision.current = state.revision;
        // A new netlist invalidates every element's accumulated phase, and
        // clearing the map stops it growing across circuit loads.
        dotPhaseRef.current.clear();
        const err = engine.setCircuit(elements, settings, scopes, widthOf);
        const warnings = err ? [err] : engine.warnings();
        useStore.getState().setProblem(warnings.length ? warnings.join(' ') : null);
        // The reload serialised the current elements, so any queued value
        // edits are already in effect. Mark them consumed and drop the queue,
        // or they would be replayed against the fresh circuit below.
        appliedParamRevision.current = state.paramRevision;
        appliedScopeFp.current = scopeParamsFingerprint(scopes, widthOf);
        if (state.pendingParams.size > 0 || state.pendingStates.size > 0) {
          state.clearPending();
        }
      }

      // Scope capture params (speed zoom, window resize) change through the
      // engine's fast path, never through a rebuild, so the clock survives.
      // The fingerprint is compared every frame so a ResizeObserver width
      // change is picked up without any store action.
      if (engine) {
        const fp = scopeParamsFingerprint(scopes, widthOf);
        if (fp !== appliedScopeFp.current) {
          appliedScopeFp.current = fp;
          if (!engine.applyScopeParams(scopes, settings, widthOf)) {
            // A trace index out of range means the last setCircuit failed;
            // force the reload branch next frame.
            loadedRevision.current = -1;
          }
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
          const err = engine.setCircuit(elements, settings, scopes, widthOf);
          const warnings = err ? [err] : engine.warnings();
          useStore.getState().setProblem(warnings.length ? warnings.join(' ') : null);
        }
        state.clearPending();
      }

      // Advance the simulation.
      let currents: Float64Array | null = null;
      let nodeVoltages: Float64Array | null = null;
      let elementNodes: Uint32Array | null = null;
      let values: Float64Array | null = null;
      if (engine) {
        if (running) {
          const stats = engine.run(settings.stepsPerFrame);
          if (!stats.converged && stats.error) {
            // Name the elements that refused to settle: the engine only
            // crosses the typed-array boundary with ids, and the UI owns the
            // element metadata to resolve them.
            const names = stats.failingElementIds
              .map((id) => {
                const e = elements.find((el) => el.id === id);
                return e ? `${e.kind} (${id})` : `id ${id}`;
              })
              .join(', ');
            useStore.getState().setProblem(
              names ? `${stats.error}; not settled: ${names}` : stats.error,
            );
          }
        }
        currents = engine.elementCurrents();
        nodeVoltages = engine.nodeVoltages();
        elementNodes = engine.elementNodes();
        values = engine.elementValues();
      }

      // ---- render ----
      const dpr = window.devicePixelRatio || 1;
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
        canvas.width = width * dpr;
        canvas.height = height * dpr;
      }

      const theme = makeTheme(state.dark, state.settings);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = theme.background;
      ctx.fillRect(0, 0, width, height);
      ctx.save();
      ctx.scale(view.scale, view.scale);
      ctx.translate(-view.x, -view.y);

      const grid = gridSize(settings);
      if (settings.showGrid && view.scale > 0.4) {
        drawGrid(ctx, view.x, view.y, width / view.scale, height / view.scale, theme.grid, grid);
      }

      // The crosshair is a drawn alignment guide through the grid-snapped
      // pointer, not the CSS cursor shape (UIManager.java:719-726). The theme
      // grid colour keeps it readable in both themes. The stored pointer is in
      // canvas-relative client pixels and is re-projected through the current
      // view here, so a keyboard zoom or Center Circuit (which move the
      // circuit point under a stationary cursor) keep the guides honest.
      if (settings.showCrosshair && pointerRef.current) {
        const p = pointerRef.current;
        const px = view.x + p.x / view.scale;
        const py = view.y + p.y / view.scale;
        const sx = Math.round(px / grid) * grid;
        const sy = Math.round(py / grid) * grid;
        ctx.strokeStyle = theme.grid;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(view.x, sy);
        ctx.lineTo(view.x + width / view.scale, sy);
        ctx.moveTo(sx, view.y);
        ctx.lineTo(sx, view.y + height / view.scale);
        ctx.stroke();
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
        const voltage = voltages.length >= 2 ? voltages[0] - voltages[1] : (voltages[0] ?? 0);
        const value = idx !== undefined && values ? (values[idx] ?? 0) : 0;

        // The shift-highlighted net: any terminal on the highlighted node
        // colours the whole element (CircuitElm.isOnHighlightedNet).
        const onHighlightedNet =
          highlightedNode !== null &&
          elementNodes !== null &&
          offset !== undefined &&
          posts.some((_, i) => elementNodes[offset + i] === highlightedNode);

        // Phase is integrated per element so changing the speed or the current
        // mid-run cannot teleport the dots. Only advance while running, so a
        // pause freezes them in place.
        const step = dotPhaseStep(
          current,
          settings.currentSpeed,
          elapsed,
          settings.conventional,
        );
        const phase =
          step === TOO_FAST ? TOO_FAST : wrapPhase((dotPhaseRef.current.get(e.id) ?? 0) + step);
        if (running) dotPhaseRef.current.set(e.id, phase === TOO_FAST ? 0 : phase);

        const g: DrawContext = {
          ctx,
          theme,
          voltages,
          current,
          voltage,
          // The terminal voltage times the element current, the same V*I the
          // power ramp colours by: positive is dissipated, negative generated
          // (upstream's getPower(), CircuitElm.java:1273).
          power: current * voltage,
          value,
          dotPhase: phase,
          showCurrent: settings.showCurrent,
          showValues: settings.showValues,
          showVoltageColor: settings.showVoltageColor,
          showPowerColor: settings.showPowerColor,
          conventional: settings.conventional,
          euroResistors: settings.euroResistors,
          euroGates: settings.euroGates,
          selected: selectedIds.includes(e.id),
          hovered: hoveredId === e.id,
          onHighlightedNet,
          voltageRange: settings.voltageRange,
          powerRange: settings.powerRange,
          scale: view.scale,
          valueDigits: settings.shortDecimalDigits,
          valueFontSize: settings.valueFontSize,
        };
        def.draw(g, e);
      }

      // Junction dots: a dot only where the post count at a coordinate is not
      // exactly 2, so a plain two-element pass-through connection hides while
      // dead ends and real junctions keep theirs, matching makePostDrawList
      // (SimulationManager.java:1056-1108). Drawn after all elements, like the
      // upstream postDrawList pass. The radius is upstream's drawPost
      // fillOval(pt.x-3, pt.y-3, 7, 7), a 7 px filled circle (CircuitElm.java:
      // 851-854), so a junction reads at the same weight as the thicker bodies.
      ctx.fillStyle = theme.wire;
      for (const [key, count] of postDotPoints(elements)) {
        if (!shouldDrawDot(count)) continue;
        const [x, y] = key.split(',').map(Number);
        ctx.beginPath();
        ctx.arc(x, y, 3.5, 0, Math.PI * 2);
        ctx.fill();
      }

      // Red no-connect marker: a dragged wire end over another wire's interior
      // will not connect there, so show it as upstream's bad-connection dot.
      // Drawn after the elements so it stays visible through the dragged wire.
      const drag = dragRef.current;
      if (drag.mode === 'dragpost') {
        const dragged = elements.find((e) => e.id === drag.id);
        if (dragged) {
          const pos = drag.post === 1 ? { x: dragged.x1, y: dragged.y1 } : { x: dragged.x2, y: dragged.y2 };
          const bad = invalidDropPoint(dragged, pos.x, pos.y, elements);
          if (bad) {
            ctx.fillStyle = theme.noConnect;
            ctx.beginPath();
            ctx.arc(bad.x, bad.y, 3, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }

      // Rubber-band selection rectangle.
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
    // The refs are stable for the life of the component, so this runs once per
    // engine just like the inline effect it was extracted from.
  }, [engine, canvasRef, dragRef, stateRef, pointerRef]);
}
