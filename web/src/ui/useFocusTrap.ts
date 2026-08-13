/** Focus management for a modal panel: pulls focus in on mount without
 *  stealing it from a child's `autoFocus`, traps Tab inside while open, and
 *  restores focus to the element that opened the panel on cleanup. Returns a
 *  ref to hand to the panel div. The numeric wrap lives in `focusTrap.ts`,
 *  where it is node-tested; this hook is the thin DOM wiring and is untested
 *  by construction (the repo has no jsdom and `.tsx`-adjacent hooks are
 *  deliberately not under test). */

import { useEffect, useRef, useState, type RefObject } from 'react';
import { nextFocusIndex, type Focusable } from './focusTrap';

const FOCUSABLE_SELECTOR =
  'button, textarea, input, select, [tabindex]:not([tabindex="-1"])';

export function useFocusTrap<T extends HTMLElement>(opts: {
  returnFocus?: boolean;
}): RefObject<T | null> {
  const { returnFocus = true } = opts;
  const ref = useRef<T>(null);
  // Whoever had focus on the render that mounted the panel is the opener to
  // hand focus back to on close. It has to be captured here, in the render
  // body, not in the effect below: React applies a child's `autoFocus` in the
  // layout phase, which runs before effects, so by effect time the active
  // element is already the autofocused child inside the panel. The initializer
  // runs on the first render, before the commit phase has inserted anything.
  const [restoreTo] = useState<HTMLElement | null>(() =>
    returnFocus ? (document.activeElement as HTMLElement | null) : null,
  );

  useEffect(() => {
    const panel = ref.current;
    if (!panel) return;

    // This effect runs after children mount, so a child's `autoFocus` has
    // already run and the active element is inside the panel; only a dialog
    // without one needs the panel itself focused. That ordering is the
    // contract the documented "child autoFocus wins" behaviour relies on, and
    // it must not be reordered.
    if (!panel.contains(document.activeElement)) panel.focus();

    const onKeyDown = (ev: KeyboardEvent) => {
      if (ev.key !== 'Tab') return;
      const focusables = Array.from(
        panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      ).filter((el) => !el.hasAttribute('disabled'));
      const index = nextFocusIndex(
        focusables,
        document.activeElement as Focusable | null,
        ev.shiftKey,
      );
      if (index === null) return;
      ev.preventDefault();
      focusables[index].focus();
    };
    panel.addEventListener('keydown', onKeyDown);

    return () => {
      panel.removeEventListener('keydown', onKeyDown);
      // The opener may be gone: a store action can fire while the dialog is
      // open (the Subcircuit Manager mutates the model library and the menu
      // re-renders), so restore only when the element is still connected.
      if (returnFocus && restoreTo && restoreTo.isConnected) restoreTo.focus();
    };
  }, [returnFocus, restoreTo]);

  return ref;
}
