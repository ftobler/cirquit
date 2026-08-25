import { describe, expect, it } from 'vitest';
import type { CircuitElement } from '../model/types';
import { cachedDragHints, dragHintPoints, dragHintsActive } from './junctionHints';

const el = (kind: string, x1: number, y1: number, x2: number, y2: number): CircuitElement => ({
  id: 1,
  kind,
  x1,
  y1,
  x2,
  y2,
  flags: 0,
  params: {},
});

describe('seam hints', () => {
  it('marks a colinear wire-to-wire seam the dot rule hides, normal to the chain', () => {
    const left = el('wire', 0, 0, 80, 0);
    const right = { ...el('wire', 80, 0, 160, 0), id: 2 };

    // The chain runs horizontal, so the bar stands vertical.
    expect(dragHintPoints([left, right])).toEqual([{ x: 80, y: 0, vertical: true }]);
  });

  it('lays a horizontal bar across a vertical chain', () => {
    const top = { ...el('wire', 80, -80, 80, 0), id: 2 };
    const bottom = { ...el('wire', 80, 0, 80, 80), id: 3 };

    expect(dragHintPoints([top, bottom])).toEqual([{ x: 80, y: 0, vertical: false }]);
  });

  it('marks a seam spanning two kinds, wire end onto resistor lead', () => {
    const wire = el('wire', 0, 0, 80, 0);
    const resistor = { ...el('resistor', 80, 0, 160, 0), id: 2 };

    expect(dragHintPoints([wire, resistor])).toEqual([{ x: 80, y: 0, vertical: true }]);
  });

  it('refuses a corner: two members share a post but nothing continues', () => {
    // An L corner hides its dot like any pass-through, but its members do not
    // run one line, so it is not a coincident segment and gets no mark,
    // whichever element comes first in the document.
    const horizontal = { ...el('wire', 0, 0, 80, 0), id: 2 };
    const vertical = { ...el('wire', 80, 0, 80, 80), id: 3 };

    expect(dragHintPoints([horizontal, vertical])).toEqual([]);
    expect(dragHintPoints([vertical, horizontal])).toEqual([]);
  });

  it('refuses an angled join whose axes only tie-break into agreement', () => {
    // A 45 degree wire meeting a horizontal one shares a post and both store
    // spans lean horizontal; the direction check compares actual directions
    // through the coordinate, so the join stays unmarked.
    const diagonal = { ...el('wire', 0, 0, 80, 80), id: 2 };
    const across = { ...el('wire', 80, 80, 160, 80), id: 3 };

    expect(dragHintPoints([diagonal, across])).toEqual([]);
  });

  it('leaves a real junction alone: its circle already covers it', () => {
    const a = el('wire', 0, 0, 80, 0);
    const b = { ...el('wire', 80, 0, 80, 80), id: 2 };
    const c = { ...el('wire', 80, 0, 160, 0), id: 3 };

    expect(dragHintPoints([a, b, c])).toEqual([]);
  });

  it('leaves dead ends and bare routed bends alone', () => {
    const lone = el('wire', 0, 0, 80, 0);
    expect(dragHintPoints([lone])).toEqual([]);

    const routed = el('wire', 0, 0, 160, 0);
    routed.route = [
      [0, 0],
      [80, 80],
      [160, 0],
    ];
    expect(dragHintPoints([routed])).toEqual([]);
  });

  it('does not fake a meeting on a wide bus wire stacked over itself', () => {
    // A width-2 wire presents two posts per endpoint; the raw count of the
    // dangling end is 2 and the dot pass hides it, but both posts belong to
    // one element, which is no meeting at all.
    const wide = el('wire', 0, 0, 80, 0);
    wide.params.busWidth = 2;

    expect(dragHintPoints([wide])).toEqual([]);
  });

  it('gives a collapsed-to-point part no seam tick of its own', () => {
    const ghost = { ...el('wire', 80, 0, 80, 0), id: 2 };
    const elsewhere = { ...el('wire', 200, 200, 280, 280), id: 3 };

    expect(dragHintPoints([ghost, elsewhere], [2])).toEqual([]);
  });

  it('gives a text annotation nothing to reveal', () => {
    const resistor = el('resistor', 0, 0, 160, 0);
    const label = { ...el('decoration', 80, 0, 80, 0), id: 2, text: 'note' };

    expect(dragHintPoints([resistor, label])).toEqual([]);
  });

  it('marks a collapsed bus bank coordinate paired with a label anchor', () => {
    const splitter = el('busSplitter', 400, 300, 496, 300);
    splitter.params.bits = 4;
    const anchor = { ...el('labeledNode', 400, 300, 400, 300), id: 2, text: 'DBUS' };

    expect(dragHintPoints([splitter, anchor])).toEqual([{ x: 400, y: 300, vertical: true }]);
  });
});

