import { describe, expect, it } from 'vitest';
import { parseCircuit, serializeCircuit } from './index';
import { makeElement } from '../../state/store';
import { postsOf } from '../../model/registry';
import { OUTPUT_FIXED, OUTPUT_SHOW_VOLTAGE } from '../../model/registry/flags';
import { DEFAULT_SETTINGS, type CircuitElement } from '../../model/types';

describe('probe file format', () => {
  const probeLine = (line: string) => {
    const [e] = parseCircuit(line).elements;
    const out = serializeCircuit([e], { ...DEFAULT_SETTINGS }).trim();
    return { e, elementLine: out.split('\n').find((l) => l.startsWith('p ')) ?? '' };
  };

  it('a fresh probe dumps the upstream constructor defaults', () => {
    const e = makeElement('probe', 0, 0, 32, 0);
    expect(e.flags).toBe(3);
    expect(e.params).toEqual({ meter: 0, scale: 0, resistance: 1e7 });
    const out = serializeCircuit([{ ...e, id: 1 }], { ...DEFAULT_SETTINGS }).trim();
    expect(out).toContain('p 0 0 32 0 3 0 0 10000000');
  });

  it('a legacy probe line without the resistance token stays ideal', () => {
    // peak-detect.txt's exact shape. Upstream's file constructor defaults the
    // resistance to 0 and only the third token overrides it (ProbeElm.java:61),
    // so the 10 M `defaults` above must not leak into a tokenless line: 31
    // corpus probes stop after 6 or 7 tokens and would all load with a 10 M
    // load across what they measure.
    const { e, elementLine } = probeLine('p 80 64 80 288 0');
    expect(e.flags).toBe(0);
    expect(e.params.resistance).toBe(0);
    // A save writes all three tokens, exactly as upstream's dump() does.
    expect(elementLine).toBe('p 80 64 80 288 0 0 0 0');
  });

  it('a full probe line keeps its meter and resistance tokens', () => {
    const line = 'p 80 64 80 288 3 1 0 10000000';
    const { e, elementLine } = probeLine(line);
    expect(e.flags).toBe(3);
    expect(e.params.meter).toBe(1);
    expect(e.params.scale).toBe(0);
    expect(e.params.resistance).toBe(1e7);
    expect(elementLine).toBe(line);
  });
});

describe('output file format', () => {
  const outputLine = (line: string) => {
    const [e] = parseCircuit(line).elements;
    const out = serializeCircuit([e], { ...DEFAULT_SETTINGS }).trim();
    return { e, elementLine: out.split('\n').find((l) => l.startsWith('O ')) ?? '' };
  };

  it('round-trips the seven-token corpus shape byte-for-byte', () => {
    // allpass1.txt's line: flags 0, scale 0 (auto). The output draws the
    // literal `out` under these flags, the 116 flagless corpus lines' reading.
    const { e, elementLine } = outputLine('O 416 224 480 224 0 0');
    expect([e.x1, e.y1]).toEqual([416, 224]);
    expect([e.x2, e.y2]).toEqual([480, 224]);
    expect(e.flags).toBe(0);
    expect(e.params.scale).toBe(0);
    expect(elementLine).toBe('O 416 224 480 224 0 0');
  });

  it('keeps the FLAG_VALUE|FLAG_FIXED flags and the V scale', () => {
    // The corpus's one fixed-scale output: flags 3 (show voltage and fixed
    // precision), scale 1 (V).
    const { e, elementLine } = outputLine('O 448 144 496 144 3 1');
    expect(e.flags).toBe(OUTPUT_SHOW_VOLTAGE | OUTPUT_FIXED);
    expect(e.params.scale).toBe(1);
    expect(elementLine).toBe('O 448 144 496 144 3 1');
  });

  it('a six-token line defaults its scale to auto and writes it on save', () => {
    // The corpus's dominant shape stops after the flags; the scale reads as
    // absent and the draw falls back to auto. A save appends the scale token,
    // the same always-write policy the probe's dump has.
    const { e, elementLine } = outputLine('O 416 224 480 224 0');
    expect(e.flags).toBe(0);
    expect(e.params.scale).toBeUndefined();
    expect(elementLine).toBe('O 416 224 480 224 0 0');
  });

  it('connects only at the first endpoint, never at the free end', () => {
    const { e } = outputLine('O 416 224 480 224 0 0');
    expect(postsOf(e)).toEqual([{ x: 416, y: 224 }]);
  });
});

