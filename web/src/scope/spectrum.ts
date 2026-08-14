/** The FFT spectrum overlay of a scope canvas (ScopeFFT.java). The windowing
 *  math lives in `fft.ts`; this module owns the pixels, including the
 *  frequency grid, the log/linear body and the cursor readout. */

import type { Scope } from '../engine/simulator';
import type { ScopeCursor } from './draw';
import { canvasFont, formatValue } from '../render/draw';
import { dbOf, spectrumMagnitudes } from './fft';
import { drawInfo, type InfoLine } from './info';

/** Draws the FFT spectrum (ScopeFFT.java:43-111). Blanks until the ring is
 *  full enough for a complete transform. */
export function drawFFT(
  ctx: CanvasRenderingContext2D,
  scope: Scope,
  data: Float32Array,
  columns: number,
  w: number,
  h: number,
  speed: number,
  timeStep: number,
  cursor: ScopeCursor,
  decimalDigits: number,
): void {
  const n = Math.pow(2, Math.ceil(Math.log2(columns)));
  // Blank until columns_written >= columns: a partial ring would feed the
  // transform stale zeroes.
  if (columns < n) return;
  const values = new Float64Array(n);
  const start = columns - n;
  for (let i = 0; i < n; i++) {
    values[i] = 0.5 * (data[(start + i) * 2] + data[(start + i) * 2 + 1]);
  }
  const mag = spectrumMagnitudes(values);
  let maxM = 1e-8;
  for (let i = 0; i < mag.length; i++) if (mag[i] > maxM) maxM = mag[i];

  // Frequency grid: 20 divisions up to 1/(timeStep*speed*2)
  // (ScopeFFT.java:24-41).
  const divs = 20;
  const maxFreq = 1 / (timeStep * speed * divs * 2);
  ctx.font = canvasFont(9);
  let prevEnd = 0;
  for (let i = 0; i < divs; i++) {
    const x = (w * i) / divs;
    if (x < prevEnd) continue;
    const s = `${Math.round(i * maxFreq)}Hz`;
    const sWidth = ctx.measureText(s).width;
    prevEnd = x + sWidth + 4;
    if (i > 0) {
      ctx.strokeStyle = '#880000';
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }
    ctx.fillStyle = '#ff5555';
    ctx.fillText(s, x + 2, h - 4);
  }

  drawSpectrumBody(ctx, mag, maxM, w, h, n, scope.logSpectrum);

  // Cursor readout: frequency and dB at the mouse x (ScopeFFT.java:159-171).
  if (cursor.hover) {
    const cx = cursor.mouseX;
    const f = (maxFreq * divs * cx) / w;
    const lines: InfoLine[] = [{ text: formatValue(f, 'Hz', decimalDigits), y: 4 }];
    const fftIndex = Math.floor((cx * n) / (2 * w));
    if (fftIndex >= 0 && fftIndex < mag.length && maxM > 0) {
      lines.push({ text: `${Math.round(dbOf(mag[fftIndex], maxM))} dB`, y: 19 });
    }
    drawInfo(ctx, lines, h);
  }
}

function drawSpectrumBody(
  ctx: CanvasRenderingContext2D,
  mag: Float64Array,
  maxM: number,
  w: number,
  h: number,
  n: number,
  logSpectrum: boolean,
): void {
  if (!logSpectrum) {
    ctx.strokeStyle = '#ff5555';
    ctx.beginPath();
    const y0 = h - 12;
    let prevX = 0;
    let prevHeight = 0;
    for (let i = 0; i < mag.length; i++) {
      const x = (2 * i * w) / n;
      const height = (mag[i] * y0) / maxM;
      if (x !== prevX) {
        ctx.moveTo(prevX, y0 - prevHeight);
        ctx.lineTo(x, y0 - height);
      }
      prevHeight = height;
      prevX = x;
    }
    ctx.stroke();
  } else {
    const dbRange = 80;
    const topMargin = 5;
    const bottomMargin = 12;
    const plotHeight = h - topMargin - bottomMargin;
    const pixelsPerDb = plotHeight / dbRange;
    for (let db = -20; db >= -80; db -= 20) {
      const y = topMargin + -db * pixelsPerDb;
      if (y < 0 || y >= h) continue;
      ctx.strokeStyle = '#880000';
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
      ctx.fillStyle = '#ff5555';
      ctx.font = canvasFont(9);
      ctx.fillText(`${db} dB`, 2, y - 2);
    }
    ctx.strokeStyle = '#ff5555';
    ctx.beginPath();
    let prevX = 0;
    let prevY = 0;
    for (let i = 0; i < mag.length; i++) {
      const x = (2 * i * w) / n;
      const db = dbOf(mag[i], maxM, dbRange);
      const y = topMargin + -db * pixelsPerDb;
      if (x !== prevX) {
        ctx.moveTo(prevX, prevY);
        ctx.lineTo(x, y);
      }
      prevY = y;
      prevX = x;
    }
    ctx.stroke();
  }
}
