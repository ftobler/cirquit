/** Built-in device-model tables, the port of DiodeModel.java:82-116,
 *  TransistorModel.java:114-145 and MosfetModel.java:110-135. A named model
 *  with no `34`/`32` file line resolves against these tables at load, so a
 *  `d ... 2 1N4148` line simulates as a 1N4148 exactly like upstream's global
 *  modelMap (getModelWithNameOrCopy, DiodeModel.java:62-76).
 *
 *  The values are copied from the upstream table constructors (the read-only
 *  reference checkout); the port writes original code around them. `internal`
 *  marks the models upstream hides from the UI picker (getModelList,
 *  DiodeModel.java:185-200): they still resolve if a file names them, exactly
 *  like a map lookup. */

import type { DiodeModel, TransistorModel } from '../io/netlist/types';

/** Thermal voltage the forward-drop derivation uses (DiodeModel.java:32). */
const VT = 0.025865;

/** The device families a model name can name. The mosfet and jfet share one
 *  table upstream (MosfetModel, distinguished by the jfet flag); the diode
 *  family (diode/zener/varactor/led) all resolve through the diode table. */
export type ModelFamily = 'diode' | 'transistor' | 'mosfet' | 'jfet';

/** A built-in diode table row: the same four core params a `34` line carries,
 *  plus the picker visibility flag. */
export interface DiodeTableEntry extends DiodeModel {
  /** Hidden from the UI picker (DiodeModel.java:191-192); still resolves. */
  internal?: boolean;
}

/** A built-in transistor table row. The port's Ebers-Moll consumes only satCur
 *  and betaR; the rest of an upstream row stays unused, exactly as the `32`
 *  resolution treats it. */
export interface TransistorTableEntry extends TransistorModel {
  internal?: boolean;
}

/** A built-in mosfet/jfet table row. The structural flags (showBulk,
 *  bodyDiode, bodyTerminal, digitalSymbol) are deliberately not modelled: the
 *  port's engine has no expressible params for them, so `default-nodiode`,
 *  `default-body` and `default-digital` simulate identically to `default`.
 *  Only `threshold` and `beta` resolve. */
export interface MosfetTableEntry {
  threshold: number;
  beta: number;
  /** A JFET entry shows only in a JFET's picker (MosfetModel.java:212). */
  jfet: boolean;
  internal?: boolean;
}

/** The diode table (DiodeModel.java:82-116). The `~` internal models are
 *  loaded through loadInternalModel upstream and carry no forward description;
 *  they still resolve when a file names them, so they stay in the map. */
export const DIODE_MODELS: Readonly<Record<string, DiodeTableEntry>> = {
  'spice-default': { saturationCurrent: 1e-14, seriesResistance: 0, emissionCoefficient: 1, breakdownVoltage: 0 },
  default: { saturationCurrent: 1.7143528192808883e-7, seriesResistance: 0, emissionCoefficient: 2, breakdownVoltage: 0 },
  'default-zener': { saturationCurrent: 1.7143528192808883e-7, seriesResistance: 0, emissionCoefficient: 2, breakdownVoltage: 5.6 },
  // The old default LED's saturation current is far too small, which causes
  // numerical errors; kept only for files that already name it
  // (DiodeModel.java:87).
  'old-default-led': { saturationCurrent: 2.2349907006671927e-18, seriesResistance: 0, emissionCoefficient: 2, breakdownVoltage: 0, internal: true },
  // The default for newly created LEDs (DiodeModel.java:90).
  'default-led': { saturationCurrent: 93.2e-12, seriesResistance: 0.042, emissionCoefficient: 3.73, breakdownVoltage: 0 },
  'default-optocoupler-led': { saturationCurrent: 1.714e-7, seriesResistance: 0, emissionCoefficient: 4.077, breakdownVoltage: 0 },
  '1N5711': { saturationCurrent: 315e-9, seriesResistance: 2.8, emissionCoefficient: 2.03, breakdownVoltage: 70 },
  '1N5712': { saturationCurrent: 680e-12, seriesResistance: 12, emissionCoefficient: 1.003, breakdownVoltage: 20 },
  BAT85: { saturationCurrent: 2.076e-7, seriesResistance: 2.326, emissionCoefficient: 1.023, breakdownVoltage: 33 },
  // The model is inaccurate (DiodeModel.java:102), so upstream marks it
  // internal; a file that names it still resolves.
  '1N34': { saturationCurrent: 200e-12, seriesResistance: 84e-3, emissionCoefficient: 2.19, breakdownVoltage: 60, internal: true },
  '1N4004': { saturationCurrent: 18.8e-9, seriesResistance: 28.6e-3, emissionCoefficient: 2, breakdownVoltage: 400 },
  '1N4148': { saturationCurrent: 4.352e-9, seriesResistance: 0.6458, emissionCoefficient: 1.906, breakdownVoltage: 75 },
  'x2n2646-emitter': { saturationCurrent: 2.13e-11, seriesResistance: 0, emissionCoefficient: 1.8, breakdownVoltage: 0, internal: true },
  '~tl431ed-d_ed': { saturationCurrent: 1e-14, seriesResistance: 5, emissionCoefficient: 1, breakdownVoltage: 0, internal: true },
  '~lm317-dz': { saturationCurrent: 1e-14, seriesResistance: 0, emissionCoefficient: 1, breakdownVoltage: 6.3, internal: true },
};

