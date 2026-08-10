import { describe, expect, it } from 'vitest';
import {
  commitSubcircuitEdit,
  NO_SUBCIRCUIT_EDIT,
  setSubcircuitDraft,
  startSubcircuitEdit,
  type RenameOutcome,
} from './subcircuitManager';

/** A rename that records what it was asked and answers `outcome`. The Manager
 *  must not ask at all for a blank or unchanged name. */
function recordingRename(outcome: RenameOutcome = 'renamed') {
  const calls: [string, string][] = [];
  return {
    calls,
    rename: (oldName: string, newName: string): RenameOutcome => {
      calls.push([oldName, newName]);
      return outcome;
    },
  };
}

describe('subcircuit manager edit row', () => {
  it('starts the draft from the name being edited', () => {
    expect(startSubcircuitEdit('divider')).toEqual({
      editing: 'divider',
      draftName: 'divider',
      error: null,
    });
  });

  it('closes the row without asking the library when the name is unchanged', () => {
    const { calls, rename } = recordingRename();
    const result = commitSubcircuitEdit(startSubcircuitEdit('divider'), rename);
    expect(result.outcome).toBe('unchanged');
    expect(result.state).toEqual(NO_SUBCIRCUIT_EDIT);
    expect(result.refresh).toBe(false);
    expect(calls).toEqual([]);
  });

  it('treats a name that only gained whitespace as unchanged', () => {
    const { calls, rename } = recordingRename();
    const state = setSubcircuitDraft(startSubcircuitEdit('divider'), '  divider  ');
    const result = commitSubcircuitEdit(state, rename);
    expect(result.outcome).toBe('unchanged');
    expect(result.state.editing).toBeNull();
    expect(calls).toEqual([]);
  });

  it('renames on a changed name, closes the row and asks for a refresh', () => {
    const { calls, rename } = recordingRename('renamed');
    const state = setSubcircuitDraft(startSubcircuitEdit('divider'), '  amp  ');
    const result = commitSubcircuitEdit(state, rename);
    expect(calls).toEqual([['divider', 'amp']]);
    expect(result.outcome).toBe('renamed');
    expect(result.state).toEqual(NO_SUBCIRCUIT_EDIT);
    expect(result.refresh).toBe(true);
  });

  it('closes the row and refreshes when the model went missing underneath', () => {
    const { rename } = recordingRename('missing');
    const state = setSubcircuitDraft(startSubcircuitEdit('divider'), 'amp');
    const result = commitSubcircuitEdit(state, rename);
    expect(result.outcome).toBe('missing');
    expect(result.state).toEqual(NO_SUBCIRCUIT_EDIT);
    expect(result.refresh).toBe(true);
  });

  it('keeps the row open with a message for a blank name', () => {
    const { calls, rename } = recordingRename();
    const state = setSubcircuitDraft(startSubcircuitEdit('divider'), '   ');
    const result = commitSubcircuitEdit(state, rename);
    expect(result.outcome).toBe('blank');
    expect(result.state.editing).toBe('divider');
    expect(result.state.error).not.toBeNull();
    expect(result.refresh).toBe(false);
    expect(calls).toEqual([]);
  });

  it('drops the message as soon as the user types again', () => {
    const { rename } = recordingRename();
    const blanked = commitSubcircuitEdit(
      setSubcircuitDraft(startSubcircuitEdit('divider'), ''),
      rename,
    );
    expect(setSubcircuitDraft(blanked.state, 'd').error).toBeNull();
  });

  it('does nothing when no row is in edit mode', () => {
    const { calls, rename } = recordingRename();
    const result = commitSubcircuitEdit(NO_SUBCIRCUIT_EDIT, rename);
    expect(result.state).toEqual(NO_SUBCIRCUIT_EDIT);
    expect(result.refresh).toBe(false);
    expect(calls).toEqual([]);
  });
});
