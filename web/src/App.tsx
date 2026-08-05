import { useEffect, useState } from 'react';
import { SimEngine } from './engine/simulator';
import { circuitFromUrl } from './io/urlShare';
import { CircuitCanvas } from './ui/CircuitCanvas';
import { Menubar } from './ui/Menubar';
import { OptionsPanel } from './ui/OptionsPanel';
import { ScopePanel } from './ui/ScopePanel';
import { Toolbox } from './ui/Toolbox';
import { useStore } from './state/store';

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
  const dark = useStore((s) => s.dark);
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

  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  }, [dark]);

  // Keyboard shortcuts.
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      const target = ev.target as HTMLElement | null;
      if (target && /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName)) return;
      const s = useStore.getState();

      if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'z') {
        ev.preventDefault();
        if (ev.shiftKey) s.redo();
        else s.undo();
        return;
      }
      if (ev.key === 'Delete' || ev.key === 'Backspace') {
        ev.preventDefault();
        s.deleteSelected();
        return;
      }
      if (ev.key === 'Escape') {
        s.setTool(null);
        s.select([]);
        return;
      }
      if (ev.key === ' ') {
        ev.preventDefault();
        s.toggleRunning();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
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
