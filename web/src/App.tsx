import { useEffect, useRef, useState } from 'react';
import { SimEngine } from './engine/simulator';
import { handleAppKeyDown, handleAppKeyUp, type AppKeyHost } from './input/appKeys';
import { openCircuit } from './io/fileIO';
import { loadDefaultCircuit, loadLibraryCircuit } from './io/library';
import { startupSource } from './io/urlShare';
import { printCircuit } from './render/print';
import { AboutDialog } from './ui/AboutDialog';
import { CreateSubcircuitDialog } from './ui/CreateSubcircuitDialog';
import { CircuitCanvas } from './ui/CircuitCanvas';
import { ContextMenu } from './ui/ContextMenu';
import { DeviceModelEditorDialog } from './ui/DeviceModelEditorDialog';
import { ElementPropertiesDialog } from './ui/ElementPropertiesDialog';
import { ExportAsLinkDialog } from './ui/ExportAsLinkDialog';
import { ExportAsTextDialog } from './ui/ExportAsTextDialog';
import { ImportFromTextDialog } from './ui/ImportFromTextDialog';
import { Menubar } from './ui/Menubar';
import { paletteAnchor } from './ui/paletteAnchor';
import { OptionsPanel } from './ui/OptionsPanel';
import { OtherOptionsDialog } from './ui/OtherOptionsDialog';
import { SaveAsDialog } from './ui/SaveAsDialog';
import { SaveAsImageDialog } from './ui/SaveAsImageDialog';
import { ScopePanel } from './ui/ScopePanel';
import { ShortcutsDialog } from './ui/ShortcutsDialog';
import { SliderDialog } from './ui/SliderDialog';
import { SliderPanel } from './ui/SliderPanel';
import { SubcircuitManagerDialog } from './ui/SubcircuitManagerDialog';
import { Toolbox } from './ui/Toolbox';
import { useAutoPause } from './ui/useAutoPause';
import { hasUnsavedChanges, useStore } from './state/store';
import { noteUndockedHello } from './undocked/opener';
import { UNDOCKED_HELLO_TYPE } from './undocked/protocol';
import { startAutoSave } from './state/recovery';

