import { useEffect, useRef, useState } from 'react';
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
  const [, forceRender] = useState(0);
  const setViewSize = useStore((s) => s.setViewSize);
  useFrameLoop(canvasRef, engine, dragRef, pointerRef);
  const interactions = useCanvasInteractions(canvasRef, dragRef, pointerRef, forceRender, engine);

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

  return (
    <>
      <canvas
        ref={canvasRef}
        className="circuit-canvas"
        onPointerDown={interactions.onPointerDown}
        onPointerMove={interactions.onPointerMove}
        onPointerUp={interactions.onPointerUp}
        onPointerCancel={interactions.onPointerUp}
        onPointerLeave={interactions.onPointerLeave}
        onWheel={interactions.onWheel}
        onContextMenu={interactions.onContextMenu}
        onDoubleClick={interactions.onDoubleClick}
      />
      {interactions.popover && (
        <ScrollValuePopup
          session={interactions.popover.session}
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
