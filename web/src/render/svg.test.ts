import { describe, expect, it } from 'vitest';
import { SvgRecorder, renderCircuitToSvg } from './svg';
import { makeTheme, voltageColor } from './draw';
import { RESISTOR_DEF } from '../model/registry/elements/resistor';
import { INDUCTOR_DEF } from '../model/registry/elements/inductor';
import { DEFAULT_SETTINGS, type CircuitElement, type DrawContext } from '../model/types';
import type { SimEngine } from '../engine/simulator';

/** A fake engine returning flat zero arrays with the given per-element render
 *  states, enough for `drawAllElements` to colour and animate an export. The
 *  real engine is wasm-backed and cannot run under node. */
function fakeEngine(states: number[]): SimEngine {
  return {
    nodeVoltages: () => new Float64Array(2),
    elementNodes: () => new Uint32Array(2),
    elementCurrents: () => new Float64Array(states.length),
    elementValues: () => new Float64Array(states.length),
    elementStates: () => new Float64Array(states),
    indexOf: (id: number) => (id === 1 ? 0 : undefined),
    postOffset: () => 0,
  } as unknown as SimEngine;
}

/** A DrawContext on a fresh recorder, the same fields the canvas path sets. */
function drawCtx(rec: SvgRecorder): DrawContext {
  return {
    ctx: rec,
    theme: makeTheme(false, DEFAULT_SETTINGS),
    voltages: [0, 0],
    current: 1e-3,
    voltage: 0,
    power: 0,
    value: 0,
    state: 0,
    wave: [],
    dotPhase: 0,
    postCurrents: [],
    postDotPhases: [],
    showCurrent: false,
    showValues: false,
    showVoltageColor: false,
    showPowerColor: false,
    conventional: true,
    euroResistors: true,
    euroGates: false,
    selected: false,
    hovered: false,
    onHighlightedNet: false,
    voltageRange: 5,
    powerRange: 50,
    scale: 1,
    valueDigits: 1,
    valueFontSize: 12,
  };
}

/** A fresh recorder with an identity transform and default styles. */
function rec(): SvgRecorder {
  return new SvgRecorder();
}

