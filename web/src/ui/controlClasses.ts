/** State-to-class mappers for the shared interactive surfaces. Pure functions
 *  so the active/selected class logic is node-testable; the components only
 *  pass their boolean state through and never build class strings themselves. */

/** A menubar control: borderless chrome at rest, plus the accent state class
 *  when its dropdown is open or its drawer is shown. */
export function menubarButtonClass(active: boolean): string {
  return active ? 'menubar-btn active' : 'menubar-btn';
}

/** A toolbox tile: the base `tool` class, plus `active` for the picked tool. */
export function toolTileClass(active: boolean): string {
  return active ? 'tool active' : 'tool';
}
