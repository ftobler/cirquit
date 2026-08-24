/** The window-level shortcut pipeline, extracted from App.tsx so the gate and
 *  the dispatcher are testable without a DOM. App keeps only the INPUT-focus
 *  early return and the preventDefault bookkeeping; everything between lives
 *  here against plain state objects. */

import { GRID_SIZE } from '../model/types';
import type { AppState } from '../state/types';
import {
  chordOf,
  hasChord,
  isPrintableKey,
  matchShortcut,
  type KeyEventLike,
  type ShortcutAction,
} from './shortcuts';
import { modalSurface } from './modalSurface';

/** Shortcut actions that edit the circuit. Dropped whole when Disable Editing
 *  is on; everything else (zoom, file, view) stays live. */
const EDIT_ACTIONS = new Set<ShortcutAction['type']>([
  'undo',
  'redo',
  'delete',
  'nudge',
  'copy',
  'cut',
  'paste',
  'duplicate',
  'selectAll',
  'rotate',
  'mirror',
  'swap',
  'place',
]);

/** The side effects a shortcut can need that no store action provides, named
 *  once so tests can record calls instead of touching the browser. */
export interface AppKeyHost {
  /** File > Open's picker; needs a DOM file input. */
  openFile(): void;
  /** Ctrl+P's schematic print; needs the canvas and the engine handle. */
  print(): void;
  /** The refused drill-in exit's alert. */
  alert(message: string): void;
  /** '/' opening the palette menu centred in the window; reads viewport size. */
  openPalette(): void;
  /** Live store state re-read after an action may have replaced it: the
   *  refused-exit path looks for subcircuitError set by exitSubcircuit. */
  stateAfter(): AppState;
}

/** A keydown/keyup descriptor: the five fields matching reads plus the auto-
 *  repeat flag, which a real KeyboardEvent carries directly. */
export interface AppKeyEvent extends KeyEventLike {
  repeat?: boolean;
}

/** One keydown through the whole pipeline. Returns true when the event was
 *  consumed and the browser default must be suppressed; false covers both
 *  "no binding" and "a modal surface owns the keyboard". */
export function handleAppKeyDown(s: AppState, ev: AppKeyEvent, host: AppKeyHost): boolean {
  // While a modal surface is up it owns the keyboard: no shortcut may reach
  // the app, or Ctrl+V would paste into the circuit instead of the dialog's
  // textarea and Delete would edit the circuit behind the modal.
  if (modalSurface(s)) return false;
  // A plain printable key checks the switch keyShortcut map first: a switch
  // assigned this key beats every command binding, and a held key must not
  // re-toggle (UIManager.java:1248-1268). A switch is a run-mode control like
  // the pointer throw, so it stays live with editing disabled.
  if (!ev.repeat && !ev.ctrlKey && !ev.metaKey && !ev.altKey && isPrintableKey(ev.key)) {
    if (s.toggleSwitchByKey(ev.key)) return true;
  }
  // A held key must not re-fire a user-assigned shortcut
  // (UIManager.java:1181); the hardcoded nudge, delete and zoom keys still
  // repeat by design. True still suppresses the browser default, or a held
  // Space assigned to a command would scroll the page on every repeat.
  if (ev.repeat && hasChord(s.shortcuts, chordOf(ev))) return true;
  const action = matchShortcut(ev, s.shortcuts);
  if (!action) return false;
  // With editing disabled the edit keys are dropped, not ignored: the status
  // bar explains why nothing happened (CommandManager.java:22-24). View and
  // file commands (zoom, save, open) stay live, and an unmatched key keeps
  // its browser default, notably Ctrl+= and Ctrl+- page zoom.
  if (!s.settings.editable && EDIT_ACTIONS.has(action.type)) {
    s.setStatus('Editing disabled. Re-enable from the Options menu.');
    return false;
  }
  // A held rotate key turns once, not at the key-repeat rate: Space is rotate
  // now, and a resting thumb would otherwise spin the part. The nudge, delete
  // and zoom keys keep repeating by design.
  if (ev.repeat && action.type === 'rotate') return true;
  applyShortcut(s, action, host);
  return true;
}

