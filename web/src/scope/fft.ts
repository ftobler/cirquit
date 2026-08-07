/**
 * Radix-2 FFT for the scope spectrum, porting the algorithm ScopeFFT.java
 * feeds (ScopeFFT.java:43-57). Input is the column mid values over the most
 * recent `columns` columns, where `columns` is a power of two from Stage 1.
 * No engine data is needed: upstream feeds the min/max buffer mid values, and
 * so does this port.
 */

/** In-place radix-2 Cooley-Tukey FFT over `values`, forward transform. */
export function fft(values: ArrayLike<number>): { real: Float64Array; imag: Float64Array } {
  const n = values.length;
  const real = new Float64Array(n);
  const imag = new Float64Array(n);
  for (let i = 0; i < n; i++) real[i] = values[i];

  // Bit-reversal permutation.
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = real[i];
      real[i] = real[j];
      real[j] = tr;
      const ti = imag[i];
      imag[i] = imag[j];
      imag[j] = ti;
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wlenR = Math.cos(ang);
    const wlenI = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let wr = 1;
      let wi = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = real[i + k];
        const ui = imag[i + k];
        const vr = real[i + k + len / 2] * wr - imag[i + k + len / 2] * wi;
        const vi = real[i + k + len / 2] * wi + imag[i + k + len / 2] * wr;
        real[i + k] = ur + vr;
        imag[i + k] = ui + vi;
        real[i + k + len / 2] = ur - vr;
        imag[i + k + len / 2] = ui - vi;
        const nwr = wr * wlenR - wi * wlenI;
        wi = wr * wlenI + wi * wlenR;
        wr = nwr;
      }
    }
  }
  return { real, imag };
}

/** Magnitudes of the lower half of the spectrum (bins 0..N/2-1). */
export function spectrumMagnitudes(values: ArrayLike<number>): Float64Array {
  const { real, imag } = fft(values);
  const n = real.length;
  const mag = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) mag[i] = Math.hypot(real[i], imag[i]);
  return mag;
}

/** Log-scale level in dB relative to the peak, clamped to the range floor
 *  (ScopeFFT.java:99-110). */
export function dbOf(mag: number, maxM: number, dbRange = 80): number {
  if (maxM <= 0) return -dbRange;
  let db = 20 * Math.log10(mag / maxM);
  if (db < -dbRange) db = -dbRange;
  return db;
}
