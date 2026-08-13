/** Keyboard navigation for a flat dropdown menu, the menubar's File/Edit/
 *  Scopes/Options/Tools/Help popups. One hook per `.dropdown` container: on
 *  the trigger, ArrowDown/ArrowUp open the menu onto the first/last enabled
 *  row; inside the menu, the arrow keys and Home/End move the cursor with wrap
 *  and disabled-row skipping, Escape closes and refocuses the trigger, and Tab
 *  closes so focus never lands in a stale open menu. The numeric movement
 *  lives in `menuNavigation.ts`, which is node-tested; this hook is the thin
 *  DOM wiring and is untested by construction. */

import { useEffect, useRef, type RefObject } from 'react';
import { stepMenuCursor } from './menuNavigation';

interface UseMenuKeyboardArgs {
  /** False for the Circuits dropdown, which has no menu semantics. */
  enabled?: boolean;
  open: boolean;
  /** Force-open the menu (an open menu must not be toggled shut). */
  onOpen: () => void;
  onClose: () => void;
  containerRef: RefObject<HTMLElement | null>;
  /** Which end the opening key asked to land on; consumed when `open` next
   *  becomes true, after the menu has rendered. */
  focusOnOpen: 'first' | 'last' | null;
  setFocusOnOpen: (dir: 'first' | 'last' | null) => void;
}

export function useMenuKeyboard({
  enabled = true,
  open,
  onOpen,
  onClose,
  containerRef,
  focusOnOpen,
  setFocusOnOpen,
}: UseMenuKeyboardArgs): void {
  // The callbacks are recreated per render by the parent; read the latest via
  // refs so this effect only depends on the pieces that matter.
  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const container = containerRef.current;
    if (!enabled || !container) return;

    // An opening key on the trigger asked to land on a specific end; the menu
    // has been rendered by now, so focus it. Runs once per open because the
    // state flips back to null right after.
    if (open && focusOnOpen) {
      const items = Array.from(
        container.querySelectorAll<HTMLElement>('.dropdown-menu .menu-item:not([disabled])'),
      );
      const target = focusOnOpen === 'first' ? items[0] : items[items.length - 1];
      if (target) target.focus();
      setFocusOnOpen(null);
    }

    // The listener stays attached while the menu is closed so the trigger can
    // open it with the arrow keys; `menu` is null then and every key falls
    // through to the trigger branch below.
    const menu = container.querySelector<HTMLElement>('.dropdown-menu');
    const trigger = container.querySelector<HTMLElement>('button');
    const items = () =>
      Array.from(menu?.querySelectorAll<HTMLElement>('.menu-item:not([disabled])') ?? []);
    // The rows mirror items() 1:1, so a returned index indexes either array.
    const rows = () => items().map((el) => ({ disabled: el.hasAttribute('disabled') }));

    const onKeyDown = (ev: KeyboardEvent) => {
      const insideMenu = menu !== null && menu.contains(ev.target as Node);
      if (insideMenu) {
        if (ev.key === 'Escape') {
          // The Dropdown window Escape listener would close the menu anyway;
          // here it also returns focus to the trigger. Stop the propagation so
          // exactly one closer runs.
          ev.stopPropagation();
          onCloseRef.current();
          trigger?.focus();
          return;
        }
        if (ev.key === 'Tab') {
          // Tab leaves the menu: close it so focus does not sit in a menu that
          // is still open but unfocused, and let the default Tab move on.
          onCloseRef.current();
          return;
        }
        const isMenuKey =
          ev.key === 'ArrowDown' ||
          ev.key === 'ArrowUp' ||
          ev.key === 'Home' ||
          ev.key === 'End';
        if (isMenuKey) {
          const active = document.activeElement;
          const cursor = active === null ? null : items().indexOf(active as HTMLElement);
          const next = stepMenuCursor(
            rows(),
            cursor,
            ev.key as 'ArrowDown' | 'ArrowUp' | 'Home' | 'End',
          );
          if (next !== null) {
            ev.preventDefault();
            // Without this the app-level window handler (shortcuts.ts) would
            // nudge the selection on every menu key press.
            ev.stopPropagation();
            items()[next].focus();
          }
        }
        return;
      }
      // Focus on the trigger: an arrow opens the menu onto the matching end.
      if (ev.key === 'ArrowDown') {
        ev.preventDefault();
        ev.stopPropagation();
        setFocusOnOpen('first');
        onOpenRef.current();
      } else if (ev.key === 'ArrowUp') {
        ev.preventDefault();
        ev.stopPropagation();
        setFocusOnOpen('last');
        onOpenRef.current();
      }
    };
    container.addEventListener('keydown', onKeyDown);
    return () => container.removeEventListener('keydown', onKeyDown);
  }, [enabled, open, focusOnOpen, setFocusOnOpen, containerRef]);
}
