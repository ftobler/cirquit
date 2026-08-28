import { describe, expect, it } from 'vitest';
import type { XmlNode } from './xml';
import {
  attr,
  compositeModel,
  diodeModel,
  transistorModel,
} from './xmlModelLines';
import { modelToEngineSpec, parseCompositeModelLine } from './subcircuits';

/** Builds an `XmlNode` without children boilerplate. */
function node(tag: string, attrs: Record<string, string>, children: XmlNode[] = []): XmlNode {
  return { tag, attrs, children, text: '' };
}

describe('xmlModelLines attr', () => {
  it('returns the fallback when the attribute is absent', () => {
    expect(attr(node('dm', {}), 'f', 0)).toBe(0);
    expect(attr(node('dm', {}), 'is', 1e-14)).toBe(1e-14);
  });

  it('parses a present numeric attribute', () => {
    expect(attr(node('dm', { f: '3' }), 'f', 0)).toBe(3);
    expect(attr(node('dm', { is: '2e-12' }), 'is', 1e-14)).toBe(2e-12);
  });

  it('throws on a non-numeric attribute so a broken file fails loudly', () => {
    expect(() => attr(node('dm', { f: 'abc' }), 'f', 0)).toThrow(/not a number/);
  });
});

describe('xmlModelLines diodeModel', () => {
  it('writes the 34 line with every upstream token in order (DiodeModel.dump)', () => {
    // order: 34 <nm> <f> <is> <rs> <n> <bv> <fi>
    const n = node('dm', {
      nm: 'd1',
      f: '1',
      is: '2e-14',
      rs: '3',
      n: '1.2',
      bv: '5',
      fi: '0.5',
    });
    expect(diodeModel(n)).toBe('34 d1 1 2e-14 3 1.2 5 0.5');
  });

  it('fills the upstream defaults when attributes are missing', () => {
    expect(diodeModel(node('dm', { nm: 'd2' }))).toBe('34 d2 0 1e-14 0 1 0 0');
  });

  it('escapes the model name the way the text netlist does', () => {
    // A name with a space and a backslash trips escapeToken.
    expect(diodeModel(node('dm', { nm: 'a b\\c' }))).toBe(
      '34 a\\sb\\\\c 0 1e-14 0 1 0 0',
    );
  });
});

describe('xmlModelLines transistorModel', () => {
  it('writes the 32 line with the full undump table (TransistorModel.undump)', () => {
    // order: 32 <nm> <f> <is> <ikf> <ise> <ne> <ikr> <isc> <nc> <nf> <nr>
    //        <vaf> <var> <br>
    const n = node('tm', { nm: 't1', f: '2', is: '3e-13' });
    expect(transistorModel(n)).toBe('32 t1 2 3e-13 0 0 1.5 0 0 2 1 1 0 0 3');
  });

  it('appends the optional capacitance/transit-time tokens only when present', () => {
    const n = node('tm', {
      nm: 't2',
      cje: '1e-12',
      vje: '0.7',
      mje: '0.33',
      cjc: '2e-12',
      vjc: '0.6',
      mjc: '0.5',
      tf: '1e-9',
      tr: '5e-9',
    });
    expect(transistorModel(n)).toBe(
      '32 t2 0 5e-13 0 0 1.5 0 0 2 1 1 0 0 3 1e-12 0.7 0.33 2e-12 0.6 0.5 1e-9 5e-9',
    );
  });
});

describe('xmlModelLines compositeModel', () => {
  it('writes the . line for a composite with external pins and a gate child', () => {
    // Cross-checked against io/xmlToText.test.ts "converts a ccm composite
    // model to a . line": same token order and the same escaped child tokens.
    const n = node(
      'ccm',
      { nm: 'op', f: '0', sx: '2', sy: '2' },
      [
        node('ext', { nm: 'A', nd: '1', ps: '0', sd: '2' }),
        node('ext', { nm: 'B', nd: '2', ps: '1', sd: '2' }),
        node('And', { nn: '1 2 3', f: '0' }),
      ],
    );
    expect(compositeModel(n)).toBe(
      '. op 0 2 2 2 A 1 0 2 B 2 1 2 AndGateElm\\s1\\s2\\s3 0\\\\s2\\\\s0\\\\s5',
    );
  });

  it('expands a bus external pin once per bit when bcs is set', () => {
    const n = node(
      'ccm',
      { nm: 'bus', f: '0', sx: '1', sy: '1', bcs: '1' },
      [node('ext', { nm: 'A', nd: '1', ps: '0', sd: '2', bw: '2' })],
    );
    expect(compositeModel(n)).toBe('. bus 0 1 1 2 A 1 0 2 A 2 0 2 \\0 \\0');
  });

  it('emits a no-op dump for a child the engine has no composite for', () => {
    // A child whose tag is not in CHILD_CLASS contributes neither a line nor
    // a dump token, so the line and dump lists stay in step.
    const n = node('ccm', { nm: 'op', f: '0', sx: '1', sy: '1' }, [
      node('ext', { nm: 'A', nd: '1', ps: '0', sd: '2' }),
      node('unknown', { nn: '4 5 6', f: '0' }),
    ]);
    expect(compositeModel(n)).toBe('. op 0 1 1 1 A 1 0 2 \\0 \\0');
  });

  it('keeps one dump token per ccm child when there are two (F1)', () => {
    // A multi-child composite must round-trip to one engine dump per child.
    // Before the fix the inter-child boundary was escaped the same as the
    // intra-child field separators, so the loader merged every child into one
    // blob and `apply_dump` read garbage for child 1.
    const n = node('ccm', { nm: 'op', f: '0', sx: '1', sy: '1' }, [
      node('ext', { nm: 'A', nd: '1', ps: '0', sd: '2' }),
      node('And', { nn: '1 2 3', f: '0' }),
      node('And', { nn: '4 5 6', f: '0' }),
    ]);
    const line = compositeModel(n);
    const model = parseCompositeModelLine(line);
    expect(modelToEngineSpec(model!).dumps).toHaveLength(2);
  });

  it('keeps a space-bearing child model name intact across the dump (F2)', () => {
    // A diode child whose model name has a space must survive the dump as one
    // field. Before the fix the field value was never escaped, so `my model`
    // split into three fields and the engine read the wrong name.
    const n = node('ccm', { nm: 'op', f: '0', sx: '1', sy: '1' }, [
      node('ext', { nm: 'A', nd: '1', ps: '0', sd: '2' }),
      node('d', { nn: '1 2', mo: 'my model', f: '0' }),
    ]);
    const line = compositeModel(n);
    const model = parseCompositeModelLine(line);
    expect(modelToEngineSpec(model!).dumps[0]).toBe('0_my\\smodel');
  });
});
