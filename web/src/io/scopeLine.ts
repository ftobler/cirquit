/**
 * Scope `o` line display-field codec.
 *
 * The netlist parser reads an `o` line for its element attachment and keeps
 * every remaining display token verbatim in `Scope.raw`; this module interprets
 * those tokens into the Scope state on load and regenerates a new-style line
 * from the state on save. That makes a loaded scope render and measure as the
 * file configured, and UI edits persist instead of being silently dropped.
 *
 * The token walk here must agree token-for-token with `parseScopeLine`
 * (netlist/parse.ts) and with upstream's `undump`
 * (ScopeSerializer.java:188-289): a one-token drift would misread the per-plot
 * fields and swallow part of the label.
 */

import type { Scope, ScopePlot, ScopeValue } from '../engine/simulator';
import { unescapeToken, escapeToken } from './netlist/tokens';
import {
  FLAG_DIVISIONS,
  FLAG_PERPLOTFLAGS,
  FLAG_PERPLOT_MAN_SCALE,
  FLAG_PLOTS,
  importDecOrHex,
  unitsOf,
  valueTokenOf,
} from './netlist/parse';

/** Per-plot fields a scope line carries, indexed like the plot list. */
export interface DecodedPlotFields {
  acCoupled: boolean;
  /** The per-plot manScale token, or null when no pair was on the line. */
  manScale: number | null;
  /** The per-plot manVPosition token; upstream's -200..200 span (the port's
   *  draw divides by the same 200, so a 1:1 mapping keeps the file's on-screen
   *  position, ScopePlot.java:43, draw.ts:172). */
  manVPosition: number;
}

/** Every display field an `o` line carries, decoded from the raw tokens. */
export interface DecodedScopeLine {
  speed: number;
  /** The stacking column, normalised through `positionFromToken` (a missing or
   *  negative token becomes the caller's supplied fallback). */
  position: number;
  showI: boolean;
  showV: boolean;
  showMax: boolean;
  showMin: boolean;
  showScale: boolean;
  showP2P: boolean;
  showFreq: boolean;
  showRMS: boolean;
  showAverage: boolean;
  showDutyCycle: boolean;
  fftPlot: boolean;
  logSpectrum: boolean;
  plotXY: boolean;
  showPhaseAngle: boolean;
  manualScale: boolean;
  maxScale: boolean;
  /** The manual-mode division count, 8 when the line carries none
   *  (ScopeSerializer.java:218-220). */
  manDivisions: number;
  /** Show Extended Info (bit 1<<20), the Properties dialog's checkbox. */
  showElmInfo: boolean;
  /** The label, unescaped; empty when the line carried none. */
  label: string;
  scaleV: number;
  scaleA: number;
  perPlot: DecodedPlotFields[];
}

/** Scope flag bits the decoder reads, from the table researched out of
 *  ScopeSerializer.java:25-68. Bits 32 (YELM) and 2048 (IVALUE) are
 *  old-format only. */
const FLAG_SHOW_I = 1;
const FLAG_SHOW_V = 2;
const FLAG_SHOW_MAX_OFF = 4;
const FLAG_SHOW_FREQ = 8;
const FLAG_MAN_SCALE = 16;
const FLAG_PLOT2D = 64;
const FLAG_SHOW_MIN = 256;
const FLAG_SHOW_SCALE = 512;
const FLAG_FFT = 1024;
const FLAG_MAX_SCALE = 8192;
const FLAG_SHOW_RMS = 16384;
const FLAG_SHOW_DUTY = 32768;
const FLAG_LOG_SPECTRUM = 65536;
const FLAG_SHOW_AVERAGE = 1 << 17;
const FLAG_SHOW_ELM_INFO = 1 << 20;
const FLAG_SHOW_P2P = 1 << 22;
/** Show Phase Angle: the FFT per-bin phase overlay (ScopeFFT.java:9). */
const FLAG_SHOW_PHASE_ANGLE = 1 << 23;
/** FLAG_YELM / FLAG_IVALUE, old-style only: a y-element index and an extra
 *  value token that sit before the label (ScopeSerializer.java:264-274). */
