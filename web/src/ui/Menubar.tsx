/** Top bar: the File/Edit/Scopes/Options/Tools dropdown menus, the circuit
 *  library and the run controls. One store action per command, so the menubar,
 *  the context menu and the keyboard cannot diverge. Rows whose commands other
 *  features still own render disabled with a tooltip, never live-looking. */

import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import type { SimEngine } from '../engine/simulator';
import { DOC_PAGES } from '../docs/pages';
import { openCircuit } from '../io/fileIO';
import {
  filterLibrary,
  loadLibraryCircuit,
  loadLibraryIndex,
  type LibraryGroup,
} from '../io/library';
import { parseCircuit } from '../io/netlist';
import { canMirror, canRotate } from '../model/transform';
import { renderCircuitToCanvas } from '../render/export';
import { printCircuit } from '../render/print';
import { makeGhostElement, useStore } from '../state/store';
import { menubarButtonClass } from './controlClasses';
import { useMenuKeyboard } from './menuKeyboard';
import { deferred, type MenuItemDef } from './menuRows';

interface Props {
  engine: SimEngine | null;
}

function MenuItem({
  label,
  shortcut,
  disabled,
  disabledTitle,
  title,
  onClick,
  deferred,
}: MenuItemDef) {
  return (
    <button
      type="button"
      className={deferred ? 'menu-item deferred' : 'menu-item'}
      role="menuitem"
      disabled={disabled}
      title={disabled ? disabledTitle : title}
      onClick={onClick}
    >
      <span>{label}</span>
      {shortcut && <span className="menu-shortcut">{shortcut}</span>}
    </button>
  );
}

/** A checkbox-style menu row: the two Options rows this plan owns. The check
 *  renders in the fixed 24 px leading slot (`.menu-check`), the MD3
 *  menu-with-selection-control pattern, so the icon column lines up across
 *  the whole menu. */
function CheckItem({
  label,
  checked,
  onClick,
}: {
  label: string;
  checked: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="menu-item check-item"
      role="menuitemcheckbox"
      aria-checked={checked}
      onClick={onClick}
    >
      <span className="menu-check" aria-hidden="true">
        {checked ? <span className="material-icons">check</span> : null}
      </span>
      <span>{label}</span>
    </button>
  );
}

