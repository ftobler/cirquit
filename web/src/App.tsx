import { useEffect, useState } from 'react';
import { SimEngine } from './engine/simulator';
import { matchShortcut } from './input/shortcuts';
import { openCircuit, saveCircuit } from './io/fileIO';
import { circuitFromUrl } from './io/urlShare';
import { CircuitCanvas } from './ui/CircuitCanvas';
import { ContextMenu } from './ui/ContextMenu';
import { Menubar } from './ui/Menubar';
import { OptionsPanel } from './ui/OptionsPanel';
import { ScopePanel } from './ui/ScopePanel';
import { Toolbox } from './ui/Toolbox';
import { hasUnsavedChanges, useStore } from './state/store';

/** A small RC circuit, so the app opens on something that actually runs. */
const STARTER_CIRCUIT = `$ 1 0.000005 10.2 50 5 43 5e-11
v 176 320 176 96 0 0 40 5 0 0 0.5
r 176 96 384 96 0 1000
c 384 96 384 320 0 0.00001 0 0 0
w 384 320 176 320 0
g 176 320 176 352 0
o 2 64 0 4099
`;

export default function App() {
  const [engine, setEngine] = useState<SimEngine | null>(null);
  const [engineError, setEngineError] = useState<string | null>(null);
  const status = useStore((s) => s.status);
  const loadNetlist = useStore((s) => s.loadNetlist);

  // Bring up the wasm engine once, then load whatever circuit was requested.
  useEffect(() => {
    let cancelled = false;
    SimEngine.create()
      .then((e) => {
        if (cancelled) return;
        setEngine(e);
        loadNetlist(circuitFromUrl() ?? STARTER_CIRCUIT);
      })
      .catch((e: unknown) => {
        if (!cancelled) setEngineError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [loadNetlist]);

  // Keyboard shortcuts. All key matching lives in matchShortcut; this effect
  // only guards the input focus and dispatches one-line store calls.
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      const target = ev.target as HTMLElement | null;
      if (target && /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName)) return;
      const action = matchShortcut({
        key: ev.key,
        ctrlKey: ev.ctrlKey,
        metaKey: ev.metaKey,
        shiftKey: ev.shiftKey,
        altKey: ev.altKey,
      });
      if (!action) return;
      // Every matched chord is an app command, so prevent its browser default;
      // unbound keys keep theirs, notably Ctrl+= and Ctrl+- page zoom.
      ev.preventDefault();
      const s = useStore.getState();
      switch (action.type) {
        case 'undo':
          s.undo();
          break;
        case 'redo':
          s.redo();
          break;
        case 'delete':
          s.deleteSelected();
          break;
        case 'escape':
          // Upstream's Escape returns to select mode and leaves the selection
          // alone (UIManager.java:1145-1151); do not deselect here.
          s.setTool(null);
          break;
        case 'selectMode':
          s.setTool(null);
          break;
        case 'nudge':
          s.nudgeSelection(action.dx, action.dy);
          break;
        case 'zoomIn':
          s.zoomIn();
          break;
        case 'zoomOut':
          s.zoomOut();
          break;
        case 'zoomReset':
          s.zoomReset();
          break;
        case 'save': {
          // Exporting counts as saved, exactly like the Menubar Save button.
          const text = s.toNetlist();
          s.markSaved(text);
          saveCircuit('circuit.txt', text);
          break;
        }
        case 'open':
          openCircuit((text, name) => {
            s.loadNetlist(text);
            s.setStatus(name);
          });
          break;
        case 'copy':
          s.copySelection();
          break;
        case 'cut':
          s.cutSelection();
          break;
        case 'paste':
          s.pasteFromClipboard();
          break;
        case 'duplicate':
          s.duplicateSelection();
          break;
        case 'selectAll':
          s.selectAll();
          break;
        case 'rotate':
          s.rotateSelection();
          break;
        case 'mirror':
          s.mirrorSelection();
          break;
        case 'swap':
          s.swapTerminals();
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Ask before the page reloads or closes with unsaved changes. The browser
  // draws its own "leave site?" prompt; `returnValue` is what arms it.
  useEffect(() => {
    const onBeforeUnload = (ev: BeforeUnloadEvent) => {
      const s = useStore.getState();
      if (hasUnsavedChanges(s.lastSaved, s.toNetlist())) {
        ev.preventDefault();
        ev.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);

  if (engineError) {
    return (
      <div className="fatal">
        <h1>The simulation engine could not start</h1>
        <p>{engineError}</p>
        <p className="hint">
          The WebAssembly engine is built by <code>just wasm</code>; check that
          <code> web/src/wasm</code> exists.
        </p>
      </div>
    );
  }

  return (
    <div className="app">
      <Menubar />
      <div className="workspace">
        <aside className="left">
          <Toolbox />
        </aside>
        <main className="centre">
          <CircuitCanvas engine={engine} />
          <ScopePanel engine={engine} />
          <ContextMenu />
        </main>
        <aside className="right">
          <OptionsPanel engine={engine} />
        </aside>
      </div>
      <footer className="statusbar">
        <span>{engine ? status || 'Ready' : 'Loading engine…'}</span>
      </footer>
    </div>
  );
}
