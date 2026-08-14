/** Properties of the selected element, the right-sidebar port of upstream's
 *  edit dialog (EditDialog, opened by `edit`/`elm:edit`). The global settings
 *  live in the Other Options dialog; this panel holds only the element half.
 *  The live readout ticks per frame through useLiveSimReadout, which re-reads
 *  the engine arrays while this panel is mounted with one element selected. */

import { useEffect, useRef } from 'react';
import type { SimEngine } from '../engine/simulator';
import { defFor } from '../model/registry';
import { AUDIO_DECODE_ERROR, decodeAudioFile } from '../model/audioFile';
import { parseDataFile } from '../model/dataFile';
import { recorderDataText, recorderFilename } from '../model/recorder';
import { formatValue } from '../render/draw';
import { saveBlob } from '../io/fileIO';
import { selectableModels } from '../model/deviceModels';
import type { CircuitElement, FieldDef } from '../model/types';
import { sliderFromSteps, stepsFromSlider } from '../state/helpers';
import { useStore } from '../state/store';
import { UnitNumberInput } from './UnitNumberInput';
import { useLiveSimReadout } from './useLiveSimReadout';

interface Props {
  engine: SimEngine | null;
}

/** Where a field reads from: free text, a bit of `e.flags`, a named model, or
 *  a param. A flag field is a checkbox, so it is handed to `Field` as 0 or 1. */
function fieldValue(e: CircuitElement, f: FieldDef): number | string {
  if (f.target === 'text') return e.text ?? '';
  if (f.target === 'keyShortcut') return e.keyShortcut ?? '';
  if (f.target === 'modelName') return e.modelName ?? '';
  if (f.flag !== undefined) return (e.flags & f.flag) !== 0 ? 1 : 0;
  return e.params[f.name] ?? 0;
}

