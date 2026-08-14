import { useEffect, useRef } from 'react';
import type { SimEngine } from '../../engine/simulator';
import { scopeParamsFingerprint } from '../../engine/simulator';
import { defFor } from '../../model/registry';
import type { DrawContext, Point } from '../../model/types';
import { dotPhaseStep, stepPostPhases, TOO_FAST, wrapPhase } from '../../render/dots';
import { dragpostHandlesFrom, elementLength, makeTheme } from '../../render/draw';
import { drawGrid } from '../../render/grid';
import { invalidDropPoint } from '../../render/geometry';
import { postDotPoints, shouldDrawDot } from '../../render/junction';
import { scopeWidth } from '../../scope/geometry';
import { pruneScaleStates, pruneXYScales } from '../../scope/scale';
import { GRID_SIZE } from '../../model/types';
import { mergeProblem, useStore } from '../../state/store';
import { useStoreRef } from './useStoreRef';
import type { Drag } from './useCanvasInteractions';
import { overlayLiveState, recordBuildOnSuccess, shouldInjectLiveState } from '../../io/liveState';

/** Runs one animation frame's work without letting a throw kill the loop.
 *  `report` receives the error message. The loop re-schedules before this
 *  runs, so a crash only skips that frame's work and the next frame still
 *  arrives. Kept out of the hook so the survival guarantee is testable
 *  without a DOM. */
export function frameSafely(body: () => void, report: (message: string) => void): void {
  try {
    body();
  } catch (err) {
    report(err instanceof Error ? err.message : String(err));
  }
}

/** Resolves each scope's measured canvas width, for engine ring sizing. */
const widthOf = (id: number): number | undefined => scopeWidth(id);

