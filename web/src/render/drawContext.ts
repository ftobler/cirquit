/** The draw context for symbols drawn outside the circuit.
 *
 *  Three call sites draw an element the engine knows nothing about: the
 *  toolbox icons, the drag-post handles and the placement ghost. All three
 *  need a `DrawContext` whose live-simulation half is zero, so no symbol can
 *  read a voltage, a current or an animation phase that does not exist. Kept
 *  here as one function rather than three hand-built literals, so the three
 *  cannot drift apart.
 */

import type { Context2D, DrawContext, SimSettings, Theme } from '../model/types';

/** How the user's display toggles reach the context. `settings` passes them
 *  through, for a symbol drawn inside the live canvas alongside real elements
 *  (the handles, the ghost); `off` forces every readout off, for a symbol
 *  drawn in its own box where a value label or a current dot would be noise
 *  (the toolbox icons). Both keep the symbol-set flags, which decide which
 *  body is drawn and so must match the part the user will get. */
export type DisplayToggles = 'settings' | 'off';

/** A `DrawContext` with no live simulation state: every voltage, current and
 *  phase zero, nothing selected, hovered or on a highlighted net. `scale` is
 *  the caller's own zoom, so line weights and text match the surrounding
 *  drawing. A missing `settings` (the icon path takes it optional) falls back
 *  to the app defaults for the symbol set: IEC on, matching a freshly placed
 *  part. */
export function neutralDrawContext(
  ctx: Context2D,
  theme: Theme,
  settings: SimSettings | undefined,
  scale: number,
  toggles: DisplayToggles = 'off',
): DrawContext {
  const live = toggles === 'settings' && settings !== undefined;
  return {
    ctx,
    theme,
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
    showCurrent: live ? settings.showCurrent : false,
    showValues: live ? settings.showValues : false,
    showVoltageColor: live ? settings.showVoltageColor : false,
    showPowerColor: live ? settings.showPowerColor : false,
    conventional: live ? settings.conventional : true,
    // The app defaults to the IEC symbols, so an icon drawn before any
    // settings exist matches a freshly placed part (DEFAULT_SETTINGS
    // euroResistors/euroGates true).
    euroResistors: settings?.euroResistors ?? true,
    euroGates: settings?.euroGates ?? true,
    selected: false,
    hovered: false,
    onHighlightedNet: false,
    voltageRange: live ? settings.voltageRange : 5,
    powerRange: live ? settings.powerRange : 50,
    scale,
    valueDigits: live ? settings.shortDecimalDigits : 2,
    valueFontSize: live ? settings.valueFontSize : 12,
  };
}
