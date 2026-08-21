/** The element property rows, one control per `fields` entry of the registry
 *  def. Shared by the options panel and the element properties dialog, so a
 *  field added to a def shows up in both without further work. What the rows
 *  are and what a change does live next door in `elementFields.ts`, which is
 *  node-tested; this file is the controls and the file-picker plumbing. */

import type { SimEngine } from '../engine/simulator';
import { AUDIO_DECODE_ERROR, decodeAudioFile } from '../model/audioFile';
import { parseDataFile } from '../model/dataFile';
import { recorderDataText, recorderFilename } from '../model/recorder';
import { saveBlob } from '../io/fileIO';
import { selectableModels } from '../model/deviceModels';
import type { CircuitElement, FieldDef } from '../model/types';
import { useStore } from '../state/store';
import { applyFieldChange, clampInteger, fieldRows } from './elementFields';
import { UnitNumberInput } from './UnitNumberInput';

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
    // and calls the store action when the file is ready. The file input
    // deliberately does not commit on focus like the other fields: the read
    // and decode take time, so the undo baseline is taken by the store action
    // when the decoded samples actually land (store.ts loadAudioFile/
    // loadDataFile), which keeps an edit made mid-decode on its own undo step
    // and leaves nothing behind when the decode fails.
    return (
      <label className="field">
        <span>{field.label}</span>
        <input
          type="file"
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

  if (field.integer) {
    // A whole-number field (an input count, a bit width): a spinner stepping
    // by one, clamped to the def's range. A slider here would post fractions
    // the engine then truncates, so the shown value and the built circuit
    // would disagree.
    return (
      <label className="field">
        <span>{field.label}</span>
        <input
          type="number"
          value={v}
          min={field.min}
          max={field.max}
          step={1}
          onFocus={onBeginEdit}
          onChange={(e) => {
            const n = Number(e.target.value);
            // An empty box reads as NaN mid-edit; leave the value alone until
            // a number is there rather than snapping it to the minimum.
            if (Number.isFinite(n)) onChange(clampInteger(n, field));
          }}
        />
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

interface Props {
  element: CircuitElement;
  /** Only the data recorder's Export row needs it, to pull the ring buffer. */
  engine: SimEngine | null;
}

/** The def's property rows for one element. Every control writes through a
 *  store action, so undo bracketing, the revision bump and the engine rebuild
 *  behave the same wherever this list is mounted. */
export function ElementFields({ element, engine }: Props) {
  const timeStep = useStore((s) => s.settings.timeStep);
  const setParam = useStore((s) => s.setParam);
  const setText = useStore((s) => s.setText);
  const setKeyShortcut = useStore((s) => s.setKeyShortcut);
  const setModelName = useStore((s) => s.setModelName);
  const beginEdit = useStore((s) => s.beginEdit);
  const updateElement = useStore((s) => s.updateElement);
  const loadAudioFile = useStore((s) => s.loadAudioFile);
  const loadDataFile = useStore((s) => s.loadDataFile);

  return (
    <>
      {fieldRows(element).map(({ field, value }) => (
        <Field
          key={field.name}
          field={field}
          value={value}
          onBeginEdit={beginEdit}
          onDownload={
            field.type === 'download'
              ? () => {
                  // The engine holds the ring; the samples are pulled on
                  // demand and downloaded with upstream's filename and
                  // header (DataRecorderElm.java:106-118).
                  if (!engine) return;
                  const data = engine.recordedData(element.id);
                  saveBlob(
                    recorderFilename(),
                    new Blob([recorderDataText(data, timeStep)], { type: 'text/plain' }),
                  );
                }
              : undefined
          }
          onChange={(v) => {
            if (field.type === 'file' && field.fileLoad !== undefined) {
              // `v` is the FileList; the read and decode are asynchronous
              // and land through the store action once ready.
              loadFileInto(
                element,
                field.fileLoad,
                v as FileList | null,
                loadAudioFile,
                loadDataFile,
              );
              return;
            }
            applyFieldChange(element, field, v as number | string, {
              setParam,
              setText,
              setKeyShortcut,
              setModelName,
              updateElement,
            });
          }}
        />
      ))}
    </>
  );
}
