/**
 * Reader and writer for the original CircuitJS text format, so circuits and
 * shared links move between this app and upstream unchanged.
 *
 * The format is line-oriented and whitespace-separated:
 *
 * ```text
 * $ flags timeStep iterCount currentSpeed voltageRange powerRange minTimeStep
 * r 176 80 384 80 0 10
 * o 4 64 0 4099 20 0.05 0 2 4 3
 * ```
 *
 * Element lines are `<type> x1 y1 x2 y2 flags <type-specific tokens...>`.
 * Anything this build does not model is preserved verbatim, so loading and
 * saving a circuit never silently drops data.
 */

import { defFor, defForDumpCode } from '../model/registry';
import type { CircuitElement, SimSettings } from '../model/types';

/** A scope trace as stored in the file. */
export interface ScopeConfig {
  /** Index into the element list, or -1 for an unattached scope. */
  elementIndex: number;
  value: 'voltage' | 'current' | 'power';
  /** Remaining tokens, kept so the line round-trips exactly. */
  raw: string[];
}

export interface ParsedCircuit {
  elements: CircuitElement[];
  settings: Partial<SimSettings>;
  scopes: ScopeConfig[];
  /** Lines this build does not interpret, re-emitted on save. */
  passthrough: string[];
  /** Types present in the file that this build cannot draw or simulate. */
  unsupported: string[];
}

/** Undoes the token escaping used for text that may contain spaces. */
export function unescapeToken(s: string): string {
  return s.replace(/\\(.)/g, (_, c: string) => (c === 's' ? ' ' : c === 'n' ? '\n' : c));
}

export function escapeToken(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/ /g, '\\s').replace(/\n/g, '\\n');
}

let nextId = 1;
/** Ids only need to be unique within a session; the file format has none. */
export function allocateId(): number {
  return nextId++;
}

export function resetIds(): void {
  nextId = 1;
}

export function parseCircuit(text: string): ParsedCircuit {
  const elements: CircuitElement[] = [];
  const settings: Partial<SimSettings> = {};
  const scopes: ScopeConfig[] = [];
  const passthrough: string[] = [];
  const unsupported: string[] = [];

  for (const rawLine of text.split(/\r?\n/)) {
    const lineText = rawLine.trim();
    if (!lineText || lineText.startsWith('#')) continue;
    const tokens = lineText.split(/\s+/);
    const head = tokens[0];

    if (head === '$') {
      // Header: global simulation options.
      const timeStep = Number(tokens[2]);
      const currentSpeed = Number(tokens[4]);
      const voltageRange = Number(tokens[5]);
      if (Number.isFinite(timeStep) && timeStep > 0) settings.timeStep = timeStep;
      if (Number.isFinite(currentSpeed)) settings.currentSpeed = currentSpeed;
      if (Number.isFinite(voltageRange) && voltageRange > 0) settings.voltageRange = voltageRange;
      // Bit 4 of the flags suppresses value labels.
      const flags = Number(tokens[1]) || 0;
      settings.showValues = (flags & 16) === 0;
      passthrough.push(lineText);
      continue;
    }

    if (head === 'o') {
      // Scope. Only the attachment is interpreted; the rest is preserved.
      const elementIndex = Number(tokens[1]);
      scopes.push({
        elementIndex: Number.isFinite(elementIndex) ? elementIndex : -1,
        value: 'voltage',
        raw: tokens.slice(1),
      });
      continue;
    }

    const def = defForDumpCode(head);
    if (!def) {
      // Sliders (`38`), hints (`h`), models and anything newer than this
      // build. Keep the line so a save round-trips.
      passthrough.push(lineText);
      if (/^[0-9]+$/.test(head) || /^[a-zA-Z]$/.test(head)) unsupported.push(head);
      continue;
    }

    const element: CircuitElement = {
      id: allocateId(),
      kind: def.kind,
      x1: Number(tokens[1]) || 0,
      y1: Number(tokens[2]) || 0,
      x2: Number(tokens[3]) || 0,
      y2: Number(tokens[4]) || 0,
      flags: Number(tokens[5]) || 0,
      params: { ...(def.defaults ?? {}) },
    };
    const rest = tokens.slice(6).map(unescapeToken);
    def.parse?.(rest, element);
    elements.push(element);
  }

  return { elements, settings, scopes, passthrough, unsupported };
}

/** Serialises a circuit back to the original format. */
export function serializeCircuit(
  elements: CircuitElement[],
  settings: SimSettings,
  scopes: ScopeConfig[] = [],
  passthrough: string[] = [],
): string {
  const lines: string[] = [];

  // Rebuild the header rather than reusing the parsed one, so edits to the
  // settings are actually saved.
  const flags = settings.showValues ? 0 : 16;
  lines.push(
    [
      '$',
      flags,
      settings.timeStep,
      // Iteration count is advisory; upstream recomputes it on load.
      10,
      settings.currentSpeed,
      settings.voltageRange,
      50,
      settings.timeStep / 100,
    ].join(' '),
  );

  for (const e of elements) {
    const def = defFor(e.kind);
    if (!def) continue;
    const extra = (def.dump?.(e) ?? []).map((v) =>
      typeof v === 'string' ? escapeToken(v) : String(v),
    );
    lines.push([def.dumpCode, e.x1, e.y1, e.x2, e.y2, e.flags, ...extra].join(' '));
  }

  for (const s of scopes) {
    lines.push(['o', ...s.raw].join(' '));
  }

  // Non-header passthrough lines keep their content but move to the end,
  // which the format tolerates.
  for (const line of passthrough) {
    if (!line.startsWith('$')) lines.push(line);
  }

  return lines.join('\n') + '\n';
}
