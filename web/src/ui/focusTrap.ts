/** Focus-trap navigation over a flat list of focusable stubs. No DOM, no
 *  React: the caller (`useFocusTrap`) builds the list from the panel, filters
 *  disabled elements out of it, and passes `{ focus() }` element-shaped
 *  objects, so this module stays node-testable like `gestures.ts`. */

/** The only shape the trap needs from an element. */
export interface Focusable {
  focus(): void;
}

/** What the trap's caller collects as focusable rows, in DOM order: form
 *  controls, any tabindex other than the explicit off-switch, and links.
 *  An anchor needs href to be in the tab order, and an explicit
 *  tabindex="-1" takes any element back out of it, so the anchor clause
 *  carries the same guard as the bare [tabindex] one beside it. Lives beside
 *  nextFocusIndex so the wrap rules and the row list they run over are
 *  node-tested together; useFocusTrap imports it rather than keeping its own
 *  copy that can drift. */
export const FOCUSABLE_SELECTOR =
  'button, textarea, input, select, [tabindex]:not([tabindex="-1"]), a[href]:not([tabindex="-1"])';

/** Where a Tab press should land, given the list of focusables and the
 *  currently focused element.
 *
 *  - empty list -> `null` (nothing to trap);
 *  - `active` outside the list -> `0` forward, `last` backward: the caller's
 *    focus escaped the panel (or is still on the panel itself), so the trap
 *    pulls it back in, which is also the "bring focus into the dialog" case;
 *  - last + forward -> `0`, first + backward -> `last` (wrap);
 *  - otherwise `index +/- 1`.
 *
 *  Disabled filtering is the caller's job, so this helper has no disabled
 *  logic to test. */
export function nextFocusIndex(
  list: readonly Focusable[],
  active: Focusable | null,
  shift: boolean,
): number | null {
  if (list.length === 0) return null;
  const i = active === null ? -1 : list.indexOf(active);
  if (i === -1) return shift ? list.length - 1 : 0;
  if (shift) return i === 0 ? list.length - 1 : i - 1;
  return i === list.length - 1 ? 0 : i + 1;
}