function Dropdown({
  label,
  open,
  onToggle,
  onOpen,
  onClose,
  menu = false,
  children,
}: {
  label: string;
  open: boolean;
  onToggle: () => void;
  /** Force-opens the menu from the keyboard; only wired when `menu` is true. */
  onOpen?: () => void;
  onClose: () => void;
  /** True for the flat command menus, which get `role="menu"` and arrow-key
   *  navigation. False for the Circuits dropdown: it is a search region with
   *  an input and `<details>` groups, so it keeps native controls and a
   *  group role instead of pretending to be a flat menu. */
  menu?: boolean;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // The opening key asks for the first or last item; the hook consumes it the
  // render after the menu opens, once the items exist.
  const [focusOnOpen, setFocusOnOpen] = useState<'first' | 'last' | null>(null);
  // The Circuits popup has no menu role, so the trigger names what it expands
  // through aria-controls instead of aria-haspopup.
  const popupId = useId();

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

  useMenuKeyboard({
    enabled: menu,
    open,
    onOpen: () => onOpen?.(),
    onClose,
    containerRef: ref,
    focusOnOpen,
    setFocusOnOpen,
  });

  return (
    <div ref={ref} className="dropdown">
      <button
        type="button"
        className={menubarButtonClass(open)}
        aria-haspopup={menu ? 'menu' : undefined}
        aria-controls={menu ? undefined : popupId}
        aria-expanded={open}
        onClick={onToggle}
      >
        {label}
      </button>
      {open && (
        <div
          id={menu ? undefined : popupId}
          className="dropdown-menu"
          role={menu ? 'menu' : 'group'}
          aria-label={menu ? label : 'Circuit library'}
        >
          {children}
        </div>
      )}
    </div>
  );
}

export function Menubar({ engine }: Props) {
  const running = useStore((s) => s.running);
  const tool = useStore((s) => s.tool);
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
  const mouseWheelEdit = useStore((s) => s.settings.mouseWheelEdit);
  // Derived selectors: commit replaces the stack arrays wholesale, so
  // subscribing to the length picks up each undo/redo boundary.
  const canUndo = useStore((s) => s.undoStack.length > 0);
  const canRedo = useStore((s) => s.redoStack.length > 0);
  const conventional = useStore((s) => s.settings.conventional);
  const euroResistors = useStore((s) => s.settings.euroResistors);
  const euroGates = useStore((s) => s.settings.euroGates);
  const showHitboxes = useStore((s) => s.settings.showHitboxes);
  const elements = useStore((s) => s.elements);
  const selectedIds = useStore((s) => s.selectedIds);
  const clipboard = useStore((s) => s.clipboard);
  const hasRecovery = useStore((s) => s.hasRecovery);
  const partsOpen = useStore((s) => s.partsOpen);
  const setPartsOpen = useStore((s) => s.setPartsOpen);
  const panelOpen = useStore((s) => s.panelOpen);
  const setPanelOpen = useStore((s) => s.setPanelOpen);

  const [openMenu, setOpenMenu] = useState<string | null>(null);
  // The mobile burger panel. On desktop the menu group is a plain run of
  // menubar items (`display: contents`) and this flag never matters; the
  // narrow layout turns the group into a panel the burger opens.
  const [burgerOpen, setBurgerOpen] = useState(false);
  const [library, setLibrary] = useState<LibraryGroup[] | null>(null);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [libraryError, setLibraryError] = useState<string | null>(null);
  const [libraryQuery, setLibraryQuery] = useState('');
  const [fullscreen, setFullscreen] = useState(() => document.fullscreenElement !== null);
  const burgerRef = useRef<HTMLDivElement>(null);
  const burgerButtonRef = useRef<HTMLButtonElement>(null);

  // The Full Screen row labels itself from the browser state both ways.
  useEffect(() => {
    const onChange = () => setFullscreen(document.fullscreenElement !== null);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  // The burger panel dismisses like a dropdown: a pointerdown outside it and
  // its trigger, or Escape. The dropdowns inside keep their own handlers, so a
  // tap on the panel's background closes only the open submenu.
  useEffect(() => {
    if (!burgerOpen) return;
    const outside = (target: EventTarget | null) =>
      target instanceof Node &&
      !burgerRef.current?.contains(target) &&
      !burgerButtonRef.current?.contains(target);
    const onPointerDown = (ev: PointerEvent) => {
      if (outside(ev.target)) setBurgerOpen(false);
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') setBurgerOpen(false);
    };
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [burgerOpen]);

  useEffect(() => {
    if (!libraryOpen || library) return;
    loadLibraryIndex()
      .then(setLibrary)
      .catch((e: unknown) => setLibraryError(e instanceof Error ? e.message : String(e)));
  }, [libraryOpen, library]);

  const toggleMenu = (name: string) => setOpenMenu((m) => (m === name ? null : name));
  const closeMenus = () => {
    setOpenMenu(null);
    setBurgerOpen(false);
  };

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
      setBurgerOpen(false);
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
          // The bigger canvas deserves a centred circuit (CommandManager.java:310),
          // but only once the browser has laid the fullscreen element out:
          // an immediate fit would measure the windowed canvas.
          useStore.getState().requestCenter();
        })
        .catch(() => undefined);
    }
  };

  // The Help rows are the `menu: true` docs pages, opened in a new tab so the
  // running circuit is not lost by navigating the app tab away. Generated from
  // the same registry the docs index and the tests read. The pages live under
  // `web/pages/`, so Vite emits them to `dist/pages/` and the links carry the
  // prefix.
  const openDocsPage = (file: string) => {
    closeMenus();
    window.open(`${import.meta.env.BASE_URL}pages/${file}`, '_blank', 'noopener');
  };
  const helpItems = DOC_PAGES.filter((p) => p.menu).map((p) => ({
    label: p.title,
    onClick: () => openDocsPage(p.file),
  }));

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
  // A ghost the armed tool is about to drop counts as rotatable, and takes
  // precedence over the selection exactly as Space does (store.rotateSelection):
  // arming a tool does not clear the selection, so the row must not go grey
  // while the key still turns something, nor turn the old selection when the
  // key turns the ghost.
  const canRotateGhost = tool !== null && canRotate({ ...makeGhostElement(tool, 0, 0, 0), id: -1 });
  const canRotateSelection = canRotateGhost || (selected.length > 0 && selected.every(canRotate));
  const canMirrorSelection = selected.length > 0 && selected.every(canMirror);
  // The clipboard only ever holds text this app serialised, but guard anyway:
  // a manual garbage string must grey out Paste. Memoized like the context
  // menu's canPaste, since parsing on every render is wasteful.
  const canPaste = useMemo(
    () => clipboard !== null && parseCircuit(clipboard).elements.length > 0,
    [clipboard],
  );

  // The logo is the favicon file itself, so the tab icon and the brand mark
  // can never drift apart. BASE_URL carries the deploy base, like the docs
  // links below.
  const brandLogoSrc = `${import.meta.env.BASE_URL}favicon.svg`;

  // Rows owned by other features that have not landed render disabled with the
  // deferral reason as a tooltip and a red strikethrough via `deferred()`
  // (menuRows.ts), so nothing half-working is ever bound.

  const fileItems: MenuItemDef[] = [
    // New Window is deliberately absent: upstream opens a fresh Electron
    // window over the running app (CommandManager.java:35-37), which a
    // single-window static site cannot do, so it is omitted rather than shown
    // disabled.
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
    // Import From Dropbox is deliberately absent: it needs a backend service
    // and is not to be ported, so it is omitted rather than shown disabled.
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
    deferred(
      'Find DC Operating Point',
      'The DC operating point runs on reset; the one-shot command is not ported',
    ),
    // Enabled only while a recovery exists (UIManager.java:170); the flag is
    // set once at store init and cleared by the recover, so the row stays
    // disabled for the session even though autosave keeps writing.
    {
      label: 'Recover Auto-Save',
      disabled: !hasRecovery,
      onClick: fire(() => useStore.getState().recoverAutoSave()),
    },
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
    {
      label: 'Cut',
      shortcut: 'Ctrl+X',
      disabled: !editable || !hasSelection,
      onClick: fire(() => useStore.getState().cutSelection()),
    },
    {
      label: 'Copy',
      shortcut: 'Ctrl+C',
      disabled: !editable || !hasSelection,
      onClick: fire(() => useStore.getState().copySelection()),
    },
    {
      label: 'Paste',
      shortcut: 'Ctrl+V',
      disabled: !editable || !canPaste,
      onClick: fire(() => useStore.getState().pasteFromClipboard()),
    },
    {
      label: 'Duplicate',
      shortcut: 'Ctrl+D',
      disabled: !editable || !hasSelection,
      onClick: fire(() => useStore.getState().duplicateSelection()),
    },
    {
      label: 'Select All',
      shortcut: 'Ctrl+A',
      disabled: !editable || elements.length === 0,
      onClick: fire(() => useStore.getState().selectAll()),
    },
    // An edit command like the rest of the Edit menu, so the read-only gate
    // applies (CommandManager.java:22-24); the '/' key stays live because
    // upstream's "key" menu path bypasses the gate (menuPerformed "key").
    {
      label: 'Find Component…',
      shortcut: '/',
      disabled: !editable,
      onClick: fire(() => openDialog('findComponent')),
    },
    // View commands, so they work with editing disabled like the zoom keys do.
    { label: 'Center Circuit', onClick: fire(centerCircuit) },
    { label: 'Zoom 100%', shortcut: '0', onClick: fire(zoomReset) },
    { label: 'Zoom In', shortcut: '+', onClick: fire(zoomIn) },
    { label: 'Zoom Out', shortcut: '-', onClick: fire(zoomOut) },
    {
      label: 'Rotate',
      shortcut: 'Space',
      disabled: !editable || !canRotateSelection,
      onClick: fire(() => useStore.getState().rotateSelection()),
    },
    {
      label: 'Mirror',
      shortcut: 'Alt+M',
      disabled: !editable || !canMirrorSelection,
      onClick: fire(() => useStore.getState().mirrorSelection()),
    },
  ];

  const scopesItems: MenuItemDef[] = [
    // Upstream's read-only guard blocks the scopes menu too
    // (CommandManager.java:22-24), so stacking is off while editing is.
    {
      label: 'Stack All',
      disabled: !editable,
      onClick: fire(() => useStore.getState().stackAllScopes()),
    },
    {
      label: 'Unstack All',
      disabled: !editable,
      onClick: fire(() => useStore.getState().unstackAllScopes()),
    },
    {
      label: 'Combine All',
      disabled: !editable,
      onClick: fire(() => useStore.getState().combineAllScopes()),
    },
    {
      label: 'Separate All',
      disabled: !editable,
      onClick: fire(() => useStore.getState().separateAllScopes()),
    },
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
      label: 'Sliders…',
      onClick: fire(() => {
        // The menubar dialog is circuit-wide; the context menu scopes the same
        // dialog to one element via setSliderElement.
        useStore.getState().setSliderElement(null);
        useStore.getState().openDialog('sliders');
      }),
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
        deferred={m.deferred}
        onClick={m.onClick}
      />
    ));

  return (
    <header className="menubar">
      <strong className="brand">
        <img
          className="brand-logo"
          src={brandLogoSrc}
          alt=""
          width={20}
          height={20}
          draggable={false}
        />
        <span className="brand-title">Circuit Simulator</span>
      </strong>

      <div className="edit-group">
        <button
          type="button"
          className="menubar-btn icon-btn"
          disabled={!editable || !canUndo}
          onClick={fire(undo)}
          title="Undo"
          aria-label="Undo"
        >
          <span className="material-icons" aria-hidden="true">
            undo
          </span>
        </button>
        <button
          type="button"
          className="menubar-btn icon-btn"
          disabled={!editable || !canRedo}
          onClick={fire(redo)}
          title="Redo"
          aria-label="Redo"
        >
          <span className="material-icons" aria-hidden="true">
            redo
          </span>
        </button>
      </div>
      <span className="sep" />

      {/* The narrow layout folds the seven menus behind this trigger; on
          desktop it is hidden and the group renders inline. */}
      <button
        ref={burgerButtonRef}
        type="button"
        className={
          burgerOpen ? 'menubar-btn icon-btn burger active' : 'menubar-btn icon-btn burger'
        }
        aria-haspopup="true"
        aria-expanded={burgerOpen}
        aria-controls="menubar-menus"
        aria-label="Menus"
        title="Menus"
        onClick={() => {
          setOpenMenu(null);
          setBurgerOpen((v) => !v);
        }}
      >
        <span className="material-icons" aria-hidden="true">
          menu
        </span>
      </button>

      <div
        ref={burgerRef}
        id="menubar-menus"
        className={burgerOpen ? 'menu-group open' : 'menu-group'}
      >
        <Dropdown
          label="File"
          menu
          open={openMenu === 'file'}
          onToggle={() => toggleMenu('file')}
          onOpen={() => setOpenMenu('file')}
          onClose={closeMenus}
        >
          {menu(fileItems)}
        </Dropdown>

        <Dropdown
          label="Edit"
          menu
          open={openMenu === 'edit'}
          onToggle={() => toggleMenu('edit')}
          onOpen={() => setOpenMenu('edit')}
          onClose={closeMenus}
        >
          {menu(editItems)}
        </Dropdown>

        <Dropdown
          label="Scopes"
          menu
          open={openMenu === 'scopes'}
          onToggle={() => toggleMenu('scopes')}
          onOpen={() => setOpenMenu('scopes')}
          onClose={closeMenus}
        >
          {menu(scopesItems)}
        </Dropdown>

        <Dropdown
          label="Options"
          menu
          open={openMenu === 'options'}
          onToggle={() => toggleMenu('options')}
          onOpen={() => setOpenMenu('options')}
          onClose={closeMenus}
        >
          <CheckItem
            label="White Background"
            checked={!dark}
            onClick={fire(() => setDark(!dark))}
          />
          <CheckItem
            label="European Resistors"
            checked={euroResistors}
            onClick={fire(() => updateSettings({ euroResistors: !euroResistors }))}
          />
          <CheckItem
            label="IEC Gates"
            checked={euroGates}
            onClick={fire(() => updateSettings({ euroGates: !euroGates }))}
          />
          <CheckItem
            label="Conventional Current Motion"
            checked={conventional}
            onClick={fire(() => updateSettings({ conventional: !conventional }))}
          />
          <CheckItem
            label="Disable Editing"
            checked={!editable}
            onClick={fire(() => updateSettings({ editable: !editable }))}
          />
          <CheckItem
            label="Toolbar"
            checked={partsOpen}
            onClick={fire(() => setPartsOpen(!partsOpen))}
          />
          <CheckItem
            label="Edit Values With Mouse Wheel"
            checked={mouseWheelEdit}
            onClick={fire(() => updateSettings({ mouseWheelEdit: !mouseWheelEdit }))}
          />
          <div className="menu-sep" role="separator" />
          {/* A diagnostic with no upstream counterpart, in its own group so it
            does not read as one of the drawing options: it paints the regions
            the pointer picker measures against over the schematic. Draw-only,
            and off by default. */}
          <CheckItem
            label="Show Hitboxes"
            checked={showHitboxes}
            onClick={fire(() => updateSettings({ showHitboxes: !showHitboxes }))}
          />
          <div className="menu-sep" role="separator" />
          {menu([
            { label: 'Shortcuts…', onClick: fire(() => openDialog('shortcuts')) },
            { label: 'Other Options…', onClick: fire(() => openDialog('otherOptions')) },
            // Electron-only upstream (Menus.java:238-239); the port is a web app.
            deferred(
              'Toggle Dev Tools',
              'The port is a web app, not Electron; there is no dev tools toggle',
            ),
          ])}
        </Dropdown>

        <Dropdown
          label="Tools"
          menu
          open={openMenu === 'tools'}
          onToggle={() => toggleMenu('tools')}
          onOpen={() => setOpenMenu('tools')}
          onClose={closeMenus}
        >
          {menu(toolsItems)}
        </Dropdown>

        <Dropdown
          label="Help"
          menu
          open={openMenu === 'help'}
          onToggle={() => toggleMenu('help')}
          onOpen={() => setOpenMenu('help')}
          onClose={closeMenus}
        >
          {menu(helpItems)}
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
                aria-label="Search circuits"
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
      </div>

      {/* A zero-height flex item that forces a wrap: on mobile the drawer
          toggles and the run controls start a second row. Inert on desktop. */}
      <span className="row-break" aria-hidden="true" />

      <div className="drawer-buttons">
        <button
          type="button"
          className={menubarButtonClass(partsOpen)}
          aria-expanded={partsOpen}
          aria-controls="parts-drawer"
          onClick={() => setPartsOpen(!partsOpen)}
        >
          Parts
        </button>
        <button
          type="button"
          className={menubarButtonClass(panelOpen)}
          aria-expanded={panelOpen}
          aria-controls="options-drawer"
          onClick={() => setPanelOpen(!panelOpen)}
        >
          Options
        </button>
      </div>
      <span className="sep" />

      <span className="status" role="status">
        {engine ? status || 'Ready' : 'Loading engine…'}
      </span>

      <div className="run-group">
        <button
          type="button"
          className={running ? 'primary running icon-btn' : 'primary icon-btn'}
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
          className="menubar-btn icon-btn"
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
