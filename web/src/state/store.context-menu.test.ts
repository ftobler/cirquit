/** The context menu, dialog and element-properties panel are modal surfaces
 *  that must close on the same whole-document events that already tear down
 *  the scope properties, device-model editor and scroll-value popover. A menu
 *  left open across an undo/redo/load/new keeps modalSurface() true and blocks
 *  every shortcut, and its actions can target an element id the new document
 *  no longer holds. These tests pin the teardown behaviour. */

import { beforeEach, describe, expect, it } from 'vitest';
import { modalSurface } from '../input/modalSurface';
import { useStore } from './store';
import { addResistor, fresh } from './store.test-helpers';

beforeEach(() => useStore.setState(fresh()));

const openMenu = () => {
  const id = addResistor();
  useStore
    .getState()
    .openContextMenu(10, 20, id, { x: 0, y: 0 }, false);
  return id;
};

describe('contextMenu is torn down by whole-document events', () => {
  it('undo closes an open context menu and drops the keyboard gate', () => {
    useStore.getState().commit();
    openMenu();
    expect(modalSurface(useStore.getState())).toBe(true);

    useStore.getState().undo();

    expect(useStore.getState().contextMenu).toBeNull();
    expect(modalSurface(useStore.getState())).toBe(false);
  });

  it('redo closes an open context menu', () => {
    // Build an undo/redo pair, then open the menu without committing so that
    // redo() keeps a non-empty redoStack and actually reaches its teardown.
    addResistor();
    useStore.getState().commit();
    useStore.getState().undo();
    expect(useStore.getState().redoStack.length).toBeGreaterThan(0);

    // openContextMenu does not commit, so it leaves the redo future intact.
    useStore.getState().openContextMenu(10, 20, 1, { x: 0, y: 0 }, false);
    expect(useStore.getState().contextMenu).not.toBeNull();

    useStore.getState().redo();

    expect(useStore.getState().contextMenu).toBeNull();
    expect(modalSurface(useStore.getState())).toBe(false);
  });

  it('loadNetlist closes an open context menu', () => {
    openMenu();
    expect(modalSurface(useStore.getState())).toBe(true);

    useStore.getState().loadNetlist('$ 1 0.000000 10.0 -1\n');

    expect(useStore.getState().contextMenu).toBeNull();
    expect(modalSurface(useStore.getState())).toBe(false);
  });

  it('newCircuit closes an open context menu', () => {
    openMenu();

    useStore.getState().newCircuit();

    expect(useStore.getState().contextMenu).toBeNull();
    expect(modalSurface(useStore.getState())).toBe(false);
  });

  it('the dialog and elementProperties panels close the same way', () => {
    useStore.getState().commit();
    useStore.getState().openDialog('shortcuts');
    useStore.getState().requestEdit(addResistor());

    useStore.getState().undo();

    expect(useStore.getState().dialog).toBeNull();
    expect(useStore.getState().elementProperties).toBeNull();
    expect(modalSurface(useStore.getState())).toBe(false);
  });
});