describe('SvgRecorder paths', () => {
  it('emits a stroked path from a polyline with the stroke style', () => {
    const r = rec();
    r.strokeStyle = '#ff0000';
    r.lineWidth = 2;
    r.beginPath();
    r.moveTo(0, 0);
    r.lineTo(32, 0);
    r.stroke();
    expect(r.toString(100, 100)).toContain(
      '<path d="M0 0L32 0" fill="none" stroke="#ff0000" stroke-width="2"',
    );
  });

  it('emits a filled shape with no stroke', () => {
    const r = rec();
    r.fillStyle = '#00ff00';
    r.beginPath();
    r.moveTo(0, 0);
    r.lineTo(16, 16);
    r.lineTo(0, 32);
    r.closePath();
    r.fill();
    const svg = r.toString(64, 64);
    expect(svg).toContain('<path d="M0 0L16 16L0 32Z" fill="#00ff00"');
    expect(svg).not.toContain('stroke=');
  });

  it('emits a rect from fillRect with the current fillStyle', () => {
    const r = rec();
    r.fillStyle = '#abcdef';
    r.fillRect(10, 20, 30, 40);
    expect(r.toString(100, 100)).toContain(
      '<rect x="10" y="20" width="30" height="40" fill="#abcdef"',
    );
  });

  it('emits an arc path starting with M and containing A', () => {
    const r = rec();
    r.beginPath();
    r.arc(0, 0, 10, 0, Math.PI);
    r.stroke();
    expect(r.toString(100, 100)).toContain('d="M10 0A10 10 0 0 1 -10 0"');
  });

  it('sweeps a wrap-around arc the long way through 0/2π', () => {
    // counterclockwise=false from 3π/2 travels 270°→360°→90°, a π arc through
    // the +x axis; the |end-start| short way would point the wrong way.
    const r = rec();
    r.beginPath();
    r.arc(0, 0, 10, (3 * Math.PI) / 2, Math.PI / 2);
    r.stroke();
    expect(r.toString(100, 100)).toContain('d="M0 -10A10 10 0 0 1 0 10"');
  });

  it('marks a counterclockwise wrap-around arc as large', () => {
    // counterclockwise=true from π/4 to 3π/4 travels the 270° way around
    // through 0; the reduced sweep must set largeArc even though the raw
    // angle difference is small.
    const r = rec();
    r.beginPath();
    r.arc(0, 0, 10, Math.PI / 4, (3 * Math.PI) / 4, true);
    r.stroke();
    expect(r.toString(100, 100)).toContain('d="M7.071 7.071A10 10 0 1 0 -7.071 7.071"');
  });

  it('splits a full circle into two arcs', () => {
    const r = rec();
    r.beginPath();
    r.arc(0, 0, 10, 0, Math.PI * 2);
    r.stroke();
    expect(r.toString(100, 100)).toContain('d="M10 0A10 10 0 1 1 -10 0A10 10 0 1 1 10 0"');
  });

  it('connects an arc after a moveTo from the current point', () => {
    const r = rec();
    r.beginPath();
    r.moveTo(0, 0);
    r.arc(0, 0, 10, 0, Math.PI);
    r.stroke();
    expect(r.toString(100, 100)).toContain('d="M0 0L10 0A10 10 0 0 1 -10 0"');
  });

  it('emits a closed four-corner path from rect', () => {
    const r = rec();
    r.beginPath();
    r.rect(0, 0, 10, 5);
    r.stroke();
    expect(r.toString(100, 100)).toContain('d="M0 0L10 0L10 5L0 5Z"');
  });

  it('keeps the path across fill and stroke so a filled circle strokes too', () => {
    const r = rec();
    r.fillStyle = '#123456';
    r.beginPath();
    r.arc(0, 0, 10, 0, Math.PI * 2);
    r.fill();
    r.stroke();
    const svg = r.toString(100, 100);
    expect(svg).toContain('<path d="M10 0A10 10 0 1 1 -10 0A10 10 0 1 1 10 0" fill="#123456"');
    expect(svg).toContain('<path d="M10 0A10 10 0 1 1 -10 0A10 10 0 1 1 10 0" fill="none"');
  });
});

describe('SvgRecorder transforms', () => {
  it('attaches the scaled-and-translated matrix to an emitted shape', () => {
    const r = rec();
    r.scale(2, 2);
    r.translate(10, 20);
    r.beginPath();
    r.moveTo(0, 0);
    r.lineTo(16, 0);
    r.stroke();
    expect(r.toString(100, 100)).toContain('transform="matrix(2 0 0 2 20 40)"');
  });

  it('restores the prior matrix after save/restore', () => {
    const r = rec();
    r.scale(3, 3);
    r.save();
    r.scale(2, 2);
    r.beginPath();
    r.moveTo(0, 0);
    r.lineTo(1, 0);
    r.stroke();
    r.restore();
    r.beginPath();
    r.moveTo(0, 0);
    r.lineTo(2, 0);
    r.stroke();
    const svg = r.toString(100, 100);
    expect(svg).toContain('transform="matrix(6 0 0 6 0 0)"');
    expect(svg).toContain('transform="matrix(3 0 0 3 0 0)"');
  });

  it('restores style state like globalAlpha', () => {
    const r = rec();
    r.save();
    r.globalAlpha = 0.5;
    r.beginPath();
    r.moveTo(0, 0);
    r.lineTo(10, 0);
    r.stroke();
    r.restore();
    r.beginPath();
    r.moveTo(0, 0);
    r.lineTo(10, 0);
    r.stroke();
    const svg = r.toString(100, 100);
    expect(svg.match(/opacity="0.5"/)).not.toBeNull();
    expect(svg.match(/opacity="0.5"/)).toHaveLength(1);
  });

  it('setLineDash yields a stroke-dasharray and globalAlpha an opacity', () => {
    const r = rec();
    r.setLineDash([4, 3]);
    r.globalAlpha = 0.5;
    r.beginPath();
    r.moveTo(0, 0);
    r.lineTo(10, 0);
    r.stroke();
    const svg = r.toString(100, 100);
    expect(svg).toContain('stroke-dasharray="4,3"');
    expect(svg).toContain('opacity="0.5"');
  });

  it('emits no dasharray after setLineDash([])', () => {
    const r = rec();
    r.setLineDash([4, 3]);
    r.setLineDash([]);
    r.beginPath();
    r.moveTo(0, 0);
    r.lineTo(10, 0);
    r.stroke();
    expect(r.toString(100, 100)).not.toContain('stroke-dasharray');
  });

  it('restores the full style state on restore', () => {
    const r = rec();
    r.fillStyle = '#111111';
    r.strokeStyle = '#222222';
    r.font = '20px serif';
    r.textAlign = 'center';
    r.textBaseline = 'middle';
    r.setLineDash([1, 2]);
    r.save();
    r.fillStyle = '#ffffff';
    r.strokeStyle = '#ffffff';
    r.font = '40px serif';
    r.textAlign = 'left';
    r.textBaseline = 'top';
    r.setLineDash([9, 9]);
    r.beginPath();
    r.moveTo(0, 0);
    r.lineTo(10, 0);
    r.stroke();
    r.fillText('x', 0, 0);
    r.restore();
    r.beginPath();
    r.moveTo(0, 0);
    r.lineTo(10, 0);
    r.stroke();
    r.fillText('y', 0, 0);
    const svg = r.toString(100, 100);
    expect(svg).toContain('stroke="#ffffff"');
    expect(svg).toContain('stroke-dasharray="9,9"');
    expect(svg).toContain('font-size="40"');
    expect(svg).toContain('text-anchor="start"');
    expect(svg).toContain('dominant-baseline="text-before-edge"');
    expect(svg).toContain('stroke="#222222"');
    expect(svg).toContain('stroke-dasharray="1,2"');
    expect(svg).toContain('font-size="20"');
    expect(svg).toContain('fill="#111111"');
    expect(svg).toContain('text-anchor="middle"');
    expect(svg).toContain('dominant-baseline="central"');
  });
});

