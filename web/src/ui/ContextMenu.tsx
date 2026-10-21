/**
 * Right-click context menu. Over an element it offers element commands; over
 * empty canvas, the element palette and circuit commands. Position, clamping
 * and dismissal live here; every command is a store action, so the menu,
 * menubar and keyboard cannot diverge. The empty-canvas palette is the port's
 * modernized form of upstream's Draw menu (Menus.java:271-483): the toolbox
 * entries with real icons and a search box, instead of category submenus.
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { execute, commandState } from '../commands/execute';
import { defFor, type ToolboxEntry } from '../model/registry';
import { toolShortcut } from '../model/search';
import type { SimSettings } from '../model/types';
import { useStore } from '../state/store';
import { canCreateSlider, canSplitWire, elementScopeCommands, paletteGroups } from './contextMenuRows';
import { ToolIcon } from './ToolIcon';

interface MenuItem {
  label: string;
  shortcut?: string;
  disabled?: boolean;
  disabledTitle?: string;
  /** A row upstream has but the port does not implement: disabled with the
   *  reason as a tooltip and the red strikethrough, the same treatment the
   *  menubar's `deferred()` rows get (menuRows.ts). */
  deferred?: boolean;
  action: () => void;
}

export function ContextMenu() {
  const contextMenu = useStore((s) => s.contextMenu);
  const closeContextMenu = useStore((s) => s.closeContextMenu);
  const elements = useStore((s) => s.elements);
  const scopes = useStore((s) => s.scopes);
  const editable = useStore((s) => s.settings.editable);
  const dark = useStore((s) => s.dark);
  const settings = useStore((s) => s.settings);
  const [query, setQuery] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // The menu mounts only while contextMenu is set. Measure it before paint and
  // pull it inside the viewport, so a right-click near an edge does not open a
  // menu that is half offscreen.
  useLayoutEffect(() => {
    if (!contextMenu) return;
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    el.style.left = `${Math.max(4, Math.min(contextMenu.x, window.innerWidth - w - 4))}px`;
    el.style.top = `${Math.max(4, Math.min(contextMenu.y, window.innerHeight - h - 4))}px`;
  }, [contextMenu]);

  // Opened by the '/' key there is no pointer and no click: the caret goes
  // into the element search so the menu is ready to type into, which is the
  // whole point of the key. A right-click leaves focus alone.
  useEffect(() => {
    if (contextMenu?.focusSearch) searchRef.current?.focus();
  }, [contextMenu]);

  // A fresh open starts from the whole palette; a stale query from the last
  // open would hide most of the parts with no visible cause. Cleared on close
  // rather than on open: the menu renders nothing while closed, so the height
  // change cannot land after the layout effect above has already measured and
  // placed it.
  useEffect(() => {
    if (!contextMenu) setQuery('');
  }, [contextMenu]);

  // Dismissal: a pointerdown anywhere outside the menu, Escape, and losing
  // focus or scrolling. A scroll inside the menu (the palette is long) is the
  // user reading it, not the page moving away, so inner scrolls are ignored.
  useEffect(() => {
    if (!contextMenu) return;
    const onPointerDown = (ev: PointerEvent) => {
      if (ref.current && ev.target instanceof Node && ref.current.contains(ev.target)) return;
      closeContextMenu();
    };
    const onKeyDown = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') closeContextMenu();
    };
    const onBlur = () => closeContextMenu();
    const onScroll = (ev: Event) => {
      if (ref.current && ev.target instanceof Node && ref.current.contains(ev.target)) return;
      closeContextMenu();
    };
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('blur', onBlur);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [contextMenu, closeContextMenu]);

  if (!contextMenu) return null;

  const { target, circuit } = contextMenu;
  const targetElement = target !== null ? elements.find((e) => e.id === target) : undefined;
  const targetDef = targetElement ? defFor(targetElement.kind) : undefined;
  const run = (action: () => void) => {
    closeContextMenu();
    action();
  };

  const runCommand = (id: string, args?: unknown) => {
    const result = execute(id, args, { store: useStore, source: 'user' });
    if (!result.ok) useStore.getState().setStatus(result.message);
  };

  /** Disabled state and its tooltip from the command definition, so the menu
   *  cannot grey a different set from the keyboard. */
  const availability = (id: string, args?: unknown) => {
    const check = commandState(id, args ?? {}, useStore.getState());
    return { disabled: !check.enabled, disabledTitle: check.reason };
  };

  const item = (m: MenuItem) => (
    <button
      key={m.label}
      type="button"
      className={m.deferred ? 'menu-item deferred' : 'menu-item'}
      role="menuitem"
      disabled={m.disabled}
      title={m.disabled ? m.disabledTitle : undefined}
      onClick={() => run(m.action)}
    >
      <span>{m.label}</span>
      {m.shortcut && <span className="menu-shortcut">{m.shortcut}</span>}
    </button>
  );

  const isElementMenu = target !== null;

  // ---- element menu rows (upstream elmMenuBar, Menus.java:255-267) ----

  const scopeItems: MenuItem[] = [];
  if (isElementMenu && targetDef) {
    const undockedOpen = useStore.getState().undocked !== null;
    scopeItems.push(
      // The row definitions live in the pure module; this only wires the
      // store actions behind them.
      ...elementScopeCommands({
        editable,
        hasEditableFields: Boolean(targetDef.fields?.length),
        scopeIds: scopes.map((s) => s.id),
        undockedOpen,
        commands: {
          edit: () => useStore.getState().requestEdit(target),
          viewInScope: () => runCommand('scope.add', { elementId: target, value: 'voltage' }),
          // The undocked window is host-bound presentation on top of a scope
          // create, so it stays a store action rather than a command.
          viewUndocked: () => useStore.getState().openUndockedScope(target),
          addTo: (scopeId) =>
            runCommand('scope.addTo', { elementId: target, scopeId, value: 'voltage' }),
          addCurrent: () => runCommand('scope.add', { elementId: target, value: 'current' }),
        },
      }).map((row) => ({
        label: row.label,
        disabled: row.disabled,
        disabledTitle: row.disabledTitle,
        deferred: row.deferred,
        action: row.run,
      })),
    );
  }

  const selectionItems: MenuItem[] = [
    {
      label: 'Cut',
      shortcut: 'Ctrl+X',
      ...availability('clipboard.cut'),
      action: () => runCommand('clipboard.cut'),
    },
    {
      label: 'Copy',
      shortcut: 'Ctrl+C',
      ...availability('clipboard.copy'),
      action: () => runCommand('clipboard.copy'),
    },
    {
      label: 'Paste',
      shortcut: 'Ctrl+V',
      ...availability('clipboard.paste'),
      action: () => runCommand('clipboard.paste'),
    },
    {
      label: 'Delete',
      shortcut: 'Delete',
      ...availability('element.delete'),
      action: () => runCommand('element.delete'),
    },
    {
      label: 'Duplicate',
      shortcut: 'Ctrl+D',
      ...availability('clipboard.duplicate'),
      action: () => runCommand('clipboard.duplicate'),
    },
    {
      label: 'Swap Terminals',
      shortcut: 'Alt+T',
      ...availability('element.swapTerminals'),
      action: () => runCommand('element.swapTerminals'),
    },
    {
      label: 'Rotate',
      shortcut: 'Space',
      ...availability('element.rotate'),
      action: () => runCommand('element.rotate'),
    },
    {
      label: 'Mirror Horizontally',
      shortcut: 'Alt+H',
      ...availability('element.mirror'),
      action: () => runCommand('element.mirror'),
    },
    {
      label: 'Mirror Vertically',
      shortcut: 'Alt+V',
      ...availability('element.mirrorVertical'),
      action: () => runCommand('element.mirrorVertical'),
    },
  ];

  // The element-only tail: the wire split (wires only, upstream enables it on
  // `instanceof WireElm`, MouseManager.java:956) and the element-scoped
  // Sliders dialog.
  const wireItems: MenuItem[] = [];
  if (isElementMenu && canSplitWire(targetElement?.kind)) {
    wireItems.push({
      label: 'Split Wire Manually',
      // No shortcut hint: upstream's Ctrl+click on a wire is the dragpost
      // gesture here (pointerDown.ts:235), not a split, so advertising it
      // would claim a key that does the wrong thing.
      ...availability('wire.split', { id: target, x: circuit.x, y: circuit.y }),
      // The menu opened over the wire, so the click point is the split point;
      // the command snaps it to the grid (MouseManager.java:586-593).
      action: () => runCommand('wire.split', { id: target, x: circuit.x, y: circuit.y }),
    });
  }
  if (isElementMenu) {
    wireItems.push({
      label: 'Sliders...',
      // Kinds with their own built-in slider, and elements with no adjustable
      // field, have nothing to bind (MouseManager.java:994-1007).
      disabled: !editable || !canCreateSlider(targetElement?.kind),
      disabledTitle:
        targetElement && !canCreateSlider(targetElement.kind)
          ? 'This element has no adjustable parameters'
          : undefined,
      action: () => {
        useStore.getState().setSliderElement(target);
        useStore.getState().openDialog('sliders');
      },
    });
  }

  // ---- empty-canvas menu (upstream's Draw menu, modernized) ----

  const canvasItems: MenuItem[] = [
    {
      label: 'Undo',
      shortcut: 'Ctrl+Z',
      ...availability('history.undo'),
      action: () => runCommand('history.undo'),
    },
    {
      label: 'Redo',
      shortcut: 'Ctrl+Shift+Z',
      ...availability('history.redo'),
      action: () => runCommand('history.redo'),
    },
    {
      label: 'Paste',
      shortcut: 'Ctrl+V',
      ...availability('clipboard.paste'),
      action: () => runCommand('clipboard.paste'),
    },
    {
      label: 'Select All',
      ...availability('selection.all'),
      action: () => runCommand('selection.all'),
    },
    {
      label: 'New',
      ...availability('circuit.new'),
      action: () => runCommand('circuit.new'),
    },
    // Upstream's Select/Drag Sel mode (space). The port's select mode is
    // `tool === null`; the other Drag modes (All/Row/Column/Post) are
    // keyboard-modifier gestures with no store mode to select, so they are
    // deliberately omitted rather than offered as dead rows.
    {
      label: 'Select/Drag Sel',
      shortcut: 'Space',
      disabled: !editable,
      action: () => useStore.getState().setTool(null),
    },
  ];

  const paletteItem = (t: ToolboxEntry, dark: boolean, settings: SimSettings) => {
    const shortcut = toolShortcut(t);
    return (
      <button
        key={t.id}
        type="button"
        className="menu-item palette-item"
        role="menuitem"
        // A locked circuit cannot place, so its palette rows are disabled like
        // the toolbox's (Toolbox.tsx), and choosing one is impossible.
        disabled={!editable}
        onClick={() => run(() => useStore.getState().setTool(t.id))}
      >
        <ToolIcon toolId={t.id} dark={dark} settings={settings} />
        <span className="tool-label">{t.label}</span>
        {shortcut && (
          <kbd className="tool-shortcut" aria-hidden="true">
            {shortcut}
          </kbd>
        )}
      </button>
    );
  };

  const groups = paletteGroups(query);
  const searching = query.trim() !== '';

  // Two columns over the empty canvas: the commands on the left, the element
  // palette on the right. Each column scrolls on its own, so a long palette
  // never pushes the commands out of reach, and the search box sits outside
  // the palette's scroller and stays put while the list moves under it.
  return (
    <div
      ref={ref}
      className={isElementMenu ? 'dropdown-menu context-menu' : 'dropdown-menu context-menu wide'}
      role="menu"
      style={{ left: contextMenu.x, top: contextMenu.y }}
    >
      <div className="context-commands">
        {scopeItems.length > 0 && (
          <>
            {scopeItems.map(item)}
            <div className="menu-sep" role="separator" />
          </>
        )}
        {(isElementMenu ? selectionItems : canvasItems).map(item)}
        {isElementMenu && wireItems.length > 0 && (
          <>
            <div className="menu-sep" role="separator" />
            {wireItems.map(item)}
          </>
        )}
      </div>
      {!isElementMenu && (
        <div className="context-palette">
          <input
            ref={searchRef}
            type="text"
            className="tool-search"
            aria-label="Search tools"
            placeholder="Search tools…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="context-palette-list">
            {groups.map((group) => (
              <section key={group.category}>
                <h3>{group.category}</h3>
                {group.entries.map((t) => paletteItem(t, dark, settings))}
              </section>
            ))}
            {searching && groups.length === 0 && (
              <p className="hint">No tools match “{query.trim()}”</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
