import { beforeEach, describe, expect, it } from 'vitest';
import {
  axisSamplesFit,
  barToSpeed,
  calcGridParams,
  dragPlotYPosition,
  gridStep,
  gridStepX,
  gridStepY,
  nextAxisScale,
  nextHighestScale,
  nextLowestScale,
  nextScaleState,
  positionToOffset,
  pruneScaleStates,
  pruneXYScales,
  samplesFit,
  scaleStateFor,
  seedManScale,
  setScaleState,
  setXYScale,
  xyScaleFor,
} from './scale';

beforeEach(() => pruneScaleStates([]));

describe('scale grid series', () => {
  it('gridStep returns the smallest 1-2-5-10 value >= the target', () => {
    expect(gridStep(0.032)).toBe(0.05);
    expect(gridStep(0.5)).toBe(0.5);
    expect(gridStep(6)).toBe(10);
    expect(gridStep(1)).toBe(1);
    expect(gridStep(2e-3)).toBe(2e-3);
  });

  it('gridStepX gives the default 10 ms/div and scales with speed', () => {
    expect(gridStepX(64, 5e-6)).toBe(0.01);
    expect(gridStepX(20, 5e-6)).toBe(0.002);
    expect(gridStepX(1, 5e-6)).toBe(1e-4);
  });
});

describe('sticky auto-scale', () => {
  it('doubles in powers of two until the peak fits, then halves once when it fits', () => {
    // 8 exceeds gridMax 5, so one doubling lands on 10.
    expect(nextScaleState({ gridMax: 5, showNegative: false }, 8, -2, false, { maxScale: false })).toEqual({
      gridMax: 10,
      showNegative: false,
    });
    // A fit frame halves once; a spike in the frame blocks the halving.
    expect(nextScaleState({ gridMax: 5, showNegative: false }, 3, -1, true, { maxScale: false })).toEqual({
      gridMax: 2.5,
      showNegative: false,
    });
    expect(nextScaleState({ gridMax: 5, showNegative: false }, 3, -1, false, { maxScale: false })).toEqual({
      gridMax: 5,
      showNegative: false,
    });
  });

  it('maxScale pins the scale to the current frame peak and follows it down', () => {
    expect(
      nextScaleState({ gridMax: 5, showNegative: false }, 7, -7, true, { maxScale: true }),
    ).toEqual({ gridMax: 7, showNegative: false });
    // A smaller signal must shrink the pinned scale: upstream resets the scale
    // to 1e-4 every frame and pins to the current max (Scope.java:622-624,
    // 733-734), so a decaying trace stays legible instead of zoomed out.
    expect(
      nextScaleState({ gridMax: 5, showNegative: false }, 1, -1, true, { maxScale: true }),
    ).toEqual({ gridMax: 1, showNegative: false });
    expect(
      nextScaleState({ gridMax: 8, showNegative: false }, 2, -2, true, { maxScale: true }),
    ).toEqual({ gridMax: 2, showNegative: false });
    // Never halves, and never falls below the 1e-4 reset floor.
    expect(
      nextScaleState({ gridMax: 1, showNegative: false }, 1e-5, 0, true, { maxScale: true }),
    ).toEqual({ gridMax: 1e-4, showNegative: false });
  });
});

