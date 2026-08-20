import { describe, expect, it } from 'vitest';
import { parseCircuit, serializeCircuit } from '../../../io/netlist';
import { DEFAULT_SETTINGS } from '../../types';
import {
  DEFAULT_LOOKUP,
  INSTRUCTION_DISPLAY_DEF,
  instructionDisplayPosts,
  instructionDisplayText,
} from './instructionDisplay';
import type { CircuitElement } from '../../types';

function mk(): CircuitElement {
  return {
    id: 1,
    kind: 'instructionDisplay',
    x1: 0,
    y1: 0,
    x2: 64,
    y2: 0,
    flags: 0,
    params: { ...(INSTRUCTION_DISPLAY_DEF.defaults ?? {}) },
    text: DEFAULT_LOOKUP,
  };
}

describe('instruction display', () => {
  it('uses dump code 434', () => {
    expect(INSTRUCTION_DISPLAY_DEF.dumpCode).toBe('434');
  });

  it('parses and dumps bus width, threshold and lookup table round-trip', () => {
    const e = mk();
    e.params.busWidth = 8;
    e.params.threshold = 1.5;
    e.text = '0=zero\n3=three\n0x4-0x7=hi ({a})';
    const line = serializeCircuit([e], DEFAULT_SETTINGS);
    expect(line.split('\n').find((l) => l.startsWith('434 '))).toBeDefined();
    const back = parseCircuit(line).elements[0];
    expect(back.params.busWidth).toBe(8);
    expect(back.params.threshold).toBe(1.5);
    expect(back.text).toBe('0=zero\n3=three\n0x4-0x7=hi ({a})');
  });

  it('escapes newlines in the lookup table on save and restores them', () => {
    const e = mk();
    e.text = '0=a\n1=b';
    const line = serializeCircuit([e], DEFAULT_SETTINGS);
    expect(line).toContain('\\n');
    const back = parseCircuit(line).elements[0];
    expect(back.text).toBe('0=a\n1=b');
  });

  it('lays out one post per bus bit, vertically centred on the anchor', () => {
    const e = mk();
    e.params.busWidth = 4;
    const posts = instructionDisplayPosts(e);
    expect(posts).toHaveLength(4);
    expect(posts[0]).toEqual({ x: 0, y: -24 });
    expect(posts[3]).toEqual({ x: 0, y: 24 });
  });

  it('postCountOf equals the bus width', () => {
    const e = mk();
    e.params.busWidth = 8;
    expect(INSTRUCTION_DISPLAY_DEF.postCountOf?.(e)).toBe(8);
  });

  it('maps the value through the lookup table', () => {
    const lookup = '0=text0\n1=text1\n0x2-0xF=other ({a})';
    expect(instructionDisplayText(0, lookup)).toBe('text0');
    expect(instructionDisplayText(1, lookup)).toBe('text1');
    expect(instructionDisplayText(5, lookup)).toBe('other (5)');
    // No matching entry falls back to the decimal value.
    expect(instructionDisplayText(20, lookup)).toBe('20');
  });
});
