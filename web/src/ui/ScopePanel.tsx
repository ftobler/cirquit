/**
 * Docked oscilloscope traces.
 *
 * The engine samples every timestep and aggregates into min/max columns, so
 * what is drawn here is the true waveform envelope rather than a 60 Hz
 * subsample of it.
 */

import { useEffect, useRef } from 'react';
import type { SimEngine } from '../engine/simulator';
import { defFor } from '../model/registry';
import { formatValue, makeTheme } from '../render/draw';
import { useStore } from '../state/store';

interface Props {
  engine: SimEngine | null;
}

const UNIT: Record<string, string> = { voltage: 'V', current: 'A', power: 'W' };

function ScopeTrace({ engine, scopeId, title }: { engine: SimEngine | null; scopeId: number; title: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dark = useStore((s) => s.dark);

  useEffect(() => {
    let raf = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const canvas = canvasRef.current;
      if (!canvas || !engine) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const index = engine.scopeIndexOf(scopeId);
      const theme = makeTheme(dark);
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
        canvas.width = w * dpr;
        canvas.height = h * dpr;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = theme.background;
      ctx.fillRect(0, 0, w, h);

      if (index === undefined) return;
      const data = engine.scopeData(index);
      const columns = data.length / 2;
      if (columns < 2) return;

      // Symmetric auto-scale around zero, so the zero line stays centred.
      let peak = 0;
      for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i]));
      if (peak === 0) peak = 1;
      const scale = (h / 2 - 4) / peak;
      const mid = h / 2;

      ctx.strokeStyle = theme.grid;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, mid);
      ctx.lineTo(w, mid);
      ctx.stroke();

      // One vertical span per column covers everything the signal did during
      // that slice of time.
      ctx.strokeStyle = theme.positive;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let c = 0; c < columns; c++) {
        const x = (c / (columns - 1)) * w;
        const lo = mid - data[c * 2] * scale;
        const hi = mid - data[c * 2 + 1] * scale;
        ctx.moveTo(x, lo);
        ctx.lineTo(x, hi === lo ? hi + 0.5 : hi);
      }
      ctx.stroke();

      ctx.fillStyle = theme.text;
      ctx.font = '10px system-ui, sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText(`${title}  ±${formatValue(peak)}`, 4, 3);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [engine, scopeId, title, dark]);

  return <canvas ref={canvasRef} className="scope-canvas" />;
}

export function ScopePanel({ engine }: Props) {
  const scopes = useStore((s) => s.scopes);
  const elements = useStore((s) => s.elements);
  const removeScope = useStore((s) => s.removeScope);

  if (scopes.length === 0) return null;

  return (
    <div className="scopes">
      {scopes.map((scope) => {
        const element = elements.find((e) => e.id === scope.elementId);
        const label = element ? (defFor(element.kind)?.label ?? element.kind) : 'missing';
        const title = `${label} ${scope.value} (${UNIT[scope.value] ?? ''})`;
        return (
          <div key={scope.id} className="scope">
            <ScopeTrace engine={engine} scopeId={scope.id} title={title} />
            <button
              type="button"
              className="scope-close"
              onClick={() => removeScope(scope.id)}
              title="Remove scope"
            >
              ×
            </button>
          </div>
        );
      })}
    </div>
  );
}