describe('instrument file formats (batch I)', () => {
  const lineFor = (e: CircuitElement) =>
    serializeCircuit([e], { ...DEFAULT_SETTINGS }).trim().split('\n').join('\n');

  it('216 ohmmeter round-trips the current-source tokens', () => {
    const line = '216 80 64 80 288 0 0.01 0';
    const [e] = parseCircuit(line).elements;
    expect(e.kind).toBe('ohmmeter');
    expect(e.params.current).toBe(0.01);
    expect(e.params.maxVoltage).toBe(0);
    const out = lineFor(e);
    expect(out).toContain(line);
  });

  it('a fresh ohmmeter dumps the current-source defaults', () => {
    const e = makeElement('ohmmeter', 0, 0, 32, 0);
    expect(e.params).toEqual({ current: 0.01, maxVoltage: 0 });
    expect(lineFor({ ...e, id: 1 })).toContain('216 0 0 32 0 0 0.01 0');
  });

  it('368 test point round-trips the meter and an escaped label', () => {
    const line = '368 80 64 80 288 1 3 my\\sLabel';
    const [e] = parseCircuit(line).elements;
    expect(e.kind).toBe('testPoint');
    expect(e.flags).toBe(1);
    expect(e.params.meter).toBe(3);
    expect(e.text).toBe('my Label');
    expect(lineFor(e)).toContain(line);
  });

  it('a fresh test point dumps the default TP without a label token', () => {
    const e = makeElement('testPoint', 0, 0, 32, 0);
    expect(e.text).toBe('TP');
    expect(e.params).toEqual({ meter: 0 });
    const out = lineFor({ ...e, id: 1 });
    // The default label is not dumped and FLAG_LABEL (bit 1) is cleared, so a
    // save never invents a label the file did not carry.
    expect(out).toContain('368 0 0 32 0 0 0');
  });

  it('a tokenless 368 test point keeps the TP default and the meter', () => {
    // Upstream's own dump() never writes the meter or label, so a bare line is
    // legal; the meter token is the only thing that may follow the flags.
    const line = '368 80 64 80 288 0 2';
    const [e] = parseCircuit(line).elements;
    expect(e.params.meter).toBe(2);
    expect(e.text).toBe('TP');
    expect(lineFor(e)).toContain(line);
  });

  it('420 wattmeter round-trips width and meter', () => {
    const line = '420 80 64 80 288 0 32 1';
    const [e] = parseCircuit(line).elements;
    expect(e.kind).toBe('wattmeter');
    expect(e.params.width).toBe(32);
    expect(e.params.meter).toBe(1);
    expect(lineFor(e)).toContain(line);
  });

  it('a fresh wattmeter dumps the grid default width', () => {
    const e = makeElement('wattmeter', 0, 0, 32, 0);
    expect(e.params).toEqual({ width: 16, meter: 0 });
    expect(lineFor({ ...e, id: 1 })).toContain('420 0 0 32 0 0 16 0');
  });

  it('210 data recorder round-trips dataCount', () => {
    const line = '210 80 64 80 288 0 2048';
    const [e] = parseCircuit(line).elements;
    expect(e.kind).toBe('dataRecorder');
    expect(e.params.dataCount).toBe(2048);
    expect(lineFor(e)).toContain(line);
  });

  it('a fresh data recorder dumps the upstream 10240 default', () => {
    const e = makeElement('dataRecorder', 0, 0, 32, 0);
    expect(e.params).toEqual({ dataCount: 10240 });
    expect(lineFor({ ...e, id: 1 })).toContain('210 0 0 32 0 0 10240');
  });

  it('408 stop trigger round-trips its four tokens', () => {
    const line = '408 80 64 80 288 0 2.5 1 0.01 3';
    const [e] = parseCircuit(line).elements;
    expect(e.kind).toBe('stopTrigger');
    expect(e.params.triggerVoltage).toBe(2.5);
    expect(e.params.type).toBe(1);
    expect(e.params.delay).toBe(0.01);
    expect(e.params.count).toBe(3);
    expect(lineFor(e)).toContain(line);
  });

  it('a fresh stop trigger dumps the four constructor defaults', () => {
    const e = makeElement('stopTrigger', 0, 0, 32, 0);
    expect(e.params).toEqual({ triggerVoltage: 1, type: 0, delay: 0, count: 1 });
    expect(lineFor({ ...e, id: 1 })).toContain('408 0 0 32 0 0 1 0 0 1');
  });
});

describe('ammeter file format', () => {
  /** Parses a single `370` line and re-emits it, returning that line. */
  const ammeterLine = (line: string) => {
    const [e] = parseCircuit(line).elements;
    const out = serializeCircuit([e], { ...DEFAULT_SETTINGS }).trim();
    const elementLine = out.split('\n').find((l) => l.startsWith('370 ')) ?? '';
    return { e, elementLine };
  };

  it('round-trips the meter mode, scale and flag bits byte-for-byte', () => {
    // meter scale (AmmeterElm.java's token constructor). Flags 3 are the
    // ammeter's own pair: bit 1 Show Current, bit 2 Circular Symbol.
    const line = '370 512 336 640 336 3 1 2';
    const { e, elementLine } = ammeterLine(line);
    expect(e.flags).toBe(3);
    expect(e.params.meter).toBe(1);
    expect(e.params.scale).toBe(2);
    expect(elementLine).toBe(line);
  });

  it('a wheatstone corpus line missing the scale token saves it as auto', () => {
    // wheatstone.txt carries `... 1 0`: meter only. The defaults seed scale
    // to 0, so the save appends the token rather than shortening the stream.
    const { e, elementLine } = ammeterLine('370 512 336 640 336 1 0');
    expect(e.params.meter).toBe(0);
    expect(e.params.scale).toBe(0);
    expect(elementLine).toBe('370 512 336 640 336 1 0 0');
  });
});
