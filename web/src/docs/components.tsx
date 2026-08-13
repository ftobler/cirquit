/** Small shared pieces for the docs pages: the simulator deep-link helper and
 *  the "open in the simulator" link the example buttons use. Thin shells, the
 *  URL construction they do is the pure `circuitToUrl` the tests cover. */

import type { ReactNode } from 'react';
import { circuitToUrl } from '../io/urlShare';
import { EXAMPLES } from './examples';

/** The app's own origin and deployment sub-path, resolved against the current
 *  page so it works however the docs are served. */
export function simulatorBase(): string {
  return new URL(import.meta.env.BASE_URL, window.location.href).href;
}

/** A link that opens one of the inline examples in the simulator in a new tab,
 *  via the same `?ctz=` share format the app's `circuitFromUrl` reads. */
export function OpenExample({ name, children }: { name: string; children: ReactNode }) {
  const netlist = EXAMPLES[name];
  if (netlist === undefined) return null;
  return (
    <a href={circuitToUrl(netlist, simulatorBase())} target="_blank" rel="noopener">
      {children}
    </a>
  );
}