describe('SvgRecorder text', () => {
  it('emits text with the parsed font size, alignment and escaped content', () => {
    const r = rec();
    r.font = "12px 'Roboto Variable', Roboto, system-ui, sans-serif";
    r.fillStyle = '#123456';
    r.textAlign = 'center';
    r.textBaseline = 'middle';
    r.fillText('a<b&c', 4, 8);
    const svg = r.toString(64, 64);
    expect(svg).toContain('<text x="4" y="8" font-size="12"');
    expect(svg).toContain('font-family="&#39;Roboto Variable&#39;, Roboto, system-ui, sans-serif"');
    expect(svg).toContain('text-anchor="middle"');
    expect(svg).toContain('dominant-baseline="central"');
    expect(svg).toContain('fill="#123456"');
    expect(svg).toContain('>a&lt;b&amp;c</text>');
  });

  it('maps left and right alignment to the SVG anchors', () => {
    const left = rec();
    left.textAlign = 'left';
    left.fillText('x', 0, 0);
    expect(left.toString(10, 10)).toContain('text-anchor="start"');
    const right = rec();
    right.textAlign = 'right';
    right.fillText('x', 0, 0);
    expect(right.toString(10, 10)).toContain('text-anchor="end"');
  });

  it('measureText returns the length-times-size heuristic', () => {
    const r = rec();
    r.font = '16px sans-serif';
    expect(r.measureText('abcd').width).toBeCloseTo(16 * 4 * 0.6, 10);
  });
});

