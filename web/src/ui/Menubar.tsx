/** Top bar: the File/Edit/Scopes/Options/Tools dropdown menus, the circuit
 *  library and the run controls. One store action per command, so the menubar,
 *  the context menu and the keyboard cannot diverge. Rows whose commands other
 *  features still own render disabled with a tooltip, never live-looking. */

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { SimEngine } from '../engine/simulator';
import { openCircuit } from '../io/fileIO';
import { filterLibrary, loadLibraryCircuit, loadLibraryIndex, type LibraryGroup } from '../io/library';
import { parseCircuit } from '../io/netlist';
import { canMirror, canRotate } from '../model/transform';
import { renderCircuitToCanvas } from '../render/export';
import { printCircuit } from '../render/print';
import { useStore } from '../state/store';

interface Props {
  engine: SimEngine | null;
}

interface MenuItemDef {
  label: string;
  shortcut?: string;
  disabled?: boolean;
  disabledTitle?: string;
  title?: string;
  onClick: () => void;
}

function MenuItem({ label, shortcut, disabled, disabledTitle, title, onClick }: MenuItemDef) {
  return (
    <button
      type="button"
      className="menu-item"
      disabled={disabled}
      title={disabled ? disabledTitle : title}
      onClick={onClick}
    >
      <span>{label}</span>
      {shortcut && <span className="menu-shortcut">{shortcut}</span>}
    </button>
  );
}

/** A checkbox-style menu row: the two Options rows this plan owns. */
function CheckItem({ label, checked, onClick }: { label: string; checked: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      className="menu-item check-item"
      role="menuitemcheckbox"
      aria-checked={checked}
      onClick={onClick}
    >
      <span className="menu-check">{checked ? '✓' : ''}</span>
      <span>{label}</span>
    </button>
  );
}

function Dropdown({
  label,
  open,
  onToggle,
  onClose,
  children,
}: {
  label: string;
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);

  // Dismissal: a pointerdown outside, Escape, or losing focus. One listener
  // per open dropdown, the same pattern as the context menu.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (ev: PointerEvent) => {
      if (ref.current && ev.target instanceof Node && ref.current.contains(ev.target)) return;
      onClose();
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') onClose();
    };
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);

  return (
    <div ref={ref} className="dropdown">
      <button
        type="button"
        className={open ? 'active' : ''}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={onToggle}
      >
        {label} ▾
      </button>
      {open && <div className="dropdown-menu">{children}</div>}
    </div>
  );
}