const FLAG_YELM = 32;
const FLAG_IVALUE = 2048;
/** Per-plot flags read as hex with no `x` prefix, like `Integer.parseInt(_, 16)`
 *  (ScopeSerializer.java:231). */
const FLAG_AC = 1;

/** The vertical position a fresh plot of this value starts at: power, charge
 *  and resistance plots sit at the bottom of the manual-mode screen, everything
 *  else centred, upstream's ScopePlot constructor (ScopePlot.java:62-66). */
function defaultManVPosition(value: ScopeValue | null): number {
  return value === 'power' || value === 'charge' || value === 'resistance' ? -100 : 0;
}

/** The full flag word a scope's display state encodes, the port of upstream's
 *  `getFlags` (ScopeSerializer.java:25-47). Shared by the o-line encoder and
 *  the save-as-default storage, so the two can never drift. The per-plot bits
 *  (FLAG_PLOTS and friends) depend only on the scope state, so a UI-created
 *  scope and a loaded one encode identically. */
export function scopeDisplayFlags(scope: Scope): number {
  const anyPlotFlags = scope.plots.some((p) => p.acCoupled);
  const manual = scope.manualScale;
  return (
    (scope.showI ? FLAG_SHOW_I : 0) |
    (scope.showV ? FLAG_SHOW_V : 0) |
    (scope.showMax ? 0 : FLAG_SHOW_MAX_OFF) |
    (scope.showFreq ? FLAG_SHOW_FREQ : 0) |
    (scope.manualScale ? FLAG_MAN_SCALE : 0) |
    // plotXY writes both of upstream's 2D bits: plot2d.enabled and plotXY
    // (ScopeSerializer.java:31-32).
    (scope.plotXY ? FLAG_PLOT2D | 128 : 0) |
    (scope.showMin ? FLAG_SHOW_MIN : 0) |
    (scope.showScale ? FLAG_SHOW_SCALE : 0) |
    (scope.fftPlot ? FLAG_FFT : 0) |
    (scope.maxScale ? FLAG_MAX_SCALE : 0) |
    (scope.showRMS ? FLAG_SHOW_RMS : 0) |
    (scope.showDutyCycle ? FLAG_SHOW_DUTY : 0) |
    (scope.logSpectrum ? FLAG_LOG_SPECTRUM : 0) |
    (scope.showAverage ? FLAG_SHOW_AVERAGE : 0) |
    (scope.showP2P ? FLAG_SHOW_P2P : 0) |
    (scope.showElmInfo ? FLAG_SHOW_ELM_INFO : 0) |
    (scope.showPhaseAngle ? FLAG_SHOW_PHASE_ANGLE : 0) |
    FLAG_PLOTS |
    (anyPlotFlags ? FLAG_PERPLOTFLAGS : 0) |
    (manual ? FLAG_PERPLOT_MAN_SCALE : 0) |
    (manual ? FLAG_DIVISIONS : 0)
  );
}

/** The display fields a flag word encodes, the inverse of the flag half of
 *  `scopeDisplayFlags` and of upstream's `setFlags` (ScopeSerializer.java:49-68).
 *  The scope-defaults loader uses it: the stored blob carries only the flag
 *  word, never the plot list, so the per-plot bits are simply not read here. */
export function scopeFieldsFromFlags(flags: number): Pick<
  DecodedScopeLine,
  | 'showI'
  | 'showV'
  | 'showMax'
  | 'showMin'
  | 'showScale'
  | 'showP2P'
  | 'showFreq'
  | 'showRMS'
  | 'showAverage'
  | 'showDutyCycle'
  | 'fftPlot'
  | 'logSpectrum'
  | 'plotXY'
  | 'showPhaseAngle'
  | 'manualScale'
  | 'maxScale'
  | 'showElmInfo'
