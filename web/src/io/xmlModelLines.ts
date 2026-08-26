/**
 * The attribute reader and the device-model writers of the XML converter.
 *
 * Split from `xmlToText.ts` to keep that file readable: the `dm`/`tm`/`ccm`
 * model tags each rebuild one upstream model line (DiodeModel.dump,
 * TransistorModel.undump, CustomCompositeModel.buildXmlElement), and their
 * machinery shares nothing with the element writers beyond the attribute
 * reader, which lives here too so the converter can import it without a
 * cycle.
 */

import type { XmlNode } from './xml';
import { escapeToken } from './netlist/tokens';

/** Reads an attribute as a number, falling back on absence and throwing on
 *  garbage so a broken file fails loudly instead of producing a wrong line. */
export function attr(node: XmlNode, name: string, fallback: number): number {
  const v = node.attrs[name];
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`xml: ${node.tag} attribute ${name} is not a number: ${v}`);
  return n;
}

/** The `dm` diode model to a `34` line (DiodeModel.dump, DiodeModel.java:277-286). */
export function diodeModel(node: XmlNode): string {
  return [
    '34',
    escapeToken(node.attrs.nm ?? ''),
    attr(node, 'f', 0),
    attr(node, 'is', 1e-14),
    attr(node, 'rs', 0),
    attr(node, 'n', 1),
    attr(node, 'bv', 0),
    attr(node, 'fi', 0),
  ].join(' ');
}

/** The `tm` transistor model to a `32` line (TransistorModel.dump,
 *  TransistorModel.java:205-234). */
export function transistorModel(node: XmlNode): string {
  const tail: (string | number)[] = [
    '32',
    escapeToken(node.attrs.nm ?? ''),
    attr(node, 'f', 0),
    attr(node, 'is', 5e-13),
    attr(node, 'ikf', 0),
    attr(node, 'ise', 0),
    attr(node, 'ne', 1.5),
    attr(node, 'ikr', 0),
    attr(node, 'isc', 0),
    attr(node, 'nc', 2),
    attr(node, 'nf', 1),
    attr(node, 'nr', 1),
    attr(node, 'vaf', 0),
    attr(node, 'var', 0),
    attr(node, 'br', 3),
  ];
  for (const a of ['cje', 'vje', 'mje', 'cjc', 'vjc', 'mjc', 'tf', 'tr']) {
    if (node.attrs[a] !== undefined) tail.push(attr(node, a, 0));
  }
  return tail.join(' ');
}

/** One `ccm` custom-composite model to a `.` line: the size, the external
 *  pins (bus entries expanded under `bcs`), and the escaped child model lines
 *  and dump tokens (CustomCompositeModel.buildXmlElement). The engine builds
 *  only the child kinds it has composite models for; the rest ride the line
 *  and round-trip. */
export function compositeModel(node: XmlNode): string {
  const bcs = attr(node, 'bcs', 0) !== 0;
  const ext: (string | number)[] = [];
  let count = 0;
  const lines: string[] = [];
  const dumps: string[] = [];
  for (const child of node.children) {
    if (child.tag === 'ext') {
      const bw = attr(child, 'bw', 1);
      const name = child.attrs.nm ?? '';
      const nd = attr(child, 'nd', 0);
      const ps = attr(child, 'ps', 0);
      const sd = attr(child, 'sd', 0);
      if (bcs && bw > 1) {
        for (let j = 0; j < bw; j++) {
          ext.push(escapeToken(name), nd + j, ps, sd);
          count += 1;
        }
      } else {
        ext.push(escapeToken(name), nd, ps, sd);
        count += 1;
      }
      continue;
    }
    const className = CHILD_CLASS[child.tag];
    if (className !== undefined && child.attrs.nn !== undefined) {
      const nodes = child.attrs.nn.split(' ').map((v) => Number(v));
      lines.push(`${className} ${nodes.join(' ')}`);
      // The engine indexes the dump tokens by model-line position
      // (composite.rs, `dumps.get(i)`), so the two lists have to stay in step:
      // a child that contributes no line contributes no dump either, and one
      // whose tag carries no fields still contributes its flags.
      dumps.push(escapeChildField(childDumpToken(child) ?? String(attr(child, 'f', 0))));
    }
  }
  return [
    '.',
    escapeToken(node.attrs.nm ?? ''),
    attr(node, 'f', 0),
    attr(node, 'sx', 1),
    attr(node, 'sy', 1),
    count,
    ext.join(' '),
    escapeToken(lines.join('\r')),
    escapeToken(dumps.join(' ')),
  ].join(' ');
}

/** The upstream class name a ccm child's model line starts with. */
const CHILD_CLASS: Record<string, string> = {
  And: 'AndGateElm',
  Or: 'OrGateElm',
  Nand: 'NandGateElm',
  Nor: 'NorGateElm',
  Xor: 'XorGateElm',
  I: 'InverterElm',
  d: 'DiodeElm',
  w: 'WireElm',
  rw: 'RoutedWireElm',
  ln: 'LabeledNodeElm',
  cc: 'CustomCompositeElm',
};

/** One ccm child's `_`-joined dump token: its flags then its fields, the shape
 *  `composite.rs`'s `apply_dump` splits. Gates carry inputCount/output/high
 *  voltage; wires and labeled nodes carry nothing. */
function childDumpToken(node: XmlNode): string | null {
  const tag = node.tag;
  const f = attr(node, 'f', 0);
  if (tag === 'And' || tag === 'Or' || tag === 'Nand' || tag === 'Nor' || tag === 'Xor') {
    return [f, attr(node, 'in', 2), attr(node, 'o', 0), attr(node, 'hi', 5)].join('_');
  }
  if (tag === 'I') return [f, attr(node, 'sl', 0.5), attr(node, 'hi', 5)].join('_');
  if (tag === 'd') return [f, node.attrs.mo ?? 'default'].join('_');
  if (tag === 'cc') return [f, node.attrs.mo ?? ''].join('_');
  if (tag === 'w' || tag === 'rw' || tag === 'ln') return String(f);
  return null;
}

/** Escapes one field of a `_`-joined dump token (`_`, space and backslash), so
 *  the join's separators stay unambiguous (subcircuitBuild.ts:333-343). */
function escapeChildField(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/_/g, '\\u').replace(/ /g, '\\s');
}
