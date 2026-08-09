import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { useStore } from './store';
import { addResistor, fresh } from './store.test-helpers';

beforeEach(() => useStore.setState(fresh()));

describe('load and save keep the file arrangement', () => {
  const FILE = [
    '$ 1 0.000005 10.20027730826997 50 5 43 5e-11',
    '',
    '# a note from the author',
    'r 0 0 16 0 0 100',
    '38 3 0 0.000001 0.000101 Capacitance',
    'r 16 0 32 0 0 220',
    'o 0 64 0 4099 20 0.05 0 2 4 3',
    '',
  ].join('\n');

  it('replays the header, the comment, the blank lines and the unmodelled line in place', () => {
    useStore.getState().loadNetlist(FILE);
    const out = useStore.getState().toNetlist().split('\n');
    // Byte-identical header, including the power range and the flag bits this
    // build does not decode (bit 64 is cleared here, so the adaptive flag
    // stays off and the flags re-emit unchanged).
    expect(out[0]).toBe('$ 1 0.000005 10.20027730826997 50 5 43 5e-11');
    expect(out[1]).toBe('');
    expect(out[2]).toBe('# a note from the author');
    expect(out[4]).toBe('38 3 0 0.000001 0.000101 Capacitance');
    expect(out[5]).toBe('r 16 0 32 0 0 220');
    // Every display field on the `o` line survives: speed, plot flags, scale,
    // min and max. The save used to truncate it to `o 0 64 0 4099`.
    expect(out[6]).toBe('o 0 64 0 4099 20 0.05 0 2 4 3');
  });

  it('saves a whole loaded file byte-for-byte', () => {
    useStore.getState().loadNetlist(FILE);
    expect(useStore.getState().toNetlist()).toBe(FILE);
  });

  it('appends an element added after the load and leaves the slider line where it was', () => {
    useStore.getState().loadNetlist(FILE);
    addResistor();
    const out = useStore.getState().toNetlist().split('\n');
    expect(out[4]).toBe('38 3 0 0.000001 0.000101 Capacitance');
    expect(out[out.length - 2]).toBe('r 0 0 160 0 0 1000');
  });

  it('drops the unmodelled header fields of the previous file on the next load', () => {
    useStore.getState().loadNetlist(FILE);
    useStore.getState().loadNetlist('$ 0 0.000005 1.5 50 5\nr 0 0 16 0 0 100\n');
    // Inheriting 43 and 5e-11 from the first file would be inventing data.
    expect(useStore.getState().toNetlist().split('\n')[0]).toBe('$ 0 0.000005 1.5 50 5 50 5e-11');
  });

  it('renumbers a scope when an element ahead of it is deleted', () => {
    useStore.getState().loadNetlist(FILE.replace('o 0 64', 'o 1 64'));
    const [first] = useStore.getState().elements;
    useStore.getState().select([first.id]);
    useStore.getState().deleteSelected();
    // The trace was on the second resistor, which is now element 0. Writing
    // the loaded index token back verbatim would repoint it at nothing.
    const line = useStore
      .getState()
      .toNetlist()
      .split('\n')
      .find((l) => l.startsWith('o '));
    expect(line).toBe('o 0 64 0 4099 20 0.05 0 2 4 3');
  });
});

describe('scope lines index the file, not the elements this build can read', () => {
  // `214` is a CCVS, which this build has no model for. Upstream counts it in
  // the element list all the same, so both scope indices sit one past what
  // the port's own element array would say.
  const FILE = [
    '$ 1 0.000005 10.20027730826997 50 5 43 5e-11',
    'r 0 0 16 0 0 100',
    '214 32 0 48 0 0 20 0.1 1000 0',
    'r 64 0 80 0 0 220',
    'o 0 64 0 4099 20 0.05 0 2 4 3',
    'o 1 8 0 34 6 0.00625 0 -1 sweep',
    'o 2 8 0 34 6 0.00625 0 -1 second',
    '',
  ].join('\n');

  it('attaches each scope to the element the file meant', () => {
    useStore.getState().loadNetlist(FILE);
    const s = useStore.getState();
    // Two traces on the two resistors; the one on the CCVS has no element to
    // attach to and is not silently invented onto the wrong one.
    expect(s.scopes.map((x) => x.plots[0].elementId)).toEqual([s.elements[0].id, s.elements[1].id]);
    expect(s.unmatchedScopes).toHaveLength(1);
    expect(s.unmatchedScopes[0].elementIndex).toBe(1);
  });

  it('saves all three lines, in place and unchanged', () => {
    useStore.getState().loadNetlist(FILE);
    expect(useStore.getState().toNetlist()).toBe(FILE);
  });

  it('reports the missing element kind as missing, not as a preserved line', () => {
    useStore.getState().loadNetlist(FILE);
    const problem = useStore.getState().problem ?? '';
    expect(problem).toContain('214');
    expect(problem).toContain('missing from the drawing and the simulation');
  });

  it('attaches allpass1.txt the way the file means it', () => {
    // The bundled case this came from. Its element lines are
    // a r r w r w c g w 170 O, and the `170` sweep is number 9, so `o 9`
    // lands on the sweep and `o 10` on the `O` readout. The scope indices
    // count the element list including every line, not just the readable ones.
    const text = readFileSync(
      fileURLToPath(new URL('../../public/circuits/allpass1.txt', import.meta.url)),
      'utf8',
    );
    useStore.getState().loadNetlist(text);
    const s = useStore.getState();
    // Both `o` lines attach: `o 9` to the sweep, `o 10` to the readout.
    expect(s.scopes).toHaveLength(2);
    expect(
      s.scopes.map((x) => s.elements.find((e) => e.id === x.plots[0].elementId)?.kind),
    ).toEqual(['sweep', 'output']);
    expect(s.unmatchedScopes).toHaveLength(0);
    // Both `o` lines come back, last and with every display field, and the
    // `170` keeps its place among the elements. The header and the element
    // lines re-render their numbers, so they are checked by the corpus sweep.
    expect(s.toNetlist().split('\n').slice(-5)).toEqual([
      '170 240 208 192 208 3 10 2000 5 0.1',
      'O 416 224 480 224 0 0',
      'o 9 8 0 34 6.0 0.00625 0 -1 input',
      'o 10 8 0 34 6.0 9.765625E-55 0 -1 output',
      '',
    ]);
  });

  it('parses slider lines into state and reports nothing missing', () => {
    useStore.getState().loadNetlist(
      '$ 0 0.000005 10 50 5 43 5e-11\nr 0 0 16 0 0 100\n' +
        '38 0 0 1 2 A\n38 0 1 1 2 B\n',
    );
    const s = useStore.getState();
    // Both sliders bind to the resistor; a parsed slider is not an unsupported
    // type, so the load warning is silent.
    expect(s.sliders).toHaveLength(2);
    expect(s.sliders.every((x) => x.elementId === s.elements[0].id)).toBe(true);
    expect(s.problem).toBeNull();
    // The lines still come back in place.
    expect(s.toNetlist()).toContain('38 0 0 1 2 A\n38 0 1 1 2 B');
  });
});
