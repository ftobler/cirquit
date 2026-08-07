/** Properties of the selected element, plus global simulation settings. */

import { useEffect, useRef, useState } from 'react';
import type { SimEngine } from '../engine/simulator';
import { defFor } from '../model/registry';
import { formatUnits, parseUnits } from '../model/units';
import { formatValue, makeTheme } from '../render/draw';
import type { CircuitElement, FieldDef, Theme, ThemeColors } from '../model/types';
import { useStore } from '../state/store';

interface Props {
  engine: SimEngine | null;
}

/** Where a field reads from: free text, a bit of `e.flags`, or a param. A flag
 *  field is a checkbox, so it is handed to `Field` as 0 or 1. */
function fieldValue(e: CircuitElement, f: FieldDef): number | string {
  if (f.target === 'text') return e.text ?? '';
  if (f.flag !== undefined) return (e.flags & f.flag) !== 0 ? 1 : 0;
  return e.params[f.name] ?? 0;
}

/** Text input for a physical value. Accepts unit suffixes, shorthand and
 *  scientific notation through parseUnits, keeps an invalid draft on screen
 *  with an error instead of dropping the edit, and re-formats to the stored
 *  value once the user blurs. */
function UnitInput({
  label,
  value,
  positive,
  onCommit,
  onFocus,
}: {
  label: string;
  value: number;
  /** Reject zero or negative parsed values (the timestep must stay positive). */
  positive?: boolean;
  onCommit: (n: number) => void;
  onFocus?: () => void;
}) {
  // The box shows just the value, unit-less ("4.7k"), with the unit carried by
  // the field label, exactly like upstream's edit dialog. parseUnits would
  // reject a rendered "4.7k Ω" anyway (space before unit, Ω not a suffix).
  const [draft, setDraft] = useState(() => formatUnits(value));
  const [focused, setFocused] = useState(false);
  const [error, setError] = useState(false);

  // An outside change (undo, selection switch, file load) must refresh the
  // box, but the value flowing back from our own commit must not fight the
  // keystroke the user is mid-way through, so the sync only runs while blurred.
  useEffect(() => {
    if (!focused) setDraft(formatUnits(value));
  }, [value, focused]);

  return (
    <>
      <label className="field">
        <span>{label}</span>
        <input
          type="text"
          value={draft}
          aria-invalid={error}
          onFocus={() => {
            setFocused(true);
            setError(false);
            onFocus?.();
          }}
          onChange={(e) => {
            setDraft(e.target.value);
            const n = parseUnits(e.target.value);
            if (Number.isFinite(n) && (!positive || n > 0)) {
              setError(false);
              onCommit(n);
            } else {
              setError(true);
            }
          }}
          onBlur={() => {
            setFocused(false);
            setError(false);
            setDraft(formatUnits(value));
          }}
        />
      </label>
      {error && <div className="problem">Invalid value</div>}
    </>
  );
}