export function Menubar({ engine }: Props) {
  const running = useStore((s) => s.running);
  const toggleRunning = useStore((s) => s.toggleRunning);
  const status = useStore((s) => s.status);
  const newCircuit = useStore((s) => s.newCircuit);
  const loadNetlist = useStore((s) => s.loadNetlist);
  const undo = useStore((s) => s.undo);
  const redo = useStore((s) => s.redo);
  const setStatus = useStore((s) => s.setStatus);
  const setDark = useStore((s) => s.setDark);
  const updateSettings = useStore((s) => s.updateSettings);
  const openDialog = useStore((s) => s.openDialog);
  const centerCircuit = useStore((s) => s.centerCircuit);
  const zoomIn = useStore((s) => s.zoomIn);
  const zoomOut = useStore((s) => s.zoomOut);
  const zoomReset = useStore((s) => s.zoomReset);

  const dark = useStore((s) => s.dark);
  const editable = useStore((s) => s.settings.editable);
  const conventional = useStore((s) => s.settings.conventional);
  const euroResistors = useStore((s) => s.settings.euroResistors);
  const euroGates = useStore((s) => s.settings.euroGates);
  const elements = useStore((s) => s.elements);
  const selectedIds = useStore((s) => s.selectedIds);
  const clipboard = useStore((s) => s.clipboard);
  const hasRecovery = useStore((s) => s.hasRecovery);
  const partsOpen = useStore((s) => s.partsOpen);
  const panelOpen = useStore((s) => s.panelOpen);
  const setPartsOpen = useStore((s) => s.setPartsOpen);
  const setPanelOpen = useStore((s) => s.setPanelOpen);

  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [library, setLibrary] = useState<LibraryGroup[] | null>(null);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [libraryError, setLibraryError] = useState<string | null>(null);
  const [libraryQuery, setLibraryQuery] = useState('');
  const [fullscreen, setFullscreen] = useState(() => document.fullscreenElement !== null);

  // The Full Screen row labels itself from the browser state both ways.
  useEffect(() => {
    const onChange = () => setFullscreen(document.fullscreenElement !== null);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  useEffect(() => {
    if (!libraryOpen || library) return;
    loadLibraryIndex()
      .then(setLibrary)
      .catch((e: unknown) => setLibraryError(e instanceof Error ? e.message : String(e)));
  }, [libraryOpen, library]);

  const toggleMenu = (name: string) => setOpenMenu((m) => (m === name ? null : name));
  const closeMenus = () => setOpenMenu(null);

  // A command runs once per click: close every dropdown, then the action.
  const fire = (action: () => void) => () => {
    closeMenus();
    action();
  };

  const openLibraryCircuit = async (file: string, title: string) => {
    try {
      loadNetlist(await loadLibraryCircuit(file));
      setStatus(title);
      setLibraryOpen(false);
      setLibraryQuery('');
    } catch (e) {
      setLibraryError(e instanceof Error ? e.message : String(e));
    }
  };

  const toggleFullScreen = () => {
    closeMenus();
    if (document.fullscreenElement) {
      void document.exitFullscreen();
    } else {
      void document.documentElement
        .requestFullscreen()
        .then(() => {
          // The bigger canvas deserves a centred circuit (CommandManager.java:310).
          useStore.getState().centerCircuit();
        })
        .catch(() => undefined);
    }
  };

  const copyImage = async () => {
    closeMenus();
    const s = useStore.getState();
    try {
      const canvas = document.createElement('canvas');
      renderCircuitToCanvas(canvas, s.elements, s.settings, false, engine);
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
      if (!blob) {
        setStatus('Could not render the circuit image.');
        return;
      }
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      setStatus('Circuit image copied to clipboard');
    } catch {
      // The Clipboard API needs a secure context; say so instead of failing
      // silently.
      setStatus('Image copy is not available in this browser.');
    }
  };

  // Print always renders on white, like upstream's forced-printable print
  // export (ImageExporter.java:187-189).
  const doPrint = () => {
    const s = useStore.getState();
    printCircuit(s.elements, s.settings, false, engine);
  };

  const selected = elements.filter((e) => selectedIds.includes(e.id));
  const hasSelection = selectedIds.length > 0;
  // A plain wire is one with no route; a routed one is already converted.
  const plainWires = elements.filter((e) => e.kind === 'wire' && !e.route);
  const canConvertWires = hasSelection
    ? plainWires.some((e) => selectedIds.includes(e.id))
    : plainWires.length > 0;
  const canRotateSelection = selected.length > 0 && selected.every(canRotate);
  const canMirrorSelection = selected.length > 0 && selected.every(canMirror);
  // The clipboard only ever holds text this app serialised, but guard anyway:
  // a manual garbage string must grey out Paste. Memoized like the context
  // menu's canPaste, since parsing on every render is wasteful.
  const canPaste = useMemo(
    () => clipboard !== null && parseCircuit(clipboard).elements.length > 0,
    [clipboard],
  );

  // Rows owned by other features that have not landed: disabled with the
  // deferral reason as a tooltip, so nothing half-working is ever bound.
  const deferred = (label: string, reason: string, shortcut?: string): MenuItemDef => ({
    label,
    shortcut,
    disabled: true,
    disabledTitle: reason,
    onClick: () => undefined,
  });

  const fileItems: MenuItemDef[] = [
    { label: 'New Blank Circuit', onClick: fire(newCircuit) },
    {
      label: 'Open File…',
      onClick: fire(() =>
        openCircuit((text, name) => {
          loadNetlist(text);
          setStatus(name);
        }),
      ),
    },
    { label: 'Import From Text…', onClick: fire(() => openDialog('importText')) },
    deferred('Import From Dropbox…', 'Dropbox import needs a backend service; not available'),
    { label: 'Save As…', onClick: fire(() => openDialog('saveAs')) },
    { label: 'Export As Link…', onClick: fire(() => openDialog('exportAsLink')) },
    { label: 'Export As Text…', onClick: fire(() => openDialog('exportAsText')) },
    { label: 'Save As Image…', onClick: fire(() => openDialog('exportAsImage')) },
    { label: 'Copy Circuit Image to Clipboard', onClick: () => void copyImage() },
    { label: 'Save As SVG…', onClick: fire(() => openDialog('exportAsSvg')) },
    {
      label: 'Create Subcircuit…',
      disabled: !editable,
      onClick: fire(() => {
        // The command aborts (with a browser alert from the caller) when the
        // selection holds a kind the composite cannot represent, has no
        // labeled nodes to expose as pins, or labels a net that is grounded or
        // unused, like upstream's guards (EditCompositeModelDialog.java:70-75,
        // SimulationManager.java:1588-1591, 1663-1668). The store leaves the
        // reason behind, so the alert says which one it was; every false comes
        // with one, so there is no second copy of the wording here to drift.
        if (!useStore.getState().createSubcircuit()) {
          window.alert(useStore.getState().subcircuitError);
        }
      }),
    },
    deferred('Find DC Operating Point', 'The DC operating point runs on reset; the one-shot command is not ported'),
    // Enabled only while a recovery exists (UIManager.java:170); the flag is
    // set once at store init and cleared by the recover, so the row stays
    // disabled for the session even though autosave keeps writing.
    { label: 'Recover Auto-Save', disabled: !hasRecovery, onClick: fire(() => useStore.getState().recoverAutoSave()) },
    { label: 'Print…', shortcut: 'Ctrl+P', onClick: fire(doPrint) },
    {
      label: 'Toggle Full Screen',
      onClick: toggleFullScreen,
      // The label is the command either way; the tooltip says which way it
      // currently points, kept fresh by the fullscreenchange listener.
      title: fullscreen ? 'Exit full screen' : 'Enter full screen',
    },
    { label: 'About…', onClick: fire(() => openDialog('about')) },
  ];

  const editItems: MenuItemDef[] = [
    { label: 'Undo', shortcut: 'Ctrl+Z', disabled: !editable, onClick: fire(undo) },
    { label: 'Redo', shortcut: 'Ctrl+Y', disabled: !editable, onClick: fire(redo) },
    { label: 'Cut', shortcut: 'Ctrl+X', disabled: !editable || !hasSelection, onClick: fire(() => useStore.getState().cutSelection()) },
    { label: 'Copy', shortcut: 'Ctrl+C', disabled: !editable || !hasSelection, onClick: fire(() => useStore.getState().copySelection()) },
    { label: 'Paste', shortcut: 'Ctrl+V', disabled: !editable || !canPaste, onClick: fire(() => useStore.getState().pasteFromClipboard()) },
    { label: 'Duplicate', shortcut: 'Ctrl+D', disabled: !editable || !hasSelection, onClick: fire(() => useStore.getState().duplicateSelection()) },
    { label: 'Select All', shortcut: 'Ctrl+A', disabled: !editable || elements.length === 0, onClick: fire(() => useStore.getState().selectAll()) },
    // An edit command like the rest of the Edit menu, so the read-only gate
    // applies (CommandManager.java:22-24); the '/' key stays live because
    // upstream's "key" menu path bypasses the gate (menuPerformed "key").
    { label: 'Find Component…', shortcut: '/', disabled: !editable, onClick: fire(() => openDialog('findComponent')) },
    // View commands, so they work with editing disabled like the zoom keys do.
    { label: 'Center Circuit', onClick: fire(centerCircuit) },
    { label: 'Zoom 100%', shortcut: '0', onClick: fire(zoomReset) },
    { label: 'Zoom In', shortcut: '+', onClick: fire(zoomIn) },
    { label: 'Zoom Out', shortcut: '-', onClick: fire(zoomOut) },
    { label: 'Rotate', shortcut: 'Alt+R', disabled: !editable || !canRotateSelection, onClick: fire(() => useStore.getState().rotateSelection()) },
    { label: 'Mirror', shortcut: 'Alt+M', disabled: !editable || !canMirrorSelection, onClick: fire(() => useStore.getState().mirrorSelection()) },
  ];

  const scopesItems: MenuItemDef[] = [
    // Upstream's read-only guard blocks the scopes menu too
    // (CommandManager.java:22-24), so stacking is off while editing is.
    { label: 'Stack All', disabled: !editable, onClick: fire(() => useStore.getState().stackAllScopes()) },
    { label: 'Unstack All', disabled: !editable, onClick: fire(() => useStore.getState().unstackAllScopes()) },
    { label: 'Combine All', disabled: !editable, onClick: fire(() => useStore.getState().combineAllScopes()) },
    { label: 'Separate All', disabled: !editable, onClick: fire(() => useStore.getState().separateAllScopes()) },
  ];

  const toolsItems: MenuItemDef[] = [
    // Enabled only when a plain wire is selected or present: a circuit that is
    // already fully routed has nothing to merge (upstream greys nothing, the
    // port ties the row to what the command can actually do).
    {
      label: 'Convert Wires to Routed Wires',
      disabled: !editable || !canConvertWires,
      onClick: fire(() => useStore.getState().convertWiresToRouted()),
    },
    {
      label: 'Subcircuit Manager',
      disabled: !editable,
      onClick: fire(() => openDialog('subcircuitManager')),
    },
    {
      label: 'Create Test',
      disabled: !editable,
      onClick: fire(() => {
        // The command builds a harness around the selected chip; when no
        // single chip is selected it aborts with the same alert upstream's
        // TestCreator shows (TestCreator.java:27-30), rather than placing
        // anything wrong.
        if (!useStore.getState().createTest()) {
          window.alert('Select a single chip element first.');
        }
      }),
    },
  ];

  const menu = (items: MenuItemDef[]) =>
    items.map((m) => (
      <MenuItem
        key={m.label}
        label={m.label}
        shortcut={m.shortcut}
        disabled={m.disabled}
        disabledTitle={m.disabledTitle}
        title={m.title}
        onClick={m.onClick}
      />
    ));

  return (
    <header className="menubar">
      <strong className="brand">Circuit Simulator</strong>

      <Dropdown label="File" open={openMenu === 'file'} onToggle={() => toggleMenu('file')} onClose={closeMenus}>
        {menu(fileItems)}
      </Dropdown>

      <Dropdown label="Edit" open={openMenu === 'edit'} onToggle={() => toggleMenu('edit')} onClose={closeMenus}>
        {menu(editItems)}
      </Dropdown>

      <Dropdown label="Scopes" open={openMenu === 'scopes'} onToggle={() => toggleMenu('scopes')} onClose={closeMenus}>
        {menu(scopesItems)}
      </Dropdown>

      <Dropdown label="Options" open={openMenu === 'options'} onToggle={() => toggleMenu('options')} onClose={closeMenus}>
        <CheckItem label="White Background" checked={!dark} onClick={fire(() => setDark(!dark))} />
        <CheckItem label="European Resistors" checked={euroResistors} onClick={fire(() => updateSettings({ euroResistors: !euroResistors }))} />
        <CheckItem label="IEC Gates" checked={euroGates} onClick={fire(() => updateSettings({ euroGates: !euroGates }))} />
        <CheckItem label="Conventional Current Motion" checked={conventional} onClick={fire(() => updateSettings({ conventional: !conventional }))} />
        <CheckItem label="Disable Editing" checked={!editable} onClick={fire(() => updateSettings({ editable: !editable }))} />
        <div className="menu-sep" />
        {menu([
          { label: 'Shortcuts…', onClick: fire(() => openDialog('shortcuts')) },
        ])}
      </Dropdown>

      <Dropdown label="Tools" open={openMenu === 'tools'} onToggle={() => toggleMenu('tools')} onClose={closeMenus}>
        {menu(toolsItems)}
      </Dropdown>

      <Dropdown
        label="Circuits"
        open={libraryOpen}
        onToggle={() => setLibraryOpen((v) => !v)}
        onClose={() => {
          setLibraryOpen(false);
          setLibraryQuery('');
        }}
      >
        {libraryError && <p className="problem">{libraryError}</p>}
        {!library && !libraryError && <p className="hint">Loading…</p>}
        {library && (
          <>
            <input
              type="text"
              className="library-search"
              placeholder="Search circuits…"
              value={libraryQuery}
              onChange={(e) => setLibraryQuery(e.target.value)}
              autoFocus
            />
            {(() => {
              const filtered = filterLibrary(library, libraryQuery);
              const searching = libraryQuery.trim() !== '';
              if (searching && filtered.length === 0) {
                return <p className="hint">No circuits match “{libraryQuery.trim()}”</p>;
              }
              return filtered.map((group) => (
                <details key={group.title} open={searching}>
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
              ));
            })()}
          </>
        )}
      </Dropdown>

      <div className="drawer-buttons">
        <button
          type="button"
          className={partsOpen ? 'active' : ''}
          onClick={() => setPartsOpen(!partsOpen)}
        >
          Parts
        </button>
        <button
          type="button"
          className={panelOpen ? 'active' : ''}
          onClick={() => setPanelOpen(!panelOpen)}
        >
          Options
        </button>
      </div>

      <span className="status">{engine ? status || 'Ready' : 'Loading engine…'}</span>

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
            // engine.reset() rewinds runtime state in place — fuse heat/blown,
            // capacitor charge, inductor current, lamp temperature — matching
            // upstream's reset (CircuitElm.reset, FuseElm.reset). The old
            // netlist self-reload re-injected a popped fuse's `blown true`
            // token, which is why a fuse survived Reset; unblowFuses drops the
            // store's live copies and queued pop-confirms so they cannot
            // re-apply it a frame later.
            engine?.reset();
            useStore.getState().unblowFuses();
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