export function useFrameLoop(
  canvasRef: React.RefObject<HTMLCanvasElement | null>,
  engine: SimEngine | null,
  dragRef: React.MutableRefObject<Drag>,
  pointerRef: React.MutableRefObject<Point | null>,
): void {
  const dotPhaseRef = useRef(new Map<number, number>());
  const postPhaseRef = useRef(new Map<number, number[]>());
  const lastFrameRef = useRef(performance.now());
  const loadedRevision = useRef(-1);
  const appliedParamRevision = useRef(-1);
  const appliedScopeFp = useRef('');
  // Whether the simulation was running at the end of the last frame. The stop
  // trigger latch clears only on the pause -> run edge (or reset), so the edge
  // must be detected here rather than re-armed per step.
  const wasRunningRef = useRef(false);
  // The last crash message surfaced from the frame body, so a persistent
  // failure reports once instead of rewriting the banner every frame.
  const lastFrameErrorRef = useRef('');
  // The document the engine currently holds. setCircuit records it, and the
  // rebuild branches inject live state only when it matches the store's
  // current document (a load or New bumps the counter, so their rebuilds seed
  // from the new file's tokens instead).
  const builtDocument = useRef(-1);
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
      // The loop re-schedules before the body, so a throw in it would spin
      // the loop with nothing drawn. The simulator wrapper converts wasm
      // throws into error flags, but a render bug would still escape: catch
      // it here, surface it as a problem, and keep the loop alive.
      frameSafely(
        () => {
          const canvas = canvasRef.current;
          if (!canvas) return;
          const ctx = canvas.getContext('2d');
          if (!ctx) return;

          const now = performance.now();
          const elapsed = Math.min(0.1, (now - lastFrameRef.current) / 1000);
          lastFrameRef.current = now;

          const state = stateRef.current;
          const {
            elements,
            settings,
            view,
            selectedIds,
            running,
            scopes,
            hoveredId,
            highlightedNode,
          } = state;

          // Drop sticky auto-scale state for plots that no longer exist (a removed
          // scope), keeping the map bounded across a session.
          pruneScaleStates(scopes.flatMap((s) => s.plots.map((p) => p.id)));
          pruneXYScales(scopes.map((s) => s.id));

          // Reload the engine whenever the netlist changed.
          if (engine && loadedRevision.current !== state.revision) {
            loadedRevision.current = state.revision;
            // A new netlist invalidates every element's accumulated phase, and
            // clearing the maps stops them growing across circuit loads.
            dotPhaseRef.current.clear();
            postPhaseRef.current.clear();
            // A mid-run rebuild keeps the live charges only when the engine still
            // holds this document; the rebuild right after a load injects nothing,
            // because the new file's tokens are already in the params.
            const build = shouldInjectLiveState(builtDocument.current, state.document)
              ? overlayLiveState(elements, engine.elementStateTokens())
              : elements;
            const err = engine.setCircuit(build, settings, scopes, widthOf);
            // A failed build leaves the engine on a stale or partial circuit, so
            // the next rebuild must not pull live tokens off it; record only on
            // success (recordBuildOnSuccess).
            builtDocument.current = recordBuildOnSuccess(
              builtDocument.current,
              state.document,
              err,
            );
            const warnings = err ? [err] : engine.warnings();
            // Merge, not replace: the load-time unsupported-lines message has to
            // survive the first engine build, which is what wiped it before.
            useStore.getState().setProblem(mergeProblem(state.unsupportedProblem, warnings));
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
              // otherwise read as a dead slider; rebuild the whole circuit. The
              // rebuild keeps the live charges under the same document gate as
              // the revision branch, so an undo or a param that forces a reload
              // does not snap every reactive element back to its file charge.
              dotPhaseRef.current.clear();
              postPhaseRef.current.clear();
              const build = shouldInjectLiveState(builtDocument.current, state.document)
                ? overlayLiveState(elements, engine.elementStateTokens())
                : elements;
              const err = engine.setCircuit(build, settings, scopes, widthOf);
              builtDocument.current = recordBuildOnSuccess(
                builtDocument.current,
                state.document,
                err,
              );
              const warnings = err ? [err] : engine.warnings();
              // Same merge as the revision branch: the load-time message must not
              // be overwritten by this rebuild's warnings either.
              useStore.getState().setProblem(mergeProblem(state.unsupportedProblem, warnings));
            }
            state.clearPending();
          }

          // Advance the simulation.
          let currents: Float64Array | null = null;
          let postCurrents: Float64Array | null = null;
          let nodeVoltages: Float64Array | null = null;
          let elementNodes: Uint32Array | null = null;
          let values: Float64Array | null = null;
          let states: Float64Array | null = null;
          if (engine) {
            // A stop trigger latches `stopped` in engine state and the pause check
            // below keeps the loop stopped until the latch clears. The latch keeps
            // the element highlighted, and pressing Run would run one frame, see
            // the still-set latch and re-pause immediately, making the button look
            // dead until Reset. So on the pause -> run edge, clear the latches
            // first: the trigger re-arms in the waiting state and the next crossing
            // fires it again, the re-arm upstream's next stepFinished performs when
            // the sim resumes.
            if (running && !wasRunningRef.current) {
              engine.clearStops();
            }
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
                useStore
                  .getState()
                  .setProblem(
                    mergeProblem(state.unsupportedProblem, [
                      names ? `${stats.error}; not settled: ${names}` : stats.error,
                    ]),
                  );
              }
            }
            currents = engine.elementCurrents();
            postCurrents = engine.elementPostCurrents();
            nodeVoltages = engine.nodeVoltages();
            elementNodes = engine.elementNodes();
            values = engine.elementValues();
            states = engine.elementStates();

            // A stop trigger cannot pause the engine from inside (the engine has
            // no UI), so it latches `stopped` and this loop pauses the run when it
            // sees the latch, the same one-shot pattern as the fuse's blown check.
            // The latch stays set until the next Run edge clears it via
            // `clearStops` above, so the draw highlight stays live while the
            // repeated pause call is a harmless no-op guarded by `running` having
            // already flipped false.
            if (running && states) {
              for (const e of elements) {
                if (e.kind === 'stopTrigger') {
                  const idx = engine.indexOf(e.id);
                  if (idx !== undefined && (states[idx] ?? 0) >= 1) {
                    useStore.getState().setRunning(false);
                    break;
                  }
                }
              }
            }

            // Remember the running state for the next frame's pause -> run edge
            // detection. `running` is this frame's snapshot, so the frame that
            // pauses below still records true; the pause is seen next frame.
            wasRunningRef.current = running;
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

          const grid = GRID_SIZE;
          if (settings.showGrid && view.scale > 0.4) {
            drawGrid(
              ctx,
              view.x,
              view.y,
              width / view.scale,
              height / view.scale,
              theme.grid,
              grid,
            );
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
            const postCs = posts.map((_, i) =>
              offset !== undefined && postCurrents ? (postCurrents[offset + i] ?? 0) : 0,
            );
            const voltage = voltages.length >= 2 ? voltages[0] - voltages[1] : (voltages[0] ?? 0);
            const value = idx !== undefined && values ? (values[idx] ?? 0) : 0;
            const state = idx !== undefined && states ? (states[idx] ?? 0) : 0;

            // The body-wave strips only exist for the transmission line, so only
            // that kind pays for the on-demand engine call; every other element
            // draws the flat body from an empty array. `segments = dn/2` is the
            // upstream draw's own resample count (TransLineElm.java:126).
            let wave: number[] = [];
            if (engine && e.kind === 'transmissionLine') {
              wave = Array.from(
                engine.transmissionLineWave(e.id, Math.floor(elementLength(e) / 2)),
              );
            }

            // The engine is authoritative for a fuse's pop; the store's `e.state`
            // is the serialized copy. Push the live value in on a transition (both
            // directions, so a reset un-pops it), exactly as a switch throw flows
            // store-to-engine through setElementState. The comparison against the
            // current `e.state` keeps this a one-time write, never a per-frame one.
            // A null engine reads every state as 0, which must not rewrite a
            // file-loaded blown fuse's `e.state` to 0.
            if (engine && e.kind === 'fuse') {
              const blown = state >= 1;
              if (((e.state ?? 0) !== 0) !== blown) {
                useStore.getState().setElementState(e.id, blown ? 1 : 0);
              }
            }

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

            // Per-terminal phases step each post on its own current, so a
            // saturated collector cannot drag the base or emitter into TOO_FAST or
            // speed them up. Integrated in place, exactly like the scalar phase.
            let postPhases = postPhaseRef.current.get(e.id);
            if (!postPhases || postPhases.length !== posts.length) {
              postPhases = new Array(posts.length).fill(0);
              postPhaseRef.current.set(e.id, postPhases);
            }
            const postDotPhases = stepPostPhases(
              postPhases,
              postCs,
              settings.currentSpeed,
              elapsed,
              settings.conventional,
              running,
            );

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
              state,
              wave,
              dotPhase: phase,
              postCurrents: postCs,
              postDotPhases,
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

          // Control-point drag handles: a filled selection-colour rect at each of
          // the dragged element's stored endpoints, the grabbed one at 9x9, so the
          // moving control point keeps its highlight (CircuitElm.drawHandles,
          // CircuitElm.java:747-761). Drawn after the elements, like upstream's
          // overlay pass, so the rects sit on top of the symbol. The grey ovals at
          // every other element's posts (UIManager.java:674-687) are deliberately
          // not ported: they are draw-mode noise the user's complaint never asked
          // for, and a per-frame pass over all elements buys nothing here.
          const drag = dragRef.current;
          if (drag.mode === 'dragpost') {
            const dragged = elements.find((e) => e.id === drag.id);
            if (dragged) {
              dragpostHandlesFrom(
                {
                  ctx,
                  theme,
                  voltages: [],
                  current: 0,
                  voltage: 0,
                  power: 0,
                  value: 0,
                  state: 0,
                  wave: [],
                  dotPhase: 0,
                  postCurrents: [],
                  postDotPhases: [],
                  showCurrent: settings.showCurrent,
                  showValues: settings.showValues,
                  showVoltageColor: settings.showVoltageColor,
                  showPowerColor: settings.showPowerColor,
                  conventional: settings.conventional,
                  euroResistors: settings.euroResistors,
                  euroGates: settings.euroGates,
                  selected: false,
                  hovered: false,
                  onHighlightedNet: false,
                  voltageRange: settings.voltageRange,
                  powerRange: settings.powerRange,
                  scale: view.scale,
                  valueDigits: settings.shortDecimalDigits,
                  valueFontSize: settings.valueFontSize,
                },
                [
                  { x: dragged.x1, y: dragged.y1 },
                  { x: dragged.x2, y: dragged.y2 },
                ],
                drag.post === 1 ? 0 : 1,
              );
              // Red no-connect marker: a dragged wire end over another wire's
              // interior will not connect there, so show it as upstream's
              // bad-connection dot. Drawn after the handles so it stays visible
              // on top of the highlight.
              const pos =
                drag.post === 1
                  ? { x: dragged.x1, y: dragged.y1 }
                  : { x: dragged.x2, y: dragged.y2 };
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
        },
        (message) => {
          // A persistent failure must not rewrite the same banner on every
          // frame, so report each distinct crash once.
          if (lastFrameErrorRef.current === message) return;
          lastFrameErrorRef.current = message;
          useStore
            .getState()
            .setProblem(mergeProblem(useStore.getState().unsupportedProblem, [message]));
        },
      );
    };

    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
    // The refs are stable for the life of the component, so this runs once per
    // engine just like the inline effect it was extracted from.
  }, [engine, canvasRef, dragRef, stateRef, pointerRef]);
}
