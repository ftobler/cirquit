import { describe, expect, it } from 'vitest';
import { parseCircuit, serializeCircuit } from '../../../io/netlist';
import { DEFAULT_SETTINGS } from '../../types';
import { MULTIPLEXER_DEF, MUX_INPUT_MODE_BUS_BUS, muxPins } from './multiplexer';
import type { CircuitElement } from '../../types';

function mk(params: Record<string, number> = {}): CircuitElement {
  return {
    id: 1,
    kind: 'multiplexer',
    x1: 0,
    y1: 0,
    x2: 64,
    y2: 0,
    flags: 0,
    params,
  };
}

describe('multiplexer bus/bus input mode', () => {
  it('uses dump code 184', () => {
    expect(MULTIPLEXER_DEF.dumpCode).toBe('184');
  });

  it('lays out the bus/bus pin table with grouped input buses and one output bus', () => {
    // 2 select bits, 4-bit data width: 4 groups of 4 input bus pins, 2 selects,
    // 4 output bus pins (MultiplexerElm.java:99-129).
    const e = mk({ bits: 2, inputMode: MUX_INPUT_MODE_BUS_BUS, dataBusWidth: 4 });
    const pins = muxPins(e);
    expect(pins).toHaveLength(16 + 2 + 4);
    // Every input pin is a bus pin tagged by its bit within its group.
    const inputs = pins.slice(0, 16);
    for (let g = 0; g < 4; g++) {
      for (let i = 0; i < 4; i++) {
        const p = inputs[g * 4 + i];
        expect(p.side).toBe('W');
        expect(p.pos).toBe(g);
        expect(p.busWidth).toBe(4);
        expect(p.busZ).toBe(i);
        expect(p.text).toBe(`I${g}`);
      }
    }
    // Selects sit south; output bus is dataBusWidth wide on the east.
    const selects = pins.slice(16, 18);
    expect(selects.every((p) => p.side === 'S')).toBe(true);
    const outputs = pins.slice(18, 22);
    expect(outputs).toHaveLength(4);
    for (let i = 0; i < 4; i++) {
      expect(outputs[i].side).toBe('E');
      expect(outputs[i].pos).toBe(0);
      expect(outputs[i].busWidth).toBe(4);
      expect(outputs[i].busZ).toBe(i);
      expect(outputs[i].output).toBe(true);
    }
  });

  it('postCountOf matches the engine for both layouts', () => {
    const bus = mk({ bits: 2, inputMode: MUX_INPUT_MODE_BUS_BUS, dataBusWidth: 4 });
    expect(MULTIPLEXER_DEF.postCountOf?.(bus)).toBe(16 + 2 + 4);
    const individual = mk({ bits: 2 });
    expect(MULTIPLEXER_DEF.postCountOf?.(individual)).toBe(4 + 2 + 1);
  });

  it('offers Individual and Bus-Bus as the only input modes', () => {
    const field = MULTIPLEXER_DEF.fields?.find((f) => f.name === 'inputMode');
    expect(field?.type).toBe('choice');
    expect(field?.choices).toEqual([
      { value: 0, label: 'Individual' },
      { value: MUX_INPUT_MODE_BUS_BUS, label: 'Bus-Bus' },
    ]);
  });

  it('hides the Data Bus Width field outside bus/bus mode', () => {
    const field = MULTIPLEXER_DEF.fields?.find((f) => f.name === 'dataBusWidth');
    expect(field?.visible?.(mk({ bits: 2 }))).toBe(false);
    expect(
      field?.visible?.(mk({ bits: 2, inputMode: MUX_INPUT_MODE_BUS_BUS, dataBusWidth: 4 })),
    ).toBe(true);
  });

  it('round-trips a hand-written bus/bus 184 line byte-for-byte', () => {
    const line = '184 0 0 64 0 0 2 2 4';
    const parsed = parseCircuit(line).elements[0];
    expect(parsed.params.inputMode).toBe(2);
    expect(parsed.params.dataBusWidth).toBe(4);
    const back = serializeCircuit([parsed], DEFAULT_SETTINGS);
    expect(back.split('\n').find((l) => l.startsWith('184 '))).toBe(line);
  });

  it('round-trips a mode-0 184 line as mode 0', () => {
    const line = '184 0 0 64 0 0 2';
    const parsed = parseCircuit(line).elements[0];
    expect(parsed.params.inputMode).toBeUndefined();
    expect(parsed.params.dataBusWidth).toBeUndefined();
    const back = serializeCircuit([parsed], DEFAULT_SETTINGS);
    expect(back.split('\n').find((l) => l.startsWith('184 '))).toBe(line);
  });

  it('reads a lone trailing token as the data bus width of a mode-0 line', () => {
    // The dump writes a bare dataBusWidth in mode 0 whenever it differs from
    // 4, so a single small token must stay a width: reading it as inputMode
    // would silently flip a hand-edited mode-0 line into the grouped bus/bus
    // layout and strand its wires.
    const line = '184 0 0 64 0 0 2 2';
    const parsed = parseCircuit(line).elements[0];
    expect(parsed.params.inputMode).toBeUndefined();
    expect(parsed.params.dataBusWidth).toBe(2);
    const back = serializeCircuit([parsed], DEFAULT_SETTINGS);
    expect(back.split('\n').find((l) => l.startsWith('184 '))).toBe(line);
  });

  it('still reads the two-token inputMode pair into bus/bus mode', () => {
    // The converter emits exactly `<inputMode> <dataBusWidth>` for im="2"
    // (xmlToText.ts), so a genuine pair keeps parsing into the bus layout.
    const line = '184 0 0 64 0 0 1 2 3';
    const parsed = parseCircuit(line).elements[0];
    expect(parsed.params.inputMode).toBe(MUX_INPUT_MODE_BUS_BUS);
    expect(parsed.params.dataBusWidth).toBe(3);
    const back = serializeCircuit([parsed], DEFAULT_SETTINGS);
    expect(back.split('\n').find((l) => l.startsWith('184 '))).toBe(line);
  });

  it('degrades a three-token tail without flipping the input mode', () => {
    // Only exactly two trailing tokens led by 1 or 2 mean the pair; anything
    // longer falls back to the leading token as a width.
    const parsed = parseCircuit('184 0 0 64 0 0 2 2 4 7').elements[0];
    expect(parsed.params.inputMode).toBeUndefined();
    expect(parsed.params.dataBusWidth).toBe(2);
    const back = serializeCircuit([parsed], DEFAULT_SETTINGS);
    expect(back.split('\n').find((l) => l.startsWith('184 '))).toBe('184 0 0 64 0 0 2 2');
  });
});
