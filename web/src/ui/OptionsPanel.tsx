/** Properties of the selected element, the right-sidebar companion to the
 *  element properties dialog (both render the same rows through
 *  `ElementFields`). The global settings live in the Other Options dialog;
 *  this panel holds only the element half. The live readout ticks per frame
 *  inside its own `LiveReadout` leaf, so this panel does not re-render at
 *  frame rate while a simulation runs. */

import type { SimEngine } from '../engine/simulator';
import { defFor } from '../model/registry';
import { sliderFromSteps, stepsFromSlider } from '../state/helpers';
import { useStore } from '../state/store';
import { ElementFields } from './ElementFields';
import { LiveReadout } from './LiveReadout';

interface Props {
  engine: SimEngine | null;
}

export function OptionsPanel({ engine }: Props) {
  const elements = useStore((s) => s.elements);
  const selectedIds = useStore((s) => s.selectedIds);
  const settings = useStore((s) => s.settings);
  const updateSettings = useStore((s) => s.updateSettings);
  const addScope = useStore((s) => s.addScope);

  const selected = elements.find((e) => e.id === selectedIds[0]);
  const def = selected ? defFor(selected.kind) : undefined;

  // Only a single selection reads the engine per frame; with nothing or
  // several selected the readout stays hidden, matching the empty state below.
  const selectedId = selectedIds.length === 1 ? selectedIds[0] : undefined;

  return (
    <div className="options" tabIndex={-1}>
      {selected && def ? (
        <section>
          <h3>{def.label}</h3>
          <LiveReadout engine={engine} selectedId={selectedId} digits={settings.decimalDigits} />
          <ElementFields element={selected} engine={engine} />
          <div className="row">
            <button type="button" onClick={() => addScope(selected.id, 'voltage')}>
              Scope voltage
            </button>
            <button type="button" onClick={() => addScope(selected.id, 'current')}>
              Scope current
            </button>
          </div>
        </section>
      ) : (
        <section>
          <h3>Nothing selected</h3>
          <p className="hint">Click an element to inspect and edit it.</p>
        </section>
      )}

      <section>
        <h3>Simulation</h3>
        <label className="field">
          <span>
            Speed <em>{settings.stepsPerFrame} steps/frame</em>
          </span>
          <input
            type="range"
            min={1}
            max={1000}
            value={sliderFromSteps(settings.stepsPerFrame, 1, 1000)}
            onChange={(e) =>
              updateSettings({ stepsPerFrame: stepsFromSlider(Number(e.target.value), 1, 1000) })
            }
          />
        </label>
        <label className="field">
          <span>
            Current speed <em>{settings.currentSpeed}</em>
          </span>
          <input
            type="range"
            min={0}
            max={100}
            value={settings.currentSpeed}
            onChange={(e) => updateSettings({ currentSpeed: Number(e.target.value) })}
          />
        </label>
      </section>
    </div>
  );
}