/** One keyup: a momentary switch returns to rest when its shortcut key is let
 *  go (UIManager.java:1113-1131). Modifiers suppress the release the way they
 *  suppress the press upstream, so a modified key never releases one. */
export function handleAppKeyUp(s: AppState, ev: KeyEventLike): boolean {
  if (modalSurface(s)) return false;
  if (ev.ctrlKey || ev.metaKey || ev.altKey) return false;
  if (!isPrintableKey(ev.key)) return false;
  s.releaseMomentaryByKey(ev.key);
  return true;
}

/** The command table behind matchShortcut: one-line store calls except where
 *  a browser has to help, which arrives through the host. */
export function applyShortcut(s: AppState, action: ShortcutAction, host: AppKeyHost): void {
  switch (action.type) {
    case 'undo':
      s.undo();
      break;
    case 'redo':
      s.redo();
      break;
    case 'delete':
      s.deleteSelected();
      break;
    case 'escape':
      // Upstream's Escape returns to select mode and leaves the selection
      // alone (UIManager.java:1145-1151); do not deselect here. Inside a
      // subcircuit drill-in it closes the editing context instead, the
      // keyboard's File-close-context: the modal-surface guard already means
      // no dialog or menu owns this key. A refused exit stays inside and says
      // why.
      if (s.subcircuitStack.length > 0) {
        s.exitSubcircuit();
        const after = host.stateAfter();
        if (after.subcircuitError !== null) host.alert(after.subcircuitError);
      } else s.setTool(null);
      break;
    case 'selectMode':
      s.setTool(null);
      break;
    case 'place':
      // A placement char arms the element, the same setTool the toolbox
      // button and the palette menu use: upstream's MODE_ADD_ELM
      // (UIManager.java:1273-1284). The split semiconductors carry their
      // toolbox id here (pnp, pmos), so the N/P flavour arms exactly.
      s.setTool(action.kind);
      break;
    case 'nudge':
      // The matcher reports a unit-less step count; the grid size resolves
      // it here so a nudge moves one grid square, like upstream's
      // app.gridSize (UIManager.java:1153). The step is always 16: the
      // small-grid option is removed, so there is one spacing.
      s.nudgeSelection(action.dx * GRID_SIZE, action.dy * GRID_SIZE);
      break;
    case 'zoomIn':
      s.zoomIn();
      break;
    case 'zoomOut':
      s.zoomOut();
      break;
    case 'zoomReset':
      s.zoomReset();
      break;
    case 'save':
      // Ctrl+S and the File>Save row open the Save As dialog, one behavior
      // for both, so the name is editable and exporting counts as saved
      // when the dialog confirms.
      s.openDialog('saveAs');
      break;
    case 'open':
      host.openFile();
      break;
    case 'copy':
      s.copySelection();
      break;
    case 'cut':
      s.cutSelection();
      break;
    case 'paste':
      s.pasteFromClipboard();
      break;
    case 'duplicate':
      s.duplicateSelection();
      break;
    case 'selectAll':
      s.selectAll();
      break;
    case 'rotate':
      s.rotateSelection();
      break;
    case 'mirror':
      s.mirrorSelection();
      break;
    case 'swap':
      s.swapTerminals();
      break;
    case 'toggleRunning':
      // Only reachable through a user-assigned shortcut: run/pause has no
      // default key upstream (CommandManager.java:100-101).
      s.toggleRunning();
      break;
    case 'print':
      // Prints just the schematic image, white background, not the page
      // (CommandManager.java:73-74).
      host.print();
      break;
    case 'openPalette':
      // The port has no Find Component dialog; the right-click menu is
      // where the element search lives, so '/' opens that, under the
      // cursor when there is one and centred on the window when there is
      // not.
      host.openPalette();
      break;
  }
}
