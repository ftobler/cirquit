/** The command table: the one enumerable list of document mutations. The
 *  order is the order a tool listing shows; ids are the stable public names. */

import type { CommandDef } from './types';
import { circuitCommands } from './circuit';
import { editCommands } from './edit';
import { historyCommands } from './history';
import { scopeCommands } from './scope';
import { selectionCommands } from './selection';

export const COMMANDS: readonly CommandDef[] = [
  ...editCommands,
  ...selectionCommands,
  ...scopeCommands,
  ...circuitCommands,
  ...historyCommands,
];

const byId = new Map(COMMANDS.map((def) => [def.id, def]));

export function commandById(id: string): CommandDef | undefined {
  return byId.get(id);
}

/** Store actions deliberately outside the command table. Every one is
 *  presentation, a transient dialog/gesture helper, or a host-bound effect;
 *  the registry test fails when a store action is in neither this list nor
 *  reachable from a command. */
export const NON_COMMAND_STORE_ACTIONS: Readonly<Record<string, string>> = {
  floatScope: 'Floating a scope is panel presentation, not a document edit.',
  dockScope: 'Docking a scope is panel presentation, not a document edit.',
  setFloatRect: 'Moving a floating panel is presentation.',
  raiseFloatingScope: 'Panel stacking is presentation.',
  openUndockedScope: 'Opens a browser popup and creates a display-only scope; host-bound.',
  closeUndockedScope: 'Closes the undocked popup window.',
  setTool: 'Arming a placement tool is UI mode, not a document edit.',
  turnTool: 'Turns the placement ghost before it exists in the document.',
  setView: 'Canvas panning and wheel zoom are gestures, not commands.',
  setViewSize: 'Maintained by the canvas ResizeObserver.',
  setStatus: 'Status-line presentation.',
  setProblem: 'Banner presentation; commands write it through their own result.',
  setNotice: 'Notice presentation; commands write it through their own result.',
  setDark: 'Theme presentation.',
  openDialog: 'Opening a dialog is presentation.',
  closeDialog: 'Closing a dialog is presentation.',
  setMenubarOpen: 'Menu keyboard grab is presentation.',
  setHovered: 'Hover highlight is presentation.',
  setHighlightedNode: 'Net highlight is presentation.',
  resetSettings: 'Other Options Reset button; it delegates to updateSettings.',
  placeWireEnd: 'Wire gesture helper inside the addWires transaction.',
  autoSplitAt: 'Connect-on-drop gesture helper inside the open transaction.',
  requestCenter: 'Asks the canvas to re-fit after a layout change.',
  requestEdit: 'Opens the element properties dialog.',
  closeElementProperties: 'Closes the element properties dialog.',
  openDeviceModelEditor: 'Opens the model editor dialog.',
  closeDeviceModelEditor: 'Closes the model editor dialog.',
  applyDeviceModelEdit: 'Dialog model edit; its context (create/edit/rename) is not a command yet.',
  setPartsOpen: 'Toolbox drawer presentation.',
  setPanelOpen: 'Options drawer presentation.',
  saveSubcircuitDraft: 'The naming dialog stores the pending draft, not the circuit.',
  cancelSubcircuitDraft: 'The naming dialog drops the pending draft.',
  setSliderElement: 'Scopes the Sliders dialog to one element.',
  setShortcuts: 'App preference, never part of the circuit snapshot.',
  setLiveStateProvider: 'Host wiring for live-state readback.',
  markSaved: 'Marks the export baseline clean; the file IO is host-bound.',
  beginTransaction: 'Gesture undo boundary helper.',
  endTransaction: 'Gesture undo boundary helper.',
  beginElementGesture: 'Raises the canvas gesture flag inside an open transaction.',
  endElementGesture: 'Lowers the canvas gesture flag and closes its transaction.',
  beginEdit: 'Focused-field undo checkpoint helper.',
  openScrollValuePopover: 'Wheel value popover presentation.',
  stepScrollValuePopover: 'Wheel value popover presentation.',
  closeScrollValuePopover: 'Wheel value popover presentation.',
  revertScrollValuePopover: 'Wheel value popover presentation.',
  openContextMenu: 'Context menu presentation, including its selection rule.',
  closeContextMenu: 'Context menu presentation.',
  openScopeMenu: 'Scope menu presentation.',
  closeScopeMenu: 'Scope menu presentation.',
  openScopeProperties: 'Scope properties dialog presentation.',
  closeScopeProperties: 'Scope properties dialog presentation.',
  toggleSwitchByKey: 'Keyboard run-control path; the explicit toggleSwitch action is a command.',
  releaseMomentaryByKey: 'Keyboard release path for held momentary switches.',
  releaseHeldMomentaries: 'Window-blur safety net for held momentary switches.',
  revertToBaseline: 'Zero-length gesture guard; owned by the canvas pointer path.',
  clearPending: 'Frame-loop queue drain, not an edit.',
};

/** Pure reads that happen to be methods on the store. The registry test skips
 *  them: they cannot land in a Snapshot. */
export const READ_ONLY_STORE_ACTIONS: ReadonlySet<string> = new Set([
  'toNetlist',
  'saveNetlist',
  'recoveryNetlist',
]);
