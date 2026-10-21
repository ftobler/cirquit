/** The registry is the public API, so its shape is a test: stable ids, valid
 *  schemas, one editing gate, and no mutating store action outside the table
 *  or the documented allow-list. */

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { useStore } from '../state/store';
import { fresh } from '../state/store.test-helpers';
import { commandById, COMMANDS, NON_COMMAND_STORE_ACTIONS, READ_ONLY_STORE_ACTIONS } from './registry';
import { commandState } from './execute';
import { validateSchema } from './schema';
import type { ArgSchema } from './types';

const COMMANDS_DIR = fileURLToPath(new URL('.', import.meta.url));
const TYPES_FILE = fileURLToPath(new URL('../state/types.ts', import.meta.url));

const EDITING_DISABLED = 'Editing disabled. Re-enable from the Options menu.';

beforeEach(() => {
  useStore.setState(fresh());
});

/** A minimal value that satisfies a schema, for gating checks. */
function sample(schema: ArgSchema): unknown {
  if ('anyOf' in schema) return sample(schema.anyOf[0]);
  switch (schema.type) {
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const key of schema.required ?? []) out[key] = sample(schema.properties[key]);
      return out;
    }
    case 'array':
      return Array.from({ length: schema.minItems ?? 0 }, () => sample(schema.items));
    case 'number':
    case 'integer':
      return schema.minimum ?? 1;
    case 'string':
      return schema.enum?.[0] ?? 'x';
    case 'boolean':
      return false;
    case 'null':
      return null;
  }
}

describe('command table', () => {
  it('has unique dotted lowercase ids that survive the MCP name transform', () => {
    const seen = new Set<string>();
    for (const def of COMMANDS) {
      // Camel case is kept inside a segment (mirrorVertical, setState), because
      // those ids are already the published spellings; every segment starts
      // lowercase and the segments are dotted.
      expect(def.id).toMatch(/^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/);
      expect(seen.has(def.id)).toBe(false);
      seen.add(def.id);
      const mcpName = def.id.replace(/[^a-zA-Z0-9_-]/g, '_');
      expect(mcpName.length).toBeGreaterThan(0);
      expect(mcpName.length).toBeLessThanOrEqual(64);
      expect(mcpName).toMatch(/^[a-zA-Z0-9_-]+$/);
      expect(commandById(def.id)).toBe(def);
    }
  });

  it('gives every command a non-empty description and a valid schema', () => {
    for (const def of COMMANDS) {
      expect(def.description.trim().length).toBeGreaterThan(20);
      expect(validateSchema(def.args)).toEqual([]);
    }
  });

  it('has exactly one definition per inventory topic', () => {
    const ids = new Set(COMMANDS.map((d) => d.id));
    for (const required of [
      'element.add',
      'element.update',
      'element.resetDefaults',
      'element.delete',
      'element.move',
      'element.movePost',
      'element.rotate',
      'element.mirror',
      'element.mirrorVertical',
      'element.swapTerminals',
      'element.setState',
      'element.setModel',
      'wire.add',
      'wire.split',
      'wire.convertToRouted',
      'clipboard.copy',
      'clipboard.cut',
      'clipboard.paste',
      'clipboard.duplicate',
      'selection.set',
      'selection.all',
      'selection.clear',
      'scope.add',
      'scope.remove',
      'scope.reset',
      'scope.combine',
      'scope.separate',
      'scope.stack',
      'scope.unstack',
      'scope.setSpeed',
      'scope.setTrigger',
      'scope.setFlags',
      'slider.add',
      'slider.remove',
      'slider.set',
      'circuit.new',
      'circuit.loadText',
      'circuit.createTest',
      'subcircuit.create',
      'subcircuit.enter',
      'subcircuit.exit',
      'sim.run',
      'sim.pause',
      'sim.step',
      'sim.reset',
      'sim.dcOperatingPoint',
      'settings.update',
      'view.zoomIn',
      'view.zoomOut',
      'view.reset',
      'view.center',
      'history.undo',
      'history.redo',
      'history.batch',
    ]) {
      expect(ids.has(required), `${required} is missing`).toBe(true);
    }
  });

  it('marks the two document replacements destructive', () => {
    expect(commandById('circuit.new')?.destructive).toBe(true);
    expect(commandById('circuit.loadText')?.destructive).toBe(true);
  });

  it('refuses every edits:true command when editing is disabled', () => {
    useStore.getState().updateSettings({ editable: false });
    const state = useStore.getState();
    for (const def of COMMANDS) {
      const gate = commandState(def.id, sample(def.args), state);
      if (def.edits) {
        expect(gate, def.id).toEqual({ enabled: false, reason: EDITING_DISABLED });
      } else if (!gate.enabled) {
        expect(gate.reason, def.id).not.toBe(EDITING_DISABLED);
      }
    }
  });
});

/** The actions declared on AppState, parsed rather than imported so a newly
 *  added action cannot hide behind a missing type import. */
function storeActions(): string[] {
  const source = readFileSync(TYPES_FILE, 'utf8');
  const body = source.slice(source.indexOf('export interface AppState'));
  return [...body.matchAll(/^ {2}([a-zA-Z][a-zA-Z0-9]*)\(/gm)].map((m) => m[1]);
}

function commandSources(): string {
  return readdirSync(COMMANDS_DIR)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .filter((name) => name !== 'registry.ts')
    .map((name) => readFileSync(`${COMMANDS_DIR}${name}`, 'utf8'))
    .join('\n');
}

describe('store coverage', () => {
  it('every store action is reachable from a command or documented as not one', () => {
    const sources = commandSources();
    const actions = storeActions();
    const missing = actions.filter((name) => {
      if (READ_ONLY_STORE_ACTIONS.has(name)) return false;
      if (name in NON_COMMAND_STORE_ACTIONS) return false;
      return !new RegExp(`\\b${name}\\b`).test(sources);
    });
    expect(missing).toEqual([]);
  });

  it('keeps the allow-list honest: every entry names a real store action', () => {
    const actions = new Set(storeActions());
    const stale = [...Object.keys(NON_COMMAND_STORE_ACTIONS), ...READ_ONLY_STORE_ACTIONS].filter(
      (name) => !actions.has(name),
    );
    expect(stale).toEqual([]);
  });

  it('does not leave a Snapshot-writing action only in the allow-list without a reason', () => {
    for (const [name, reason] of Object.entries(NON_COMMAND_STORE_ACTIONS)) {
      expect(reason.trim().length, name).toBeGreaterThan(10);
    }
  });
});
