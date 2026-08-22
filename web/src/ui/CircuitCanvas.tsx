import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { SimEngine } from '../engine/simulator';
import type { Point } from '../model/types';
import { useStore } from '../state/store';
import { useFrameLoop } from './canvas/useFrameLoop';
import { ScrollValuePopup } from './canvas/ScrollValuePopup';
import { useCanvasInteractions, type Drag } from './canvas/useCanvasInteractions';

/**
 * The schematic view: renders the circuit, runs the animation loop that drives
 * the engine, and handles all mouse editing. The loop and the pointer handlers
 * live in `useFrameLoop` and `useCanvasInteractions`; this component only
 * wires their shared refs to the canvas element. The wheel value popover is a
 * fixed sibling of the canvas, so wheel events over it never reach the zoom
 * handler.
 */
export function CircuitCanvas({ engine }: { engine: SimEngine | null }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragRef = useRef<Drag>({ mode: 'none' });
  // Last pointer position in circuit space, shared with the frame loop so the
  // crosshair guide lines can follow the cursor without a 60 Hz setState.
  const pointerRef = useRef<Point | null>(null);
  // Where a hovering mouse or pen is, in the same canvas-relative pixels. The
  // armed tool's ghost follows this and not `pointerRef`, which the touch path
  // also writes and which survives a finger lifting: a ghost must not stay
  // stuck under the spot the last tap landed on.
  const hoverRef = useRef<Point | null>(null);
  const [, forceRender] = useState(0);
  const setViewSize = useStore((s) => s.setViewSize);
  const centerRequest = useStore((s) => s.centerRequest);
  useFrameLoop(canvasRef, engine, dragRef, pointerRef, hoverRef);
  const interactions = useCanvasInteractions(
    canvasRef,
    dragRef,
    pointerRef,
    hoverRef,
    forceRender,
    engine,
  );

  // Keep the store's canvas size in step with the element so keyboard zoom can
  // target the exact screen centre (MouseManager.java:1339).
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const report = () => setViewSize(canvas.clientWidth, canvas.clientHeight);
    report();
    const observer = new ResizeObserver(report);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [setViewSize]);

  // A deferred fit, for the changes that resize this canvas themselves. A load
  // that brings scopes with it mounts the scope strip in the same commit, so
  // the canvas loses that strip's height and the fit the store already ran
  // used the taller, pre-load viewport: the circuit ends up sitting low by
  // half the strip. Layout effects run after the DOM is committed, so reading
  // clientHeight here forces the layout and returns the height the circuit
  // will actually be drawn into. The ResizeObserver above would get there too,
  // but only a frame later and after the wrong view has been painted. Skips
  // the initial render, where the counter is still its 0 baseline and no one
  // has asked for anything.
  useLayoutEffect(() => {
    if (centerRequest === 0) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    setViewSize(canvas.clientWidth, canvas.clientHeight);
    useStore.getState().centerCircuit();
  }, [centerRequest, setViewSize]);

  return (
    <>
      <canvas
        ref={canvasRef}
        className="circuit-canvas"
        onPointerDown={interactions.onPointerDown}
        onPointerMove={interactions.onPointerMove}
        onPointerUp={interactions.onPointerUp}
        onPointerCancel={interactions.onPointerCancel}
        onPointerLeave={interactions.onPointerLeave}
        onWheel={interactions.onWheel}
        onContextMenu={interactions.onContextMenu}
        onDoubleClick={interactions.onDoubleClick}
      />
      {interactions.popover && (
        <ScrollValuePopup
          session={interactions.popover.session}
          name={interactions.popover.name}
          x={interactions.popover.x}
          y={interactions.popover.y}
          onStep={interactions.stepPopover}
          onClose={interactions.closePopover}
          onRevert={interactions.revertPopover}
        />
      )}
    </>
  );
}
