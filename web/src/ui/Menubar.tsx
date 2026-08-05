/** Top bar: run controls, file actions and the example-circuit library. */

import { useEffect, useRef, useState } from 'react';
import { loadLibraryCircuit, loadLibraryIndex, type LibraryGroup } from '../io/library';
import { circuitToUrl } from '../io/urlShare';
import { useStore } from '../state/store';

function download(filename: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function Menubar() {
  const running = useStore((s) => s.running);
  const toggleRunning = useStore((s) => s.toggleRunning);
  const dark = useStore((s) => s.dark);
  const setDark = useStore((s) => s.setDark);
  const newCircuit = useStore((s) => s.newCircuit);
  const loadNetlist = useStore((s) => s.loadNetlist);
  const toNetlist = useStore((s) => s.toNetlist);
  const undo = useStore((s) => s.undo);
  const redo = useStore((s) => s.redo);
  const setStatus = useStore((s) => s.setStatus);

  const [library, setLibrary] = useState<LibraryGroup[] | null>(null);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [libraryError, setLibraryError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

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
      <button type="button" onClick={() => fileInput.current?.click()}>
        Open…
      </button>
      <input
        ref={fileInput}
        type="file"
        accept=".txt,.circuitjs,text/plain"
        hidden
        onChange={async (e) => {
          const file = e.target.files?.[0];
          if (!file) return;
          loadNetlist(await file.text());
          setStatus(file.name);
          e.target.value = '';
        }}
      />
      <button type="button" onClick={() => download('circuit.txt', toNetlist())}>
        Save
      </button>
      <button
        type="button"
        onClick={async () => {
          const url = circuitToUrl(toNetlist());
          try {
            await navigator.clipboard.writeText(url);
            setStatus('Shareable link copied to clipboard');
          } catch {
            // Clipboard access is blocked in some contexts; show the link so
            // it can still be copied by hand.
            window.prompt('Shareable link', url);
          }
        }}
      >
        Share link
      </button>

      <span className="sep" />

      <button type="button" onClick={undo} title="Undo (Ctrl+Z)">
        Undo
      </button>
      <button type="button" onClick={redo} title="Redo (Ctrl+Shift+Z)">
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
        <button type="button" className="primary" onClick={toggleRunning} title="Run/Pause (Space)">
          {running ? 'Pause' : 'Run'}
        </button>
        <button
          type="button"
          onClick={() => {
            // Reloading the netlist into itself is the simplest reset that also
            // clears element state such as capacitor charge.
            const text = toNetlist();
            loadNetlist(text);
          }}
        >
          Reset
        </button>
      </div>

      <span className="sep" />

      <button type="button" onClick={() => setDark(!dark)} title="Toggle theme">
        {dark ? '☀' : '☾'}
      </button>
    </header>
  );
}
