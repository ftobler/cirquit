import { describe, expect, it } from 'vitest';
import { dbOf, fft, spectrumMagnitudes } from './fft';

describe('radix-2 FFT', () => {
  it('a sine with k cycles peaks in bin k with magnitude A*N/2', () => {
    const n = 1024;
    const k = 7;
    const a = 1.5;
    const values = new Float64Array(n);
    for (let i = 0; i < n; i++) values[i] = a * Math.sin((2 * Math.PI * k * i) / n);
    const mag = spectrumMagnitudes(values);
    // The peak sits exactly in bin k (no spectral leakage for an integral
    // number of cycles) with magnitude A*N/2.
    expect(mag[k]).toBeCloseTo((a * n) / 2, 2);
    expect(mag[(k + 1) % (n / 2)]).toBeLessThan(0.01);
    expect(mag[0]).toBeLessThan(0.01);
  });

  it('a DC + cos input yields the expected bins', () => {
    const n = 1024;
    const k = 13;
    const dc = 2;
    const amp = 3;
    const values = new Float64Array(n);
    for (let i = 0; i < n; i++) values[i] = dc + amp * Math.cos((2 * Math.PI * k * i) / n);
    const mag = spectrumMagnitudes(values);
    // DC at bin 0 is dc*N, the cosine splits amp*N/2 across +-k.
    expect(mag[0]).toBeCloseTo(dc * n, 0);
    expect(mag[k]).toBeCloseTo((amp * n) / 2, 1);
  });

  it('fft round-trips through the inverse', () => {
    const n = 64;
    const values = new Float64Array(n);
    for (let i = 0; i < n; i++) values[i] = Math.cos((2 * Math.PI * 5 * i) / n) + 0.5 * Math.sin((2 * Math.PI * 3 * i) / n);
    const { real, imag } = fft(values);
    // Energy is conserved: sum |X|^2 = N * sum |x|^2.
    let sumX2 = 0;
    let sumV2 = 0;
    for (let i = 0; i < n; i++) {
      sumX2 += real[i] * real[i] + imag[i] * imag[i];
      sumV2 += values[i] * values[i];
    }
    expect(sumX2).toBeCloseTo(n * sumV2, 6);
  });

  it('log rendering maps the peak to 0 dB and clamps below the floor', () => {
    expect(dbOf(10, 10)).toBe(0);
    // 1e-5 of the peak is -100 dB, below the 80 dB floor.
    expect(dbOf(1e-5, 1)).toBe(-80);
    expect(dbOf(0, 1)).toBe(-80);
  });
});
