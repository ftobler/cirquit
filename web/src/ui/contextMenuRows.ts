/** Pure row-definition helpers for the context menu, split out so the menu
 *  composition stays node-testable (AGENTS.md: nothing testable belongs inside
 *  a React component). The .tsx owns the rendering and the store wiring; this
 *  module owns what the rows mean. */

import { CATEGORIES, type ToolboxEntry } from '../model/registry';
import { filterTools } from '../model/search';
import { adjustableFields } from '../model/sliders';

export interface PaletteGroup {
  category: string;
  entries: ToolboxEntry[];
}

/** The element palette for the empty-canvas menu: the toolbox entries grouped
 *  by category in toolbox order, with empty categories dropped, exactly the
 *  grouping the toolbox sidebar shows. A blank query returns the whole palette,
 *  so the context menu opens showing every part (filterTools, search.ts). */
export function paletteGroups(query: string): PaletteGroup[] {
  const tools = filterTools(query);
  return CATEGORIES.map((category) => ({
    category,
    entries: tools.filter((t) => t.category === category),
  })).filter((g) => g.entries.length > 0);
}

/** True when the context-menu target element can be split manually: only a
 *  wire, plain or routed, matching upstream's `instanceof WireElm` check for
 *  the Split Wire Manually row (MouseManager.java:956). */
export function canSplitWire(kind: string | undefined): boolean {
  return kind === 'wire';
}

/** True when the element context menu's Sliders row is worth enabling: the
 *  element has an adjustable field to bind, and is not one of the kinds with
 *  its own built-in slider (VarRailElm/PotElm, MouseManager.java:994-1007).
 *  Without this the row would open an empty create/remove dialog. */
export function canCreateSlider(kind: string | undefined): boolean {
  if (kind === undefined) return false;
  if (kind === 'varRail' || kind === 'potentiometer') return false;
  return adjustableFields(kind).length > 0;
}
