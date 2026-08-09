/**
 * Right-click context menu. Over an element it offers element commands; over
 * empty canvas, circuit commands. Position, clamping and dismissal live here;
 * every command is a store action, so the menu, menubar and keyboard cannot
 * diverge.
 */

import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { parseCircuit } from '../io/netlist';
import { defFor } from '../model/registry';
import { canMirror, canRotate, canSwap } from '../model/transform';
import { useStore } from '../state/store';

interface MenuItem {
  label: string;
  shortcut?: string;
  disabled?: boolean;
  action: () => void;
}

export function ContextMenu() {
  const contextMenu = useStore((s) => s.contextMenu);
  const clipboard = useStore((s) => s.clipboard);
  const closeContextMenu = useStore((s) => s.closeContextMenu);
  const selectedIds = useStore((s) => s.selectedIds);
  const elements = useStore((s) => s.elements);
  const editable = useStore((s) => s.settings.editable);
  const ref = useRef<HTMLDivElement>(null);

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

  // Dismissal: a pointerdown anywhere outside the menu, Escape, and losing
  // focus or scrolling (a menu that scrolled away is worse than no menu).
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
    const onScroll = () => closeContextMenu();
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

  // The clipboard only ever holds text this app serialised, but guard anyway:
  // a manually-set garbage string must grey out Paste, not paste nothing.
  const canPaste = useMemo(
    () => clipboard !== null && parseCircuit(clipboard).elements.length > 0,
    [clipboard],
  );

  if (!contextMenu) return null;

  const { target } = contextMenu;
  const targetElement = target !== null ? elements.find((e) => e.id === target) : undefined;
  const targetDef = targetElement ? defFor(targetElement.kind) : undefined;
  const hasSelection = selectedIds.length > 0;
  const selected = elements.filter((e) => selectedIds.includes(e.id));
  // A command is enabled only when every selected element can do it, matching
  // the store actions, which refuse a mixed or unsupported selection.
  const canRotateSelection = selected.length > 0 && selected.every(canRotate);
  const canMirrorSelection = selected.length > 0 && selected.every(canMirror);
  const canSwapSelection = selected.length > 0 && selected.every(canSwap);

  const run = (action: () => void) => {
    closeContextMenu();
    action();
  };

  const item = (m: MenuItem) => (
    <button
      key={m.label}
      type="button"
      className="menu-item"
      disabled={m.disabled}
      onClick={() => run(m.action)}
    >
      <span>{m.label}</span>
      {m.shortcut && <span className="menu-shortcut">{m.shortcut}</span>}
    </button>
  );

  const isElementMenu = target !== null;
  const scopeItems: MenuItem[] = [];
  if (isElementMenu && targetDef) {
    scopeItems.push({
      label: 'Edit',
      disabled: !editable || !targetDef.fields?.length,
      // One implementation of "edit this element" shared with the canvas
      // double-click and touch double-tap: select, open the options panel,
      // focus its first field.
      action: () => useStore.getState().requestEdit(target),
    });
    scopeItems.push({
      label: 'View in New Scope',
      disabled: !editable,
      action: () => useStore.getState().addScope(target, 'voltage'),
    });
    scopeItems.push({
      label: 'Add Current Scope',
      disabled: !editable,
      action: () => useStore.getState().addScope(target, 'current'),
    });
  }

  const selectionItems: MenuItem[] = [
    {
      label: 'Cut',
      shortcut: 'Ctrl+X',
      disabled: !editable || !hasSelection,
      action: () => useStore.getState().cutSelection(),
    },
    {
      label: 'Copy',
      shortcut: 'Ctrl+C',
      disabled: !editable || !hasSelection,
      action: () => useStore.getState().copySelection(),
    },
    {
      label: 'Paste',
      shortcut: 'Ctrl+V',
      disabled: !editable || !canPaste,
      action: () => useStore.getState().pasteFromClipboard(),
    },
    {
      label: 'Duplicate',
      shortcut: 'Ctrl+D',
      disabled: !editable || !hasSelection,
      action: () => useStore.getState().duplicateSelection(),
    },
    {
      label: 'Delete',
      shortcut: 'Delete',
      disabled: !editable || !hasSelection,
      action: () => useStore.getState().deleteSelected(),
    },
    {
      label: 'Swap Terminals',
      shortcut: 'Alt+T',
      disabled: !editable || !canSwapSelection,
      action: () => useStore.getState().swapTerminals(),
    },
    {
      label: 'Rotate',
      shortcut: 'Alt+R',
      disabled: !editable || !canRotateSelection,
      action: () => useStore.getState().rotateSelection(),
    },
    {
      label: 'Mirror',
      shortcut: 'Alt+M',
      disabled: !editable || !canMirrorSelection,
      action: () => useStore.getState().mirrorSelection(),
    },
  ];

  const canvasItems: MenuItem[] = [
    {
      label: 'Paste',
      shortcut: 'Ctrl+V',
      disabled: !editable || !canPaste,
      action: () => useStore.getState().pasteFromClipboard(),
    },
    {
      label: 'Select All',
      disabled: !editable,
      action: () => useStore.getState().selectAll(),
    },
    {
      label: 'New',
      action: () => useStore.getState().newCircuit(),
    },
    {
      label: 'Undo',
      shortcut: 'Ctrl+Z',
      disabled: !editable,
      action: () => useStore.getState().undo(),
    },
    {
      label: 'Redo',
      shortcut: 'Ctrl+Shift+Z',
      disabled: !editable,
      action: () => useStore.getState().redo(),
    },
  ];

  return (
    <div
      ref={ref}
      className="dropdown-menu context-menu"
      style={{ left: contextMenu.x, top: contextMenu.y }}
    >
      {scopeItems.length > 0 && (
        <>
          {scopeItems.map(item)}
          <div className="menu-sep" />
        </>
      )}
      {(isElementMenu ? selectionItems : canvasItems).map(item)}
    </div>
  );
}