describe('reduce-range band', () => {
  const H = 150;

  it('measures the band from zero, not from the display centre', () => {
    // Upstream compares gridMult * (v - gridMid) against +/-10 - gridMid *
    // gridMult, so gridMid cancels and the band is |gridMult * v| <= 10
    // (Scope.java:856-857, 881-884). On a 150 px scope at gridMax 5 that is
    // roughly +/-0.19 V.
    const state = { gridMax: 5, showNegative: false };
    expect(samplesFit([0.1, -0.1], state, H)).toBe(true);
    // 2.6 V sits right by the display centre (gridMid = 2.5): a band centred
    // there would call this reducible.
    expect(samplesFit([2.6], state, H)).toBe(false);
  });

  it('does not halve and re-double a steady mid-scale signal frame after frame', () => {
    // The paused-scope flicker: a steady 2.6 V read as "fits the band" halves
    // the scale to 2.5, which the next frame's doubling pushes straight back
    // to 5, and the trace jumps by 2x every frame. The scale must settle.
    let state = { gridMax: 5, showNegative: false };
    const seen: number[] = [];
    for (let frame = 0; frame < 10; frame++) {
      const drawn = nextScaleState(state, 2.6, 2.6, false, { maxScale: false });
      seen.push(drawn.gridMax);
      const fit = samplesFit([2.6], drawn, H);
      state = nextScaleState(state, 2.6, 2.6, fit, { maxScale: false });
    }
    expect(seen).toEqual(new Array(10).fill(5));
  });

  it('still walks a small signal down one halving per frame', () => {
    // The band must not be so tight that the scale stops coming down: 0.01 V
    // on a gridMax of 5 has to zoom in until it fills the band.
    let state = { gridMax: 5, showNegative: false };
    for (let frame = 0; frame < 12; frame++) {
      const drawn = nextScaleState(state, 0.01, 0, false, { maxScale: false });
      state = nextScaleState(state, 0.01, 0, samplesFit([0.01], drawn, H), { maxScale: false });
    }
    expect(state.gridMax).toBeLessThan(0.2);
    expect(state.gridMax).toBeGreaterThan(0.01);
  });
});

describe('X-Y axis scale', () => {
  it('defaults to a voltage-like X and current-like Y, matching ScopePlot2d', () => {
    expect(xyScaleFor(1)).toEqual({ x: 5, y: 0.1 });
  });

  it('nextAxisScale doubles to contain and halves once when the locus fits', () => {
    expect(nextAxisScale(5, 8, -8, false)).toBe(10);
    expect(nextAxisScale(5, 3, -3, true)).toBe(2.5);
    // A spike blocks the halving.
    expect(nextAxisScale(5, 3, -3, false)).toBe(5);
  });

  it('axisSamplesFit gates the halving on the reduce-range band', () => {
    // scale 5 over 500 px: a sample at 4 maps to ~200 px from centre, so it
    // never fits; a sample near the centre (0.1 -> ~5 px) does.
    expect(axisSamplesFit([0, 4], 5, 500)).toBe(false);
    expect(axisSamplesFit([0, 0.1], 5, 500)).toBe(true);
    // scale 0.1 over 500 px: a 0.08 sample sits ~200 px from the axis centre,
    // outside the 10 px band, so it does not fit; a 0.003 sample (~7.5 px) does.
    expect(axisSamplesFit([0.08], 0.1, 500)).toBe(false);
    expect(axisSamplesFit([0.003], 0.1, 500)).toBe(true);
  });

  it('keeps scale per scope id and prunes removed scopes', () => {
    setXYScale(1, { x: 10, y: 0.4 });
    expect(xyScaleFor(1)).toEqual({ x: 10, y: 0.4 });
    expect(xyScaleFor(2)).toEqual({ x: 5, y: 0.1 });
    // Pruning keeps only the ids in the live set.
    pruneXYScales([2]);
    expect(xyScaleFor(1)).toEqual({ x: 5, y: 0.1 });  // pruned -> defaults
    expect(xyScaleFor(2)).toEqual({ x: 5, y: 0.1 });
  });
});

describe('calcGridParams zero placement', () => {
  it('a unipolar signal keeps zero at the bottom', () => {
    const p = calcGridParams(5, 0, 5, false, 150);
    expect(p.gridMid).toBe(2.5);
    expect(p.gridMax).toBe(2.75);
    expect(p.showNegative).toBe(false);
    // gridMult = maxy / gridMax with maxy = (150-1)/2 = 74.
    expect(p.gridMult).toBeCloseTo(74 / 2.75, 9);
  });

  it('a bipolar signal centres on zero and shows negatives', () => {
    const p = calcGridParams(5, -0.5, 5, false, 150);
    expect(p.showNegative).toBe(true);
    expect(p.gridMid).toBe(0);
    expect(p.gridMax).toBe(5.5);
  });

  it('gridStepY for a 5 V bipolar signal on a 150 px scope is 2', () => {
    // display span 5.5, maxy 74: target 20*5.5/74 = 1.49 -> 2.
    expect(gridStepY({ gridMax: 5, showNegative: true }, 150)).toBe(2);
  });
});

