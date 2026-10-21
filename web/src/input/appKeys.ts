/** The window-level shortcut pipeline, extracted from App.tsx so the gate and
 *  the dispatcher are testable without a DOM. App keeps only the INPUT-focus
 *  early return and the preventDefault bookkeeping; everything between lives
 *  here against plain state objects. */

import type { AppState } from '../state/types';
import { execute } from '../commands/execute';
import type { CommandStore } from '../commands/types';
import {
  chordOf,
  hasChord,
  isPrintableKey,
  matchShortcut,
  type KeyEventLike,
  type ShortcutAction,
} from './shortcuts';
import { modalSurface } from './modalSurface';

/** The status line under Disable Editing, shared by every refused edit door. */
const EDITING_DISABLED = 'Editing disabled. Re-enable from the Options menu.';

/** The key actions that must act once per press, not at the key-repeat rate:
 *  a resting thumb on Space or an Alt mirror must not spin the part. */
const REPEAT_ONCE = new Set(['element.rotate', 'element.mirror', 'element.mirrorVertical']);

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
  /** The real store, so command shortcuts go through the same door the menus
   *  and the later MCP server use. `stateAfter` stays for the paths that read
   *  a value after a command changed it. */
  store: CommandStore;
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
  const action = dragMirrorAction(s, ev) ?? matchShortcut(ev, s.shortcuts);
  if (!action) return false;
  // A held rotate or mirror key acts once, not at the key-repeat rate: Space
  // is rotate now, and a resting thumb would otherwise spin the part. The
  // nudge, delete and zoom keys keep repeating by design.
  if (
    ev.repeat &&
    action.type === 'command' &&
    REPEAT_ONCE.has(action.command)
  ) {
    return true;
  }
  applyShortcut(s, action, host);
  return true;
}

/** Plain h and v while a move drag holds the selection: the mirror keys at
 *  their most useful, without Alt. Outside a drag v arms the DC voltage
 *  source, a placement no drag can start, so the letters are free exactly
 *  while dragging. A repeat still resolves here, so the caller can swallow
 *  it instead of letting it fall through to the voltage-source placement. */
function dragMirrorAction(s: AppState, ev: AppKeyEvent): ShortcutAction | null {
  if (s.elementGesture?.kind !== 'move') return null;
  if (ev.ctrlKey || ev.metaKey || ev.altKey || ev.shiftKey) return null;
  const key = ev.key.toLowerCase();
  if (key === 'h') return { type: 'command', command: 'element.mirror' };
  if (key === 'v') return { type: 'command', command: 'element.mirrorVertical' };
  return null;
}

/** One keyup: a momentary switch returns to rest when its shortcut key is let
 *  go (UIManager.java:1113-1131). Modifiers suppress the release the way they
 *  suppress the press upstream, so a modified key never releases one. The
 *  release deliberately outranks every gate, modal surface and focus guard
 *  alike: a hold that started on the canvas must end even if focus moved into
 *  a text field or a dialog opened before the key came up, or the switch
 *  sticks closed until some lucky later press. */
export function handleAppKeyUp(s: AppState, ev: KeyEventLike): boolean {
  if (ev.ctrlKey || ev.metaKey || ev.altKey) return false;
  if (!isPrintableKey(ev.key)) return false;
  return s.releaseMomentaryByKey(ev.key);
}

/** The command table behind matchShortcut: command ids go through execute,
 *  host-only effects through the interface the app injects. */
export function applyShortcut(s: AppState, action: ShortcutAction, host: AppKeyHost): void {
  if (action.type === 'command') {
    const result = execute(action.command, action.args, {
      store: host.store,
      source: 'user',
    });
    // A refused command still consumes the key: the status explains why
    // nothing happened, exactly as the old editing gate did
    // (CommandManager.java:22-24), and Space/arrows stop scrolling the page.
    if (!result.ok) s.setStatus(result.message);
    return;
  }
  switch (action.type) {
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
      // Placement is an edit mode, so Disable Editing drops it with the same
      // status line every refused command uses.
      if (!s.settings.editable) {
        s.setStatus(EDITING_DISABLED);
        break;
      }
      s.setTool(action.kind);
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
