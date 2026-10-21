/** Top bar: the File/Edit/Scopes/Options/Tools dropdown menus, the circuit
 *  library and the run controls. One store action per command, so the menubar,
 *  the context menu and the keyboard cannot diverge. Rows whose commands other
 *  features still own render disabled with a tooltip, never live-looking. */

import { Fragment, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type { SimEngine } from '../engine/simulator';
import { execute } from '../commands/execute';
import type { SimControls } from '../commands/types';
import { DOC_PAGES } from '../docs/pages';
import { openCircuit } from '../io/fileIO';
import {
  filterLibrary,
  loadLibraryCircuit,
  loadLibraryIndex,
  type LibraryEntry,
  type LibraryGroup,
} from '../io/library';
import { renderCircuitToCanvas } from '../render/export';
import { printCircuit } from '../render/print';
import { useStore } from '../state/store';
import { PROJECT_GITHUB_URL } from './about';
import { runFullScreenToggle } from './fullscreen';
import { menubarButtonClass } from './controlClasses';
import { useMenuKeyboard } from './menuKeyboard';
import {
  commandRow,
  fileMenuTailRows,
  helpAboutRow,
  helpGithubRow,
  findDcOperatingPointRow,
  historyRow,
  type MenuItemDef,
} from './menuRows';

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
  sepBefore,
}: MenuItemDef) {
  return (
    <>
      {/* Upstream's menu separators (Menus.java:140,:142), carried on the row
          they precede so a factory can express a whole grouped block. */}
      {sepBefore && <div className="menu-sep" role="separator" />}
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
    </>
  );
}

/** One circuit-library group and everything under it. Upstream's setup list
 *  nests three deep, so a group renders its own circuits and then its
 *  subgroups, each as another collapsible of the same shape. `depth` only
 *  drives the indent; there is no limit on how far the list may nest. */
function LibraryGroupRows({
  group,
  depth,
  open,
  onPick,
}: {
  group: LibraryGroup;
  depth: number;
  /** Force every level open, which the search does so hits are visible without
   *  the user expanding each ancestor by hand. */
  open: boolean;
  onPick: (entry: LibraryEntry) => void;
}) {
  return (
    <details open={open} className={depth === 0 ? undefined : 'library-subgroup'}>
      <summary>{group.title}</summary>
      {group.entries.map((entry) => (
        <button key={entry.file} type="button" className="menu-item" onClick={() => onPick(entry)}>
          {entry.title}
        </button>
      ))}
      {group.groups.map((child) => (
        <LibraryGroupRows
          key={child.title}
          group={child}
          depth={depth + 1}
          open={open}
          onPick={onPick}
        />
      ))}
    </details>
  );
}

/** The Edit menu's zoom control: one row carrying all three zoom commands
 *  instead of three rows that each dismiss the menu after a single step. The
 *  minus and plus buttons step the view and deliberately leave the menu open,
 *  so a zoom can be nudged several notches in one visit; the readout between
 *  them shows the current factor and is itself the reset button. The row is
 *  not a `.menu-item`, so the arrow-key menu cursor steps over it rather than
 *  landing on a row with three targets in it; its buttons are reachable by
 *  Tab like any other control. */