/** The transistor table (TransistorModel.java:114-145). Only the two
 *  user-selectable models are shown; the internal entries exist for composite
 *  elements this port does not have (LM324v2, TL431, LM317), ported for map
 *  fidelity so a file that names one resolves. The port's Ebers-Moll consumes
 *  only satCur and betaR, exactly as the `32` resolution does; the rest of
 *  each upstream row stays unused. */
export const TRANSISTOR_MODELS: Readonly<Record<string, TransistorTableEntry>> = {
  default: { saturationCurrent: 1e-13, betaReverse: 1 },
  'spice-default': { saturationCurrent: 1e-16, betaReverse: 1 },
  'xlm324v2-qpi': { saturationCurrent: 1.01e-16, betaReverse: 1, internal: true },
  'xlm324v2-qpa': { saturationCurrent: 1.01e-16, betaReverse: 1, internal: true },
  'xlm324v2-qnq': { saturationCurrent: 1e-16, betaReverse: 1, internal: true },
  'xlm324v2-qpq': { saturationCurrent: 1e-16, betaReverse: 1, internal: true },
  '~tl431ed-qn_ed': { saturationCurrent: 1e-16, betaReverse: 1, internal: true },
  '~tl431ed-qn_ed-A1.2': { saturationCurrent: 1.2e-16, betaReverse: 1, internal: true },
  '~tl431ed-qn_ed-A2.2': { saturationCurrent: 2.2000000000000002e-16, betaReverse: 1, internal: true },
  '~tl431ed-qn_ed-A0.5': { saturationCurrent: 5e-17, betaReverse: 1, internal: true },
  '~tl431ed-qp_ed': { saturationCurrent: 1e-16, betaReverse: 1, internal: true },
  '~tl431ed-qn_ed-A5': { saturationCurrent: 5e-16, betaReverse: 1, internal: true },
  '~lm317-qpl-A0.1': { saturationCurrent: 1e-17, betaReverse: 1, internal: true },
  '~lm317-qnl-A0.2': { saturationCurrent: 2e-17, betaReverse: 1, internal: true },
  '~lm317-qpl-A0.2': { saturationCurrent: 2e-17, betaReverse: 1, internal: true },
  '~lm317-qnl-A2': { saturationCurrent: 2e-16, betaReverse: 1, internal: true },
  '~lm317-qpl-A2': { saturationCurrent: 2e-16, betaReverse: 1, internal: true },
  '~lm317-qnl-A5': { saturationCurrent: 5e-16, betaReverse: 1, internal: true },
  '~lm317-qnl-A50': { saturationCurrent: 5e-15, betaReverse: 1, internal: true },
};

/** The mosfet/jfet table (MosfetModel.java:110-135). All user-selectable, so
 *  no `internal` entry; the selector filters by the jfet flag instead. */
export const MOSFET_MODELS: Readonly<Record<string, MosfetTableEntry>> = {
  default: { threshold: 1.5, beta: 0.02, jfet: false },
  'default-nodiode': { threshold: 1.5, beta: 0.02, jfet: false },
  'default-body': { threshold: 1.5, beta: 0.02, jfet: false },
  'default-digital': { threshold: 1.5, beta: 0.02, jfet: false },
  // Values taken from Hayes+Horowitz p155 (MosfetModel.java:132-134). These
  // are exactly the port's jfet engine defaults (jfet.rs:38-39), so resolving
  // this entry is identity for the engine.
  'default-jfet': { threshold: -4, beta: 0.00125, jfet: true },
};

/** The device family an element kind's model name resolves against, or
 *  undefined for an element that cannot name a model. */
