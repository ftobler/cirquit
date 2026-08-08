/** Circuit-level sliders (`38` Adjustable lines), bound to the target
 *  element's parameter. Renders in the right drawer below the options panel;
 *  nothing is shown when the circuit has no resolvable slider. */

import { useStore } from '../state/store';
import { resolveParam, sliderPositionToValue, sliderValueToPosition } from '../model/sliders';
import { formatValue } from '../render/draw';

export function SliderPanel() {
  const sliders = useStore((s) => s.sliders);
  const elements = useStore((s) => s.elements);
  const beginEdit = useStore((s) => s.beginEdit);
  const setSliderValue = useStore((s) => s.setSliderValue);

  // File order is the store order; a slider whose element is gone or whose
  // parameter cannot be resolved renders nothing but still round-trips.
  const rows = sliders.flatMap((slider) => {
    if (slider.elementId === undefined) return [];
    const element = elements.find((e) => e.id === slider.elementId);
    if (!element) return [];
    const resolved = resolveParam(element.kind, slider.editItem, slider.text);
    if (!resolved) return [];
    return [{ slider, element, resolved }];
  });
  if (rows.length === 0) return null;

  return (
    <section className="sliders">
      <h3>Sliders</h3>
      {rows.map(({ slider, element, resolved }) => {
        const value = element.params[resolved.name] ?? 0;
        const position = sliderValueToPosition(value, slider.min, slider.max, slider.logarithmic);
        const label = slider.text || resolved.field.label;
        return (
          <label key={slider.id} className="field">
            <span>
              {label}{' '}
              <em>
                {formatValue(value, resolved.field.unit ?? '', 3)}
              </em>
            </span>
            <input
              type="range"
              min={0}
              max={100}
              value={Math.round(position)}
              // Pointer-down lands before the first change event, so a drag
              // opens one edit session and is one undo step, exactly like the
              // options panel's range fields (OptionsPanel.tsx:174-175).
              onPointerDown={beginEdit}
              onFocus={beginEdit}
              onChange={(e) => {
                const pos = Number(e.target.value);
                const v = sliderPositionToValue(
                  pos,
                  slider.min,
                  slider.max,
                  slider.logarithmic,
                  slider.step,
                );
                setSliderValue(slider.id, v);
              }}
            />
          </label>
        );
      })}
    </section>
  );
}
