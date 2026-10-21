/** Circuit-level commands: document replacement, run control, settings and
 *  the view. The destructive document commands still wipe the undo history
 *  exactly as the File menu does; the `destructive` flag is what a later live
 *  bridge uses to ask first. */

import { chipPinsOf } from '../model/registry/chips';
import { selectHarnessChip } from '../model/testHarness';
import type { SimSettings } from '../model/types';
import { CommandFailure, type CommandDef } from './types';

/** Keys carried in the netlist `$` header. A settings write touching one is a
 *  document edit and lands as one undo step; a pure app preference (a colour,
 *  a digit count) stays outside the stacks, matching the store's own rule. */
const HEADER_KEYS = new Set<keyof SimSettings>([
  'timeStep',
  'stepsPerFrame',
  'voltageRange',
  'powerRange',
  'currentSpeed',
  'minTimeStep',
  'iterCount',
  'adaptiveTimeStep',
  'autoDC',
  'showCurrent',
  'showValues',
  'showVoltageColor',
  'showPowerColor',
  'showGrid',
  'conventional',
]);

const numberSetting = (description: string, extra: Record<string, unknown> = {}) => ({
  type: 'number' as const,
  description,
  ...extra,
});
const boolSetting = (description: string) => ({ type: 'boolean' as const, description });
const colourSetting = {
  anyOf: [{ type: 'string' as const }, { type: 'null' as const }],
  description: 'CSS colour, or null for the theme default.',
};

const settingsSchema = {
  type: 'object' as const,
  properties: {
    timeStep: numberSetting('Seconds per solver timestep.', { minimum: 0 }),
    stepsPerFrame: numberSetting('Timesteps attempted per animation frame.', { minimum: 1 }),
    voltageRange: numberSetting('Full-scale voltage for colouring.'),
    powerRange: numberSetting('Power colour ramp.'),
    currentSpeed: numberSetting('Current-dot animation speed.'),
    minTimeStep: numberSetting('Adaptive timestep floor, seconds.', { minimum: 0 }),
    iterCount: numberSetting('Header iteration token.'),
    adaptiveTimeStep: boolSetting('Adapt the timestep under hard steps.'),
    autoDC: boolSetting('Run a DC operating point before the first step and on reset.'),
    showCurrent: boolSetting('Animate current dots.'),
    showValues: boolSetting('Draw element values.'),
    showVoltageColor: boolSetting('Colour bodies by voltage.'),
    showPowerColor: boolSetting('Colour bodies by dissipated power.'),
    showGrid: boolSetting('Draw the grid.'),
    conventional: boolSetting('Conventional current direction.'),
    euroResistors: boolSetting('IEC resistor symbol.'),
    euroGates: boolSetting('IEC gate symbols.'),
    editable: boolSetting('Allow circuit edits.'),
    mouseWheelEdit: boolSetting('Step values with the mouse wheel.'),
    showCrosshair: boolSetting('Draw grid-snapped crosshair guides.'),
    showHitboxes: boolSetting('Draw pointer hit-test regions.'),
    positiveColor: colourSetting,
    negativeColor: colourSetting,
    neutralColor: colourSetting,
    selectionColor: colourSetting,
    currentColor: colourSetting,
    valueFontSize: numberSetting('Element value label size, px.', { minimum: 1 }),
    shortDecimalDigits: numberSetting('Fraction digits on element values.', { minimum: 0 }),
    decimalDigits: numberSetting('Fraction digits in readouts.', { minimum: 0 }),
    wheelSensitivity: numberSetting('Wheel zoom steps per notch.', { minimum: 0 }),
  },
  additionalProperties: false as const,
  description: 'Settings to merge. Header-borne keys are undoable; app preferences are not.',
};

/** Where a DC operating point outcome lands: the transient notice for success
 *  and the "converged on nothing" case, the sticky problem banner for the
 *  engine's own refusal. Pure, so the wording is node-testable. */
export function dcOutcomeReport(result: string | null): {
  notice: string | null;
  problem: string | null;
} {
  if (result === null) {
    return { notice: 'Found the DC operating point', problem: null };
  }
  if (result === 'degraded') {
    return {
      notice: 'No DC operating point exists; the circuit restarted uncharged',
      problem: null,
    };
  }
  return { notice: null, problem: result };
}

