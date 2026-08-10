import { describe, expect, it } from 'vitest';
import type { RemoveOutcome, RenameOutcome } from '../io/subcircuits';
import {
  commitSubcircuitCreate,
  commitSubcircuitEdit,
  deleteSubcircuit,
  NO_SUBCIRCUIT_EDIT,
  setSubcircuitDraft,
  startSubcircuitEdit,
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

  it('keeps the row open and names the clash when the name is taken', () => {
    // Plan test 5 without a DOM: the row the dialog renders comes straight
    // from this state, so "the error shows and the row is still in edit mode"
    // is exactly these two fields.
    const { rename } = recordingRename('taken');
    const state = setSubcircuitDraft(startSubcircuitEdit('divider'), 'amp');
    const result = commitSubcircuitEdit(state, rename);
    expect(result.outcome).toBe('taken');
    expect(result.state.editing).toBe('divider');
    expect(result.state.draftName).toBe('amp');
    expect(result.state.error).toBe('A subcircuit named "amp" already exists.');
    // No refresh: nothing moved, and re-reading the list would be the row
    // blinking for no reason.
    expect(result.refresh).toBe(false);
  });

  it('drops the taken message as soon as the user types again', () => {
    const { rename } = recordingRename('taken');
    const state = setSubcircuitDraft(startSubcircuitEdit('divider'), 'amp');
    const taken = commitSubcircuitEdit(state, rename);
    expect(setSubcircuitDraft(taken.state, 'amp2').error).toBeNull();
  });

  it('explains the row a rename uncovered', () => {
    const { rename } = recordingRename('uncovered');
    const state = setSubcircuitDraft(startSubcircuitEdit('divider'), 'amp');
    const result = commitSubcircuitEdit(state, rename);
    expect(result.state).toEqual(NO_SUBCIRCUIT_EDIT);
    expect(result.refresh).toBe(true);
    // The user has to learn why the old name is still listed.
    expect(result.notice).toContain('"divider"');
    expect(result.notice).toContain('"amp"');
  });

  it('keeps the row open with a message when storage refused the rename', () => {
    const { rename } = recordingRename('refused');
    const state = setSubcircuitDraft(startSubcircuitEdit('divider'), 'amp');
    const result = commitSubcircuitEdit(state, rename);
    expect(result.outcome).toBe('refused');
    expect(result.state.editing).toBe('divider');
    expect(result.state.error).not.toBeNull();
    // Nothing moved, so there is nothing to re-read.
    expect(result.refresh).toBe(false);
  });
});

/** A library stub for Delete: `stores` says what `remove` finds, and each call
 *  empties one of them, so a shadowed name behaves like the real two-store
 *  library. `answers` is the queue `confirm` reads. */
function deleteDeps(stores: RemoveOutcome[], answers: boolean[]) {
  const prompts: string[] = [];
  const removed: string[] = [];
  const left = [...stores];
  return {
    prompts,
    removed,
    deps: {
      remove: (name: string): RemoveOutcome => {
        removed.push(name);
        return left.shift() ?? 'none';
      },
      exists: () => left.length > 0,
      confirm: (message: string) => {
        prompts.push(message);
        return answers.shift() ?? false;
      },
    },
  };
}

