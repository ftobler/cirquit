/** The device-model create and edit dialog, the port of upstream's
 *  EditDiodeModelDialog/EditTransistorModelDialog/EditMosfetModelDialog. One
 *  component serves every model-naming family: the rows follow the upstream
 *  field tables but only the ones this port's engine consumes, so a row that
 *  would silently lie (a transistor's early voltage, which the Ebers-Moll does
 *  not read) is left out. OK applies the fields through the store action,
 *  which registers the writable entry and rebinds or refreshes the referencing
 *  elements; Cancel discards. */

import { useState } from 'react';
import {
  forwardVoltageAt,
  simpleDiodeEntry,
  synthesizeModelName,
  type ModelFamily,
  type UserDiodeEntry,
  type UserModelEntry,
  type UserMosfetEntry,
  type UserTransistorEntry,
} from '../model/deviceModels';
import { useStore } from '../state/store';
import type { AppState } from '../state/store';
import { Dialog } from './Dialog';
import { isCommitEnter } from './dialogEnter';

/** One numeric row: a plain number box accepting scientific notation, with the
 *  value kept as a string so an empty or half-typed field stays editable. */
function NumberRow({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <input
        type="number"
        step="any"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

function s(v: number | undefined, fallback: number): string {
  return v === undefined ? String(fallback) : String(v);
}

export function DeviceModelEditorDialog() {
  const editor = useStore((s) => s.deviceModelEditor);
  const closeDeviceModelEditor = useStore((s) => s.closeDeviceModelEditor);
  const applyDeviceModelEdit = useStore((s) => s.applyDeviceModelEdit);
  if (editor === null) return null;
  return (
    <EditorDialogBody
      editor={editor}
      onClose={closeDeviceModelEditor}
      onApply={applyDeviceModelEdit}
    />
  );
}

/** The dialog body, split from the store reader so every hook runs on every
 *  render (the editor is null when closed, which would otherwise skip them). */
function EditorDialogBody({
  editor,
  onClose,
  onApply,
}: {
  editor: NonNullable<AppState['deviceModelEditor']>;
  onClose: () => void;
  onApply: (family: ModelFamily, entry: UserModelEntry, attachedElementId?: number, prevName?: string) => void;
}) {
  const { family, initial, attachedElementId, prevName } = editor;
  const simple = family === 'diode' && ((initial as UserDiodeEntry).flags ?? 0) !== 0;

  const [name, setName] = useState(initial.name);
  // A loaded simple model's `34` line carries only the forward current; the
  // voltage field is derived from it and the emission coefficient, upstream's
  // setForwardVoltage (DiodeModel.java:326-330).
  const [saturationCurrent, setSaturationCurrent] = useState(
    s((initial as UserDiodeEntry).saturationCurrent, 1e-14),
  );
  const [seriesResistance, setSeriesResistance] = useState(
    s((initial as UserDiodeEntry).seriesResistance, 0),
  );
  const [emissionCoefficient, setEmissionCoefficient] = useState(
    s((initial as UserDiodeEntry).emissionCoefficient, 1),
  );
  const [forwardVoltage, setForwardVoltage] = useState(
    s(
      simple
        ? (initial as UserDiodeEntry).forwardVoltage ??
            forwardVoltageAt(
              (initial as UserDiodeEntry).saturationCurrent,
              (initial as UserDiodeEntry).emissionCoefficient,
              (initial as UserDiodeEntry).forwardCurrent ?? 1,
            )
        : 0,
      0,
    ),
  );
  const [forwardCurrent, setForwardCurrent] = useState(
    s(simple ? (initial as UserDiodeEntry).forwardCurrent : undefined, 1),
  );
  const [breakdownVoltage, setBreakdownVoltage] = useState(
    s((initial as UserDiodeEntry).breakdownVoltage, 0),
  );
  const [betaReverse, setBetaReverse] = useState(
    s((initial as UserTransistorEntry).betaReverse, 1),
  );
  const [threshold, setThreshold] = useState(s((initial as UserMosfetEntry).threshold, 1.5));
  const [beta, setBeta] = useState(s((initial as UserMosfetEntry).beta, 0.02));
  const [error, setError] = useState<string | null>(null);

  const num = (raw: string): number | undefined => {
    const v = Number(raw);
    return raw !== '' && Number.isFinite(v) ? v : undefined;
  };

  const ok = () => {
    // The same positivity guards the `34`/`32` load path applies: a
    // non-positive saturation current would make the derived forward drop
    // infinite, and the simple mode's emission coefficient derives from a
    // positive voltage and current (DiodeModel.java:319-321).
    const is = num(saturationCurrent);
    if (is === undefined || !(is > 0)) {
      setError('Saturation current must be a positive number');
      return;
    }
    let entry: UserModelEntry;
    if (family === 'diode') {
      const bv = Math.abs(num(breakdownVoltage) ?? 0);
      if (simple) {
        const fwdV = num(forwardVoltage);
        const fwdI = num(forwardCurrent);
        if (fwdV === undefined || !(fwdV > 0) || fwdI === undefined || !(fwdI > 0)) {
          setError('Forward voltage and current at that voltage must be positive numbers');
          return;
        }
        // Simple mode pins the series resistance to zero and derives the
        // emission coefficient, exactly as upstream's setEmissionCoefficient
        // does (DiodeModel.java:319-324) - but only when a field actually
        // changed, so an untouched file model keeps its `n` token's bytes.
        entry = simpleDiodeEntry(initial as UserDiodeEntry, {
          name,
          saturationCurrent: is,
          forwardVoltage: fwdV,
          forwardCurrent: fwdI,
          breakdownVoltage: bv,
        });
      } else {
        const n = num(emissionCoefficient);
        if (n === undefined || !(n > 0)) {
          setError('Emission coefficient must be a positive number');
          return;
        }
        entry = {
          name,
          builtIn: false,
          flags: 0,
          saturationCurrent: is,
          seriesResistance: num(seriesResistance) ?? 0,
          emissionCoefficient: n,
          breakdownVoltage: bv,
        };
      }
    } else if (family === 'transistor') {
      const br = num(betaReverse);
      if (br === undefined || !(br > 0)) {
        setError('Reverse beta must be a positive number');
        return;
      }
      entry = {
        name,
        builtIn: false,
        saturationCurrent: is,
        betaReverse: br,
      };
    } else {
      entry = {
        name,
        builtIn: false,
        threshold: num(threshold) ?? 1.5,
        beta: num(beta) ?? 0.02,
        jfet: family === 'jfet',
      };
    }
    const finalName = synthesizeModelName(family, entry, prevName);
    // A typed name another model already holds gets a numeric suffix; say so,
    // or the rename reads as the user's own choice instead of a collision
    // being resolved (this port's accepted divergence from upstream pickName,
    // which only suffixes synthesized names).
    if (name !== '' && finalName !== name) {
      useStore.getState().setNotice(`Model name "${name}" is taken; saved as "${finalName}"`);
    }
    entry.name = finalName;
    onApply(family, entry, attachedElementId, prevName);
    onClose();
  };

  const cancel = () => onClose();

  const title =
    family === 'diode'
      ? 'Edit Diode Model'
      : family === 'transistor'
        ? 'Edit Transistor Model'
        : 'Edit Mosfet Model';

  return (
    <Dialog
      title={title}
      onClose={cancel}
      actions={
        <>
          <button type="button" onClick={ok}>
            OK
          </button>
          <button type="button" onClick={cancel}>
            Cancel
          </button>
        </>
      }
    >
      <label className="field">
        <span>Model Name</span>
        <input
          type="text"
          value={name}
          autoFocus
          onChange={(e) => {
            setName(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => {
            if (isCommitEnter(e)) ok();
          }}
        />
      </label>
      <NumberRow label="Saturation Current" value={saturationCurrent} onChange={setSaturationCurrent} />
      {family === 'diode' ? (
        simple ? (
          <>
            <NumberRow label="Forward Voltage" value={forwardVoltage} onChange={setForwardVoltage} />
            <NumberRow label="Current At Above Voltage (A)" value={forwardCurrent} onChange={setForwardCurrent} />
          </>
        ) : (
          <>
            <NumberRow label="Series Resistance" value={seriesResistance} onChange={setSeriesResistance} />
            <NumberRow label="Emission Coefficient" value={emissionCoefficient} onChange={setEmissionCoefficient} />
          </>
        )
      ) : family === 'transistor' ? (
        <NumberRow label="Reverse Beta (BR)" value={betaReverse} onChange={setBetaReverse} />
      ) : (
        <>
          <NumberRow label="Threshold Voltage (Vt)" value={threshold} onChange={setThreshold} />
          <NumberRow label="Beta" value={beta} onChange={setBeta} />
        </>
      )}
      {family === 'diode' && (
        <NumberRow label="Breakdown Voltage" value={breakdownVoltage} onChange={setBreakdownVoltage} />
      )}
      {error && <p className="problem">{error}</p>}
      {family === 'diode' && simple && (
        <p className="hint">
          The emission coefficient is derived from the forward voltage and
          current, as upstream's simple mode does.
        </p>
      )}
    </Dialog>
  );
}