> {
  return {
    showI: (flags & FLAG_SHOW_I) !== 0,
    showV: (flags & FLAG_SHOW_V) !== 0,
    // Bit 4 is inverted: showMax was always on before the bit existed.
    showMax: (flags & FLAG_SHOW_MAX_OFF) === 0,
    showMin: (flags & FLAG_SHOW_MIN) !== 0,
    showScale: (flags & FLAG_SHOW_SCALE) !== 0,
    showP2P: (flags & FLAG_SHOW_P2P) !== 0,
    showFreq: (flags & FLAG_SHOW_FREQ) !== 0,
    showRMS: (flags & FLAG_SHOW_RMS) !== 0,
    showAverage: (flags & FLAG_SHOW_AVERAGE) !== 0,
    showDutyCycle: (flags & FLAG_SHOW_DUTY) !== 0,
    fftPlot: (flags & FLAG_FFT) !== 0,
    logSpectrum: (flags & FLAG_LOG_SPECTRUM) !== 0,
    // Upstream's plot2d.enabled; the corpus sets bit 64 for X-Y, with or
    // without the separate plotXY bit 128 (ScopeSerializer.java:55-56).
    plotXY: (flags & FLAG_PLOT2D) !== 0,
    showPhaseAngle: (flags & FLAG_SHOW_PHASE_ANGLE) !== 0,
    manualScale: (flags & FLAG_MAN_SCALE) !== 0,
    maxScale: (flags & FLAG_MAX_SCALE) !== 0,
    showElmInfo: (flags & FLAG_SHOW_ELM_INFO) !== 0,
  };
}

/** The stacking column a position token maps to. A missing or negative token
 *  means "unstacked, own column", which upstream assigns the scope's own index
 *  (ScopeManager.java:335-336); the caller supplies that index as the fallback
 *  so load and save agree on the same value. */
export function positionFromToken(token: number, fallback: number): number {
  return Number.isFinite(token) && token >= 0 ? token : fallback;
}

/** Decodes the display fields of an `o` line. `raw` is the line's tokens after
 *  the element index (so `raw[0]` is `speed`, as the store's `Scope.raw`
 *  stores it). `plots` are the already-parsed trace list, used to size the
 *  per-plot output; `kinds[i]` is the element kind of plot `i`, which decides
 *  whether a per-unit scale token follows that plot's value token. `position`
 *  comes out normalised through `positionFromToken` with `positionFallback`
 *  (the scope's own index when the line carried none), so load and the save
 *  path agree on one value. The trigger bits are deliberately not read:
 *  FLAG_TRIGGER (1<<24) carries no state in the text format and upstream never
 *  restores it, so the trigger stays at the freeRun default. */
