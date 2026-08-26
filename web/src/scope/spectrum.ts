/** The FFT spectrum overlay of a scope canvas (ScopeFFT.java). The windowing
 *  math lives in `fft.ts`; this module owns the pixels, including the
 *  frequency grid, the log/linear body, the cursor readout and the phase
 *  overlay. */

import type { Scope, ScopeValue } from '../engine/scopeModel';
import type { Theme } from '../model/types';
import type { ScopeCursor } from './draw';
import { canvasFont, formatValue } from '../render/draw';
import { dbOf, fft, spectrumMagnitudes } from './fft';
import { drawInfo, type InfoLine } from './info';

/** The phase overlay's stroke colour, distinct from the red spectrum body and
 *  the dark-red grid so a test can tell the phase lines apart. */
export const PHASE_COLOR = '#ffb000';

/** Upstream draws the spectrum trace and every label in plain red
 *  (ScopeFFT.java:35-38, 69, 93-98). */
const SPECTRUM_COLOR = '#ff0000';

/** The spectrum's gridlines, upstream's dark red (ScopeFFT.java:64, 89). It is
 *  nearly as dark as the trace on a white background; upstream has the same
 *  problem in printable mode, so the quirk is kept rather than silently
 *  retuned. */
const SPECTRUM_GRID_COLOR = '#880000';

/** One drawable trace's snapshot for the FFT overlay. The spectrum body uses
 *  the first trace; the phase overlay needs the voltage and current traces. */
export interface FFTSpectrumTrace {
  value: ScopeValue | null;
  data: Float32Array;
}

/** Draws the FFT spectrum (ScopeFFT.java:43-111). Blanks until the ring is
 *  full enough for a complete transform. */
export function drawFFT(
  ctx: CanvasRenderingContext2D,
  scope: Scope,
  traces: FFTSpectrumTrace[],
  w: number,
  h: number,
  speed: number,
  timeStep: number,
  cursor: ScopeCursor,
  theme: Theme,
  decimalDigits: number,
): void {
  const first = traces[0];
  if (!first) return;
  const columns = first.data.length / 2;
  const n = Math.pow(2, Math.ceil(Math.log2(columns)));
  // Blank until columns_written >= columns: a partial ring would feed the
  // transform stale zeroes.
  if (columns < n) return;
  const values = new Float64Array(n);
  const start = columns - n;
  for (let i = 0; i < n; i++) {
    values[i] = 0.5 * (first.data[(start + i) * 2] + first.data[(start + i) * 2 + 1]);
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
      ctx.strokeStyle = SPECTRUM_GRID_COLOR;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }
    ctx.fillStyle = SPECTRUM_COLOR;
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
    drawInfo(ctx, lines, h, theme.whiteColor);
  }
}

/** The per-bin phase difference band, ported from `drawPhaseAngle`
 *  (ScopeFFT.java:114-171): FFT both traces, then stroke each bin's V-I phase
 *  as a line in the band below the spectrum, centred on the zero line. Drawn
 *  by the scope whenever Show Phase Angle is on, independent of the spectrum
 *  itself: upstream calls drawPhaseAngle from ScopeOverlays.draw on every
 *  frame (ScopeOverlays.java:218-219). Every visible plot must be a voltage or
 *  current and both must be present, matching upstream's visible-plots scan,
 *  and the draw bails when the voltage trace's fundamental magnitude is below
 *  1e-8, so a blank or near-zero-signal scope paints no noise phase lines
 *  (ScopeFFT.java:143-150). The fundamental is scanned from bin 1: the DC bin
 *  carries no phase information. */
export function drawPhaseBand(
  ctx: CanvasRenderingContext2D,
  traces: FFTSpectrumTrace[],
  w: number,
  h: number,
): void {
  let vData: Float32Array | null = null;
  let iData: Float32Array | null = null;
  for (const t of traces) {
    if (t.value === 'voltage') {
      if (vData) return;
      vData = t.data;
    } else if (t.value === 'current') {
      if (iData) return;
      iData = t.data;
    } else {
      return;
    }
  }
  if (vData === null || iData === null) return;
  const columns = vData.length / 2;
  const n = Math.pow(2, Math.ceil(Math.log2(columns)));
  // Blank until the ring is full enough for a complete transform, the same
  // gate drawFFT applies to the spectrum body.
  if (columns < n) return;
  const v = new Float64Array(n);
  const i = new Float64Array(n);
  const start = columns - n;
  for (let k = 0; k < n; k++) {
    v[k] = 0.5 * (vData[(start + k) * 2] + vData[(start + k) * 2 + 1]);
    i[k] = 0.5 * (iData[(start + k) * 2] + iData[(start + k) * 2 + 1]);
  }
  const vf = fft(v);
  const ift = fft(i);
  // The fundamental is the largest non-DC bin of the voltage trace; below
  // 1e-8 there is no real signal to measure phase against (ScopeFFT.java:
  // 143-150).
  let fundMax = 0;
  for (let b = 1; b < n / 2; b++) {
    const m = Math.hypot(vf.real[b], vf.imag[b]);
    if (m > fundMax) fundMax = m;
  }
  if (fundMax < 1e-8) return;
  const phase = new Float64Array(n / 2);
  for (let b = 0; b < n / 2; b++) {
    let d = ((Math.atan2(vf.imag[b], vf.real[b]) - Math.atan2(ift.imag[b], ift.real[b])) * 180) / Math.PI;
    while (d > 180) d -= 360;
    while (d < -180) d += 360;
    phase[b] = d;
  }

  const bandCenter = h - 10;
  const bandHalf = 8;
  // The zero-degree reference line across the band.
  ctx.strokeStyle = SPECTRUM_GRID_COLOR;
  ctx.beginPath();
  ctx.moveTo(0, bandCenter);
  ctx.lineTo(w, bandCenter);
  ctx.stroke();
  ctx.strokeStyle = PHASE_COLOR;
  ctx.beginPath();
  let prevX = 0;
  let prevY = bandCenter;
  for (let b = 0; b < n / 2; b++) {
    const x = (2 * b * w) / n;
    const y = bandCenter - (phase[b] / 180) * bandHalf;
    if (x !== prevX) {
      ctx.moveTo(prevX, prevY);
      ctx.lineTo(x, y);
    }
    prevY = y;
    prevX = x;
  }
  ctx.stroke();
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
    ctx.strokeStyle = SPECTRUM_COLOR;
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
      ctx.strokeStyle = SPECTRUM_GRID_COLOR;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
      ctx.fillStyle = SPECTRUM_COLOR;
      ctx.font = canvasFont(9);
      ctx.fillText(`${db} dB`, 2, y - 2);
    }
    ctx.strokeStyle = SPECTRUM_COLOR;
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
