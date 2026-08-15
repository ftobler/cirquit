/** Edit Shortcuts: one row per assignable command, a read-only box the user
 *  types a key into, a Clear button, duplicate detection that greys OK, and
 *  OK that rebuilds and persists the overlay. The row math (chord capture,
 *  duplicate detection, overlay from rows) lives in `input/shortcuts.ts`;
 *  this component only maps rows to controls, so it stays untested by
 *  construction under the node env. */

import { useState } from 'react';
import {
  ACTION_LABELS,
  chordOf,
  defaultBindingFor,
  hasDuplicateChords,
  isDefaultBinding,
  overlayFromRows,
  rowsFromOverlay,
  type ShortcutRow,
} from '../input/shortcuts';
import { useStore } from '../state/store';
import { Dialog } from './Dialog';

export function ShortcutsDialog() {
  const shortcuts = useStore((s) => s.shortcuts);
  const setShortcuts = useStore((s) => s.setShortcuts);
  const closeDialog = useStore((s) => s.closeDialog);
  const [rows, setRows] = useState<ShortcutRow[]>(() => rowsFromOverlay(shortcuts));

  const duplicate = hasDuplicateChords(rows);

  const setRow = (i: number, chord: string) =>
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, chord } : r)));

  // A single keystroke in the read-only box assigns the chord; Backspace or
  // Delete clears it. The keys the host reserves are not assignable, exactly
  // as upstream leaves them inert (keyCodeToPlaceholder returns -1 for Enter
  // and the arrows): Escape closes the dialog, Tab moves focus, Enter does
  // nothing, and the arrow keys keep their navigation roles. Alt chords are
  // assignable now that the matcher matches them (the geometry commands' home
  // since their plain letters are placement chars), so a user can move them
  // or hand another command an Alt key.
  const capture = (i: number, ev: React.KeyboardEvent<HTMLInputElement>) => {
    if (
      ev.key === 'Escape' ||
      ev.key === 'Tab' ||
      ev.key === 'Enter' ||
      ev.key === 'ArrowUp' ||
      ev.key === 'ArrowDown' ||
      ev.key === 'ArrowLeft' ||
      ev.key === 'ArrowRight'
    ) {
      return;
    }
    if (ev.key === 'Backspace' || ev.key === 'Delete') {
      ev.preventDefault();
      setRow(i, '');
      return;
    }
    ev.preventDefault();
    setRow(i, chordOf(ev));
  };

  const apply = () => {
    setShortcuts(overlayFromRows(rows));
    closeDialog();
  };

  return (
    <Dialog
      title="Edit Shortcuts"
      onClose={closeDialog}
      actions={
        <>
          <button type="button" onClick={apply} disabled={duplicate}>
            OK
          </button>
          <button type="button" onClick={closeDialog}>
            Cancel
          </button>
        </>
      }
    >
      <table className="shortcuts-table">
        <thead>
          <tr>
            <th>Command</th>
            <th>Shortcut</th>
            {/* An empty spacer column for the Clear and Default buttons;
                nothing to announce. */}
            <th aria-hidden="true" />
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={row.action} className={duplicate && row.chord !== '' ? 'duplicate' : ''}>
              <td>{ACTION_LABELS[row.action]}</td>
              <td>
                <input
                  type="text"
                  readOnly
                  value={row.chord}
                  placeholder="(none)"
                  aria-label={`${ACTION_LABELS[row.action]} shortcut`}
                  onKeyDown={(ev) => capture(i, ev)}
                />
              </td>
              <td>
                <button type="button" onClick={() => setRow(i, '')}>
                  Clear
                </button>
                {/* Restores the table binding. Delete stays dialog-reserved, so
                    this is the only way back to a cleared delete:'Delete'. A row
                    already at its default (or with none) is a no-op. */}
                <button
                  type="button"
                  onClick={() => setRow(i, defaultBindingFor(row.action))}
                  disabled={isDefaultBinding(row)}
                >
                  Default
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {duplicate && <p className="problem">Each shortcut must be unique.</p>}
    </Dialog>
  );
}
