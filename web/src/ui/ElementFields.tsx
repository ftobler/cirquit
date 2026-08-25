/** The element property rows, one control per `fields` entry of the registry
 *  def. Shared by the options panel and the element properties dialog, so a
 *  field added to a def shows up in both without further work. What the rows
 *  are and what a change does live next door in `elementFields.ts`, which is
 *  node-tested; this file is the controls and the file-picker plumbing. */

import { Fragment, useRef, useState } from 'react';
import type { SimEngine } from '../engine/simulator';
import { AUDIO_DECODE_ERROR, decodeAudioFile } from '../model/audioFile';
import { parseDataFile } from '../model/dataFile';
import { recorderDataText, recorderFilename } from '../model/recorder';
import { saveBlob } from '../io/fileIO';
import { selectableModels } from '../model/deviceModels';
import type { CircuitElement, FieldDef } from '../model/types';
import { useStore } from '../state/store';
import {
  applyFieldChange,
  changeArmsBaseline,
  clampInteger,
  commitBinaryFile,
  commitContentsField,
  compositeEditModelState,
  deviceModelButtons,
  draftForToken,
  fieldRows,
  type DraftCell,
} from './elementFields';
import { UnitNumberInput } from './UnitNumberInput';

function Field({
  field,
  label,
  value,
  onChange,
  onBeginEdit,
  onDownload,
  resetToken,
}: {
  field: FieldDef;
  label: string;
  value: number | string;
  onChange: (v: number | string | FileList | null) => boolean | void;
  onBeginEdit: () => void;
  onDownload?: () => void;
  /** Only the contents row uses it: the external-write token that drops an
   *  open draft when a binary file load lands. */
  resetToken?: number;
}) {
  // Whether the pending edit's undo baseline was already armed, by focus or
  // by an earlier self-arming change below. Only the checkbox and select rows
  // consult it; the text and number rows always receive real focus events.
  const armedRef = useRef(false);
  const armOnFocus = () => {
    armedRef.current = true;
    onBeginEdit();
  };
  const armOnChange = () => {
    const decision = changeArmsBaseline(armedRef.current);
    if (decision.arm) onBeginEdit();
    armedRef.current = decision.armed;
  };

  if (field.type === 'download') {
    // A one-shot button, the data recorder's export: the recorded samples
    // come from the engine on demand and land as a Blob download
    // (DataRecorderElm.java:99-125).
    return (
      <label className="field">
        <span>{label}</span>
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
        <span>{label}</span>
        <input
          type="file"
          onChange={(e) => onChange(e.target.files)}
        />
      </label>
    );
  }

  if (field.type === 'contents') {
    // The SRAM/ROM memory editor, a five-line textarea (upstream's
    // setVisibleLines(5)).
    return (
      <ContentsField
        label={label}
        value={String(value ?? '')}
        onBeginEdit={onBeginEdit}
        onCommit={onChange}
        resetToken={resetToken ?? 0}
      />
    );
  }

  if (field.type === 'text') {
    // A multiline text field is a textarea, the battery's SOC voltage table
    // whose rows are newline-separated (BatteryElm.java:370-374). A one-line
    // input strips newlines, which would concatenate the rows into garbage.
    if (field.multiline) {
      return (
        <label className="field">
          <span>{label}</span>
          <textarea
            rows={6}
            value={String(value ?? '')}
            // Focus opens the edit session, so the whole typing session is one
            // undo entry; commit's dedup drops a focus that changed nothing.
            onFocus={onBeginEdit}
            onChange={(e) => onChange(e.target.value)}
          />
        </label>
      );
    }
    return (
      <label className="field">
        <span>{label}</span>
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
          // changed nothing. Safari never focuses a checkbox on click, so
          // the change handler arms as well when focus did not.
          onFocus={armOnFocus}
          onChange={(e) => {
            armOnChange();
            onChange(e.target.checked ? 1 : 0);
          }}
        />
        <span>{label}</span>
      </label>
    );
  }

  if (field.type === 'choice') {
    // A loaded value outside the choices (the realistic op-amp's modelType 1,
    // the old 324 upstream hides from fresh parts) must still display rather
    // than silently show the first option, the same disabled-option handling
    // the model picker gives an unknown name below.
    const current = v;
    const known = field.choices?.some((c) => c.value === current) ?? false;
    return (
      <label className="field">
        <span>{label}</span>
        <select
          value={v}
          // Focus opens the edit session so a waveform or type change is one
          // undo entry, same as the number and text fields. Safari never
          // focuses a select on click, so the change handler arms as well
          // when focus did not.
          onFocus={armOnFocus}
          onChange={(e) => {
            armOnChange();
            onChange(Number(e.target.value));
          }}
        >
          {field.choices?.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
          {!known && (
            <option value={current} disabled>
              {field.outOfRangeLabel ?? current}
            </option>
          )}
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
        <span>{label}</span>
        <select
          value={current}
          onFocus={armOnFocus}
          onChange={(e) => {
            armOnChange();
            onChange(e.target.value);
          }}
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
        <span>{label}</span>
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
          {label} <em>{v.toFixed(2)}</em>
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
        label={`${label} (${field.unit})`}
        value={v}
        onFocus={onBeginEdit}
        onCommit={(n) => onChange(n)}
      />
    );
  }

  return (
    <label className="field">
      <span>
        {label}
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
 * The SRAM/ROM contents editor row: a five-line monospace textarea. The value
 * is the pair text re-derived per render, so it always shows the current
 * contents in the current radix while the user is not editing; a local draft
 * holds the typing while focused. The draft rides a token: an external write
 * to the contents (a binary file load) bumps it, which drops the draft, so a
 * later blur cannot commit stale text over the loaded pairs. Commit parses
 * and stores on blur and Ctrl+Enter. A parse error alerts and keeps the draft
 * so the bad value stays on screen for fixing, and focus opens the edit
 * session so the whole spell is one undo entry, the bracketing every other
 * field uses.
 */
function ContentsField({
  label,
  value,
  onBeginEdit,
  onCommit,
  resetToken = 0,
}: {
  label: string;
  value: string;
  onBeginEdit: () => void;
  onCommit: (text: string) => boolean | void;
  resetToken?: number;
}) {
  const [cell, setCell] = useState<DraftCell>({ token: 0, text: null });
  const draft = draftForToken(cell, resetToken);
  const text = draft !== null ? draft : value;
  return (
    <label className="field">
      <span>{label}</span>
      <textarea
        className="memory-contents"
        rows={5}
        value={text}
        onFocus={() => {
          onBeginEdit();
          // Seed the draft only when there is none: after a failed commit the
          // bad text must survive a refocus so the user can fix it. A stale
          // cell (its token bumped under it) seeds fresh like no draft at all.
          setCell((c) =>
            draftForToken(c, resetToken) !== null ? c : { token: resetToken, text: value },
          );
        }}
        onChange={(e) => setCell({ token: resetToken, text: e.target.value })}
        onBlur={() => {
          if (draft === null) return;
          if (onCommit(draft)) setCell({ token: resetToken, text: null });
        }}
        onKeyDown={(e) => {
          if (e.ctrlKey && e.key === 'Enter') {
            e.preventDefault();
            if (draft === null) return;
            if (onCommit(draft)) {
              setCell({ token: resetToken, text: null });
              e.currentTarget.blur();
            }
          }
        }}
      />
    </label>
  );
}

/**
 * Reads a picked file into the element: data files go through the pure
 * one-value-per-line parser and alert on the same "Expected format" message
 * upstream shows (DataInputElm.java:185-216); audio files go through the
 * WebAudio decoder, taking the first channel as the sample buffer; binary
 * files land as SRAM contents, refused at 128000 bytes like upstream's
 * SRAMLoadFile.java:36-39. The basename (path and extension stripped,
 * AudioInputElm.java:160) becomes the element's rail label, which is not part
 * of the file format.
 */
function loadFileInto(
  e: CircuitElement,
  fileLoad: 'audio' | 'data' | 'binary',
  files: FileList | null,
  loadAudioFile: (id: number, samples: number[], samplingRate: number, fileName: string) => void,
  loadDataFile: (id: number, samples: number[], fileName: string) => void,
  setMemoryContents: (id: number, pairs: [number, number][]) => void,
  onBinaryLoaded: () => void,
): void {
  const file = files && files[0];
  if (!file) return;
  if (fileLoad === 'binary') {
    if (file.size >= 128000) {
      window.alert('Cannot load: That file is too large!');
      return;
    }
    // Same asynchronous shape as the two sample loaders: when the read lands,
    // any open contents draft drops first, then the bytes are encoded into
    // the editor's run and committed through the textarea's own parse-and-
    // store path.
    const reader = new FileReader();
    // A failed or aborted read must not strand the dialog silently; every
    // audio loader route alerts the same way.
    reader.onerror = () => window.alert('Cannot load: That file could not be read!');
    reader.onabort = reader.onerror;
    reader.onload = () => {
      onBinaryLoaded();
      commitBinaryFile(
        e,
        new Uint8Array(reader.result as ArrayBuffer),
        window.alert,
        { setMemoryContents },
      );
    };
    reader.readAsArrayBuffer(file);
    return;
  }
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

/** The create/edit buttons under a `modelChoice` row, the port of upstream's
 *  Create New Model and Edit Model rows (DiodeElm.java:211-227): the diode
 *  family offers a simple and an advanced create, the other model-naming
 *  families one generic create, and Edit Model appears only when the current
 *  name resolves to a writable model. Clicking opens the shared device-model
 *  dialog seeded from this element. */
function ModelButtonRow({
  element,
  onOpen,
}: {
  element: CircuitElement;
  onOpen: (action: 'create-simple' | 'create-advanced' | 'create' | 'edit') => void;
}) {
  const buttons = deviceModelButtons(element);
  if (!buttons.createSimple && !buttons.createAdvanced && !buttons.create && !buttons.edit) {
    return null;
  }
  return (
    <div className="row">
      {buttons.createSimple && (
        <button type="button" onClick={() => onOpen('create-simple')}>
          Create Simple Model
        </button>
      )}
      {buttons.createAdvanced && (
        <button type="button" onClick={() => onOpen('create-advanced')}>
          Create Advanced Model
        </button>
      )}
      {buttons.create && (
        <button type="button" onClick={() => onOpen('create')}>
          Create Model
        </button>
      )}
      {buttons.edit && (
        <button type="button" onClick={() => onOpen('edit')}>
          Edit Model
        </button>
      )}
    </div>
  );
}

/** The composite element's Edit Model button row, the port of upstream's
 *  CustomCompositeElm.java:234-238, :273-281: enters the model's internals for
 *  editing by pushing the drill-in context. The built-in default stub refuses
 *  with the same alert upstream shows (CustomCompositeElm.java:253-255), and a
 *  successful enter closes the properties dialog, as upstream's edit dialog
 *  closes on entry. */
function CompositeEditModelButton({ element }: { element: CircuitElement }) {
  const enterSubcircuit = useStore((s) => s.enterSubcircuit);
  const closeElementProperties = useStore((s) => s.closeElementProperties);
  if (compositeEditModelState(element) === 'none') return null;
  return (
    <div className="row">
      <button
        type="button"
        onClick={() => {
          if (compositeEditModelState(element) === 'default') {
            window.alert("Can't edit this model.");
            return;
          }
          const name = element.text ?? '';
          // A refusal (an unresolvable name, a child kind the port cannot
          // build) leaves the reason in subcircuitError; the user stays put.
          if (enterSubcircuit(name)) closeElementProperties();
          else window.alert(useStore.getState().subcircuitError);
        }}
      >
        Edit Model
      </button>
    </div>
  );
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
  const setMemoryContents = useStore((s) => s.setMemoryContents);
  const beginEdit = useStore((s) => s.beginEdit);
  const updateElement = useStore((s) => s.updateElement);
  const loadAudioFile = useStore((s) => s.loadAudioFile);
  const loadDataFile = useStore((s) => s.loadDataFile);
  const openDeviceModelEditor = useStore((s) => s.openDeviceModelEditor);
  // Bumped when a binary file load lands, dropping any open contents draft so
  // the stale text cannot be committed over the loaded pairs on blur.
  const [contentsReset, bumpContentsReset] = useState(0);

  return (
    <>
      {fieldRows(element).map(({ field, label, value }) => (
        <Fragment key={field.name}>
          <Field
            field={field}
            label={label}
            value={value}
            onBeginEdit={beginEdit}
            resetToken={field.type === 'contents' ? contentsReset : undefined}
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
                  setMemoryContents,
                  () => bumpContentsReset((n) => n + 1),
                );
                return;
              }
              if (field.type === 'contents') {
                // The commit owns the parse and the alert; its boolean tells
                // the textarea whether the change landed, so a parse error
                // keeps the bad draft on screen for fixing.
                return commitContentsField(element, String(v), window.alert, {
                  setMemoryContents,
                });
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
          {field.type === 'modelChoice' && (
            <ModelButtonRow
              element={element}
              onOpen={(action) => openDeviceModelEditor(element.kind, element.id, action)}
            />
          )}
          {field.name === 'modelName' && element.kind === 'customComposite' && (
            <CompositeEditModelButton element={element} />
          )}
        </Fragment>
      ))}
    </>
  );
}
