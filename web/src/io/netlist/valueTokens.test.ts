import { describe, expect, it } from 'vitest';
import { scopeValueFromToken, unitsOf, valueTokenOf } from './valueTokens';
import type { ScopeValue } from '../../engine/scopeModel';

// The scope-value codecs are intentionally many-to-one on decode: several wire
// tokens (e.g. 0, 2 and 8 on a plain element) collapse to the same engine
// quantity `'voltage'`. The contract that must hold is therefore the
// variant-level inverse, plus the unit walk: a re-encoded token must carry the
// same `unitsOf` as the one that was decoded, or the next plot's `ne`/`val`
// pair would be read one token early and a trace silently dropped.

// Every ScopeValue variant with the kind that owns its token, so the
// encode -> decode pair is a true inverse across the variant set.
const VARIANT_OWNER: ReadonlyArray<[ScopeValue, string | null]> = [
  ['voltage', null],
  ['current', null],
  ['power', null],
  ['charge', 'capacitor'],
  ['resistance', 'lamp'],
  ['ib', 'transistor'],
  ['ic', 'transistor'],
  ['ie', 'transistor'],
  ['vbe', 'transistor'],
  ['vbc', 'transistor'],
  ['vce', 'transistor'],
];

describe('scope-value codec: variant-level inverse', () => {
  it('round-trips every ScopeValue variant valueTokenOf -> scopeValueFromToken', () => {
    for (const [variant, owner] of VARIANT_OWNER) {
      const token = valueTokenOf(variant);
      expect(scopeValueFromToken(token, owner)).toBe(variant);
    }
  });

  it('covers the documented fixed points from the review finding', () => {
    expect(scopeValueFromToken(2, 'ohmmeter')).toBe('resistance');
    expect(valueTokenOf('resistance')).toBe(2);
    expect(scopeValueFromToken(1, 'transistor')).toBe('ib');
    expect(scopeValueFromToken(3, 'transistor')).toBe('ie');
  });
});

describe('scope-value codec: unitsOf walk advance', () => {
  it('puts a lamp, memristor and ohmmeter VAL_R (2) in ohms', () => {
    for (const kind of ['lamp', 'memristor', 'ohmmeter'] as const) {
      expect(unitsOf(2, kind)).toBe(3);
    }
  });

  it('puts a capacitor and polarizedCapacitor VAL_CHARGE (8) in coulombs', () => {
    for (const kind of ['capacitor', 'polarizedCapacitor'] as const) {
      expect(unitsOf(8, kind)).toBe(4);
    }
  });

  it('puts a transistor IB/IC/IE (1/2/3) in amps and power (7) in watts', () => {
    expect(unitsOf(1, 'transistor')).toBe(1);
    expect(unitsOf(2, 'transistor')).toBe(1);
    expect(unitsOf(3, 'transistor')).toBe(1);
    expect(unitsOf(7, 'transistor')).toBe(2);
    // VBE/VBC/VCE (4/5/6) and the voltage/charge fall-throughs read in volts.
    expect(unitsOf(4, 'transistor')).toBe(0);
    expect(unitsOf(6, 'transistor')).toBe(0);
    expect(unitsOf(8, 'transistor')).toBe(0);
    expect(unitsOf(0, 'transistor')).toBe(0);
  });

  it('puts a generic element current (3) in amps and power (1/7) in watts', () => {
    for (const kind of [null, 'resistor', 'inductor'] as const) {
      expect(unitsOf(3, kind)).toBe(1);
      expect(unitsOf(1, kind)).toBe(2);
      expect(unitsOf(7, kind)).toBe(2);
      // Voltage, the resistance fall-through and the charge fall-through all
      // read in volts, so they carry no extra scale token.
      expect(unitsOf(0, kind)).toBe(0);
      expect(unitsOf(2, kind)).toBe(0);
      expect(unitsOf(8, kind)).toBe(0);
    }
  });
});

describe('scope-value codec: re-encoding never desyncs the plot walk', () => {
  // For every (token, kind) the decoder produces a non-null value, the token
  // `valueTokenOf` hands back must advance the units walk exactly as far as the
  // original token did: unitsOf is preserved across the encode -> decode -> encode
  // loop. A mismatch here is what would misread the next plot's `ne`/`val` and
  // silently drop or corrupt a loaded scope.
  const KINDS: Array<string | null> = [
    null,
    'resistor',
    'transistor',
    'lamp',
    'memristor',
    'ohmmeter',
    'capacitor',
    'polarizedCapacitor',
  ];

  it('preserves unitsOf across the round trip for tokens 0..=8', () => {
    for (const kind of KINDS) {
      for (let token = 0; token <= 8; token++) {
        const value = scopeValueFromToken(token, kind);
        if (value === null) continue; // null plots ride the raw token, untouched.
        const reToken = valueTokenOf(value);
        expect(unitsOf(token, kind)).toBe(unitsOf(reToken, kind));
      }
    }
  });
});
