import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../model/types';
import type { CircuitElement, DrawContext } from '../model/types';
import { defFor } from '../model/registry';
import { SvgRecorder } from '../render/svg';
import { makeTheme } from '../render/draw';
import { useStore } from '../state/store';
import { fresh } from '../state/store.test-helpers';
import { decodeEmbeddedScope } from './embeddedScope';
import { parseCircuit, serializeCircuit } from './netlist';

const CIRCUITS_DIR = fileURLToPath(new URL('../../public/circuits', import.meta.url));
const read = (file: string) => readFileSync(join(CIRCUITS_DIR, file), 'utf8');

describe('decodeEmbeddedScope units', () => {
  it('decodes a two-plot voltage+current window, the multivib-a wire shape', () => {
    const decoded = decodeEmbeddedScope('12_256_0_4102_5_0.1_0_2_12_3', () => 'wire');
    expect(decoded).not.toBeNull();
    expect(decoded!.plots).toEqual([
      { elementIndex: 12, value: 'voltage' },
      { elementIndex: 12, value: 'current' },
    ]);
    expect(decoded!.display.speed).toBe(256);
    // 4102 = FLAG_PLOTS | showMax-off | showV.
    expect(decoded!.display.showV).toBe(true);
    expect(decoded!.display.showI).toBe(false);
    expect(decoded!.display.showMax).toBe(false);
    expect(decoded!.tokens).toEqual('12_256_0_4102_5_0.1_0_2_12_3'.split('_'));
  });

  it('decodes the capacitor window at speed 128', () => {
    const decoded = decodeEmbeddedScope('8_128_0_4102_5_0.4_0_2_8_3', () => 'capacitor');
    expect(decoded).not.toBeNull();
    expect(decoded!.plots).toEqual([
      { elementIndex: 8, value: 'voltage' },
      { elementIndex: 8, value: 'current' },
    ]);
    expect(decoded!.display.speed).toBe(128);
  });

  it('decodes the qam-256 X-Y window', () => {
    const decoded = decodeEmbeddedScope(
      '157_64_0_4802_4.999999999999999e-16_1e-17_0_2_156_0',
      () => null,
    );
    expect(decoded).not.toBeNull();
    // 4802 = FLAG_PLOTS | showScale | bit 128 | plot2d.enabled | showV.
    expect(decoded!.display.plotXY).toBe(true);
    expect(decoded!.display.showScale).toBe(true);
    expect(decoded!.plots).toEqual([
      { elementIndex: 157, value: 'voltage' },
      { elementIndex: 156, value: 'voltage' },
    ]);
  });

  it('resolves per-element value tokens through the kind callback', () => {
    const decoded = decodeEmbeddedScope(
      '13_64_6_4099_20_0.05_0_2_10_6',
      (i) => (i === 13 || i === 10 ? 'transistor' : null),
    );
    expect(decoded!.plots).toEqual([
      { elementIndex: 13, value: 'vce' },
      { elementIndex: 10, value: 'vce' },
    ]);
  });

  it('rejects a fresh unattached scope, element -1', () => {
    expect(decodeEmbeddedScope('-1_64_0_4096_5_0.1_0_0', () => null)).toBeNull();
  });

  it('rejects a truncated token and a non-numeric element index', () => {
    expect(decodeEmbeddedScope('12_256_0_4102', () => null)).toBeNull();
    expect(decodeEmbeddedScope('x_y_z_a_b_c', () => null)).toBeNull();
  });
});

