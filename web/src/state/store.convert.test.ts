import { beforeEach, describe, expect, it } from 'vitest';
import { useStore } from './store';
import { fresh } from './store.test-helpers';

beforeEach(() => useStore.setState(fresh()));

describe('convertWiresToRouted prunes the selection', () => {
  const addWire = (x1: number, y1: number, x2: number, y2: number) =>
    useStore.getState().addElement({
      kind: 'wire',
      x1,
      y1,
      x2,
      y2,
      flags: 0,
      params: {},
    });

  it('keeps only the surviving routed wire id, dropping absorbed ids', () => {
    // A chain of two plain wires sharing an endpoint: converting absorbs the
    // second wire into the first's routed element, so its id must leave the
    // selection rather than outlive the removed element.
    const idA = addWire(0, 0, 160, 0);
    const idB = addWire(160, 0, 320, 0);
    useStore.getState().select([idA, idB]);

    useStore.getState().convertWiresToRouted();

    const s = useStore.getState();
    expect(s.elements).toHaveLength(1);
    expect(s.elements[0].kind).toBe('wire');
    expect(s.elements[0].route).toBeDefined();
    // Exactly one element survives, so the selection must hold exactly one id.
    expect(s.selectedIds).toHaveLength(1);
    expect(s.selectedIds.every((id) => s.elements.some((e) => e.id === id))).toBe(true);
    expect(s.elements.some((e) => e.id === idA || e.id === idB)).toBe(true);
  });

  it('is a no-op for the selection when nothing converts', () => {
    const idA = addWire(0, 0, 160, 0);
    useStore.getState().select([idA]);

    // A lone wire converts in place, keeping its id; the selection stays whole.
    useStore.getState().convertWiresToRouted();
    const s = useStore.getState();
    expect(s.elements).toHaveLength(1);
    expect(s.selectedIds).toEqual([idA]);
  });
});
