/** Global simulation settings as a modal, the port of upstream's Other Options
 *  dialog (EditOptions.java). Every control writes through `updateSettings`,
 *  the same store action the old sidebar rows used, so no decision lives in a
 *  component and the existing store tests keep covering the settings. */

import { formatValue, makeTheme } from '../render/draw';
import type { Theme, ThemeColors } from '../model/types';
import { sliderFromSteps, stepsFromSlider } from '../state/helpers';
import { useStore } from '../state/store';
import { Dialog } from './Dialog';
import { UnitNumberInput } from './UnitNumberInput';

/** The five mutable colour rows, and which theme key each overrides. */
const COLOR_ROWS: { key: keyof ThemeColors; label: string; themeKey: keyof Theme }[] = [
  { key: 'positiveColor', label: 'Positive', themeKey: 'positive' },
  { key: 'negativeColor', label: 'Negative', themeKey: 'negative' },
  { key: 'neutralColor', label: 'Neutral', themeKey: 'neutral' },
  { key: 'selectionColor', label: 'Selection', themeKey: 'selection' },
  { key: 'currentColor', label: 'Current', themeKey: 'currentDot' },
];

export function OtherOptionsDialog() {
  const settings = useStore((s) => s.settings);
  const dark = useStore((s) => s.dark);
  const updateSettings = useStore((s) => s.updateSettings);
  const closeDialog = useStore((s) => s.closeDialog);

  // Upstream rows this dialog deliberately omits, with no SimSettings key
  // behind them (EditOptions.java): Change Language (row 2), the port is
  // English-only; Developer Mode (row 11), the port has no developer mode;
  // Minimum Target Frame Rate (row 12), the port has no frame-rate limiter;
  // Matrix Solver (row 16), the solver is fixed, picked by closure size.

  return (
    <Dialog
      title="Other Options"
      onClose={closeDialog}
      actions={
        <>
          <button type="button" onClick={closeDialog}>
            Close
          </button>
        </>
      }
    >
      <section>
        <h3>Simulation</h3>
        <label className="field">
          <span>
            Speed <em>{settings.stepsPerFrame} steps/frame</em>
          </span>
          <input
            type="range"
            min={1}
            max={1000}
            value={sliderFromSteps(settings.stepsPerFrame, 1, 1000)}
            onChange={(e) =>
              updateSettings({ stepsPerFrame: stepsFromSlider(Number(e.target.value), 1, 1000) })
            }
          />
        </label>
        <label className="field">
          <span>
            Current speed <em>{settings.currentSpeed}</em>
          </span>
          <input
            type="range"
            min={0}
            max={100}
            value={settings.currentSpeed}
            onChange={(e) => updateSettings({ currentSpeed: Number(e.target.value) })}
          />
        </label>
        <label className="field">
          <span>
            Voltage range <em>{formatValue(settings.voltageRange, 'V')}</em>
          </span>
          <input
            type="range"
            min={0.5}
            max={50}
            step={0.5}
            value={settings.voltageRange}
            onChange={(e) => updateSettings({ voltageRange: Number(e.target.value) })}
          />
        </label>
        <UnitNumberInput
          label="Timestep (s)"
          value={settings.timeStep}
          positive
          onCommit={(n) => updateSettings({ timeStep: n })}
        />

        <label className="check">
          <input
            type="checkbox"
            checked={settings.showCurrent}
            onChange={(e) => updateSettings({ showCurrent: e.target.checked })}
          />
          <span>Show current</span>
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={settings.conventional}
            onChange={(e) => updateSettings({ conventional: e.target.checked })}
          />
          <span>Conventional current motion</span>
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={settings.showValues}
            onChange={(e) => updateSettings({ showValues: e.target.checked })}
          />
          <span>Show values</span>
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={settings.showVoltageColor}
            onChange={(e) => updateSettings({ showVoltageColor: e.target.checked })}
          />
          <span>Colour by voltage</span>
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={settings.showPowerColor}
            onChange={(e) => updateSettings({ showPowerColor: e.target.checked })}
          />
          <span>Show power</span>
        </label>
        {settings.showPowerColor && (
          <label className="field">
            <span>
              Power brightness <em>{settings.powerRange}</em>
            </span>
            <input
              type="range"
              min={1}
              max={100}
              value={settings.powerRange}
              onChange={(e) => updateSettings({ powerRange: Number(e.target.value) })}
            />
          </label>
        )}
        <label className="check">
          <input
            type="checkbox"
            checked={settings.autoDC}
            onChange={(e) => updateSettings({ autoDC: e.target.checked })}
          />
          <span>Auto-Run DC Operating Point on Reset</span>
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={settings.adaptiveTimeStep}
            onChange={(e) => updateSettings({ adaptiveTimeStep: e.target.checked })}
          />
          <span>Auto-Adjust Timestep</span>
        </label>
        {settings.adaptiveTimeStep && (
          <UnitNumberInput
            label="Minimum time step size (s)"
            value={settings.minTimeStep}
            positive
            onCommit={(n) => updateSettings({ minTimeStep: n })}
          />
        )}
      </section>

      <section>
        <h3>Grid and view</h3>
        <label className="check">
          <input
            type="checkbox"
            checked={settings.showGrid}
            onChange={(e) => updateSettings({ showGrid: e.target.checked })}
          />
          <span>Show grid</span>
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={settings.showCrosshair}
            onChange={(e) => updateSettings({ showCrosshair: e.target.checked })}
          />
          <span>Show cursor crosshair</span>
        </label>
      </section>

      <section>
        <h3>Colours</h3>
        {/* The displayed swatch is the theme's own colour while the setting is
            null, so resetting to defaults still shows what each row means. */}
        {COLOR_ROWS.map(({ key, label, themeKey }) => (
          <label key={key} className="field">
            <span>{label}</span>
            <input
              type="color"
              value={settings[key] ?? makeTheme(dark)[themeKey]}
              onChange={(e) => updateSettings({ [key]: e.target.value })}
            />
          </label>
        ))}
        <button
          type="button"
          onClick={() =>
            updateSettings({
              positiveColor: null,
              negativeColor: null,
              neutralColor: null,
              selectionColor: null,
              currentColor: null,
            })
          }
        >
          Reset colours to default
        </button>
      </section>

      <section>
        <h3>Format</h3>
        <UnitNumberInput
          label="Significant digits (short format)"
          value={settings.shortDecimalDigits}
          min={0}
          max={6}
          integer
          onCommit={(n) => updateSettings({ shortDecimalDigits: n })}
        />
        <UnitNumberInput
          label="Significant digits (long format)"
          value={settings.decimalDigits}
          min={0}
          max={6}
          integer
          onCommit={(n) => updateSettings({ decimalDigits: n })}
        />
        <UnitNumberInput
          label="Value label font size"
          value={settings.valueFontSize}
          min={8}
          max={40}
          integer
          onCommit={(n) => updateSettings({ valueFontSize: n })}
        />
      </section>

      <section>
        <h3>Input</h3>
        <UnitNumberInput
          label="Mouse wheel sensitivity"
          value={settings.wheelSensitivity}
          min={0.1}
          max={10}
          onCommit={(n) => updateSettings({ wheelSensitivity: n })}
        />
      </section>
    </Dialog>
  );
}
