import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../model/types';
import type { Context2D, SimSettings } from '../model/types';
import { makeTheme } from './draw';
import { neutralDrawContext } from './drawContext';

const ctx = {} as Context2D;
const theme = makeTheme(true);

/** Settings deliberately unlike the defaults, so a field silently sourced from
 *  the wrong place shows up instead of coinciding. */
const settings: SimSettings = {
  ...DEFAULT_SETTINGS,
  showCurrent: false,
  showValues: false,
  showVoltageColor: false,
  showPowerColor: true,
  conventional: false,
  euroResistors: false,
  euroGates: false,
  voltageRange: 12,
  powerRange: 33,
  shortDecimalDigits: 3,
  valueFontSize: 17,
};

describe('neutralDrawContext', () => {
  it('carries no live simulation state, whatever the toggles say', () => {
    for (const g of [
      neutralDrawContext(ctx, theme, settings, 1),
      neutralDrawContext(ctx, theme, settings, 2, 'settings'),
    ]) {
      expect(g.voltages).toEqual([]);
      expect(g.postCurrents).toEqual([]);
      expect(g.postDotPhases).toEqual([]);
      expect(g.wave).toEqual([]);
      expect([g.current, g.voltage, g.power, g.value, g.state, g.dotPhase]).toEqual([
        0, 0, 0, 0, 0, 0,
      ]);
      // A ghost, an icon and a handle are none of these; the voltage and power
      // ramps stay off as a result, which is what makes a ghost read as a
      // preview rather than a dead part at 0 V.
      expect([g.selected, g.hovered, g.onHighlightedNet]).toEqual([false, false, false]);
    }
  });

  it("'off' reproduces the icon context: readouts off, symbol set from settings", () => {
    // Field for field what renderToolIcon built by hand before the extraction.
    const g = neutralDrawContext(ctx, theme, settings, 1);
    expect(g.showCurrent).toBe(false);
    expect(g.showValues).toBe(false);
    expect(g.showVoltageColor).toBe(false);
    expect(g.showPowerColor).toBe(false);
    expect(g.conventional).toBe(true);
    expect(g.voltageRange).toBe(5);
    expect(g.powerRange).toBe(50);
    expect(g.valueDigits).toBe(2);
    expect(g.valueFontSize).toBe(12);
    expect(g.scale).toBe(1);
    // The symbol set is the exception: an icon must show the body the user
    // will actually get.
    expect(g.euroResistors).toBe(false);
    expect(g.euroGates).toBe(false);
  });

  it("'settings' reproduces the handles context: every toggle from the user", () => {
    const g = neutralDrawContext(ctx, theme, settings, 2.5, 'settings');
    expect(g.showCurrent).toBe(settings.showCurrent);
    expect(g.showValues).toBe(settings.showValues);
    expect(g.showVoltageColor).toBe(settings.showVoltageColor);
    expect(g.showPowerColor).toBe(settings.showPowerColor);
    expect(g.conventional).toBe(settings.conventional);
    expect(g.euroResistors).toBe(settings.euroResistors);
    expect(g.euroGates).toBe(settings.euroGates);
    expect(g.voltageRange).toBe(settings.voltageRange);
    expect(g.powerRange).toBe(settings.powerRange);
    expect(g.valueDigits).toBe(settings.shortDecimalDigits);
    expect(g.valueFontSize).toBe(settings.valueFontSize);
    expect(g.scale).toBe(2.5);
  });

  it('defaults the symbol set to IEC when no settings exist yet', () => {
    // The icon path takes settings optionally: a theme-only render must match
    // a freshly placed part, which DEFAULT_SETTINGS draws with IEC bodies.
    const g = neutralDrawContext(ctx, theme, undefined, 1);
    expect(g.euroResistors).toBe(true);
    expect(g.euroGates).toBe(true);
  });
});