describe('manual scale helpers', () => {
  it('nextHighestScale walks the 1-2-5-10 checkpoints', () => {
    expect(nextHighestScale(1)).toBe(2);
    expect(nextHighestScale(1.2)).toBe(2);
    expect(nextHighestScale(2)).toBe(5);
    expect(nextHighestScale(3)).toBe(5);
    expect(nextHighestScale(5)).toBe(10);
    expect(nextHighestScale(10)).toBe(20);
    expect(nextHighestScale(25)).toBe(50);
  });

  it('nextHighestScale picks the next series value above the target', () => {
    expect(nextHighestScale(1.9)).toBe(2);
    expect(nextHighestScale(2.1)).toBe(5);
  });

  it('nextLowestScale picks the previous series value below the target', () => {
    expect(nextLowestScale(2.1)).toBe(2);
    expect(nextLowestScale(2)).toBe(1);
    expect(nextLowestScale(1)).toBe(0.5);
    expect(nextLowestScale(5)).toBe(2);
    expect(nextLowestScale(10)).toBe(5);
    expect(nextLowestScale(7.5)).toBe(5);
    expect(nextLowestScale(0.05)).toBe(0.02);
    // A mid value steps down to the checkpoint below it and up to the one above.
    expect(nextLowestScale(5.5)).toBe(5);
    expect(nextHighestScale(5)).toBe(10);
  });

  it('seedManScale uses the default 8 divisions', () => {
    // 2*5/8 = 1.25, next series value is 2.
    expect(seedManScale(5, 8)).toBe(2);
  });

  it('barToSpeed follows the 2^(10-bar) law', () => {
    expect(barToSpeed(10)).toBe(1);
    expect(barToSpeed(0)).toBe(1024);
    expect(barToSpeed(7)).toBe(8);
  });

  it('positionToOffset clamps to the upstream +-200 step span', () => {
    expect(positionToOffset(100)).toBe(100);
    expect(positionToOffset(-100)).toBe(-100);
    expect(positionToOffset(300)).toBe(200);
    expect(positionToOffset(-300)).toBe(-200);
  });

  it('dragPlotYPosition maps a drag delta into manVPosition', () => {
    // maxy 74: 74 px up (dy negative) moves +100.
    expect(dragPlotYPosition(0, -74, 74)).toBe(100);
    expect(dragPlotYPosition(50, 74, 74)).toBe(-50);
    // Clamps at the +-200 span.
    expect(dragPlotYPosition(0, -300, 74)).toBe(200);
  });
});

describe('scale state map', () => {
  it('defaults differ by units, matching the upstream scale[] initial values', () => {
    expect(scaleStateFor(99, 'voltage').gridMax).toBe(5);
    expect(scaleStateFor(99, 'power').gridMax).toBe(5);
    expect(scaleStateFor(99, 'current').gridMax).toBe(0.1);
  });

  it('keeps state per plot id across calls and prunes removed ids', () => {
    setScaleState(1, { gridMax: 40, showNegative: true });
    setScaleState(2, { gridMax: 5, showNegative: false });
    expect(scaleStateFor(1, 'voltage')).toEqual({ gridMax: 40, showNegative: true });
    expect(scaleStateFor(2, 'voltage').gridMax).toBe(5);
    pruneScaleStates([1]);
    expect(scaleStateFor(1, 'voltage').gridMax).toBe(40);
    expect(scaleStateFor(2, 'voltage').gridMax).toBe(5);  // 5 = default, id 2 was pruned
  });
});
