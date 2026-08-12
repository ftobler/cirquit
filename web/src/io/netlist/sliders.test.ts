import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseCircuit, serializeCircuit, type SliderConfig } from './index';
import { CIRCUITS_DIR } from './fixtures';
import { resolveParam } from '../../model/sliders';
import { DEFAULT_SETTINGS } from '../../model/types';

/** A fixture whose element indices mirror the corpus slider targets: resistor
 *  0, current source 1, capacitor 2, inductor 3, transistor 4, resistor 5,
 *  square-wave voltage source 6. */
const FIXTURE = `$ 1 0.000005 10 50 5 43 5e-11
r 0 0 16 0 0 100
i 0 0 16 0 0 0.002
c 0 0 16 0 0 1e-6 0.001
l 0 0 16 0 0 1 0
t 0 0 16 0 0 1 0 0 100
r 16 0 32 0 0 16087
v 0 0 0 16 0 2 40 5 5 0 0.56
o 4 64 0 4099 20 0.05 0 2 4 3
38 0 0 1 101 Resistance
38 1 0 0 0.005 Current
38 2 0 0.000001 0.000101 Capacitance
38 3 0 0.01 1.01 Inductance
38 4 0 1 1000 Beta/hFE
38 5 0 100 22000 Phase\\sControl
38 6 6 0 100 Duty\\sCycle
`;

const save = (parsed: ReturnType<typeof parseCircuit>) =>
  serializeCircuit(
    parsed.elements,
    { ...DEFAULT_SETTINGS, ...parsed.settings },
    parsed.scopes,
    parsed.passthrough,
    parsed.order,
    parsed.sliders,
  );

describe('slider round trips', () => {
  it('saves every slider line byte-for-byte with no edits', () => {
    const parsed = parseCircuit(FIXTURE);
    const out = save(parsed);
    for (const line of FIXTURE.split('\n').filter((l) => l.startsWith('38 '))) {
      expect(out).toContain(line);
    }
    // The scope line, whose index depends on the same element walk, also
    // comes back exactly.
    expect(out).toContain('o 4 64 0 4099 20 0.05 0 2 4 3');
  });

  it('moving a slider changes only the bound element, never the 38 line', () => {
    const parsed = parseCircuit(FIXTURE);
    const resistor = parsed.elements[0];
    resistor.params.resistance = 75;
    const out = save(parsed);
    expect(out).toContain('r 0 0 16 0 0 75');
    expect(out).toContain('38 0 0 1 101 Resistance');
  });

  it('a deleted bound element saves as the -1 sentinel', () => {
    const parsed = parseCircuit(FIXTURE);
    const removed = parsed.elements[3];  // the inductor the Inductance slider binds
    const out = serializeCircuit(
      parsed.elements.filter((e) => e.id !== removed.id),
      { ...DEFAULT_SETTINGS, ...parsed.settings },
      parsed.scopes,
      parsed.passthrough,
      parsed.order,
      parsed.sliders,
    );
    expect(out).toContain('38 -1 0 0.01 1.01 Inductance');
  });

  it('deleting an element ahead of a slider shifts the e token by one', () => {
    const parsed = parseCircuit(FIXTURE);
    const removed = parsed.elements[1];  // the current source, index 1
    const out = serializeCircuit(
      parsed.elements.filter((e) => e.id !== removed.id),
      { ...DEFAULT_SETTINGS, ...parsed.settings },
      parsed.scopes,
      parsed.passthrough,
      parsed.order,
      parsed.sliders,
    );
    // The capacitor slid from index 2 to 1, so its slider line says 1 now.
    expect(out).toContain('38 1 0 0.000001 0.000101 Capacitance');
  });

  it('a slider past the last element line keeps the loaded e token', () => {
    // slider-unknown.txt's `38 2` points one past the resistor and the lamp:
    // there is no session element to renumber, so the token stays exactly as
    // the file had it.
    const parsed = parseCircuit(
      '$ 0 0.000005 10 50 5 43 5e-11\nr 0 0 16 0 0 100\n181 32 0 48 0 0 20\n38 2 0 1 100 Text\n',
    );
    expect(parsed.sliders[0].elementId).toBeUndefined();
    expect(save(parsed)).toContain('38 2 0 1 100 Text');
  });

  it('the no-order subset path appends slider lines after the scopes', () => {
    const parsed = parseCircuit(FIXTURE);
    const out = serializeCircuit(
      parsed.elements,
      { ...DEFAULT_SETTINGS, ...parsed.settings },
      parsed.scopes,
      parsed.passthrough,
      undefined,
      parsed.sliders,
    ).split('\n');
    const oIndex = out.indexOf('o 4 64 0 4099 20 0.05 0 2 4 3');
    const sliderIndex = out.indexOf('38 0 0 1 101 Resistance');
    expect(sliderIndex).toBeGreaterThan(oIndex);
  });
});

describe('slider lines and the element index', () => {
  it('a 38 line between elements does not advance the scope index', () => {
    const parsed = parseCircuit(
      '$ 0 0.000005 10 50 5 43 5e-11\n' +
        'r 0 0 16 0 0 100\n' +
        'r 16 0 32 0 0 220\n' +
        '38 0 0 1 100 Resistance\n' +
        'h a hint\n' +
        'r 32 0 48 0 0 330\n' +
        'o 2 64 0 4099 20 0.05 0 1\n',
    );
    // The slider and hint lines do not advance the element list, so index 2 is
    // still the third resistor, and the slider binds to the first one.
    expect(parsed.scopes[0].plots[0].elementId).toBe(parsed.elements[2].id);
    expect(parsed.sliders[0].elementId).toBe(parsed.elements[0].id);
  });

  it('a UI-created slider (no raw tokens) writes the canonical form', () => {
    const created: SliderConfig = {
      id: 99,
      elementId: 42,
      editItem: 0,
      min: 1,
      max: 100,
      step: 0,
      text: 'My Slider',
      logarithmic: false,
      shared: null,
      raw: [],
    };
    const out = serializeCircuit(
      [{ id: 42, kind: 'resistor', x1: 0, y1: 0, x2: 16, y2: 0, flags: 0, params: { resistance: 10 } }],
      { ...DEFAULT_SETTINGS },
      [],
      [],
      undefined,
      [created],
    );
    expect(out.trim().split('\n').at(-1)).toBe('38 0 F0 0 1 100 -1 My\\sSlider 0');
  });
});

describe('bundled corpus slider bindings', () => {
  it('binds every bundled 38 line to the parameter its caption names', () => {
    const expected: Record<string, string[]> = {
      'conv-buckboost.txt': ['dutyCycle'],
      'itov.txt': ['current'],
      'lrc.txt': ['capacitance', 'inductance', 'resistance'],
      'transrectifier.txt': ['beta'],
      'triacdimmer.txt': ['resistance'],
    };
    for (const [file, want] of Object.entries(expected)) {
      const parsed = parseCircuit(readFileSync(join(CIRCUITS_DIR, file), 'utf8'));
      const names = parsed.sliders.map((s) => {
        const el = parsed.elements.find((e) => e.id === s.elementId);
        return el ? (resolveParam(el.kind, s.editItem, s.text)?.name ?? null) : null;
      });
      expect(parsed.sliders, file).toHaveLength(want.length);
      expect(names, file).toEqual(want);
    }
  });
});
