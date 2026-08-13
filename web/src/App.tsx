import { useEffect, useRef, useState } from 'react';
import { SimEngine } from './engine/simulator';
import { chordOf, hasChord, isPrintableKey, matchShortcut } from './input/shortcuts';
import { openCircuit } from './io/fileIO';
import { loadLibraryCircuit } from './io/library';
import { startupSource } from './io/urlShare';
import { printCircuit } from './render/print';
import { AboutDialog } from './ui/AboutDialog';
import { CreateSubcircuitDialog } from './ui/CreateSubcircuitDialog';
import { CircuitCanvas } from './ui/CircuitCanvas';
import { ContextMenu } from './ui/ContextMenu';
import { ExportAsLinkDialog } from './ui/ExportAsLinkDialog';
import { ExportAsTextDialog } from './ui/ExportAsTextDialog';
import { FindComponentDialog } from './ui/FindComponentDialog';
import { ImportFromTextDialog } from './ui/ImportFromTextDialog';
import { Menubar } from './ui/Menubar';
import { OptionsPanel } from './ui/OptionsPanel';
import { SaveAsDialog } from './ui/SaveAsDialog';
import { SaveAsImageDialog } from './ui/SaveAsImageDialog';
import { ScopePanel } from './ui/ScopePanel';
import { ShortcutsDialog } from './ui/ShortcutsDialog';
import { SliderPanel } from './ui/SliderPanel';
import { SubcircuitManagerDialog } from './ui/SubcircuitManagerDialog';
import { Toolbox } from './ui/Toolbox';
import { hasUnsavedChanges, useStore } from './state/store';
import { startAutoSave } from './state/recovery';
import { GRID_SIZE } from './model/types';

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
  'place',
]);

