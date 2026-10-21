/** The one door's contract: validation, gating, one labelled step, the busy
 *  rule for agent calls, and batch atomicity. */

import { beforeEach, describe, expect, it } from 'vitest';
import { snapshotKey } from '../state/history';
import { useStore } from '../state/store';
import { fresh, undoDepth } from '../state/store.test-helpers';
import type { HistorySource } from '../state/history';
import { execute } from './execute';
import type { CommandContext, CommandResult } from './types';

const ctx = (source: HistorySource = 'user'): CommandContext => ({ store: useStore, source });

const run = (id: string, args: unknown, source: HistorySource = 'user') =>
  execute(id, args, ctx(source));

const addArgs = (x = 0, y = 0) => ({
  kind: 'resistor',
  x1: x,
  y1: y,
  x2: x + 160,
  y2: y,
  params: { resistance: 4700 },
});

beforeEach(() => {
  useStore.setState(fresh());
});

describe('element.add', () => {
  it('places a resistor as one Add Resistor entry with defaults merged', () => {
    const result = run('element.add', {
      ...addArgs(1.4, 2.6),
      params: { resistance: 4700 },
    });

    expect(result.ok).toBe(true);
    const s = useStore.getState();
    expect(s.elements).toHaveLength(1);
    const e = s.elements[0];
    expect(e).toMatchObject({
      kind: 'resistor',
      x1: 1,
      y1: 3,
      x2: 161,
      y2: 3,
      flags: 0,
      params: { resistance: 4700 },
    });
    // Only the named parameter is overridden; the registry seed is what the
    // rest of the map carries (there is no other field on a resistor).
    expect(undoDepth(s)).toBe(1);
    expect(s.history.undo[0].label).toBe('Add Resistor');
    expect((result as { value: number }).value).toBe(e.id);
  });

  it('refuses an unknown kind as invalid-args and pushes nothing', () => {
    const result = run('element.add', { ...addArgs(), kind: 'resistorX' });

    expect(result).toEqual({
      ok: false,
      error: 'invalid-args',
      message: 'args.kind: unknown element kind "resistorX"',
    });
    expect(useStore.getState().elements).toEqual([]);
    expect(undoDepth(useStore.getState())).toBe(0);
  });
});

describe('elements by id', () => {
  it('deletes named ids without touching an unrelated selection', () => {
    const a = (run('element.add', addArgs(0, 0)) as { value: number }).value;
    const b = (run('element.add', addArgs(0, 64)) as { value: number }).value;
    useStore.getState().select([b]);

    const result = run('element.delete', { ids: [a] });

    expect(result.ok).toBe(true);
    expect(useStore.getState().elements.map((e) => e.id)).toEqual([b]);
    expect(useStore.getState().selectedIds).toEqual([b]);
  });

  it('deletes the selection when ids are omitted', () => {
    const a = (run('element.add', addArgs(0, 0)) as { value: number }).value;
    const b = (run('element.add', addArgs(0, 64)) as { value: number }).value;
    useStore.getState().select([a, b]);

    run('element.delete', {});

    expect(useStore.getState().elements).toEqual([]);
    expect(useStore.getState().selectedIds).toEqual([]);
  });

  it('rotate by ids matches rotateSelection geometry', () => {
    const id = (run('element.add', addArgs(0, 0)) as { value: number }).value;
    useStore.getState().select([id]);
    useStore.getState().rotateSelection();
    const viaSelection = JSON.stringify(useStore.getState().elements.map(({ id: _i, ...e }) => e));

    useStore.setState(fresh());
    const id2 = (run('element.add', addArgs(0, 0)) as { value: number }).value;
    run('element.rotate', { ids: [id2] });
    expect(JSON.stringify(useStore.getState().elements.map(({ id: _i, ...e }) => e))).toBe(
      viaSelection,
    );
  });
});

