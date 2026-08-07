/** Top bar: run controls, file actions and the example-circuit library. */

import { useEffect, useState } from 'react';
import { openCircuit, saveCircuit } from '../io/fileIO';
import { loadLibraryCircuit, loadLibraryIndex, type LibraryGroup } from '../io/library';
import { circuitToUrl } from '../io/urlShare';
import { useStore } from '../state/store';

export function Menubar() {
  const running = useStore((s) => s.running);
  const toggleRunning = useStore((s) => s.toggleRunning);
  const newCircuit = useStore((s) => s.newCircuit);
  const loadNetlist = useStore((s) => s.loadNetlist);
  const toNetlist = useStore((s) => s.toNetlist);
  const markSaved = useStore((s) => s.markSaved);
  const undo = useStore((s) => s.undo);
  const redo = useStore((s) => s.redo);
  const setStatus = useStore((s) => s.setStatus);

  const [library, setLibrary] = useState<LibraryGroup[] | null>(null);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [libraryError, setLibraryError] = useState<string | null>(null);

  useEffect(() => {
    if (!libraryOpen || library) return;
    loadLibraryIndex()
      .then(setLibrary)
      .catch((e: unknown) => setLibraryError(e instanceof Error ? e.message : String(e)));
  }, [libraryOpen, library]);

  const openLibraryCircuit = async (file: string, title: string) => {
    try {
      loadNetlist(await loadLibraryCircuit(file));
      setStatus(title);
      setLibraryOpen(false);
    } catch (e) {
      setLibraryError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <header className="menubar">
      <strong className="brand">Circuit Simulator</strong>

      <span className="sep" />

      <button type="button" onClick={newCircuit}>
        New
      </button>
      <button
        type="button"
        onClick={() =>
          openCircuit((text, name) => {
            loadNetlist(text);
            setStatus(name);
          })
        }
      >
        Open…
      </button>
      <button
        type="button"
        onClick={() => {
          const text = toNetlist();
          markSaved(text);
          saveCircuit('circuit.txt', text);
        }}
      >
        Save
      </button>
      <button
        type="button"
        onClick={() => {
          const url = circuitToUrl(toNetlist());
          window.history.pushState({}, '', url);
          setStatus('Shareable link in the address bar');
        }}
      >
        Share link
      </button>

      <span className="sep" />

      <button type="button" onClick={undo} title="Undo (Ctrl+Z)">
        Undo
      </button>
      <button type="button" onClick={redo} title="Redo (Ctrl+Y / Ctrl+Shift+Z)">
        Redo
      </button>

      <span className="sep" />

      <div className="dropdown">
        <button type="button" onClick={() => setLibraryOpen((v) => !v)}>
          Circuits ▾
        </button>
        {libraryOpen && (
          <div className="dropdown-menu">
            {libraryError && <p className="problem">{libraryError}</p>}
            {!library && !libraryError && <p className="hint">Loading…</p>}
            {library?.map((group) => (
              <details key={group.title}>
                <summary>{group.title}</summary>
                {group.entries.map((entry) => (
                  <button
                    key={entry.file}
                    type="button"
                    className="menu-item"
                    onClick={() => void openLibraryCircuit(entry.file, entry.title)}
                  >
                    {entry.title}
                  </button>
                ))}
              </details>
            ))}
          </div>
        )}
      </div>

      <div className="run-group">
        <button
          type="button"
          className="primary"
          onClick={toggleRunning}
          title="Run/Pause"
          aria-label={running ? 'Pause' : 'Run'}
        >
          <span className="material-icons" aria-hidden="true">
            {running ? 'pause' : 'play_arrow'}
          </span>
        </button>
        <button
          type="button"
          onClick={() => {
            // Reloading the netlist into itself is the simplest reset that also
            // clears element state such as capacitor charge.
            const text = toNetlist();
            loadNetlist(text);
          }}
          title="Reset"
          aria-label="Reset"
        >
          <span className="material-icons" aria-hidden="true">
            replay
          </span>
        </button>
      </div>
    </header>
  );
}
