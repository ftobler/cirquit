/** E12 preferred-number series for the mouse-wheel value popover. One decade
 *  of mantissas, mirroring upstream's `ScrollValuePopup.e12`
 *  (ScrollValuePopup.java:37). */
export const E12 = [1.0, 1.2, 1.5, 1.8, 2.2, 2.7, 3.3, 3.9, 4.7, 5.6, 6.8, 8.2];

/** Decade exponent range per element kind (ScrollValuePopup.java:90-101). */
const DECADE_RANGES: Record<string, [number, number]> = {
  resistor: [-1, 7],
  capacitor: [-11, -3],
  inductor: [-6, 0],
};

/** The decade exponent range for a kind. An unknown kind has none, so callers
 *  can treat `[0, 0]` as "no values". */
export function e12DecadeRange(kind: string): [number, number] {
  return DECADE_RANGES[kind] ?? [0, 0];
}

/** Sorted candidate list with the current value spliced in at its sorted
 *  position when it is not an exact E12 step, and the index of the current
 *  value, for highlighting. The last decade of the range contributes only its
 *  1.0, exactly as upstream's `setupValues` (ScrollValuePopup.java:104-109):
 *  a resistor's 10^7 decade is just `1e7`, never `1.2e7`. */
export function e12Values(kind: string, current: number): { values: number[]; index: number } {
  const range = DECADE_RANGES[kind];
  if (!range) return { values: [], index: 0 };
  const [minExp, maxExp] = range;
  const values: number[] = [];
  for (let exp = minExp; exp <= maxExp; exp++) {
    const count = exp === maxExp ? 1 : E12.length;
    const scale = Math.pow(10, exp);
    for (let j = 0; j < count; j++) values.push(scale * E12[j]);
  }
  for (let i = 0; i < values.length; i++) {
    // A value sits on the E12 step it was built from within float noise
    // (10^3 * 2.2 need not land exactly on 2200), so match with a tiny
    // relative epsilon rather than `===`.
    if (Math.abs(current - values[i]) <= Math.abs(values[i]) * 1e-9) {
      return { values, index: i };
    }
    if (current < values[i]) {
      values.splice(i, 0, current);
      return { values, index: i };
    }
  }
  values.push(current);
  return { values, index: values.length - 1 };
}
