/** The live Voltage/Current/Power rows of the options panel, isolated as a
 *  leaf so the per-frame tick re-renders only these rows: the readout state
 *  lives here, below OptionsPanel, instead of inside it, so the panel and its
 *  ElementFields reconcile once per selection rather than at frame rate.
 *  Untested by construction: the repo has no jsdom and `.tsx` components stay
 *  code-review only, while everything under the leaf is node-tested in
 *  `useLiveSimReadout.test.ts`. */

import type { SimEngine } from '../engine/simulator';
import { formatValue } from '../render/draw';
import { useLiveSimReadout } from './useLiveSimReadout';

interface Props {
  engine: SimEngine | null;
  /** The single selected element id, or undefined when nothing or several
   *  are selected; undefined hides the readout entirely. */
  selectedId: number | undefined;
  /** Decimal places for the formatted values, the panel's digit setting. */
  digits: number;
}

export function LiveReadout({ engine, selectedId, digits }: Props) {
  const { current, voltage, power } = useLiveSimReadout(engine, selectedId);
  if (voltage === undefined) return null;
  return (
    <dl className="readout">
      <dt>Voltage</dt>
      <dd>{formatValue(voltage, 'V', digits)}</dd>
      <dt>Current</dt>
      <dd>{formatValue(current ?? 0, 'A', digits)}</dd>
      <dt>Power</dt>
      {/* The readout uses the engine's scope-convention power, not
          voltage * current: for a voltage or current source the display
          voltage is the positive EMF while the scope's Power trace uses
          V(post0) - V(post1), so multiplying here would show the wrong
          sign for a source. */}
      <dd>{formatValue(power ?? 0, 'W', digits)}</dd>
    </dl>
  );
}
