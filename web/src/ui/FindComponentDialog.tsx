/** Find Component: a text box that filters the element palette by name, kind
 *  or category, a list of matches, and OK or double-click that arms the chosen
 *  element for placement, upstream's SearchDialog (SearchDialog.java:42-148).
 *  The filter math lives in `model/search.ts`; this component only maps matches
 *  to controls. */

import { useState } from 'react';
import { filterComponents } from '../model/search';
import { useStore } from '../state/store';
import { Dialog } from './Dialog';

export function FindComponentDialog() {
  const closeDialog = useStore((s) => s.closeDialog);
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const matches = filterComponents(query);
  // The first match is the default selection, so OK always has a target and a
  // filtered-down list starts with its best hit highlighted, like upstream
  // auto-selects row 0 after every search (SearchDialog.java:145-146).
  const selected = matches.find((m) => m.id === selectedId) ?? matches[0];

  const apply = (id: string | undefined) => {
    if (id === undefined) return;
    useStore.getState().setTool(id);
    closeDialog();
  };

  return (
    <Dialog
      title="Find Component"
      onClose={closeDialog}
      actions={
        <>
          <button type="button" onClick={() => apply(selected?.id)} disabled={!selected}>
            OK
          </button>
          <button type="button" onClick={closeDialog}>
            Cancel
          </button>
        </>
      }
    >
      <input
        autoFocus
        type="text"
        placeholder="Type a component name"
        value={query}
        onChange={(ev) => {
          setQuery(ev.target.value);
          // A re-filter invalidates whatever was highlighted before; the
          // default selection falls back to the new first match.
          setSelectedId(null);
        }}
        onKeyDown={(ev) => {
          if (ev.key === 'Enter') apply(selected?.id);
        }}
      />
      <ul className="find-list">
        {matches.map((m) => (
          <li key={m.id}>
            <button
              type="button"
              className={selected?.id === m.id ? 'selected' : ''}
              onClick={() => setSelectedId(m.id)}
              onDoubleClick={() => apply(m.id)}
            >
              <span>{m.label}</span>
              <span className="find-category">{m.category}</span>
            </button>
          </li>
        ))}
      </ul>
      {matches.length === 0 && <p className="hint">No components match "{query}".</p>}
    </Dialog>
  );
}