function Field({
  field,
  value,
  onChange,
  onBeginEdit,
}: {
  field: FieldDef;
  value: number | string;
  onChange: (v: number | string) => void;
  onBeginEdit: () => void;
}) {
  if (field.type === 'text') {
    return (
      <label className="field">
        <span>{field.label}</span>
        <input
          type="text"
          value={String(value ?? '')}
          // Focus opens the edit session, so the whole typing session is one
          // undo entry; commit's dedup drops a focus that changed nothing.
          onFocus={onBeginEdit}
          onChange={(e) => onChange(e.target.value)}
        />
      </label>
    );
  }

  // Every remaining field type is numeric; recover the number for them.
  const v = typeof value === 'string' ? Number(value) : value;

  if (field.type === 'bool') {
    return (
      <label className="check">
        <input
          type="checkbox"
          checked={v !== 0}
          // Focus opens the edit session so a flag flip is one undo entry,
          // same as the number and text fields; dedup drops a focus that
          // changed nothing.
          onFocus={onBeginEdit}
          onChange={(e) => onChange(e.target.checked ? 1 : 0)}
        />
        <span>{field.label}</span>
      </label>
    );
  }

  if (field.type === 'choice') {
    return (
      <label className="field">
        <span>{field.label}</span>
        <select
          value={v}
          // Focus opens the edit session so a waveform or type change is one
          // undo entry, same as the number and text fields.
          onFocus={onBeginEdit}
          onChange={(e) => onChange(Number(e.target.value))}
        >
          {field.choices?.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
      </label>
    );
  }

  if (field.min !== undefined && field.max !== undefined) {
    return (
      <label className="field">
        <span>
          {field.label} <em>{v.toFixed(2)}</em>
        </span>
        <input
          type="range"
          min={field.min}
          max={field.max}
          step={(field.max - field.min) / 100}
          value={v}
          // Pointer-down lands before the first change event, so a slider
          // drag opens one edit session and is one undo step. Focus covers
          // tab-to + arrow-key edits with the same bracketing; the dedup makes
          // the two calls a harmless no-op when both fire.
          onPointerDown={onBeginEdit}
          onFocus={onBeginEdit}
          onChange={(e) => onChange(Number(e.target.value))}
        />
      </label>
    );
  }

  if (field.unit) {
    // A physical value: a free-text box that accepts "4k7", "1M", "10m",
    // scientific notation and the rest, writing the plain parsed number into
    // params exactly as the old number input did.
    return (
      <UnitInput
        label={`${field.label} (${field.unit})`}
        value={v}
        onFocus={onBeginEdit}
        onCommit={(n) => onChange(n)}
      />
    );
  }

  return (
    <label className="field">
      <span>
        {field.label}
      </span>
      <input
        type="number"
        value={v}
        step="any"
        onFocus={onBeginEdit}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (Number.isFinite(n)) onChange(n);
        }}
      />
    </label>
  );
}

/** The five mutable colour rows, and which theme key each overrides. */
const COLOR_ROWS: { key: keyof ThemeColors; label: string; themeKey: keyof Theme }[] = [
  { key: 'positiveColor', label: 'Positive', themeKey: 'positive' },
  { key: 'negativeColor', label: 'Negative', themeKey: 'negative' },
  { key: 'neutralColor', label: 'Neutral', themeKey: 'neutral' },
  { key: 'selectionColor', label: 'Selection', themeKey: 'selection' },
  { key: 'currentColor', label: 'Current', themeKey: 'currentDot' },
];

/** A settings number field with a clamp, e.g. the digit counts. `step` is the
 *  input's step attribute: 1 for the integer digit/font fields so a fractional
 *  digit count cannot be typed or spun, a fraction for wheel sensitivity. */
function NumberSetting({
  label,
  value,
  min,
  max,
  step = 'any',
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number | 'any';
  onChange: (n: number) => void;
}) {
  return (
    <label className="field">
      <span>
        {label} <em>{value}</em>
      </span>
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (Number.isFinite(n)) onChange(Math.max(min, Math.min(max, n)));
        }}
      />
    </label>
  );
}

