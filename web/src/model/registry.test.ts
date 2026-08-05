import { describe, expect, it } from 'vitest';
import {
  ELEMENT_DEFS,
  opAmpInputAnchors,
  opAmpLabelAnchors,
  postsOf,
  transistorBarContacts,
} from './registry';
import { mirrorElement } from './transform';
import type { CircuitElement, Point } from './types';

const element = (
  kind: string,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  flags = 0,
  params: Record<string, number> = {},
): CircuitElement => ({ id: 1, kind, x1, y1, x2, y2, flags, params });

/** Signed distance of `p` from the element's axis; the sign is the side. */
const axisSide = (e: CircuitElement, p: Point): number =>
  (e.x2 - e.x1) * (p.y - e.y1) - (e.y2 - e.y1) * (p.x - e.x1);


/** Param names a parse or dump function reads or writes, whatever its shape. */
function referencedParams(fn: unknown): Set<string> {
  const names = new Set<string>();
  if (typeof fn !== 'function') return names;
  const src = fn.toString();
  for (const m of src.matchAll(/\.params\.(\w+)/g)) names.add(m[1]);
  // readParams(t, e, ['a', 'b']) and writeParams(['a', 'b']) both pass their
  // names in an array literal; quoted strings elsewhere in a dump are harmless
  // extras that never make a check fail. Vitest transpiles to double quotes,
  // so accept either quote style.
  for (const m of src.matchAll(/\[([^\]]*)\]/g)) {
    for (const n of m[1].matchAll(/(['"])([^'"]+)\1/g)) names.add(n[2]);
  }
  return names;
}

describe('text field metadata', () => {
  it('declares both fields on the text element, the text one targeting e.text', () => {
    const def = ELEMENT_DEFS.find((d) => d.kind === 'decoration');
    expect(def?.fields).toEqual([
      { name: 'text', label: 'Text', type: 'text', target: 'text' },
      { name: 'size', label: 'Size', unit: 'px' },
    ]);
  });

  it('gives the labeled node, another e.text label, the same text field', () => {
    const def = ELEMENT_DEFS.find((d) => d.kind === 'labeledNode');
    expect(def?.fields).toEqual([{ name: 'text', label: 'Text', type: 'text', target: 'text' }]);
  });

  it('keeps every target text field a text field', () => {
    for (const def of ELEMENT_DEFS) {
      for (const f of def.fields ?? []) {
        if (f.target === 'text') expect(f.type).toBe('text');
      }
    }
  });

  it('binds every field name to something the element reads or writes', () => {
    for (const def of ELEMENT_DEFS) {
      const bound = new Set([
        ...Object.keys(def.defaults ?? {}),
        ...referencedParams(def.parse),
        ...referencedParams(def.dump),
      ]);
      for (const f of def.fields ?? []) {
        if (f.target === 'text') continue;
        expect(bound.has(f.name), `${def.kind} field '${f.name}' is bound to nothing`).toBe(true);
      }
    }
  });
});

describe('mirrored drawing geometry', () => {
  // A mirror must move the drawn leads and labels onto the same side of the
  // body as the posts they connect to; a lead that does not would cross the
  // symbol and the minus glyph would sit on the non-inverting input.
  it('keeps the op-amp inverting lead and its minus glyph on the inverting post side', () => {
    const a = element('opamp', 0, 0, 160, 0);
    const m = mirrorElement(a);
    const [inPost] = postsOf(m);
    const [inLead] = opAmpInputAnchors(m);
    const [minus] = opAmpLabelAnchors(m);
    expect(axisSide(m, inPost)).toBeGreaterThan(0);  // sanity: post off the axis
    expect(axisSide(m, inLead) * axisSide(m, inPost)).toBeGreaterThan(0);
    expect(axisSide(m, minus) * axisSide(m, inPost)).toBeGreaterThan(0);
  });

  it('keeps the transistor collector and emitter leads on their posts side', () => {
    const t = element('transistor', 0, 0, 160, 0, 0, { pnp: 1 });
    const m = mirrorElement(t);
    const posts = postsOf(m);
    const [collLead, emitLead] = transistorBarContacts(m);
    expect(axisSide(m, posts[1])).toBeGreaterThan(0);  // sanity: collector off the axis
    expect(axisSide(m, collLead) * axisSide(m, posts[1])).toBeGreaterThan(0);
    expect(axisSide(m, emitLead) * axisSide(m, posts[2])).toBeGreaterThan(0);
  });
});