describe('gates', () => {
  it('refuses an agent command while a user gesture is open', () => {
    const id = (run('element.add', addArgs(0, 0)) as { value: number }).value;
    useStore.getState().beginTransaction('Move');
    useStore.getState().beginElementGesture('move');
    const depth = undoDepth(useStore.getState());
    const before = useStore.getState().elements[0];

    const result = run('element.move', { ids: [id], dx: 16, dy: 0 }, 'agent');

    expect(result).toMatchObject({ ok: false, error: 'busy' });
    expect(useStore.getState().elements[0]).toEqual(before);
    expect(undoDepth(useStore.getState())).toBe(depth);
    // The human's gesture is still exactly where it was.
    expect(useStore.getState().history.open).not.toBeNull();
    expect(useStore.getState().elementGesture?.kind).toBe('move');

    // A user-sourced command keeps today's behaviour: it joins the open drag.
    expect(run('element.move', { ids: [id], dx: 16, dy: 0 }, 'user').ok).toBe(true);
    expect(useStore.getState().elements[0].x1).toBe(16);
    useStore.getState().endElementGesture();
  });

  it('refuses an editing command when editing is disabled', () => {
    useStore.getState().updateSettings({ editable: false });
    const result = run('element.add', addArgs());

    expect(result).toEqual({
      ok: false,
      error: 'disabled',
      message: 'Editing disabled. Re-enable from the Options menu.',
    });
    expect(useStore.getState().elements).toEqual([]);
  });

  it('reports a missing command as unknown', () => {
    expect(run('element.nope', {})).toEqual({
      ok: false,
      error: 'unknown',
      message: 'Unknown command "element.nope".',
    });
  });
});

describe('history.batch', () => {
  const threeAdds = {
    calls: [
      { id: 'element.add', args: addArgs(0, 0) },
      { id: 'element.add', args: addArgs(0, 64) },
      { id: 'element.add', args: addArgs(0, 128) },
    ],
    label: 'Build Divider',
  };

  it('lands three adds as one labelled entry and undo removes them all', () => {
    const result = run('history.batch', threeAdds);

    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(useStore.getState().elements).toHaveLength(3);
    expect(undoDepth(useStore.getState())).toBe(1);
    expect(useStore.getState().history.undo[0].label).toBe('Build Divider');

    run('history.undo', {});
    expect(useStore.getState().elements).toEqual([]);
  });

  it('reverts the whole batch and pops its entry when a call fails', () => {
    const keep = (run('element.add', addArgs(0, 256)) as { value: number }).value;
    useStore.getState().select([keep]);
    const pre = snapshotKey(useStore.getState());
    const depth = undoDepth(useStore.getState());

    const result = run('history.batch', {
      calls: [
        { id: 'element.add', args: addArgs(0, 0) },
        { id: 'element.add', args: { ...addArgs(0, 64), kind: 'not-a-part' } },
        { id: 'element.add', args: addArgs(0, 128) },
      ],
      label: 'Broken Batch',
    });

    expect(result.ok).toBe(false);
    const failure = result as Extract<CommandResult, { ok: false }>;
    expect(failure.error).toBe('failed');
    expect(failure.message).toContain('call 1 (element.add)');
    expect(failure.message).toContain('invalid-args');
    expect(snapshotKey(useStore.getState())).toBe(pre);
    expect(undoDepth(useStore.getState())).toBe(depth);
    expect(useStore.getState().elements).toHaveLength(1);
  });

  it('is refused from an agent while a user gesture is open', () => {
    useStore.getState().beginTransaction('Move');
    const result = run('history.batch', threeAdds, 'agent');
    expect(result).toMatchObject({ ok: false, error: 'busy' });
    expect(useStore.getState().elements).toEqual([]);
    useStore.getState().endTransaction();
  });
});

describe('history source', () => {
  it('records an agent add as an agent entry', () => {
    run('element.add', addArgs(), 'agent');
    expect(useStore.getState().history.undo[0].source).toBe('agent');
  });

  it('lets an agent undo the top entry whatever its source', () => {
    run('element.add', addArgs(), 'user');
    expect(useStore.getState().elements).toHaveLength(1);

    expect(run('history.undo', {}, 'agent').ok).toBe(true);

    expect(useStore.getState().elements).toEqual([]);
  });
});