export function modelFamilyFor(kind: string): ModelFamily | undefined {
  switch (kind) {
    case 'diode':
    case 'zener':
    case 'varactor':
    case 'led':
      // All four share the diode model machinery upstream (VaractorElm,
      // ZenerElm and LEDElm extend DiodeElm), so one family serves them.
      return 'diode';
    case 'transistor':
      return 'transistor';
    case 'mosfet':
      return 'mosfet';
    case 'jfet':
      return 'jfet';
    default:
      return undefined;
  }
}

/** The picker option names for a family, sorted like upstream's getModelList
 *  (Collections.sort). Built-ins only, internal entries excluded, the
 *  mosfet/jfet split filtered by the jfet flag (MosfetModel.java:212), and
 *  `requireBreakdown` (the zener's picker, getModelList DiodeModel.java:193-194)
 *  dropping the diode rows whose breakdownVoltage is 0. */
export function selectableModels(family: ModelFamily, requireBreakdown = false): string[] {
  const names =
    family === 'transistor'
      ? Object.keys(TRANSISTOR_MODELS).filter((n) => !TRANSISTOR_MODELS[n].internal)
      : family === 'mosfet' || family === 'jfet'
        ? Object.keys(MOSFET_MODELS).filter(
            (n) => !MOSFET_MODELS[n].internal && MOSFET_MODELS[n].jfet === (family === 'jfet'),
          )
        : Object.keys(DIODE_MODELS).filter(
            (n) =>
              !DIODE_MODELS[n].internal &&
              (!requireBreakdown || DIODE_MODELS[n].breakdownVoltage !== 0),
          );
  return names.sort();
}

/** The forward drop a model implies, upstream's updateModel
 *  (DiodeModel.java:332-336). Deriving it matters: if the name is later
 *  dropped by an edit, the value-form dump writes the real drop, not the
 *  0.805904783 default. */
export function forwardVoltageFor(saturationCurrent: number, emissionCoefficient: number): number {
  return emissionCoefficient * VT * Math.log(1 / saturationCurrent + 1);
}

function paramsFor(
  family: ModelFamily,
  model: DiodeTableEntry | TransistorTableEntry | MosfetTableEntry,
): Record<string, number> {
  if (family === 'diode') {
    const d = model as DiodeTableEntry;
    return {
      saturationCurrent: d.saturationCurrent,
      seriesResistance: d.seriesResistance,
      emissionCoefficient: d.emissionCoefficient,
      breakdownVoltage: d.breakdownVoltage,
      forwardVoltage: forwardVoltageFor(d.saturationCurrent, d.emissionCoefficient),
    };
  }
  if (family === 'transistor') {
    const t = model as TransistorTableEntry;
    return { saturationCurrent: t.saturationCurrent, betaReverse: t.betaReverse };
  }
  const m = model as MosfetTableEntry;
  return { threshold: m.threshold, beta: m.beta };
}

function builtinEntry(
  family: ModelFamily,
  name: string,
): DiodeTableEntry | TransistorTableEntry | MosfetTableEntry | undefined {
  if (family === 'transistor') return TRANSISTOR_MODELS[name];
  if (family === 'mosfet' || family === 'jfet') return MOSFET_MODELS[name];
  return DIODE_MODELS[name];
}

/**
 * Resolve a named model to the params the engine reads, mirroring upstream's
 * `getModelWithNameOrCopy` (DiodeModel.java:62-76, TransistorModel.java:99-112,
 * MosfetModel.java:95-108):
 *
 * 1. The file's own `34`/`32` line wins when `fileModel` is present.
 * 2. On a file miss the built-in table is consulted, by exact case-sensitive
 *    name.
 * 3. A miss returns undefined so the caller keeps the element on its defaults,
 *    and the name round-trips. It never throws.
 *
 * The returned params are exactly what the `34`/`32` load-time resolution
 * writes: the diode family carries the derived forward drop, the transistor
 * carries satCur and betaR, the mosfet/jfet carries threshold and beta.
 */
export function resolveModelParams(
  family: ModelFamily,
  name: string,
  fileModel: DiodeModel | TransistorModel | null | undefined,
): Record<string, number> | undefined {
  if (fileModel !== null && fileModel !== undefined) {
    return paramsFor(family, fileModel as DiodeTableEntry | TransistorTableEntry);
  }
  const entry = builtinEntry(family, name);
  if (entry !== undefined) return paramsFor(family, entry);
  return undefined;
}