/** A small RC circuit, kept as the offline fallback for when the bundled
 *  library cannot be fetched, so the app still opens on something that runs. */
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
  const dialog = useStore((s) => s.dialog);
  const elementProperties = useStore((s) => s.elementProperties);
  const deviceModelEditor = useStore((s) => s.deviceModelEditor);
  const partsOpen = useStore((s) => s.partsOpen);
  const panelOpen = useStore((s) => s.panelOpen);
  const setPartsOpen = useStore((s) => s.setPartsOpen);
  const setPanelOpen = useStore((s) => s.setPanelOpen);
  const problem = useStore((s) => s.problem);
  const setProblem = useStore((s) => s.setProblem);
  const notice = useStore((s) => s.notice);
  const setNotice = useStore((s) => s.setNotice);
  // The print shortcut needs the engine, but the keydown listener is
  // registered once with no deps; a ref keeps it seeing the latest handle
  // without re-registering on every engine load.
  const engineRef = useRef<SimEngine | null>(null);
  engineRef.current = engine;

  // Pause an unattended tab after 10 s of no meaningful input, once, at
  // startup, so an opened-but-ignored page stops burning background CPU.
  useAutoPause();

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
        // with a status message when the fetch fails; else the library's own
        // default, the entry upstream marks with `>` in setuplist.txt.
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
          try {
            const { entry, netlist } = await loadDefaultCircuit();
            if (cancelled) return;
            load(netlist);
            // Name it the way the Circuits menu does, so the opening circuit
            // reads as a library entry rather than as anonymous scratch work.
            useStore.getState().setStatus(entry.title);
          } catch {
            // No status here: a missing library is not something the user
            // asked for, and the fallback circuit is usable on its own.
            if (cancelled) return;
            load(STARTER_CIRCUIT);
          }
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) setEngineError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Keyboard shortcuts. The matching, the modal-surface gate and the dispatch
  // live in input/appKeys.ts; this effect keeps only the two DOM concerns:
  // the INPUT-focus early return and the browser-default suppression.
  useEffect(() => {
    // Browser-bound side effects, collected behind one interface so the
    // pipeline stays DOM-free and headlessly testable.
    const host: AppKeyHost = {
      openFile: () =>
        openCircuit((text, name) => {
          const st = useStore.getState();
          st.loadNetlist(text);
          st.setStatus(name);
        }),
      print: () => {
        const st = useStore.getState();
        printCircuit(st.elements, st.settings, false, engineRef.current);
      },
      alert: (message) => window.alert(message),
      openPalette: () => {
        const at = paletteAnchor({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
        // The trailing true is the whole point of the key: there is no click
        // behind this open, so the menu has to put the caret in its element
        // search itself. Target null forces the empty-canvas (palette) form
        // even if the cursor happens to rest on an element.
        useStore.getState().openContextMenu(at.client.x, at.client.y, null, at.circuit, true);
      },
      stateAfter: () => useStore.getState(),
    };
    const onKey = (ev: KeyboardEvent) => {
      const target = ev.target as HTMLElement | null;
      if (target && /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName)) return;
      // True means a shortcut ran (or a switch toggled), so the browser
      // default must die with it; a modal surface or an unbound key returns
      // false and nothing is suppressed here.
      if (handleAppKeyDown(useStore.getState(), ev, host)) ev.preventDefault();
    };
    const onKeyUp = (ev: KeyboardEvent) => {
      // No INPUT/SELECT/TEXTAREA early return here: the momentary release
      // must outrank the focus guard, or a hold started on the canvas sticks
      // closed when focus moved into a search box before the key came up.
      // Releasing only touches held momentary switches, so ordinary typing
      // stays a no-op.
      handleAppKeyUp(useStore.getState(), ev);
    };
    // A hold whose release is lost entirely (alt-tab mid-press) strands every
    // kind of armed momentary; the window blur releases them all.
    const onBlur = () => useStore.getState().releaseHeldMomentaries();
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
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
      // written live so a crash restores the current charge. While a drill-in
      // session is up the payload is the stack-root document instead, so a
      // crash inside recovers onto the outer sheet.
      () => useStore.getState().toNetlist(),
      { writeNetlist: () => useStore.getState().recoveryNetlist() },
    );
    return stop;
  }, []);

  // Ask before the page reloads or closes with unsaved changes. The browser
  // draws its own "leave site?" prompt; `returnValue` is what arms it. This
  // handler must stay prompt-only: it fires before the user has chosen, so
  // any teardown here would run even for a navigation they cancel.
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

  // A real reload or close strands the undocked scope as a frozen orphan
  // window; close it while we still hold the handle. `pagehide` and not
  // `beforeunload`: it fires only once the page is actually going away (and
  // covers bfcache eviction), so a cancelled leave dialog cannot kill the
  // popup while the app keeps running.
  useEffect(() => {
    const onPageHide = () => useStore.getState().closeUndockedScope();
    window.addEventListener('pagehide', onPageHide);
    return () => window.removeEventListener('pagehide', onPageHide);
  }, []);

  // The undocked scope page announces itself when it finishes loading; the
  // per-frame push starts then, so nothing is posted into a half-loaded child.
  // The event travels whole: the bridge accepts a hello only from the window
  // we opened, never from an arbitrary tab or iframe.
  useEffect(() => {
    const onMessage = (ev: MessageEvent) => {
      const data = ev.data as { type?: string } | null;
      if (data?.type === UNDOCKED_HELLO_TYPE) noteUndockedHello(ev);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
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
      {dialog === 'createSubcircuit' && <CreateSubcircuitDialog />}
      {dialog === 'subcircuitManager' && <SubcircuitManagerDialog />}
      {dialog === 'otherOptions' && <OtherOptionsDialog />}
      {dialog === 'sliders' && <SliderDialog />}
      {elementProperties !== null && <ElementPropertiesDialog engine={engine} />}
      {deviceModelEditor !== null && <DeviceModelEditorDialog />}
      <div className="workspace">
        <aside id="parts-drawer" className={partsOpen ? 'left open' : 'left'}>
          <Toolbox />
        </aside>
        <main className="centre">
          {(problem || notice) && (
            // Absolutely positioned inside .centre (see .app-banner-stack in
            // styles.css) so it overlays the canvas instead of pushing it:
            // toggling a banner must not shift the canvas below, and anchoring
            // to .centre rather than .workspace keeps it clear of the parts and
            // options drawers on either side. One stack, so a problem and a
            // notice at the same time sit under each other rather than on top
            // of each other.
            <div className="app-banner-stack">
              {problem && (
                // The whole banner is the dismiss target, not just the ×: it
                // overlays the canvas, so a tap that means "get out of the
                // way" should not have to find a 20 px glyph. The × stays for
                // the keyboard and for anyone who reads it as the affordance.
                <div className="problem app-banner" role="alert" onClick={() => setProblem(null)}>
                  <span className="app-banner-text">{problem}</span>
                  <button
                    type="button"
                    className="app-banner-close"
                    aria-label="Dismiss"
                    title="Dismiss"
                    onClick={() => setProblem(null)}
                  >
                    ×
                  </button>
                </div>
              )}
              {notice && (
                // `status`, not `alert`: it is over before it could be acted
                // on, and it carries no close button for the same reason. The
                // CSS animation is the notice's whole life, fade-in through
                // fade-out, so its end is the moment to take the element away:
                // one owner for the timing, no JS timer racing the fade. The
                // key restarts that animation when the text changes, which a
                // reused element would not do.
                <div
                  key={notice}
                  className="notice app-banner"
                  role="status"
                  onClick={() => setNotice(null)}
                  onAnimationEnd={() => setNotice(null)}
                >
                  <span className="app-banner-text">{notice}</span>
                </div>
              )}
            </div>
          )}
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
