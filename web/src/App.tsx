import { useEffect, useState } from 'react';
import { SimEngine } from './engine/simulator';
import { matchShortcut } from './input/shortcuts';
import { openCircuit } from './io/fileIO';
import { circuitFromUrl } from './io/urlShare';
import { AboutDialog } from './ui/AboutDialog';
import { CircuitCanvas } from './ui/CircuitCanvas';
import { ContextMenu } from './ui/ContextMenu';
import { ExportAsLinkDialog } from './ui/ExportAsLinkDialog';
import { ExportAsTextDialog } from './ui/ExportAsTextDialog';
import { ImportFromTextDialog } from './ui/ImportFromTextDialog';
import { Menubar } from './ui/Menubar';
import { OptionsPanel } from './ui/OptionsPanel';
import { SaveAsDialog } from './ui/SaveAsDialog';
import { SaveAsImageDialog } from './ui/SaveAsImageDialog';
import { ScopePanel } from './ui/ScopePanel';
import { Toolbox } from './ui/Toolbox';
import { hasUnsavedChanges, gridSize, useStore } from './state/store';

/** A small RC circuit, so the app opens on something that actually runs. */
const STARTER_CIRCUIT = `$ 1 0.000005 10.2 50 5 43 5e-11
v 176 320 176 96 0 0 40 5 0 0 0.5
r 176 96 384 96 0 1000
c 384 96 384 320 0 0.00001 0 0 0
w 384 320 176 320 0
g 176 320 176 352 0
o 2 64 0 4099
`;

/** Shortcut actions that edit the circuit. Dropped whole when Disable Editing
 *  is on; everything else (zoom, file, view) stays live. */
const EDIT_ACTIONS = new Set([
  'undo',
  'redo',
  'delete',
  'nudge',
  'copy',
  'cut',
  'paste',
  'duplicate',
  'selectAll',
  'rotate',
  'mirror',
  'swap',
]);

export default function App() {
  const [engine, setEngine] = useState<SimEngine | null>(null);
  const [engineError, setEngineError] = useState<string | null>(null);
  const status = useStore((s) => s.status);
  const dialog = useStore((s) => s.dialog);
  const loadNetlist = useStore((s) => s.loadNetlist);
  const partsOpen = useStore((s) => s.partsOpen);
  const panelOpen = useStore((s) => s.panelOpen);
  const setPartsOpen = useStore((s) => s.setPartsOpen);
  const setPanelOpen = useStore((s) => s.setPanelOpen);

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
      const s = useStore.getState();
      // While a dialog is open the dialog owns the keyboard: no shortcut may
      // reach the app, or Ctrl+V would paste into the circuit instead of the
      // dialog's textarea and Delete would edit the circuit behind the modal.
      if (s.dialog !== null) return;
      // With editing disabled the edit keys are dropped, not ignored: the
      // status bar explains why nothing happened (CommandManager.java:22-24).
      // View and file commands (zoom, save, open) stay live.
      if (!s.settings.editable && EDIT_ACTIONS.has(action.type)) {
        s.setStatus('Editing disabled. Re-enable from the Options menu.');
        return;
      }
      // Every matched chord is an app command, so prevent its browser default;
      // unbound keys keep theirs, notably Ctrl+= and Ctrl+- page zoom.
      ev.preventDefault();
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
          // The matcher reports a unit-less step count; the grid size resolves
          // it here so a small-grid circuit nudges by 8, like upstream's
          // app.gridSize (UIManager.java:1153).
          s.nudgeSelection(action.dx * gridSize(s.settings), action.dy * gridSize(s.settings));
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
        case 'save':
          // Ctrl+S and the File>Save row open the Save As dialog, one behavior
          // for both, so the name is editable and exporting counts as saved
          // when the dialog confirms.
          s.openDialog('saveAs');
          break;
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
      <Menubar engine={engine} />
      {dialog === 'importText' && <ImportFromTextDialog />}
      {dialog === 'saveAs' && <SaveAsDialog />}
      {dialog === 'exportAsLink' && <ExportAsLinkDialog />}
      {dialog === 'exportAsText' && <ExportAsTextDialog />}
      {dialog === 'exportAsImage' && <SaveAsImageDialog engine={engine} />}
      {dialog === 'about' && <AboutDialog />}
      <div className="workspace">
        <aside className={partsOpen ? 'left open' : 'left'}>
          <Toolbox />
        </aside>
        <main className="centre">
          <CircuitCanvas engine={engine} />
          <ScopePanel engine={engine} />
          <ContextMenu />
        </main>
        <aside className={panelOpen ? 'right open' : 'right'}>
          <OptionsPanel engine={engine} />
        </aside>
        {/* A full-screen tap target that dismisses whichever drawer is open.
            Only rendered when one is, and only the mobile layout shows it. */}
        {(partsOpen || panelOpen) && (
          <div
            className="drawer-scrim"
            onClick={() => {
              setPartsOpen(false);
              setPanelOpen(false);
            }}
          />
        )}
      </div>
      <footer className="statusbar">
        <span>{engine ? status || 'Ready' : 'Loading engine…'}</span>
      </footer>
    </div>
  );
}
