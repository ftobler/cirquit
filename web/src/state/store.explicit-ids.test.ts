/** The explicit-id store variants: the command layer names its targets and
 *  must reach exactly the same mutation a selection-driven action performs,
 *  so an agent never has to fake a selection to run a document command. */

import { beforeEach, describe, expect, it } from 'vitest';
import { useStore } from './store';
import { fresh, undoDepth } from './store.test-helpers';

const elements = () => useStore.getState().elements;
/** Geometry and flags, without the session id allocateId advances. */
const geometry = () =>
  JSON.stringify(elements().map(({ id: _id, ...rest }) => rest));

const add = (x1: number, y1: number, x2: number, y2: number) =>
  useStore.getState().addElement({
    kind: 'resistor',
    x1,
    y1,
    x2,
    y2,
    flags: 0,
    params: { resistance: 1000 },
  });

beforeEach(() => {
  useStore.setState(fresh());
});

describe('deleteElements', () => {
  it('deletes exactly the named ids and leaves the rest selected', () => {
    const a = add(0, 0, 64, 0);
    const b = add(0, 32, 64, 32);
    useStore.getState().select([a, b]);

    useStore.getState().deleteElements([a]);

    expect(elements().map((e) => e.id)).toEqual([b]);
    expect(useStore.getState().selectedIds).toEqual([b]);
  });

  it('deletes the selection when deleteSelected is used', () => {
    const a = add(0, 0, 64, 0);
    const b = add(0, 32, 64, 32);
    useStore.getState().select([a, b]);

    useStore.getState().deleteSelected();

    expect(elements()).toEqual([]);
    expect(useStore.getState().selectedIds).toEqual([]);
  });
});

describe('explicit transforms match the selection wrappers', () => {
  it('rotateElements gives the same geometry as rotateSelection', () => {
    const id = add(0, 0, 160, 0);
    useStore.getState().select([id]);
    useStore.getState().rotateSelection();
    const viaSelection = geometry();

    useStore.setState(fresh());
    const id2 = add(0, 0, 160, 0);
    useStore.getState().rotateElements([id2]);
    expect(geometry()).toBe(viaSelection);
  });

  it('mirrorElements gives the same geometry as mirrorSelection', () => {
    const id = add(0, 0, 160, 0);
    useStore.getState().select([id]);
    useStore.getState().mirrorSelection('vertical');
    const viaSelection = geometry();

    useStore.setState(fresh());
    const id2 = add(0, 0, 160, 0);
    useStore.getState().mirrorElements([id2], 'vertical');
    expect(geometry()).toBe(viaSelection);
  });

  it('a rotate of a named id does not touch an unrelated selection', () => {
    const a = add(0, 0, 160, 0);
    const b = add(0, 64, 160, 64);
    useStore.getState().select([b]);
    const depth = undoDepth(useStore.getState());

    useStore.getState().rotateElements([a]);

    expect(elements()[0]).toMatchObject({ x1: 80, y1: 80, x2: 80, y2: -80 });
    expect(elements()[1]).toEqual(expect.objectContaining({ x1: 0, y1: 64, x2: 160, y2: 64 }));
    expect(undoDepth(useStore.getState())).toBe(depth + 1);
  });
});

describe('clipboard explicit ids', () => {
  it('copies only the named ids and pastes at the requested point', () => {
    add(0, 0, 64, 0);
    const b = add(0, 32, 64, 32);

    useStore.getState().copyElements([b]);
    useStore.setState({ selectedIds: [] });
    useStore.getState().pasteFromClipboard({ x: 320, y: 320 });

    const pasted = elements().at(-1)!;
    expect(pasted.id).not.toBe(b);
    expect([pasted.x1, pasted.y1]).toEqual([320, 320]);
    // Only the one named element travelled; the first resistor did not.
    expect(elements()).toHaveLength(3);
    expect(useStore.getState().selectedIds).toEqual([pasted.id]);
  });

  it('duplicateElements duplicates the named set without touching the clipboard', () => {
    const a = add(0, 0, 64, 0);
    add(0, 32, 64, 32);
    useStore.setState({ clipboard: 'kept' });

    useStore.getState().duplicateElements([a]);

    expect(elements()).toHaveLength(3);
    expect(useStore.getState().clipboard).toBe('kept');
    expect(useStore.getState().selectedIds).toEqual([elements().at(-1)!.id]);
  });
});