export function OptionsPanel({ engine }: Props) {
  const elements = useStore((s) => s.elements);
  const selectedIds = useStore((s) => s.selectedIds);
  const settings = useStore((s) => s.settings);
  const dark = useStore((s) => s.dark);
  const setParam = useStore((s) => s.setParam);
  const setText = useStore((s) => s.setText);
  const beginEdit = useStore((s) => s.beginEdit);
  const updateElement = useStore((s) => s.updateElement);
  const updateSettings = useStore((s) => s.updateSettings);
  const addScope = useStore((s) => s.addScope);
  const problem = useStore((s) => s.problem);

  const selected = elements.find((e) => e.id === selectedIds[0]);
  const def = selected ? defFor(selected.kind) : undefined;

  // Double-tap edit selects and bumps panelFocusTick; focus the element's
  // first field so the user can type immediately (MouseManager's edit dialog
  // opens focused on the first value). Keyed on the tick alone: requestEdit
  // sets the selection and bumps the tick in one step, so the section ref
  // already tracks the freshly selected element, while a later single-click
  // selection change must not steal focus back from the canvas.
  const panelFocusTick = useStore((s) => s.panelFocusTick);
  const fieldsRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (panelFocusTick === 0) return;
    fieldsRef.current?.querySelector<HTMLElement>('.field input, .field select')?.focus();
  }, [panelFocusTick]);

  const idx = selected && engine ? engine.indexOf(selected.id) : undefined;
  const current = idx !== undefined && engine ? engine.elementCurrents()[idx] : undefined;
  const voltage = idx !== undefined && engine ? engine.elementVoltages()[idx] : undefined;
  const power = idx !== undefined && engine ? engine.elementPowers()[idx] : undefined;

  return (
    <div className="options" tabIndex={-1}>
      {problem && <div className="problem">{problem}</div>}

      {selected && def ? (
        <section ref={fieldsRef}>
          <h3>{def.label}</h3>
          {voltage !== undefined && (
            <dl className="readout">
              <dt>Voltage</dt>
              <dd>{formatValue(voltage, 'V', settings.decimalDigits)}</dd>
              <dt>Current</dt>
              <dd>{formatValue(current ?? 0, 'A', settings.decimalDigits)}</dd>
              <dt>Power</dt>
              {/* The readout uses the engine's scope-convention power, not
                  voltage * current: for a voltage or current source the display
                  voltage is the positive EMF while the scope's Power trace uses
                  V(post0) - V(post1), so multiplying here would show the wrong
                  sign for a source. */}
              <dd>{formatValue(power ?? 0, 'W', settings.decimalDigits)}</dd>
            </dl>
          )}
          {def.fields?.map((f) => (
            <Field
              key={f.name}
              field={f}
              value={fieldValue(selected, f)}
              onBeginEdit={beginEdit}
              onChange={(v) => {
                if (f.target === 'text') {
                  setText(selected.id, String(v));
                } else if (f.flag !== undefined) {
                  // A file flag is read when the engine builds the circuit and
                  // can change the stamp or the node count, so it has to go
                  // through `updateElement`, which bumps `revision` and forces
                  // a full rebuild. `setParam`'s live path only re-stamps.
                  const on = Number(v) !== 0;
                  updateElement(selected.id, {
                    flags: on ? selected.flags | f.flag : selected.flags & ~f.flag,
                  });
                } else {
                  const value = Number(v);
                  // Switching a source to or from pulse restores the duty
                  // cycle the other family expects, mirroring
                  // VoltageElm.java:617-621: entering pulse takes the legacy
                  // 1/(2*pi), leaving it returns to 0.5. The waveform
                  // setParam below also keeps the stored pulse-duty flag (bit
                  // 4) in step, so an edited duty survives the next rebuild.
                  if (f.name === 'waveform' && selected.kind === 'voltage') {
                    const old = Number(selected.params.waveform ?? 0);
                    if (value === 5 && old !== 5) setParam(selected.id, 'dutyCycle', 1 / (2 * Math.PI));
                    else if (old === 5 && value !== 5) setParam(selected.id, 'dutyCycle', 0.5);
                  }
                  setParam(selected.id, f.name, value);
                }
              }}
            />
          ))}
          <div className="row">
            <button type="button" onClick={() => addScope(selected.id, 'voltage')}>
              Scope voltage
            </button>
            <button type="button" onClick={() => addScope(selected.id, 'current')}>
              Scope current
            </button>
          </div>
        </section>
      ) : (
        <section>
          <h3>Nothing selected</h3>
          <p className="hint">Click an element to inspect and edit it.</p>
        </section>
      )}

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
            value={settings.stepsPerFrame}
            onChange={(e) => updateSettings({ stepsPerFrame: Number(e.target.value) })}
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
        <UnitInput
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
          <span>Run DC operating point</span>
        </label>
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
            checked={settings.smallGrid}
            onChange={(e) => updateSettings({ smallGrid: e.target.checked })}
          />
          <span>Small grid</span>
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
        <NumberSetting
          label="Decimal digits (short format)"
          value={settings.shortDecimalDigits}
          min={0}
          max={6}
          step={1}
          onChange={(n) => updateSettings({ shortDecimalDigits: n })}
        />
        <NumberSetting
          label="Decimal digits (long format)"
          value={settings.decimalDigits}
          min={0}
          max={6}
          step={1}
          onChange={(n) => updateSettings({ decimalDigits: n })}
        />
        <NumberSetting
          label="Value label font size"
          value={settings.valueFontSize}
          min={8}
          max={40}
          step={1}
          onChange={(n) => updateSettings({ valueFontSize: n })}
        />
      </section>

      <section>
        <h3>Input</h3>
        <NumberSetting
          label="Mouse wheel sensitivity"
          value={settings.wheelSensitivity}
          min={0.1}
          max={10}
          step={0.1}
          onChange={(n) => updateSettings({ wheelSensitivity: n })}
        />
      </section>
    </div>
  );
}
