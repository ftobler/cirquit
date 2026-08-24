/** Which surface currently owns the keyboard. While any of these is up the
 *  global shortcut handler must stand down entirely: upstream's key handler
 *  short-circuits when dialogIsShowing() is true, and upstream counts every
 *  dialog there, the diode-model editor and the right-click context panel
 *  included (UIManager.java:996-1012, handler short-circuit :1057-1077).
 *  Without the same rule a modal that lives in its own store field lets
 *  Backspace or Ctrl+Z act on the circuit behind it, and one Escape both
 *  closes an open menu and acts on whatever sits underneath it. */

import type { AppState } from '../state/types';

/** The slice of AppState the gate reads, spelled out so tests can build it by
 *  hand without constructing a whole store. */
export type ModalSurfaces = Pick<
  AppState,
  'dialog' | 'scopeProperties' | 'elementProperties' | 'deviceModelEditor' | 'contextMenu'
>;

/** True while a modal surface owns the keyboard and no app shortcut may run.
 *  An open context menu blocks like a dialog; Escape still reaches the menu
 *  itself through its own listener, which is what makes the close exclusive. */
export function modalSurface(s: ModalSurfaces): boolean {
  return (
    s.dialog !== null ||
    s.scopeProperties !== null ||
    s.elementProperties !== null ||
    s.deviceModelEditor !== null ||
    s.contextMenu !== null
  );
}

// Deliberately not gated: scopeMenu stays ungated like upstream's Swing scope
// popup, and the wheel scroll-value popover is a known pending surface.