describe('parseCircuit attachment', () => {
  it('attaches interpreted embedded scopes to multivib-a, keeping text verbatim', () => {
    const parsed = parseCircuit(read('multivib-a.txt'));
    const scopes = parsed.elements.filter((e) => e.kind === 'scope');
    expect(scopes).toHaveLength(4);
    expect(scopes.map((e) => e.text)).toEqual([
      '12_256_0_4102_5_0.1_0_2_12_3',
      '11_256_0_4102_5_0.4_0_2_11_3',
      '8_128_0_4102_5_0.4_0_2_8_3',
      '7_128_0_4102_5_0.1_0_2_7_3',
    ]);

    // File index -> element: 7 is C1, 8 is C2, 11 and 12 are the two cross
    // wires. Every window traces its target as a voltage+current pair.
    const byId = new Map(parsed.elements.map((e) => [e.id, e]));
    const targets = scopes.map((s) =>
      s.embedded!.plots.map((p) => {
        const el = p.elementId !== null ? byId.get(p.elementId) : undefined;
        return { kind: el?.kind ?? null, value: p.value };
      }),
    );
    expect(targets).toEqual([
      [
        { kind: 'wire', value: 'voltage' },
        { kind: 'wire', value: 'current' },
      ],
      [
        { kind: 'wire', value: 'voltage' },
        { kind: 'wire', value: 'current' },
      ],
      [
        { kind: 'capacitor', value: 'voltage' },
        { kind: 'capacitor', value: 'current' },
      ],
      [
        { kind: 'capacitor', value: 'voltage' },
        { kind: 'capacitor', value: 'current' },
      ],
    ]);
    expect(scopes.map((s) => s.embedded!.display.speed)).toEqual([256, 256, 128, 128]);
    // The docked scope is not an embedded one; it has no embedded state.
    expect(scopes.every((s) => s.embedded!.plots.every((p) => p.id > 0))).toBe(true);
  });

  it('decodes the docked o line to two transistor vce plots', () => {
    const parsed = parseCircuit(read('multivib-a.txt'));
    expect(parsed.scopes).toHaveLength(1);
    const plots = parsed.scopes[0].plots.map((p) => ({
      elementIndex: p.elementIndex,
      value: p.value,
    }));
    expect(plots).toEqual([
      { elementIndex: 13, value: 'vce' },
      { elementIndex: 10, value: 'vce' },
    ]);
  });

  it('attaches the qam-256 X-Y window with every plot resolved', () => {
    const parsed = parseCircuit(read('qam-256.txt'));
    const scopes = parsed.elements.filter((e) => e.kind === 'scope');
    expect(scopes).toHaveLength(1);
    expect(scopes[0].text).toBe('157_64_0_4802_4.999999999999999e-16_1e-17_0_2_156_0');
    expect(scopes[0].embedded!.display.plotXY).toBe(true);
    // Both indexes must land on readable element lines: a null here would
    // mean the walk drifted off by one and silently dropped the trace.
    const plots = scopes[0].embedded!.plots;
    expect(plots).toHaveLength(2);
    // File indexes 156 and 157 are both output markers, the two nets this
    // X-Y window plots against each other.
    const byId = new Map(parsed.elements.map((e) => [e.id, e]));
    for (const p of plots) {
      expect(p.elementId).not.toBeNull();
      expect(byId.get(p.elementId!)!.kind).toBe('output');
    }
  });

  it('leaves a fresh unattached scope without embedded state', () => {
    const parsed = parseCircuit('403 100 100 228 164 0 -1_64_0_4096_5_0.1_0_0\n');
    const scope = parsed.elements.find((e) => e.kind === 'scope');
    expect(scope?.text).toBe('-1_64_0_4096_5_0.1_0_0');
    expect(scope?.embedded).toBeUndefined();
  });
});

describe('round-trip', () => {
  it('re-emits multivib-a, five scope lines byte-for-byte while unedited', () => {
    const text = read('multivib-a.txt');
    const parsed = parseCircuit(text);
    const out = serializeCircuit(
      parsed.elements,
      { ...DEFAULT_SETTINGS, ...parsed.settings },
      parsed.scopes,
      parsed.passthrough,
      parsed.order,
      parsed.sliders,
    );
    const srcLines = text.split(/\r\n|\r|\n/);
    const outLines = out.split('\n');
    const scopeHeads = /^(403|o) /;
    expect(srcLines.filter((l) => scopeHeads.test(l))).toHaveLength(5);
    const srcScopes = srcLines.filter((l) => scopeHeads.test(l));
    const outScopes = outLines.filter((l) => scopeHeads.test(l));
    expect(outScopes).toEqual(srcScopes);
  });

  it('re-emits the qam-256 embedded window byte-for-byte', () => {
    const text = read('qam-256.txt');
    const parsed = parseCircuit(text);
    const out = serializeCircuit(
      parsed.elements,
      { ...DEFAULT_SETTINGS, ...parsed.settings },
      parsed.scopes,
      parsed.passthrough,
      parsed.order,
      parsed.sliders,
    );
    const srcLine = text.split(/\r?\n/).find((l) => l.startsWith('403 '))!;
    expect(out.split('\n')).toContain(srcLine);
  });
});

