/**
 * Embedded-scope config codec (the 403 ScopeElm row).
 *
 * A scope drawn on the sheet carries its whole view configuration as one
 * `_`-joined token after the common fields (ScopeElm.java:43-53). Upstream
 * splits that token and hands it to ScopeSerializer.undump exactly like an
 * `o` line's display fields, with the leading element index in front, so the
 * port decodes it through the same walk: this module splits on `_` and runs
 * the plot-list cursor plus `decodeScopeLine`. The raw token itself stays in
 * the element's `text` untouched; what lands here is the display-only
 * interpretation, so a loaded scope can draw live waveforms while an
 * unedited file still saves byte-for-byte.
 */

import type { ScopeValue } from '../engine/simulator';
import type { ScopePlot } from '../engine/simulator';
import { decodeScopeLine, type DecodedScopeLine } from './scopeLine';
import {
  FLAG_DIVISIONS,
  FLAG_PERPLOT_MAN_SCALE,
  FLAG_PERPLOTFLAGS,
  FLAG_PLOTS,
  importDecOrHex,
  scopeValueFromToken,
  unitsOf,
} from './netlist/parse';

/** One resolved trace of an embedded scope's config, before the element-id
 *  resolution pass: `elementIndex` is a file position, not an id. */
export interface DecodedEmbeddedPlot {
  /** The element index token: `e` for the first plot, `ne` after. A position
   *  in upstream's element list, not an index into anything loadable. */
  elementIndex: number;
  value: ScopeValue | null;
}

/** The decoder's result for one config token. */
export interface DecodedEmbeddedScope {
  /** The config token split on `_`, verbatim, first token the leading
   *  element index. */
  tokens: string[];
  plots: DecodedEmbeddedPlot[];
  display: DecodedScopeLine;
}

/** One resolved trace attached to a 403 element after `parseCircuit`'s second
 *  pass. Plot ids are session-unique handles the engine traces key on, the
 *  same role an `o`-line plot's id plays; they are allocated once at load so
 *  undo snapshots and frame-to-frame lookups stay stable. */
export interface EmbeddedScopePlot {
  id: number;
  /** The store element the file index resolved to, or null when it landed on
   *  a line this build could not read. Such a plot is preserved through the
   *  raw token only and is never registered as a trace. */
  elementId: number | null;
  value: ScopeValue | null;
}

/** The interpreted embedded-scope state carried on a 403 element. The raw
 *  token itself stays in the element's `text`; this is display-only. */
export interface EmbeddedScopeState {
  /** The config token split on `_`, verbatim, first token the leading
   *  element index. */
  tokens: string[];
  /** The display fields the shared o-line decoder recovered from the tokens
   *  after the leading element index. */
  display: DecodedScopeLine;
  plots: EmbeddedScopePlot[];
}

/**
 * Decodes one embedded-scope config token. `kindOf` resolves a file element
 * index to its kind, which decides both the value mapping (a transistor's
 * token 6 is VCE) and whether a per-unit scale token follows a value token;
 * it is the same resolver the `o` lines use. Returns null for anything
 * upstream draws as an empty scope: element index -1 (nothing traced yet),
 * a truncated or non-numeric header, or no plot list at all.
 */
export function decodeEmbeddedScope(
  config: string,
  kindOf: (fileIndex: number) => string | null,
): DecodedEmbeddedScope | null {
  const tokens = config.split('_');
  // The fixed header is `e speed value flags scaleV scaleA`, the same six
  // fields an `o` line carries before its optional tail.
  if (tokens.length < 6) return null;
  const elementIndex = Number(tokens[0]);
  // Upstream returns before touching anything else when e is -1, the fresh
  // scope's own dump (ScopeSerializer.java:193-195).
  if (!Number.isFinite(elementIndex) || elementIndex < 0) return null;

  // Everything after the element index has exactly the layout decodeScopeLine
  // reads: raw[0] is speed, raw[2] the flags word.
  const raw = tokens.slice(1);
  const valueToken = Number(raw[1]);
  const flags = importDecOrHex(raw[2] ?? '0');

  const plots: DecodedEmbeddedPlot[] = [
    { elementIndex, value: scopeValueFromToken(valueToken, kindOf(elementIndex)) },
  ];

  if ((flags & FLAG_PLOTS) !== 0) {
    // New-style dump: the plot-list walk, token-for-token the one
    // parseScopeLine runs over an `o` line (parse.ts, the FLAG_PLOTS branch)
    // and renumberPlotIndices re-walks on save. The only difference is the
    // base: raw already has the element index sliced off, so the cursor
    // starts at 5 instead of 7.
    let cursor = 5;  // raw[0]=speed [1]=value [2]=flags [3]=scaleV [4]=scaleA
    const next = (): number => Number(raw[cursor++]);
    const position = next();
    const sz = next();
    if (Number.isFinite(position) && Number.isFinite(sz)) {
      if ((flags & FLAG_DIVISIONS) !== 0) cursor += 1;
      // Plot 0's units can carry an extra scale token before the per-plot
      // tokens (ScopeSerializer.java:221-223).
      if (unitsOf(valueToken, kindOf(elementIndex)) > 1 && cursor < raw.length) cursor += 1;
      for (let i = 0; i < sz; i++) {
        if ((flags & FLAG_PERPLOTFLAGS) !== 0 && cursor < raw.length) cursor += 1;
        if (i !== 0) {
          const ne = next();
          const val = next();
          if (!Number.isFinite(ne) || !Number.isFinite(val)) break;
          plots.push({ elementIndex: ne, value: scopeValueFromToken(val, kindOf(ne)) });
          if (unitsOf(val, kindOf(ne)) > 1 && cursor < raw.length) cursor += 1;
        }
        if ((flags & FLAG_PERPLOT_MAN_SCALE) !== 0) cursor += 2;
      }
    }
  }

  // The display fields decode through the shared reader. Its perPlot output
  // is indexed like the plot list, which is why the stubs below must carry
  // the real values: the W/C/ohm default vertical positions are
  // value-dependent (ScopePlot.java:62-66).
  const stubs: ScopePlot[] = plots.map((p, i) => ({
    id: -1 - i,
    elementId: null,
    value: p.value,
    manScale: null,
    manVPosition: 0,
    acCoupled: false,
    measurements: null,
  }));
  const kinds = plots.map((p) => kindOf(p.elementIndex));
  const display = decodeScopeLine(raw, stubs, kinds, 0);
  return { tokens, plots, display };
}