describe('touch hints', () => {
  it('marks a dragged wire end lying on a static wire interior', () => {
    const across = el('wire', 0, 0, 160, 0);
    const dropped = { ...el('wire', 80, 0, 80, 80), id: 2 };

    expect(dragHintPoints([across, dropped], [2])).toEqual([{ x: 80, y: 0, vertical: true }]);
  });

  it('orients each touch by the leg it lands on of a routed wire', () => {
    const routed = el('wire', 0, 0, 240, 80);
    routed.route = [
      [0, 0],
      [0, 80],
      [240, 80],
    ];
    const onVerticalLeg = { ...el('wire', 0, 16, 80, 16), id: 2 };
    const onHorizontalLeg = { ...el('wire', 80, 80, 80, 160), id: 3 };

    expect(dragHintPoints([routed, onVerticalLeg, onHorizontalLeg], [2])).toEqual([
      { x: 0, y: 16, vertical: false },
    ]);
    expect(dragHintPoints([routed, onVerticalLeg, onHorizontalLeg], [3])).toEqual([
      { x: 80, y: 80, vertical: true },
    ]);
  });

  it('dedupes a moving post landing on a static lone post to one mark', () => {
    const parked = el('wire', 0, 0, 80, 0);
    const arriving = { ...el('wire', 80, 0, 160, 0), id: 2 };

    expect(dragHintPoints([parked, arriving], [2])).toEqual([{ x: 80, y: 0, vertical: true }]);
  });

  it('stands down when an arrival turns a hidden seam into a circled junction', () => {
    const left = el('wire', 0, 0, 80, 0);
    const right = { ...el('wire', 80, 0, 160, 0), id: 2 };
    const arriving = { ...el('wire', 80, 0, 80, 80), id: 3 };

    expect(dragHintPoints([left, right, arriving], [3])).toEqual([]);
  });

  it('marks a dragged post within lead reach of a component stub', () => {
    const resistor = el('resistor', 0, 0, 80, 0);
    const dragged = { ...el('wire', 16, 0, 96, 0), id: 2 };

    expect(dragHintPoints([resistor, dragged], [2])).toEqual([{ x: 16, y: 0, vertical: true }]);
  });

  it('turns the bar with the stub it touches, whichever way the part points', () => {
    const down = el('resistor', 0, 0, 0, 80);
    const dragged = { ...el('wire', 0, 16, 80, 16), id: 2 };

    expect(dragHintPoints([down, dragged], [2])).toEqual([{ x: 0, y: 16, vertical: false }]);
  });

  it('stays quiet over a component body, where the drop would connect nothing', () => {
    const resistor = el('resistor', 0, 0, 80, 0);
    const dragged = { ...el('wire', 40, 0, 120, 0), id: 2 };

    expect(dragHintPoints([resistor, dragged], [2])).toEqual([]);
  });

  it('never marks a plain crossing without a shared post', () => {
    const across = el('wire', 0, 0, 160, 0);
    const down = { ...el('wire', 80, -80, 80, 80), id: 2 };
    const elsewhere = { ...el('wire', 240, 240, 320, 320), id: 3 };

    expect(dragHintPoints([across, down, elsewhere], [3])).toEqual([]);
  });

  it('previews only what travels under a single-handle post drag', () => {
    // The stationary end already rests on a static wire interior, a red-dot
    // bad connection; release splits under the grabbed endpoint alone, so
    // only that endpoint may promise a split.
    const across = el('wire', 0, 0, 160, 0);
    const dragged = { ...el('wire', 40, 0, 240, 0), id: 2 };

    // Whole-element semantics (move or placement): both ends travel.
    expect(dragHintPoints([across, dragged], [2])).toEqual([{ x: 40, y: 0, vertical: true }]);
    // Post-drag semantics: only the far end moves.
    expect(dragHintPoints([across, dragged], [2], [{ x: 240, y: 0 }])).toEqual([]);
  });

  it('skips dragged targets but keeps a genuine seam inside the selection', () => {
    // Two selected wires crossing each other self-report nothing, while two
    // selected wires joined end to end keep their seam tick: the join stays
    // real wherever the group lands.
    const across = { ...el('wire', 0, 0, 160, 0), id: 2 };
    const down = { ...el('wire', 80, -80, 80, 80), id: 3 };
    expect(dragHintPoints([across, down], [2, 3])).toEqual([]);

    const left = { ...el('wire', 0, 400, 80, 400), id: 2 };
    const right = { ...el('wire', 80, 400, 160, 400), id: 3 };
    expect(dragHintPoints([left, right], [2, 3])).toEqual([{ x: 80, y: 400, vertical: true }]);
  });
});

describe('gesture gating', () => {
  it('arms exactly for the gestures whose posts can commit', () => {
    expect(dragHintsActive({ mode: 'none' })).toBe(false);
    expect(dragHintsActive({ mode: 'select' })).toBe(false);
    expect(dragHintsActive({ mode: 'rowcol' })).toBe(false);
    expect(dragHintsActive({ mode: 'pan' })).toBe(false);
    expect(dragHintsActive({ mode: 'wire' })).toBe(false);
    expect(dragHintsActive({ mode: 'move' })).toBe(true);
    expect(dragHintsActive({ mode: 'place' })).toBe(true);
    expect(dragHintsActive({ mode: 'dragpost' })).toBe(true);
  });
});

describe('cached hints', () => {
  it('reuses the scan until the scene, the dragged set or the movers change', () => {
    const left = { ...el('wire', 0, 0, 80, 0), id: 1 };
    const right = { ...el('wire', 80, 0, 160, 0), id: 2 };
    const scene = [left, right];

    const first = cachedDragHints(scene, []);
    expect(first).toEqual([{ x: 80, y: 0, vertical: true }]);
    expect(cachedDragHints(scene, [])).toBe(first);

    // A different id list over the same scene is a different answer.
    const withDrag = cachedDragHints(scene, [2]);
    expect(withDrag).not.toBe(first);

    // So are different moving positions.
    const withMovers = cachedDragHints(scene, [2], [{ x: 240, y: 0 }]);
    expect(withMovers).not.toBe(withDrag);

    // A fresh array from a moved element invalidates.
    const moved = [{ ...left, y1: 80, y2: 80 }, right];
    const after = cachedDragHints(moved, []);
    expect(after).toEqual([]);
  });
});
