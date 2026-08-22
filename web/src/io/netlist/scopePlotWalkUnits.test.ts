import { describe, expect, it, vi } from 'vitest';
import { parseCircuit, serializeCircuit } from './index';
import { DEFAULT_SETTINGS } from '../../model/types';

// This build's registry has caught up with every dump code upstream defines
// (checked against reference/circuitjs1's `getDumpType()` returns), so the
// "element line this build cannot read" path in `parseCircuit`'s dispatch
// loop (the `!def` branch) has no naturally occurring reproduction today.
// Hiding the lamp's code from the registry here simulates the gap the fix
// protects against: the same shape a future, not-yet-ported upstream element
// would leave, without inventing a dump code upstream does not actually use.
vi.mock('../../model/registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../model/registry')>();
  return {
    ...actual,
    defForDumpCode: (code: string) => (code === '181' ? undefined : actual.defForDumpCode(code)),
  };
});

describe('o-line plot walk: units for an element line this build cannot read', () => {
  const HEADER = '$ 1 0.000005 10 50 5 43 5e-11\n';

  it('does not misread the next plot when an earlier plot targets an unreadable Ω-valued element', () => {
    // File index 0 is a lamp this build cannot construct (see the mock
    // above); its VAL_R (2) plot carries an extra Ω scale token
    // (ScopeSerializer.java:221-223) the walk must still skip even though it
    // cannot build the element. File index 1 is a real capacitor whose
    // VAL_CHARGE (8) plot carries its own C scale token right after. Before
    // the fix, the lamp's kind resolved to null, `unitsOf` returned 0 for
    // it, its Ω scale token (160) was misread as plot 1's `ne`, and the real
    // `ne` (1) was misread as plot 1's `val`.
    const text =
      HEADER +
      '181 0 0 16 0 0 293 100 120 0.4 0.4\n' +
      'c 16 0 32 0 0 1e-6 0.001\n' +
      'o 0 64 2 4099 20 0.05 0 2 160 1 8 0.001\n';
    const parsed = parseCircuit(text);

    // The lamp takes no element slot in `elements`: only the capacitor does.
    expect(parsed.elements).toHaveLength(1);
    expect(parsed.elements[0].kind).toBe('capacitor');
    // The unreadable lamp's VAL_R still maps through its raw dump code to the
    // engine's Resistance value; with no store element behind it the plot
    // stays unregistered and rides the raw line only.
    expect(parsed.scopes[0].plots).toEqual([
      expect.objectContaining({ elementIndex: 0, elementId: undefined, value: 'resistance' }),
      expect.objectContaining({
        elementIndex: 1,
        elementId: parsed.elements[0].id,
        value: 'charge',
      }),
    ]);

    // A save must skip the exact same tokens the read walk did, so the file
    // round-trips byte-for-byte instead of drifting on every load/save cycle
    // (the write side shares `unitsOf`/`kindOfDumpCode` with the reader for
    // exactly this reason).
    const out = serializeCircuit(
      parsed.elements,
      { ...DEFAULT_SETTINGS, ...parsed.settings },
      parsed.scopes,
      parsed.passthrough,
      parsed.order,
    );
    const oLine = out.split('\n').find((l) => l.startsWith('o '));
    expect(oLine).toBe('o 0 64 2 4099 20 0.05 0 2 160 1 8 0.001');
  });
});