function ZoomItem({
  scale,
  onIn,
  onOut,
  onReset,
}: {
  scale: number;
  onIn: () => void;
  onOut: () => void;
  onReset: () => void;
}) {
  return (
    <div className="zoom-item" role="group" aria-label="Zoom">
      <span className="zoom-label">Zoom</span>
      <button
        type="button"
        className="menubar-btn icon-btn"
        onClick={onOut}
        title="Zoom out (-)"
        aria-label="Zoom out"
      >
        <span className="material-icons" aria-hidden="true">
          remove
        </span>
      </button>
      <button
        type="button"
        className="zoom-readout"
        onClick={onReset}
        title="Zoom 100% (0)"
        aria-label="Zoom 100%"
      >
        {Math.round(scale * 100)}%
      </button>
      <button
        type="button"
        className="menubar-btn icon-btn"
        onClick={onIn}
        title="Zoom in (+)"
        aria-label="Zoom in"
      >
        <span className="material-icons" aria-hidden="true">
          add
        </span>
      </button>
    </div>
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
  const status = useStore((s) => s.status);
  const loadNetlist = useStore((s) => s.loadNetlist);
  const setStatus = useStore((s) => s.setStatus);
  const setNotice = useStore((s) => s.setNotice);
  const setDark = useStore((s) => s.setDark);
  const openDialog = useStore((s) => s.openDialog);
  // Only the factor, not the whole view: a pan must not re-render the menubar.
  const scale = useStore((s) => s.view.scale);

  const dark = useStore((s) => s.dark);
  const editable = useStore((s) => s.settings.editable);
  const mouseWheelEdit = useStore((s) => s.settings.mouseWheelEdit);
  // Derived selectors: commit replaces the stack arrays wholesale, so
  // subscribing to the length picks up each undo/redo boundary.
  const canUndo = useStore((s) => s.history.undo.length > 0);
  const canRedo = useStore((s) => s.history.redo.length > 0);
  const undoLabel = useStore((s) => s.history.undo[s.history.undo.length - 1]?.label ?? null);
  const redoLabel = useStore((s) => s.history.redo[s.history.redo.length - 1]?.label ?? null);
  const conventional = useStore((s) => s.settings.conventional);
  const euroResistors = useStore((s) => s.settings.euroResistors);
  const euroGates = useStore((s) => s.settings.euroGates);
  const showHitboxes = useStore((s) => s.settings.showHitboxes);
  const partsOpen = useStore((s) => s.partsOpen);
  const setPartsOpen = useStore((s) => s.setPartsOpen);
  const panelOpen = useStore((s) => s.panelOpen);
  const setPanelOpen = useStore((s) => s.setPanelOpen);
  // The drill-in session's context path: non-empty exactly while a model's
  // internals are being edited, so this is the surface that says where you
  // are and lets a crumb jump back out to it.
  const subcircuitStack = useStore((s) => s.subcircuitStack);

  const [openMenu, setOpenMenu] = useState<string | null>(null);
  // The mobile burger panel. On desktop the menu group is a plain run of
  // menubar items (`display: contents`) and this flag never matters; the
  // narrow layout turns the group into a panel the burger opens.
  const [burgerOpen, setBurgerOpen] = useState(false);
  const [library, setLibrary] = useState<LibraryGroup[] | null>(null);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [libraryError, setLibraryError] = useState<string | null>(null);
  const [libraryQuery, setLibraryQuery] = useState('');
  const burgerRef = useRef<HTMLDivElement>(null);
  const burgerButtonRef = useRef<HTMLButtonElement>(null);

  // The keyboard grab: while any dropdown or the burger panel is open the
  // store's gate flag is up, so no app shortcut fires behind the menu and one
  // Escape closes only the menu. The guard keeps redundant notifies out; the
  // cleanup covers an unmount with a menu still open.
  const setMenubarOpen = useStore((s) => s.setMenubarOpen);
  useEffect(() => {
    const open = openMenu !== null || burgerOpen || libraryOpen;
    if (useStore.getState().menubarOpen !== open) setMenubarOpen(open);
    return () => {
      if (useStore.getState().menubarOpen) useStore.getState().setMenubarOpen(false);
    };
  }, [openMenu, burgerOpen, libraryOpen, setMenubarOpen]);

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

  // The index is a single small text file, so it is fetched once at startup
  // rather than on the first open of the Circuits menu: opening the menu used
  // to show "Loading…" and then reflow under the pointer. It runs in the
  // background and nothing waits on it.
  useEffect(() => {
    let cancelled = false;
    loadLibraryIndex()
      .then((groups) => {
        if (!cancelled) setLibrary(groups);
      })
      .catch((e: unknown) => {
        if (!cancelled) setLibraryError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

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

  // Host-bound run controls the commands cannot reach on their own.
  const sim: SimControls = {
    reset: () => engine?.reset(),
    dcOperatingPoint: () => engine?.findDcOperatingPoint(),
  };

  /** The one dispatch for a menu row or button: close the menus, run the
   *  command through the same door the keyboard and an agent use, and surface
   *  a refusal in the status line. */
  const runCommand = (id: string, args?: unknown) => {
    const result = execute(id, args, { store: useStore, source: 'user', sim });
    if (!result.ok) setStatus(result.message);
    return result;
  };

  /** A menu row whose label, disabled state and reason come from the command
   *  definition. */
  const cmdRow = (
    id: string,
    opts: {
      args?: unknown;
      shortcut?: string;
      label?: string;
      sepBefore?: boolean;
    } = {},
  ): MenuItemDef =>
    commandRow(id, {
      state: useStore.getState(),
      args: opts.args,
      shortcut: opts.shortcut,
      label: opts.label,
      sepBefore: opts.sepBefore,
      run: fire(() => runCommand(id, opts.args)),
    });

  /** A command row that still alerts on refusal, for the two rows whose
   *  failure the user must see (no chip selected, a selection that cannot
   *  become a model). */
  const alertingRow = (id: string, args?: unknown): MenuItemDef =>
    commandRow(id, {
      state: useStore.getState(),
      args,
      run: fire(() => {
        const result = execute(id, args, { store: useStore, source: 'user', sim });
        if (!result.ok) {
          setStatus(result.message);
          window.alert(result.message);
        }
      }),
    });

  const openLibraryCircuit = async (file: string, title: string) => {
    try {
      // A refused load reports through the banner, not this catch (which is
      // for the fetch); only a real load names the title and closes the menu.
      if (loadNetlist(await loadLibraryCircuit(file)) !== null) return;
      setStatus(title);
      setLibraryOpen(false);
      setLibraryQuery('');
      setBurgerOpen(false);
    } catch (e) {
      setLibraryError(e instanceof Error ? e.message : String(e));
    }
  };

  // The drill-in breadcrumb: `outer > modelA > modelB`. A crumb jumps back to
  // its level by exiting once per level above it, so the outer crumb exits the
  // whole session and the current model's crumb is inert. A refused exit (a
  // pin label deleted, a net left unused) keeps the session inside and says
  // why, the same alert the create path uses.
  const jumpBackTo = (index: number) => {
    const s = useStore.getState();
    const levels = s.subcircuitStack.length - index;
    for (let i = 0; i < levels; i++) {
      useStore.getState().exitSubcircuit();
      if (useStore.getState().subcircuitError !== null) {
        window.alert(useStore.getState().subcircuitError);
        return;
      }
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
  helpItems.push(helpAboutRow(fire(() => openDialog('about'))));
  helpItems.push(
    helpGithubRow(() => {
      closeMenus();
      window.open(PROJECT_GITHUB_URL, '_blank', 'noopener');
    }),
  );

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
    cmdRow('circuit.new'),
    {
      label: 'Open File…',
      onClick: fire(() =>
        openCircuit(
          (text, name) => {
            // A refused load has already put its banner up; the status keeps
            // describing whatever is actually on screen.
            if (loadNetlist(text) !== null) return;
            setStatus(name);
          },
          // A read failure leaves the old circuit intact and nothing needs
          // dismissing, so it is a notice rather than a problem banner.
          (message) => setNotice(message),
        ),
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
    // The command builds the model and opens the naming dialog; a refusal
    // (an unsupported kind, no labeled nodes, a grounded or unused net) is
    // worth an alert because nothing visible changes otherwise.
    alertingRow('subcircuit.create'),
    // Run-mode command like Reset, so it stays enabled with editing disabled
    // (upstream gates it behind no read-only check either). The command
    // un-blows the store's fuse copies and routes its outcome through the two
    // banner channels itself.
    findDcOperatingPointRow(fire(() => runCommand('sim.dcOperatingPoint'))),
    // Enabled only while a recovery exists (UIManager.java:170); the flag is
    // set once at store init and cleared by the recover, so the row stays
    // disabled for the session even though autosave keeps writing.
    cmdRow('circuit.recoverAutoSave'),
    // The File tail: Print, then the Full Screen toggle after a separator. The command toggles the browser
    // surface on the document element and re-fits the circuit afterwards
    // (CommandManager.java:305-311). The fit goes through requestCenter, whose
    // layout-effect path measures the canvas before fitting: entering full
    // screen resizes the canvas asynchronously, so a direct centerCircuit
    // would fit the windowed viewport and leave it there.
    ...fileMenuTailRows({
      print: fire(doPrint),
      fullScreen: fire(() => runFullScreenToggle(document, useStore.getState().requestCenter)),
    }),
  ];

  const editItems: MenuItemDef[] = [
    historyRow('undo', useStore.getState(), fire(() => runCommand('history.undo'))),
    historyRow('redo', useStore.getState(), fire(() => runCommand('history.redo'))),
    cmdRow('clipboard.cut', { shortcut: 'Ctrl+X' }),
    cmdRow('clipboard.copy', { shortcut: 'Ctrl+C' }),
    cmdRow('clipboard.paste', { shortcut: 'Ctrl+V' }),
    cmdRow('clipboard.duplicate', { shortcut: 'Ctrl+D' }),
    cmdRow('selection.all', { shortcut: 'Ctrl+A' }),
    // A view command, so it works with editing disabled like the zoom keys do.
    // The three zoom commands are not rows: they share the ZoomItem control
    // rendered after this list.
    cmdRow('view.center'),
    cmdRow('element.rotate', { shortcut: 'Space' }),
    cmdRow('element.mirror', { shortcut: 'Alt+H' }),
    cmdRow('element.mirrorVertical', { shortcut: 'Alt+V' }),
  ];

  const scopesItems: MenuItemDef[] = [
    // Upstream's read-only guard blocks the scopes menu too
    // (CommandManager.java:22-24), so stacking is off while editing is.
    cmdRow('scope.stackAll'),
    cmdRow('scope.unstackAll'),
    cmdRow('scope.combineAll'),
    cmdRow('scope.separateAll'),
  ];

  const toolsItems: MenuItemDef[] = [
    // A circuit that is already fully routed has nothing to merge, so the
    // command's enabled reason greys the row.
    cmdRow('wire.convertToRouted'),
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
    // The command builds a harness around a single chip; when there is none it
    // fails with the same alert upstream's TestCreator shows
    // (TestCreator.java:27-30), rather than placing anything wrong.
    alertingRow('circuit.createTest'),
  ];

  const menu = (items: MenuItemDef[]) => items.map((m) => <MenuItem key={m.label} {...m} />);

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
          onClick={fire(() => runCommand('history.undo'))}
          title={undoLabel === null ? 'Undo' : `Undo ${undoLabel}`}
          aria-label={undoLabel === null ? 'Undo' : `Undo ${undoLabel}`}
        >
          <span className="material-icons" aria-hidden="true">
            undo
          </span>
        </button>
        <button
          type="button"
          className="menubar-btn icon-btn"
          disabled={!editable || !canRedo}
          onClick={fire(() => runCommand('history.redo'))}
          title={redoLabel === null ? 'Redo' : `Redo ${redoLabel}`}
          aria-label={redoLabel === null ? 'Redo' : `Redo ${redoLabel}`}
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
          <div className="menu-sep" role="separator" />
          <ZoomItem
            scale={scale}
            onIn={() => runCommand('view.zoomIn')}
            onOut={() => runCommand('view.zoomOut')}
            onReset={() => runCommand('view.reset')}
          />
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
            onClick={fire(() => runCommand('settings.update', { euroResistors: !euroResistors }))}
          />
          <CheckItem
            label="IEC Gates"
            checked={euroGates}
            onClick={fire(() => runCommand('settings.update', { euroGates: !euroGates }))}
          />
          <CheckItem
            label="Conventional Current Motion"
            checked={conventional}
            onClick={fire(() => runCommand('settings.update', { conventional: !conventional }))}
          />
          <CheckItem
            label="Disable Editing"
            checked={!editable}
            onClick={fire(() => runCommand('settings.update', { editable: !editable }))}
          />
          <CheckItem
            label="Toolbar"
            checked={partsOpen}
            onClick={fire(() => setPartsOpen(!partsOpen))}
          />
          <CheckItem
            label="Edit Values With Mouse Wheel"
            checked={mouseWheelEdit}
            onClick={fire(() => runCommand('settings.update', { mouseWheelEdit: !mouseWheelEdit }))}
          />
          <div className="menu-sep" role="separator" />
          {/* A diagnostic with no upstream counterpart, in its own group so it
            does not read as one of the drawing options: it paints the regions
            the pointer picker measures against over the schematic. Draw-only,
            and off by default. */}
          <CheckItem
            label="Show Hitboxes"
            checked={showHitboxes}
            onClick={fire(() => runCommand('settings.update', { showHitboxes: !showHitboxes }))}
          />
          <div className="menu-sep" role="separator" />
          {menu([
            { label: 'Shortcuts…', onClick: fire(() => openDialog('shortcuts')) },
            { label: 'Other Options…', onClick: fire(() => openDialog('otherOptions')) },
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
                  <LibraryGroupRows
                    key={group.title}
                    group={group}
                    depth={0}
                    open={searching}
                    onPick={(entry) => void openLibraryCircuit(entry.file, entry.title)}
                  />
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
          onClick={fire(() => runCommand(running ? 'sim.pause' : 'sim.run'))}
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
          onClick={fire(() => runCommand('sim.reset'))}
          title="Reset"
          aria-label="Reset"
        >
          <span className="material-icons" aria-hidden="true">
            replay
          </span>
        </button>
      </div>

      {/* The drill-in context path, upstream's SubcircuitBar (SubcircuitBar.java)
          reinterpreted as clickable crumbs: each one returns to its level, so
          the strip both names where you are and is the way out. */}
      {subcircuitStack.length > 0 && (
        <nav className="subcircuit-breadcrumb" aria-label="Editing context">
          <button type="button" className="crumb" onClick={() => jumpBackTo(0)}>
            outer
          </button>
          {subcircuitStack.map((entry, i) => (
            <Fragment key={`${entry.modelName}-${i}`}>
              <span className="crumb-sep" aria-hidden="true">
                ›
              </span>
              {i === subcircuitStack.length - 1 ? (
                <span className="crumb current">{entry.modelName}</span>
              ) : (
                <button type="button" className="crumb" onClick={() => jumpBackTo(i + 1)}>
                  {entry.modelName}
                </button>
              )}
            </Fragment>
          ))}
        </nav>
      )}
    </header>
  );
}