describe('embedded window drawing', () => {
  /** A hand-built 403 element with a resolved two-plot state, the shape
   *  parseCircuit produces for multivib-a. */
  const scopeElement = (): CircuitElement => {
    const text = '2_64_0_4102_5_0.1_0_2_2_3';
    const decoded = decodeEmbeddedScope(text, () => 'resistor')!;
    return {
      id: 7,
      kind: 'scope',
      x1: 0,
      y1: 0,
      x2: 64,
      y2: 32,
      flags: 0,
      params: {},
      text,
      embedded: {
        tokens: decoded.tokens,
        display: decoded.display,
        plots: [
          { id: 101, elementId: 2, value: 'voltage' },
          { id: 102, elementId: 2, value: 'current' },
        ],
      },
    };
  };

  const context = (ctx: DrawContext['ctx']): DrawContext => ({
    ctx,
    theme: makeTheme(),
    voltages: [],
    current: 0,
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
    showVoltageColor: true,
    showPowerColor: false,
    conventional: true,
    euroResistors: true,
    euroGates: true,
    selected: false,
    hovered: false,
    onHighlightedNet: false,
    voltageRange: 5,
    powerRange: 50,
    scale: 1,
    valueDigits: 1,
    valueFontSize: 12,
  });

  it('draws live traces inside the frame when a draw source is present', () => {
    // One engine trace with eight written min/max columns; the current plot
    // is hidden by the file's showI-off flag and never asks for a ring.
    const data = new Float32Array(16 * 2);
    for (let k = 0; k < 8; k++) {
      data[k * 2] = -1;
      data[k * 2 + 1] = 1;
    }
    const source = {
      time: 0.001,
      scopeIndexOf: (id: number) => (id === 101 ? 0 : undefined),
      scopeData: () => data,
      scopeDiverged: () => false,
      triggerInfo: () => {
        throw new Error('a freeRun window never asks for the trigger anchor');
      },
      recentSamples: () => new Float32Array(0),
    };
    const rec = new SvgRecorder();
    const g = context(rec);
    g.scopeDraw = {
      source,
      simTime: 0.001,
      timeStep: 5e-6,
      dark: true,
      decimalDigits: 3,
    };
    defFor('scope')!.draw(g, scopeElement());
    const svg = rec.toString(64, 32);
    // The placeholder caption is gone; the header's time-base readout took
    // its place and the voltage trace stroked in its own colour (the frame
    // strokes in the text colour, so this cannot match on the frame alone).
    expect(svg).not.toContain('>Scope<');
    expect(svg).toContain(`stroke="${makeTheme().positive}"`);
    expect(svg).not.toContain('NaN');
  });

  it('keeps the placeholder caption without interpreted state or a source', () => {
    const bare = { ...scopeElement(), embedded: undefined };
    const rec = new SvgRecorder();
    defFor('scope')!.draw(context(rec), bare);
    const svg = rec.toString(64, 32);
    expect(svg).toContain('>Scope<');
  });
});

describe('store integration', () => {
  it('an undo snapshot deep-clones the embedded state instead of aliasing it', () => {
    useStore.setState(fresh());
    useStore.getState().loadNetlist(read('multivib-a.txt'), { noCenter: true, noBaseline: true });
    const before = useStore.getState().elements.find((e) => e.kind === 'scope')!.embedded!;
    // A gesture baseline pushes a clone of the loaded document; the undo back
    // to it must hand back an equal but independent copy.
    useStore.getState().commit();
    useStore.getState().updateElement(
      useStore.getState().elements.find((e) => e.kind !== 'scope')!.id,
      { x1: 4 },
    );
    useStore.getState().undo();
    const after = useStore.getState().elements.find((e) => e.kind === 'scope')!.embedded!;
    expect(after).toEqual(before);
    expect(after.plots[0]).not.toBe(before.plots[0]);
    expect(after.display.perPlot[0]).not.toBe(before.display.perPlot[0]);
  });
});