export function decodeScopeLine(
  raw: string[],
  plots: ScopePlot[],
  kinds: (string | null)[],
  positionFallback: number,
): DecodedScopeLine {
  const valueToken = Number(raw[1]);
  const flags = importDecOrHex(raw[2] ?? '0');

  const perPlot: DecodedPlotFields[] = plots.map((p) => ({
    acCoupled: false,
    manScale: null,
    // Without a per-plot pair the constructor default stands, so a W/C plot
    // loads at the bottom of the manual-mode screen exactly as upstream's
    // ScopePlot constructor placed it (ScopePlot.java:62-66).
    manVPosition: defaultManVPosition(p.value),
  }));

  // Cursor over the raw tokens: the fixed `speed value flags scaleV scaleA`
  // fields end at index 4, so both styles start walking after the position
  // token at raw[5]. New-style reads it and the plot count; old-style skips
  // only the optional yElm/IVALUE pair before the label.
  let cursor = 5;
  let manDivisions = 8;
  if ((flags & FLAG_PLOTS) !== 0) {
    const next = (): number => Number(raw[cursor++]);
    const position = next();
    const sz = next();
    if (Number.isFinite(position) && Number.isFinite(sz)) {
      if ((flags & FLAG_DIVISIONS) !== 0) {
        const d = Number(raw[cursor++]);
        if (Number.isFinite(d) && d > 0) manDivisions = d;
      }
      // Plot 0's units can carry an extra scale token before the per-plot
      // tokens (ScopeSerializer.java:221-223).
      if (unitsOf(valueToken, kinds[0] ?? null) > 1 && cursor < raw.length) cursor += 1;
      for (let i = 0; i < sz && i < perPlot.length; i++) {
        if ((flags & FLAG_PERPLOTFLAGS) !== 0 && cursor < raw.length) {
          const plotFlags = Number.parseInt(raw[cursor++] ?? '', 16);
          perPlot[i].acCoupled = Number.isFinite(plotFlags) && (plotFlags & FLAG_AC) !== 0;
        }
        if (i !== 0) {
          const ne = next();
          const val = next();
          if (!Number.isFinite(ne) || !Number.isFinite(val)) break;
          if (unitsOf(val, kinds[i] ?? null) > 1 && cursor < raw.length) cursor += 1;
        }
        if ((flags & FLAG_PERPLOT_MAN_SCALE) !== 0) {
          const manScale = Number(raw[cursor++]);
          const manVPosition = Number(raw[cursor++]);
          if (Number.isFinite(manScale) && Number.isFinite(manVPosition)) {
            perPlot[i].manScale = manScale;
            perPlot[i].manVPosition = manVPosition;
          }
        }
      }
    }
  } else {
    // Old-style dumps carry no plot list: after the position token only an
    // optional yElm/IVALUE pair separates the label from the fixed fields.
    cursor = 6;
    if ((flags & FLAG_YELM) !== 0) cursor += 1;
    if ((flags & FLAG_IVALUE) !== 0) cursor += 1;
  }

  const labelTokens = raw.slice(cursor);
  return {
    speed: Number(raw[0]) || 64,
    position: positionFromToken(Number(raw[5]), positionFallback),
    ...scopeFieldsFromFlags(flags),
    manDivisions,
    showElmInfo: (flags & FLAG_SHOW_ELM_INFO) !== 0,
    label: labelTokens.length > 0 ? unescapeToken(labelTokens.join(' ')) : '',
    // A truncated line can end before these tokens; fall back to the makeScope
    // defaults so the decoded state stays finite, load and scopeLineMatches
    // agree, and an untouched truncated line still round-trips verbatim.
    scaleV: Number.isFinite(Number(raw[3])) ? Number(raw[3]) : 20,
    scaleA: Number.isFinite(Number(raw[4])) ? Number(raw[4]) : 0.05,
    perPlot,
  };
}

/** Regenerates a new-style `o` line's tokens (after the element index) from the
 *  scope state, matching upstream's `undump` shape (ScopeSerializer.java:213-256).
 *  `indexOf` resolves a plot's store element id to its file ordinal, -1 for a
 *  null element, the existing scopeUIRaw convention. `kinds[i]` is plot i's
 *  element kind, the same list `decodeScopeLine` walks with: whether a value
 *  token carries a per-unit scale token is kind-dependent (a transistor's Ib
 *  plots in amps, a lamp's R in ohms), so the encoder must decide it against
 *  the same kinds the decoders read or its output would not re-decode to
 *  itself. The encoder only writes new-style lines; upstream parses both. */