describe('subcircuit manager delete', () => {
  it('asks first and does nothing when the user says no', () => {
    const { prompts, removed, deps } = deleteDeps(['stored'], [false]);
    const result = deleteSubcircuit('divider', deps);
    expect(result).toEqual({ refresh: false, outcome: 'cancelled', notice: null });
    expect(removed).toEqual([]);
    expect(prompts).toEqual(['Delete subcircuit "divider"?']);
  });

  it('deletes a saved row with one confirmation', () => {
    const { prompts, removed, deps } = deleteDeps(['stored'], [true]);
    const result = deleteSubcircuit('divider', deps);
    expect(result).toEqual({ refresh: true, outcome: 'deleted', notice: null });
    expect(removed).toEqual(['divider']);
    expect(prompts).toHaveLength(1);
  });

  it('offers to delete through when the row only shadowed a saved model', () => {
    // The two-clicks-with-no-explanation case: deleting the file's copy leaves
    // the saved model of that name listed, so the second prompt says so.
    const { prompts, removed, deps } = deleteDeps(['session', 'stored'], [true, true]);
    const result = deleteSubcircuit('myCirc', deps);
    expect(result).toEqual({ refresh: true, outcome: 'deleted', notice: null });
    expect(removed).toEqual(['myCirc', 'myCirc']);
    expect(prompts[1]).toContain('saved subcircuit');
  });

  it('keeps the uncovered model when the user declines the second prompt', () => {
    const { removed, deps } = deleteDeps(['session', 'stored'], [true, false]);
    const result = deleteSubcircuit('myCirc', deps);
    expect(result).toEqual({ refresh: true, outcome: 'uncovered', notice: null });
    expect(removed).toEqual(['myCirc']);
  });

  it('does not ask twice for a session row with nothing under it', () => {
    const { prompts, deps } = deleteDeps(['session'], [true]);
    const result = deleteSubcircuit('myCirc', deps);
    expect(result).toEqual({ refresh: true, outcome: 'deleted', notice: null });
    expect(prompts).toHaveLength(1);
  });

  it('refreshes the stale list when the row was already gone', () => {
    const { prompts, deps } = deleteDeps(['none'], [true]);
    const result = deleteSubcircuit('ghost', deps);
    expect(result).toEqual({ refresh: true, outcome: 'missing', notice: null });
    expect(prompts).toHaveLength(1);
  });

  it('says so when storage refused to drop the key', () => {
    const { deps } = deleteDeps(['refused'], [true]);
    const result = deleteSubcircuit('divider', deps);
    expect(result.outcome).toBe('refused');
    // Nothing changed, so the row the user clicked is still the truth.
    expect(result.refresh).toBe(false);
    expect(result.notice).toContain('"divider"');
  });

  it('says so when the delete-through was refused, after the shadow went', () => {
    const { deps } = deleteDeps(['session', 'refused'], [true, true]);
    const result = deleteSubcircuit('myCirc', deps);
    expect(result.outcome).toBe('refused');
    expect(result.notice).not.toBeNull();
    // The file's copy did go, so the list has to be re-read even though the
    // saved model the second prompt asked about is still there.
    expect(result.refresh).toBe(true);
  });
});

/** The Create dialog's library, prompt and store action, recorded. */
function createDeps(taken: boolean, answer: boolean) {
  const prompts: string[] = [];
  const saved: string[] = [];
  return {
    prompts,
    saved,
    deps: {
      taken: () => taken,
      confirm: (message: string) => {
        prompts.push(message);
        return answer;
      },
      save: (name: string) => {
        saved.push(name);
      },
    },
  };
}

describe('create subcircuit commit', () => {
  it('refuses a blank name without asking anything', () => {
    const { prompts, saved, deps } = createDeps(false, true);
    const result = commitSubcircuitCreate('   ', deps);
    expect(result).toEqual({ outcome: 'blank', error: 'Enter a model name.' });
    expect(prompts).toEqual([]);
    expect(saved).toEqual([]);
  });

  it('saves a free name straight away, trimmed', () => {
    const { prompts, saved, deps } = createDeps(false, true);
    const result = commitSubcircuitCreate('  amp  ', deps);
    expect(result.outcome).toBe('saved');
    expect(saved).toEqual(['amp']);
    expect(prompts).toEqual([]);
  });

  it('asks before replacing a model of the same name', () => {
    const { prompts, saved, deps } = createDeps(true, true);
    expect(commitSubcircuitCreate('amp', deps).outcome).toBe('saved');
    expect(prompts).toEqual(['Replace the existing subcircuit "amp"?']);
    expect(saved).toEqual(['amp']);
  });

  it('writes nothing when the user declines the replacement', () => {
    const { saved, deps } = createDeps(true, false);
    const result = commitSubcircuitCreate('amp', deps);
    expect(result).toEqual({ outcome: 'cancelled', error: null });
    expect(saved).toEqual([]);
  });
});