function Field({
  field,
  value,
  onChange,
  onBeginEdit,
  onDownload,
}: {
  field: FieldDef;
  value: number | string;
  onChange: (v: number | string | FileList | null) => void;
  onBeginEdit: () => void;
  onDownload?: () => void;
}) {
  if (field.type === 'download') {
    // A one-shot button, the data recorder's export: the recorded samples
    // come from the engine on demand and land as a Blob download
    // (DataRecorderElm.java:99-125).
    return (
      <label className="field">
        <span>{field.label}</span>
        <button type="button" onClick={() => onDownload?.()}>
          Export
        </button>
      </label>
    );
  }

  if (field.type === 'file') {
    // The load itself is asynchronous (a FileReader plus, for audio, the
    // WebAudio decoder); the change handler in the parent does the reading
    // and calls the store action when the file is ready.
    return (
      <label className="field">
        <span>{field.label}</span>
        <input
          type="file"
          // Focus opens the edit session, so a file load is one undo entry,
          // same as the number and text fields; the async decode still lands
          // inside the session because commit's dedup only runs on the next
          // commit.
          onFocus={onBeginEdit}
          onChange={(e) => onChange(e.target.files)}
        />
      </label>
    );
  }

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

  if (field.type === 'modelChoice') {
    // The built-in model picker, the port of the upstream model edit item
    // (DiodeElm.java:197-210, MosfetElm.java:724-736). Options are the
    // family's built-in models plus the name-free "(default)" row; the select
    // posts a string, not a number. The zener's `zenerBreakdown` flag narrows
    // its list to the rows with a breakdown voltage (DiodeModel.java:193-194).
    // A loaded name outside the table (a file-defined `34` model, an unknown
    // name, or a zero-breakdown model the filter dropped) still displays as a
    // disabled option so it is not silently lost, mirroring upstream's choice
    // list which always contains the current model.
    const current = String(value ?? '');
    const options = selectableModels(field.modelFamily ?? 'diode', field.zenerBreakdown);
    const known = current === '' || options.includes(current);
    return (
      <label className="field">
        <span>{field.label}</span>
        <select
          value={current}
          onFocus={onBeginEdit}
          onChange={(e) => onChange(e.target.value)}
        >
          <option value="">(default)</option>
          {options.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
          {!known && (
            <option value={current} disabled>
              {current}
            </option>
          )}
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
      <UnitNumberInput
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

/**
 * Reads a picked file into the element: data files go through the pure
 * one-value-per-line parser and alert on the same "Expected format" message
 * upstream shows (DataInputElm.java:185-216); audio files go through the
 * WebAudio decoder, taking the first channel as the sample buffer. The
 * basename (path and extension stripped, AudioInputElm.java:160) becomes the
 * element's rail label, which is not part of the file format.
 */
function loadFileInto(
  e: CircuitElement,
  fileLoad: 'audio' | 'data',
  files: FileList | null,
  loadAudioFile: (id: number, samples: number[], samplingRate: number, fileName: string) => void,
  loadDataFile: (id: number, samples: number[], fileName: string) => void,
): void {
  const file = files && files[0];
  if (!file) return;
  const fileName = file.name.replace(/^.*\\/, '').replace(/\.[^.]*$/, '');
  if (fileLoad === 'data') {
    const reader = new FileReader();
    reader.onload = () => {
      const parsed = parseDataFile(String(reader.result));
      if (parsed.error !== null) {
        window.alert(parsed.error);
        return;
      }
      loadDataFile(e.id, parsed.samples, fileName);
    };
    reader.readAsText(file);
    return;
  }
  const reader = new FileReader();
  // All three failure routes land on the same alert: a read error, a missing
  // or throwing AudioContext constructor, or a failed decode.
  reader.onerror = () => window.alert(AUDIO_DECODE_ERROR);
  reader.onabort = () => window.alert(AUDIO_DECODE_ERROR);
  reader.onload = () => {
    const Ctx =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) {
      window.alert(AUDIO_DECODE_ERROR);
      return;
    }
    // `decodeAudioFile` absorbs the constructor throw and the decode failure
    // into the error state and swallows the best-effort close(), so no throw
    // or unhandled rejection escapes this callback.
    decodeAudioFile(reader.result as ArrayBuffer, () => new Ctx()).then((decoded) => {
      if (decoded.error !== null) {
        window.alert(decoded.error);
        return;
      }
      loadAudioFile(e.id, decoded.samples, decoded.samplingRate, fileName);
    });
  };
  reader.readAsArrayBuffer(file);
}

export function OptionsPanel({ engine }: Props) {
  const elements = useStore((s) => s.elements);
  const selectedIds = useStore((s) => s.selectedIds);
  const settings = useStore((s) => s.settings);
  const updateSettings = useStore((s) => s.updateSettings);
  const setParam = useStore((s) => s.setParam);
  const setText = useStore((s) => s.setText);
  const setKeyShortcut = useStore((s) => s.setKeyShortcut);
  const setModelName = useStore((s) => s.setModelName);
  const beginEdit = useStore((s) => s.beginEdit);
  const updateElement = useStore((s) => s.updateElement);
  const loadAudioFile = useStore((s) => s.loadAudioFile);
  const loadDataFile = useStore((s) => s.loadDataFile);
  const addScope = useStore((s) => s.addScope);

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

  // Only a single selection reads the engine per frame; with nothing or
  // several selected the readout stays hidden, matching the empty state below.
  const selectedId = selectedIds.length === 1 ? selectedIds[0] : undefined;
  const { current, voltage, power } = useLiveSimReadout(engine, selectedId);

  return (
    <div className="options" tabIndex={-1}>
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
              onDownload={
                f.type === 'download'
                  ? () => {
                      // The engine holds the ring; the samples are pulled on
                      // demand and downloaded with upstream's filename and
                      // header (DataRecorderElm.java:106-118).
                      if (!engine) return;
                      const data = engine.recordedData(selected.id);
                      saveBlob(
                        recorderFilename(),
                        new Blob([recorderDataText(data, settings.timeStep)], {
                          type: 'text/plain',
                        }),
                      );
                    }
                  : undefined
              }
              onChange={(v) => {
                if (f.type === 'file' && f.fileLoad !== undefined) {
                  // `v` is the FileList; the read and decode are asynchronous
                  // and land through the store action once ready.
                  loadFileInto(
                    selected,
                    f.fileLoad,
                    v as FileList | null,
                    loadAudioFile,
                    loadDataFile,
                  );
                } else if (f.target === 'text') {
                  setText(selected.id, String(v));
                } else if (f.target === 'keyShortcut') {
                  setKeyShortcut(selected.id, String(v));
                } else if (f.target === 'modelName') {
                  setModelName(selected.id, String(v));
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
      </section>
    </div>
  );
}
