/** Properties of the selected element, plus global simulation settings. */

import type { SimEngine } from '../engine/simulator';
import { defFor } from '../model/registry';
import { formatValue } from '../render/draw';
import type { FieldDef } from '../model/types';
import { useStore } from '../state/store';

/** Holds the live options panel root so the context menu's Edit can focus it. */
let panelRef: HTMLElement | null = null;

/** Moves keyboard focus to the options panel; a no-op while it is not mounted. */
export function focusOptionsPanel(): void {
  panelRef?.focus();
}

interface Props {
  engine: SimEngine | null;
}

function Field({
  field,
  value,
  onChange,
}: {
  field: FieldDef;
  value: number | string;
  onChange: (v: number | string) => void;
}) {
  if (field.type === 'text') {
    return (
      <label className="field">
        <span>{field.label}</span>
        <input type="text" value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} />
      </label>
    );
  }

  // Every remaining field type is numeric; recover the number for them.
  const v = typeof value === 'string' ? Number(value) : value;

  if (field.type === 'choice') {
    return (
      <label className="field">
        <span>{field.label}</span>
        <select value={v} onChange={(e) => onChange(Number(e.target.value))}>
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
          onChange={(e) => onChange(Number(e.target.value))}
        />
      </label>
    );
  }

  return (
    <label className="field">
      <span>
        {field.label}
        {field.unit ? ` (${field.unit})` : ''}
      </span>
      <input
        type="number"
        value={v}
        step="any"
        onChange={(e) => {
          const n = Number(e.target.value);
          if (Number.isFinite(n)) onChange(n);
        }}
      />
    </label>
  );
}

export function OptionsPanel({ engine }: Props) {
  const elements = useStore((s) => s.elements);
  const selectedIds = useStore((s) => s.selectedIds);
  const settings = useStore((s) => s.settings);
  const setParam = useStore((s) => s.setParam);
  const setText = useStore((s) => s.setText);
  const updateSettings = useStore((s) => s.updateSettings);
  const addScope = useStore((s) => s.addScope);
  const problem = useStore((s) => s.problem);

  const selected = elements.find((e) => e.id === selectedIds[0]);
  const def = selected ? defFor(selected.kind) : undefined;

  const idx = selected && engine ? engine.indexOf(selected.id) : undefined;
  const current = idx !== undefined && engine ? engine.elementCurrents()[idx] : undefined;
  const voltage = idx !== undefined && engine ? engine.elementVoltages()[idx] : undefined;

  return (
    <div
      className="options"
      tabIndex={-1}
      ref={(el) => {
        panelRef = el;
      }}
    >
      {problem && <div className="problem">{problem}</div>}

      {selected && def ? (
        <section>
          <h3>{def.label}</h3>
          {voltage !== undefined && (
            <dl className="readout">
              <dt>Voltage</dt>
              <dd>{formatValue(voltage, 'V')}</dd>
              <dt>Current</dt>
              <dd>{formatValue(current ?? 0, 'A')}</dd>
              <dt>Power</dt>
              <dd>{formatValue((voltage ?? 0) * (current ?? 0), 'W')}</dd>
            </dl>
          )}
          {def.fields?.map((f) => (
            <Field
              key={f.name}
              field={f}
              value={f.target === 'text' ? (selected.text ?? '') : (selected.params[f.name] ?? 0)}
              onChange={(v) =>
                f.target === 'text'
                  ? setText(selected.id, String(v))
                  : setParam(selected.id, f.name, Number(v))
              }
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
        <label className="field">
          <span>Timestep (s)</span>
          <input
            type="number"
            step="any"
            value={settings.timeStep}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (v > 0) updateSettings({ timeStep: v });
            }}
          />
        </label>

        {(
          [
            ['showCurrent', 'Show current'],
            ['showValues', 'Show values'],
            ['showVoltageColor', 'Colour by voltage'],
            ['showGrid', 'Show grid'],
            ['snapToGrid', 'Snap to grid'],
          ] as const
        ).map(([key, label]) => (
          <label key={key} className="check">
            <input
              type="checkbox"
              checked={settings[key]}
              onChange={(e) => updateSettings({ [key]: e.target.checked })}
            />
            <span>{label}</span>
          </label>
        ))}
      </section>
    </div>
  );
}