describe('renderCircuitToSvg', () => {
  const circuit = (): CircuitElement[] => [
    { id: 1, kind: 'wire', x1: 0, y1: 0, x2: 64, y2: 0, flags: 0, params: {} },
    {
      id: 2,
      kind: 'resistor',
      x1: 64,
      y1: 0,
      x2: 128,
      y2: 0,
      flags: 0,
      params: { resistance: 1000 },
    },
  ];

  it('emits a complete svg document with the export geometry', () => {
    const svg = renderCircuitToSvg(circuit(), DEFAULT_SETTINGS, false, null);
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
    expect(svg).toContain('width="396"');
    expect(svg).toContain('height="100"');
  });

  it('emits round caps on the wire stroke and butt on the resistor', () => {
    // The recorder copies whatever strokeStyle sets, so the wire's round cap
    // must reach the SVG while the resistor's leads and body keep butt. The
    // circuit is one wire plus one IEC resistor: one round stroke, and three
    // butt strokes (two leads plus the body's single gradient stroke).
    const svg = renderCircuitToSvg(circuit(), DEFAULT_SETTINGS, false, null);
    expect(svg.match(/stroke-linecap="round"/g)).toHaveLength(1);
    expect(svg.match(/stroke-linecap="butt"/g)).toHaveLength(3);
  });

  it('exports the coil with bevel joins and a resistor body with miter', () => {
    // The recorder mirrors lineJoin into stroke-linejoin, so the coil's bevel
    // must reach the SVG while a resistor body and every other polyline keep
    // miter. Export is what gets shared, so the join has to survive it.
    const coil = new SvgRecorder();
    INDUCTOR_DEF.draw(drawCtx(coil), {
      id: 1,
      kind: 'inductor',
      x1: 0,
      y1: 0,
      x2: 64,
      y2: 0,
      flags: 0,
      params: { inductance: 1e-3 },
    });
    const coilSvg = coil.toString(200, 100);
    expect(coilSvg).toContain('stroke-linejoin="bevel"');
    const res = new SvgRecorder();
    RESISTOR_DEF.draw(drawCtx(res), {
      id: 1,
      kind: 'resistor',
      x1: 0,
      y1: 0,
      x2: 64,
      y2: 0,
      flags: 0,
      params: { resistance: 1000 },
    });
    const resSvg = res.toString(200, 100);
    expect(resSvg).toContain('stroke-linejoin="miter"');
    expect(resSvg).not.toContain('stroke-linejoin="bevel"');
  });

  it('carries the 3-unit body stroke weight into the export', () => {
    // The recorder emits `this.lineWidth` as stroke-width (svg.ts:256), so the
    // default 3 (drawThickLine, CircuitElm.java:1007-1021) must reach the SVG
    // for bodies and wires, and no 2-unit remnant may survive.
    const svg = renderCircuitToSvg(circuit(), DEFAULT_SETTINGS, false, null);
    expect(svg.match(/stroke-width="3"/g)?.length).toBeGreaterThan(0);
    expect(svg).not.toContain('stroke-width="2"');
  });

  it('strokes the IEC resistor body as one closed path with a real gradient', () => {
    // The body shades along the voltage drop, so it is no longer 44 per-segment
    // strokes: one closed box path carries a `url(#g0)` linear gradient whose
    // axis runs lead1 (80,0) to lead2 (112,0). The closePath join makes the
    // start corner a real join like the other three, which the repeated-first-
    // point alone would not.
    const svg = renderCircuitToSvg(circuit(), DEFAULT_SETTINGS, false, null);
    expect(svg).toContain('d="M80 -6L112 -6L112 6L80 6L80 -6Z"');
    expect(svg).toContain('stroke="url(#g0)"');
    expect(svg).toContain('gradientUnits="userSpaceOnUse" x1="80" y1="0" x2="112" y2="0"');
  });

  it('exports a gradient body as a linearGradient def with distinct stop colours', () => {
    // A body with 10 V across it must export as a real `<linearGradient>`
    // referenced by `stroke="url(#g0)"`, with stops at the exact breakpoints
    // of the colour ramp: 0 and 0.5 at the clamped positive colour, 1 at the
    // neutral 0 V end. The old per-segment export is gone entirely.
    const rec = new SvgRecorder();
    const g: DrawContext = {
      ctx: rec,
      theme: makeTheme(false, DEFAULT_SETTINGS),
      voltages: [10, 0],
      current: 1e-3,
      voltage: 10,
      power: 0.01,
      value: 0,
      state: 0,
      wave: [],
      dotPhase: 0,
      postCurrents: [],
      postDotPhases: [],
      showCurrent: false,
      showValues: false,
      showVoltageColor: true,
      showPowerColor: false,
      conventional: true,
      euroResistors: true,
      euroGates: false,
      selected: false,
      hovered: false,
      onHighlightedNet: false,
      voltageRange: 5,
      powerRange: 50,
      scale: 1,
      valueDigits: 1,
      valueFontSize: 12,
    };
    RESISTOR_DEF.draw(g, {
      id: 1,
      kind: 'resistor',
      x1: 0,
      y1: 0,
      x2: 64,
      y2: 0,
      flags: 0,
      params: { resistance: 1000 },
    });
    const svg = rec.toString(200, 100);
    expect(svg).toContain('<defs>');
    expect(svg).toContain('<linearGradient id="g0"');
    expect(svg).toContain('stroke="url(#g0)"');
    // The ramp colours are the printable theme's own, not the light palette's:
    // 10 V clamps to the positive colour and 0 V is the neutral, with the
    // v=5 kink also clamped positive at offset 0.5.
    expect(svg).toContain(`<stop offset="0" stop-color="${voltageColor(g, 10)}"/>`);
    expect(svg).toContain(`<stop offset="0.5" stop-color="${voltageColor(g, 10)}"/>`);
    expect(svg).toContain(`<stop offset="1" stop-color="${voltageColor(g, 0)}"/>`);
    // No CanvasGradient may ever reach the recorder's string form.
    expect(svg).not.toContain('[');
  });

  it('fills the white background like the PNG export', () => {
    const svg = renderCircuitToSvg(circuit(), DEFAULT_SETTINGS, false, null);
    expect(svg).toContain('<rect x="0" y="0" width="396" height="100" fill="#ffffff"');
  });

  it('draws the elements as path and text markup', () => {
    const svg = renderCircuitToSvg(circuit(), DEFAULT_SETTINGS, false, null);
    expect(svg).toContain('<path');
    expect(svg).toContain('</text>');
  });

  it('runs headless for an empty circuit too', () => {
    const svg = renderCircuitToSvg([], DEFAULT_SETTINGS, false, null);
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
    expect(svg).toContain('<rect');
  });

  it('applies the export scale and margin translation to every shape', () => {
    const elements: CircuitElement[] = [
      { id: 1, kind: 'wire', x1: 0, y1: 0, x2: 64, y2: 0, flags: 0, params: {} },
      {
        id: 2,
        kind: 'resistor',
        x1: 64,
        y1: 0,
        x2: 128,
        y2: 0,
        flags: 0,
        params: { resistance: 1000 },
      },
      { id: 3, kind: 'wire', x1: 128, y1: 0, x2: 128, y2: 64, flags: 0, params: {} },
    ];
    // exportGeometry on these bounds: scale = min((2*128+140)/(128+140),
    // (2*64+100)/(64+100)) = 1.3902, and the transform composes scale with
    // translate(-(minX - 70), -(minY - 50)) = (70, 50) in the scaled space, so
    // the translation entries are scale * 70 and scale * 50, both positive.
    const trim = (n: number) => Math.round(n * 1000) / 1000;
    const scale = Math.min(396 / 268, 228 / 164);
    const matrix = `matrix(${trim(scale)} 0 0 ${trim(scale)} ${trim(scale * 70)} ${trim(scale * 50)})`;
    const svg = renderCircuitToSvg(elements, DEFAULT_SETTINGS, false, null);
    expect(svg).toContain(`transform="${matrix}"`);
  });

  it('exports a blown fuse as the open gap, not the melting wire', () => {
    // The engine's per-element render state reaches the export through the
    // same elementStates array as the live canvas, so an SVG of a circuit
    // saved after a pop must show the gap. An intact fuse exports one extra
    // path: the 16-segment sine body.
    const fuse: CircuitElement = {
      id: 1,
      kind: 'fuse',
      x1: 0,
      y1: 0,
      x2: 160,
      y2: 0,
      flags: 0,
      params: {},
    };
    const blown = renderCircuitToSvg([fuse], DEFAULT_SETTINGS, false, fakeEngine([2]));
    expect(blown.match(/<path /g)).toHaveLength(2); // two leads only
    const intact = renderCircuitToSvg([fuse], DEFAULT_SETTINGS, false, fakeEngine([0]));
    expect(intact.match(/<path /g)).toHaveLength(3); // leads plus the sine body
  });
});