export function encodeScopeLine(
  scope: Scope,
  indexOf: (elementId: number) => number | undefined,
  kinds: (string | null)[],
): string[] {
  const first = scope.plots[0];
  const manual = scope.manualScale;
  const flags = scopeDisplayFlags(scope);
  const anyPlotFlags = scope.plots.some((p) => p.acCoupled);

  const tokens = [
    String(scope.speed),
    String(valueTokenOf(first.value)),
    String(flags),
    String(scope.scaleV),
    String(scope.scaleA),
    String(scope.position),
    String(scope.plots.length),
  ];
  // The divisions token sits between the plot count and the first plot's
  // per-unit scale, exactly where undump reads it (ScopeSerializer.java:219-220).
  if (manual) tokens.push(String(scope.manDivisions));
  // A W, C or Ω plot carries a scale token (ScopeSerializer.java:221-223).
  // Charge and resistance need the explicit value check for a plot whose kind
  // is unknown here (its element left the document): only a capacitor's charge
  // and a lamp's resistance are ever those plots, so `unitsOf` with a null
  // kind would wrongly read them as volts and drop their skip token.
  const needsScaleToken = (value: ScopeValue | null, kind: string | null): boolean =>
    value === 'charge' || value === 'resistance' || unitsOf(valueTokenOf(value), kind) > 1;
  if (needsScaleToken(first.value, kinds[0] ?? null)) tokens.push('20');
  for (let i = 0; i < scope.plots.length; i++) {
    const p = scope.plots[i];
    if (anyPlotFlags) tokens.push(p.acCoupled ? '1' : '0');
    if (i !== 0) {
      const index = p.elementId === null ? -1 : (indexOf(p.elementId) ?? -1);
      tokens.push(String(index), String(valueTokenOf(p.value)));
      if (needsScaleToken(p.value, kinds[i] ?? null)) tokens.push('20');
    }
    if (manual) {
      // A plot without a user scale keeps a neutral pair so the flag stays
      // readable; upstream writes a pair for every plot under the flag.
      tokens.push(String(p.manScale ?? 1), String(p.manVPosition));
    }
  }
  if (scope.label !== '') tokens.push(escapeToken(scope.label));
  return tokens;
}

/** True when the scope state still matches what `raw` decodes to, the check
 *  the save path uses to keep an untouched loaded line byte-for-byte. Speed is
 *  deliberately excluded: `serializeDocument` patches the speed token onto the
 *  raw line separately, so a zoom must not force a regeneration. `position` is
 *  compared through the same `positionFromToken` normalisation the load used,
 *  with the scope's own index as the fallback. */
export function scopeLineMatches(
  scope: Scope,
  raw: string[],
  kinds: (string | null)[],
  positionFallback: number,
): boolean {
  const decoded = decodeScopeLine(raw, scope.plots, kinds, positionFallback);
  return (
    decoded.position === scope.position &&
    decoded.showI === scope.showI &&
    decoded.showV === scope.showV &&
    decoded.showMax === scope.showMax &&
    decoded.showMin === scope.showMin &&
    decoded.showScale === scope.showScale &&
    decoded.showP2P === scope.showP2P &&
    decoded.showFreq === scope.showFreq &&
    decoded.showRMS === scope.showRMS &&
    decoded.showAverage === scope.showAverage &&
    decoded.showDutyCycle === scope.showDutyCycle &&
    decoded.fftPlot === scope.fftPlot &&
    decoded.logSpectrum === scope.logSpectrum &&
    decoded.plotXY === scope.plotXY &&
    decoded.showPhaseAngle === scope.showPhaseAngle &&
    decoded.manualScale === scope.manualScale &&
    decoded.maxScale === scope.maxScale &&
    decoded.manDivisions === scope.manDivisions &&
    decoded.showElmInfo === scope.showElmInfo &&
    decoded.label === scope.label &&
    decoded.scaleV === scope.scaleV &&
    decoded.scaleA === scope.scaleA &&
    decoded.perPlot.length === scope.plots.length &&
    decoded.perPlot.every(
      (d, i) =>
        d.acCoupled === scope.plots[i].acCoupled &&
        d.manScale === scope.plots[i].manScale &&
        d.manVPosition === scope.plots[i].manVPosition,
    )
  );
}