export const circuitCommands: CommandDef[] = [
  {
    id: 'circuit.new',
    label: 'New Blank Circuit',
    description: 'Replaces the document with an empty circuit and resets the header settings.',
    args: { type: 'object', properties: {}, additionalProperties: false },
    history: 'none',
    edits: false,
    destructive: true,
    run: (ctx) => ctx.store.getState().newCircuit(),
  },
  {
    id: 'circuit.loadText',
    label: 'Load Circuit',
    description:
      'Replaces the document with a parsed netlist text. A malformed document ' +
      'fails and leaves the open circuit untouched. Wipes the undo history.',
    args: {
      type: 'object',
      properties: {
        text: { type: 'string', minLength: 1 },
        noCenter: { type: 'boolean' },
        noBaseline: { type: 'boolean' },
      },
      required: ['text'],
      additionalProperties: false,
    },
    history: 'none',
    edits: false,
    destructive: true,
    run: (ctx, a) => {
      const args = a as { text: string; noCenter?: boolean; noBaseline?: boolean };
      const failure = ctx.store.getState().loadNetlist(args.text, {
        noCenter: args.noCenter,
        noBaseline: args.noBaseline,
      });
      if (failure !== null) throw new CommandFailure('failed', failure);
      return null;
    },
  },
  {
    id: 'circuit.recoverAutoSave',
    label: 'Recover Auto-Save',
    description: 'Loads the stored auto-save recovery as one undo entry. No-op when none exists.',
    args: { type: 'object', properties: {}, additionalProperties: false },
    history: 'none',
    edits: false,
    run: (ctx) => ctx.store.getState().recoverAutoSave(),
  },
  {
    id: 'circuit.createTest',
    label: 'Create Test Harness',
    description:
      'Builds a logic input per input pin and a logic output per output pin around ' +
      'the selected chip, or the chip named by `id`.',
    args: {
      type: 'object',
      properties: { id: { type: 'integer' } },
      additionalProperties: false,
    },
    history: 'step',
    edits: true,
    enabled: (s, a) => {
      const id = (a as { id?: number }).id;
      if (id !== undefined) {
        const e = s.elements.find((x) => x.id === id);
        if (!e) return `No element with id ${id} exists.`;
        return chipPinsOf(e) !== null ? true : 'That element has no chip pin table.';
      }
      return selectHarnessChip(s.elements, s.selectedIds) !== null
        ? true
        : 'Select a single chip element first.';
    },
    run: (ctx, a) => {
      const s = ctx.store.getState();
      if (!s.createTest((a as { id?: number }).id)) {
        throw new CommandFailure('failed', 'Select a single chip element first.');
      }
      return true;
    },
  },
  {
    id: 'subcircuit.create',
    label: 'Create Subcircuit',
    description:
      'Builds a subcircuit model from the named elements, or the selection, and ' +
      'opens the naming dialog. Fails with the build reason when the selection ' +
      'cannot become a model.',
    args: {
      type: 'object',
      properties: {
        ids: { type: 'array', items: { type: 'integer' }, minItems: 1 },
      },
      additionalProperties: false,
    },
    history: 'none',
    edits: true,
    run: (ctx, a) => {
      const s = ctx.store.getState();
      if (!s.createSubcircuit((a as { ids?: number[] }).ids)) {
        throw new CommandFailure(
          'failed',
          ctx.store.getState().subcircuitError ?? 'Could not create the subcircuit.',
        );
      }
    },
  },
  {
    id: 'subcircuit.enter',
    label: 'Edit Subcircuit',
    description: "Opens a model's internals for editing. Fails with the reason when it cannot.",
    args: {
      type: 'object',
      properties: { name: { type: 'string', minLength: 1 } },
      required: ['name'],
      additionalProperties: false,
    },
    history: 'none',
    edits: true,
    run: (ctx, a) => {
      const name = (a as { name: string }).name;
      if (!ctx.store.getState().enterSubcircuit(name)) {
        throw new CommandFailure(
          'failed',
          ctx.store.getState().subcircuitError ?? `No subcircuit named "${name}" exists.`,
        );
      }
    },
  },
  {
    id: 'subcircuit.exit',
    label: 'Close Subcircuit',
    description: 'Leaves the innermost model editing session and returns to the enclosing circuit.',
    args: { type: 'object', properties: {}, additionalProperties: false },
    history: 'none',
    edits: false,
    run: (ctx) => {
      const s = ctx.store.getState();
      if (s.subcircuitStack.length === 0) return;
      s.exitSubcircuit();
      if (s.subcircuitError !== null) throw new CommandFailure('failed', s.subcircuitError);
    },
  },
  {
    id: 'subcircuit.rename',
    label: 'Rename Subcircuit',
    description: "Renames a model and rewrites the open document's matching `.` line, one undo step.",
    args: {
      type: 'object',
      properties: {
        oldName: { type: 'string', minLength: 1 },
        newName: { type: 'string', minLength: 1 },
      },
      required: ['oldName', 'newName'],
      additionalProperties: false,
    },
    history: 'step',
    edits: true,
    run: (ctx, a) => {
      const args = a as { oldName: string; newName: string };
      return ctx.store.getState().renameSubcircuit(args.oldName, args.newName);
    },
  },
  {
    id: 'sim.run',
    label: 'Run Simulation',
    description: 'Starts or resumes the transient simulation.',
    args: { type: 'object', properties: {}, additionalProperties: false },
    history: 'none',
    edits: false,
    run: (ctx) => ctx.store.getState().setRunning(true),
  },
  {
    id: 'sim.pause',
    label: 'Pause Simulation',
    description: 'Pauses the transient simulation, keeping all state.',
    args: { type: 'object', properties: {}, additionalProperties: false },
    history: 'none',
    edits: false,
    run: (ctx) => ctx.store.getState().setRunning(false),
  },
  {
    id: 'sim.toggle',
    label: 'Start/Stop Simulation',
    description: 'Toggles between running and paused.',
    args: { type: 'object', properties: {}, additionalProperties: false },
    history: 'none',
    edits: false,
    run: (ctx) => ctx.store.getState().toggleRunning(),
  },
  {
    id: 'sim.reset',
    label: 'Reset',
    description:
      'Rewinds runtime state in place: capacitor charge, inductor current, fuse ' +
      'heat and blown state, switch outputs. No undo entry.',
    args: { type: 'object', properties: {}, additionalProperties: false },
    history: 'none',
    edits: false,
    run: (ctx) => {
      ctx.sim?.reset();
      // The store half must run even when the engine is absent: it clears any
      // queued `blown true` that would otherwise re-apply a popped fuse.
      ctx.store.getState().unblowFuses();
    },
  },
  {
    id: 'sim.dcOperatingPoint',
    label: 'Find DC Operating Point',
    description:
      'Runs a one-shot DC solve and restarts the transient from the solved ' +
      'operating point. Reports found, degraded or the engine refusal.',
    args: { type: 'object', properties: {}, additionalProperties: false },
    history: 'none',
    edits: false,
    run: (ctx) => {
      if (!ctx.sim) throw new CommandFailure('failed', 'The simulation engine is not available.');
      const result = ctx.sim.dcOperatingPoint();
      if (result === undefined) {
        throw new CommandFailure('failed', 'The simulation engine is not available.');
      }
      const report = dcOutcomeReport(result);
      const s = ctx.store.getState();
      if (report.problem !== null) s.setProblem(report.problem);
      else if (report.notice !== null) s.setNotice(report.notice);
      s.unblowFuses();
      return result;
    },
  },
  {
    id: 'settings.update',
    label: 'Update Settings',
    description:
      'Merges the given SimSettings keys. Header-borne keys (timestep, ranges, ' +
      'display bits) are one undo step; app preferences stay outside the stacks.',
    args: settingsSchema,
    history: 'none',
    edits: false,
    enabled: (_s, a) => {
      const keys = Object.keys(a as Record<string, unknown>);
      return keys.length > 0 ? true : 'No settings were given.';
    },
    run: (ctx, raw) => {
      const patch = raw as Partial<SimSettings>;
      const s = ctx.store.getState();
      const header = Object.keys(patch).some((k) => HEADER_KEYS.has(k as keyof SimSettings));
      if (header) s.transact('Update Settings', () => s.updateSettings(patch));
      else s.updateSettings(patch);
      return patch;
    },
  },
  {
    id: 'view.zoomIn',
    label: 'Zoom In',
    description: 'Zooms in about the screen centre.',
    args: { type: 'object', properties: {}, additionalProperties: false },
    history: 'none',
    edits: false,
    run: (ctx) => ctx.store.getState().zoomIn(),
  },
  {
    id: 'view.zoomOut',
    label: 'Zoom Out',
    description: 'Zooms out about the screen centre.',
    args: { type: 'object', properties: {}, additionalProperties: false },
    history: 'none',
    edits: false,
    run: (ctx) => ctx.store.getState().zoomOut(),
  },
  {
    id: 'view.reset',
    label: 'Zoom 100%',
    description: 'Returns the view to exactly 100 percent.',
    args: { type: 'object', properties: {}, additionalProperties: false },
    history: 'none',
    edits: false,
    run: (ctx) => ctx.store.getState().zoomReset(),
  },
  {
    id: 'view.center',
    label: 'Center Circuit',
    description: 'Pans and zooms so the whole circuit fits the viewport, capped at 1.5.',
    args: { type: 'object', properties: {}, additionalProperties: false },
    history: 'none',
    edits: false,
    run: (ctx) => ctx.store.getState().centerCircuit(),
  },
];

export { HEADER_KEYS };
