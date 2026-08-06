import { useRef, useState } from 'react';
import type { SimEngine } from '../engine/simulator';
import { useFrameLoop } from './canvas/useFrameLoop';
import { useCanvasInteractions, type Drag } from './canvas/useCanvasInteractions';

/**
 * The schematic view: renders the circuit, runs the animation loop that drives
 * the engine, and handles all mouse editing. The loop and the pointer handlers
 * live in `useFrameLoop` and `useCanvasInteractions`; this component only
 * wires their shared refs to the canvas element.
 */
export function CircuitCanvas({ engine }: { engine: SimEngine | null }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragRef = useRef<Drag>({ mode: 'none' });
  const [, forceRender] = useState(0);
  useFrameLoop(canvasRef, engine, dragRef);
  const interactions = useCanvasInteractions(canvasRef, dragRef, forceRender);
  return (
    <canvas
      ref={canvasRef}
      className="circuit-canvas"
      onPointerDown={interactions.onPointerDown}
      onPointerMove={interactions.onPointerMove}
      onPointerUp={interactions.onPointerUp}
      onPointerCancel={interactions.onPointerUp}
      onWheel={interactions.onWheel}
      onContextMenu={interactions.onContextMenu}
    />
  );
}
