import { useEffect, useRef } from 'react';
import type { SimEngine } from '../engine/simulator';
import { makeTheme } from '../render/draw';
import { drawInfoBox } from '../render/infoBox';
import { useStore } from '../state/store';
import { useStoreRef } from './canvas/useStoreRef';
import { infoBoxLines } from './infoBoxLines';

/** Left margin of the info text inside the panel, upstream's `leftX + 5`
 *  (UIManager.java:874). */
const TEXT_MARGIN = 5;

/**
 * The info area next to the scope strip: the hovered element's readout or the
 * `t =` / `time step =` stats, the same `drawBottomArea` text upstream draws
 * to the right of the scopes (UIManager.java:796-891). Only exists alongside
 * the scopes; with none, the main canvas keeps drawing the info box at its
 * bottom-right corner as before.
 */
export function SimInfoPanel({ engine }: { engine: SimEngine | null }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stateRef = useStoreRef();
  const scopes = useStore((s) => s.scopes);

  // The text changes every frame (sim time, hover), so the panel owns a small
  // canvas and a rAF loop like the scope traces: the loop reads the live store
  // state behind the ref and paints the current lines. The engine arrays are
  // rewritten by the main canvas's frame loop, so this loop reads the latest
  // operating point, one frame's phase behind at worst.
  useEffect(() => {
    if (scopes.length === 0) return;
    let raf = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const canvas = canvasRef.current;
      if (!canvas) return;
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
      const state = stateRef.current;
      const theme = makeTheme(state.dark, state.settings);
      // The theme background matches the canvas above, so the panel reads as
      // the schematic's own corner, not as another chrome panel.
      ctx.fillStyle = theme.background;
      ctx.fillRect(0, 0, w, h);
      drawInfoBox(
        ctx,
        TEXT_MARGIN,
        0,
        infoBoxLines(
          state.hoveredId,
          state.elements,
          engine,
          state.settings,
        ),
        theme.text,
      );
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [engine, scopes.length, stateRef]);

  if (scopes.length === 0) return null;

  return (
    <div className="sim-info">
      <canvas ref={canvasRef} className="sim-info-canvas" />
    </div>
  );
}
