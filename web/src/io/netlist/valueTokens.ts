/**
 * Value-token level helpers shared by every scope-line reader and writer: the
 * `o` flag bits that shape the plot list, the value-token codecs and the
 * per-kind units table.
 *
 * Split out of `netlist/parse.ts` so xmlToText, scopeLine and embeddedScope
 * can share them without importing the parser: those imports were the
 * back-edges of two runtime cycles rooted at parse. Every body here is a
 * literal token switch or an immutable number, holding no state of its own;
 * the only import is a type borrowed from the engine/scopeModel leaf.
 */

import type { ScopeValue } from '../../engine/scopeModel';

/** Scope `flags` bits that change how the `o` line's plot list is laid out
 *  (ScopeSerializer.java:13-19). Shared with the scope-line decoder, whose
 *  token walk must advance exactly as this one does. */
export const FLAG_PLOTS = 4096;
export const FLAG_PERPLOTFLAGS = 1 << 18;
export const FLAG_PERPLOT_MAN_SCALE = 1 << 19;
export const FLAG_DIVISIONS = 1 << 21;

/** Upstream's `importDecOrHex`: an `x` prefix means the rest is hex
 *  (ScopeSerializer.java:327-332). Shared with the scope-line decoder. */
export function importDecOrHex(token: string): number {
  if (token.startsWith('x')) return Number.parseInt(token.slice(1), 16);
  return Number(token);
}

/**
 * The `value`/`val` token to a trace quantity. Token 1 is the legacy power id
 * upstream rewrites to power for anything but a transistor
 * (ScopeSerializer.java:197-199); each element family answers the tokens its
 * own `getScopeValue` table owns (TransistorElm.java:582-593): a
 * transistor's IB/IC/IE/VBE/VBC/VCE and the VAL_R of a lamp, memristor or
 * ohmmeter (LampElm.java:218-219, MemristorElm.java:143-146,
 * OhmMeterElm.java:38-42) now map to engine-sampled values instead of null
 * plots. On a transistor, voltage (0)
 * and charge (8) deliberately still fall through to a plain voltage
 * difference, which is friendlier than upstream's flat zero for the same
 * token; only a truly unmodelled token above 8 maps to null, because drawing
 * a wrong waveform would be worse than preserving the line raw. Every other
 * kind falls through to a voltage difference (CircuitElm.java:1270-1273).
 */
export function scopeValueFromToken(token: number, kind: string | null): ScopeValue | null {
  if (kind === 'transistor') {
    switch (token) {
      case 0:
        return 'voltage';
      case 1:
        return 'ib';  // VAL_IB
      case 2:
        return 'ic';  // VAL_IC
      case 3:
        return 'ie';  // VAL_IE
      case 4:
        return 'vbe';  // VAL_VBE
      case 5:
        return 'vbc';  // VAL_VBC
      case 6:
        return 'vce';  // VAL_VCE
      case 7:
        return 'power';
      case 8:
        return 'voltage';
      default:
        return null;
    }
  }
  switch (token) {
    case 0:
      return 'voltage';
    case 2:
      // VAL_R: a lamp, memristor and ohmmeter answer getScopeValue for it
      // (LampElm.java:218-219, MemristorElm.java:143-146, OhmMeterElm.java:
      // 38-42); everything else reads it as its voltage like upstream's
      // default.
      return kind === 'lamp' || kind === 'memristor' || kind === 'ohmmeter'
        ? 'resistance'
        : 'voltage';
    case 7:
      return 'power';
    case 1:
      return 'power';  // legacy power id becomes power
    case 3:
      return 'current';
    case 8:
      // VAL_CHARGE: a capacitor plots C*Vplate, upstream's getScopeValue
      // (CapacitorElm.java:225-229); any other element falls through to its
      // voltage like the default below.
      return kind === 'capacitor' || kind === 'polarizedCapacitor' ? 'charge' : 'voltage';
    default:
      return 'voltage';
  }
}

/** The `value`/`val` token a trace quantity serializes as, the inverse of
 *  `scopeValueFromToken`. Shared with the scope-line encoder. The per-element
 *  names are unambiguous without the kind: only a lamp, memristor or ohmmeter
 *  ever carries a `resistance` plot and only a transistor an `ib`..`vce`
 *  one. */
export function valueTokenOf(value: ScopeValue | null): number {
  switch (value) {
    case 'current':
      return 3;
    case 'power':
      return 7;
    case 'charge':
      return 8;
    case 'resistance':
      return 2;  // VAL_R
    case 'ib':
      return 1;  // VAL_IB
    case 'ic':
      return 2;  // VAL_IC
    case 'ie':
      return 3;  // VAL_IE
    case 'vbe':
      return 4;  // VAL_VBE
    case 'vbc':
      return 5;  // VAL_VBC
    case 'vce':
      return 6;  // VAL_VCE
    default:
      return 0;
  }
}

/** The units index a value token plots in, mirroring `getScopeUnits`
 *  (CircuitElm.java:1274-1277, TransistorElm.java:595-602, LampElm.java:221-222,
 *  MemristorElm.java:145-147, OhmMeterElm.java:40-42, CapacitorElm.java:230-231).
 *  Only W and higher carry an extra scale token on the line, so this decides
 *  how far the plot walk advances (ScopeSerializer.java:221-223, 236-238). A
 *  lamp's VAL_R plots in ohms and a capacitor's VAL_CHARGE in coulombs, both >
 *  UNITS_A; skipping their scale token would read the next plot's `ne` one
 *  token early. Shared with the scope-line decoder, whose walk must agree
 *  token-for-token. */
export function unitsOf(token: number, kind: string | null): number {
  if (
    (kind === 'lamp' || kind === 'memristor' || kind === 'ohmmeter') &&
    token === 2
  ) {
    return 3;  // resistance: Ω
  }
  if ((kind === 'capacitor' || kind === 'polarizedCapacitor') && token === 8) return 4;  // charge: C
  if (kind === 'transistor') {
    if (token === 1 || token === 2 || token === 3) return 1;  // IB/IC/IE: A
    if (token === 7) return 2;  // power: W
    return 0;  // VBE/VBC/VCE: V
  }
  if (token === 1) return 2;  // legacy power id becomes power
  if (token === 3) return 1;  // current: A
  if (token === 7) return 2;  // power: W
  return 0;  // everything else: V
}
