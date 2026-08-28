/** Circuit-level sliders (`38` Adjustable lines), bound to the target
 *  element's parameter. Rendered inside the Sliders dialog; nothing is shown
 *  when the circuit has no resolvable slider. */

import { useStore } from '../state/store';
import { resolveParam, sliderPositionToValue, sliderValueToPosition } from '../model/sliders';
import { fieldLabel, type CircuitElement } from '../model/types';
import { fieldValue } from './elementFields';
import { formatValue } from '../render/draw';

/** The display-unit value a slider row shows for its bound field: the same
 *  `fieldValue` the element-properties dialog uses, so a scaled slider (duty
 *  cycle in percent, phase shift in degrees) reads back in its display units
 *  and parks the thumb where the value actually is. A raw param read would
 *  disagree with the `value * paramScale` write path and sit at the wrong
 *  position. Returns 0 for the non-numeric (text/contents) rows a slider can
 *  never bind. */
export function sliderReadbackValue(
  element: CircuitElement,
  resolved: { name: string; field: import('../model/types').FieldDef },
): number {
  const raw = fieldValue(element, resolved.field);
  return typeof raw === 'number' ? raw : 0;
}

export function SliderPanel({ elementId }: { elementId?: number }) {
  const sliders = useStore((s) => s.sliders);
  const elements = useStore((s) => s.elements);
  const beginEdit = useStore((s) => s.beginEdit);
  const setSliderValue = useStore((s) => s.setSliderValue);

  // File order is the store order; a slider whose element is gone or whose
  // parameter cannot be resolved renders nothing but still round-trips. The
  // scoped Sliders dialog (context-menu path) filters to one element's rows.
  const rows = sliders.flatMap((slider) => {
    if (slider.elementId === undefined) return [];
    if (elementId !== undefined && slider.elementId !== elementId) return [];
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
        // Read the display-unit value the property dialog uses (scale/get
        // applied), so the thumb and the read-out agree with the write path
        // that multiplies by paramScale. A raw param read at 0.5 would park
        // a 50% duty cycle at the far left and print "0.5 %".
        const value = sliderReadbackValue(element, resolved);
        const position = sliderValueToPosition(value, slider.min, slider.max, slider.logarithmic);
        const label = slider.text || fieldLabel(element, resolved.field);
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
              // edit dialog's range fields.
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