export default function App() {
  const [engine, setEngine] = useState<SimEngine | null>(null);
  const [engineError, setEngineError] = useState<string | null>(null);
  const dialog = useStore((s) => s.dialog);
  const partsOpen = useStore((s) => s.partsOpen);
  const panelOpen = useStore((s) => s.panelOpen);
  const setPartsOpen = useStore((s) => s.setPartsOpen);
  const setPanelOpen = useStore((s) => s.setPanelOpen);
  // The print shortcut needs the engine, but the keydown listener is
  // registered once with no deps; a ref keeps it seeing the latest handle
  // without re-registering on every engine load.
  const engineRef = useRef<SimEngine | null>(null);
  engineRef.current = engine;

  // Bring up the wasm engine once, then load whatever circuit was requested.
  useEffect(() => {
    let cancelled = false;
    SimEngine.create()
      .then(async (e) => {
        if (cancelled) return;
        setEngine(e);
        // Point the store at the engine's token reader so saveNetlist and the
        // rebuild path can overlay live state onto a copy of the elements.
        useStore.getState().setLiveStateProvider(() => e.elementStateTokens());
        // Startup precedence, decided by the pure startupSource: a share link
        // (ctz/cct) carries the whole circuit and wins; else a startCircuit
        // deep link names a bundled library file, fetched through the same
        // path the Circuits menu uses, falling back to the starter circuit
        // with a status message when the fetch fails; else the starter.
        const source = startupSource();
        const load = useStore.getState().loadNetlist;
        if (source.kind === 'url') {
          load(source.netlist);
        } else if (source.kind === 'file') {
          try {
            const text = await loadLibraryCircuit(source.file);
            // The fetch can outlive a strict-mode unmount; don't load a circuit
            // into a component that has been torn down.
            if (cancelled) return;
            load(text);
          } catch {
            load(STARTER_CIRCUIT);
            useStore
              .getState()
              .setStatus(`Could not load ${source.file}; showing the starter circuit.`);
          }
        } else {
          load(STARTER_CIRCUIT);
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) setEngineError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Keyboard shortcuts. All key matching lives in matchShortcut; this effect
  // only guards the input focus, resolves the switch keyShortcut path against
  // the store, and dispatches one-line store calls.
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      const target = ev.target as HTMLElement | null;
      if (target && /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName)) return;
      const s = useStore.getState();
      // While a dialog is open the dialog owns the keyboard: no shortcut may
      // reach the app, or Ctrl+V would paste into the circuit instead of the
      // dialog's textarea and Delete would edit the circuit behind the modal.
      // The scope-properties modal is a store dialog of its own, so the same
      // guard covers it.
      if (s.dialog !== null || s.scopeProperties !== null) return;
      const evLike = {
        key: ev.key,
        ctrlKey: ev.ctrlKey,
        metaKey: ev.metaKey,
        shiftKey: ev.shiftKey,
        altKey: ev.altKey,
      };
      // A plain printable key checks the switch keyShortcut map first: a
      // switch assigned this key beats every command binding, and a held key
      // must not re-toggle (UIManager.java:1248-1268). A switch is a run-mode
      // control like the pointer throw, so it stays live with editing disabled.
      if (!ev.repeat && !ev.ctrlKey && !ev.metaKey && !ev.altKey && isPrintableKey(ev.key)) {
        if (s.toggleSwitchByKey(ev.key)) {
          ev.preventDefault();
          return;
        }
      }
      // A held key must not re-fire a user-assigned shortcut
      // (UIManager.java:1181); the hardcoded nudge, delete and zoom keys
      // still repeat by design. The browser default is still suppressed, or a
      // held Space assigned to a command would scroll the page on every repeat.
      if (ev.repeat && hasChord(s.shortcuts, chordOf(evLike))) {
        ev.preventDefault();
        return;
      }
      const action = matchShortcut(evLike, s.shortcuts);
      if (!action) return;
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
        case 'place':
          // A placement char arms the element, the same setTool the toolbox
          // button and Find Component use: upstream's MODE_ADD_ELM
          // (UIManager.java:1273-1284). The split semiconductors carry their
          // toolbox id here (pnp, pmos), so the N/P flavour arms exactly.
          s.setTool(action.kind);
          break;
        case 'nudge':
          // The matcher reports a unit-less step count; the grid size resolves
          // it here so a nudge moves one grid square, like upstream's
          // app.gridSize (UIManager.java:1153). The step is always 16: the
          // small-grid option is removed, so there is one spacing.
          s.nudgeSelection(action.dx * GRID_SIZE, action.dy * GRID_SIZE);
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
        case 'toggleRunning':
          // Only reachable through a user-assigned shortcut: run/pause has no
          // default key upstream (CommandManager.java:100-101).
          s.toggleRunning();
          break;
        case 'print':
          // Prints just the schematic image, white background, not the page
          // (CommandManager.java:73-74).
          printCircuit(s.elements, s.settings, false, engineRef.current);
          break;
        case 'findComponent':
          s.openDialog('findComponent');
          break;
      }
    };
    // A momentary switch returns to rest when its shortcut key is let go
    // (UIManager.java:1113-1131). Modifiers suppress the keypress path
    // upstream, so a modified key never releases one.
    const onKeyUp = (ev: KeyboardEvent) => {
      const target = ev.target as HTMLElement | null;
      if (target && /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName)) return;
      const s = useStore.getState();
      if (s.dialog !== null || s.scopeProperties !== null) return;
      if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
      if (!isPrintableKey(ev.key)) return;
      s.releaseMomentaryByKey(ev.key);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, []);

  // Autosave: after edits, dump the netlist into the recovery slot so the
  // File>Recover Auto-Save row has something to restore on the next load. One
  // subscription per app session, not per render; the cleanup unsubscribes and
  // cancels any pending write, so a strict-mode remount re-subscribes cleanly.
  useEffect(() => {
    const stop = startAutoSave(
      () => useStore,
      // The clean check compares against the non-live document; the slot is
      // written live so a crash restores the current charge.
      () => useStore.getState().toNetlist(),
      { writeNetlist: () => useStore.getState().saveNetlist() },
    );
    return stop;
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
      {dialog === 'exportAsSvg' && <SaveAsImageDialog engine={engine} format="svg" />}
      {dialog === 'about' && <AboutDialog />}
      {dialog === 'shortcuts' && <ShortcutsDialog />}
      {dialog === 'findComponent' && <FindComponentDialog />}
      {dialog === 'createSubcircuit' && <CreateSubcircuitDialog />}
      {dialog === 'subcircuitManager' && <SubcircuitManagerDialog />}
      <div className="workspace">
        <aside id="parts-drawer" className={partsOpen ? 'left open' : 'left'}>
          <Toolbox />
        </aside>
        <main className="centre">
          <CircuitCanvas engine={engine} />
          <ScopePanel engine={engine} />
          <ContextMenu />
        </main>
        <aside id="options-drawer" className={panelOpen ? 'right open' : 'right'}>
          <OptionsPanel engine={engine} />
          <SliderPanel />
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
    </div>
  );
}
