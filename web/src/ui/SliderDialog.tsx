/** Sliders (`38` Adjustable lines) as a modal. From the menubar it lists every
 *  slider for tuning; from the element context menu's Sliders... row it is
 *  scoped to one element and gains a create/remove checkbox per adjustable
 *  field, upstream's SliderDialog capability (SliderDialog.java:91-165). Every
 *  change is a store action, so the dialog, menu and file format agree. */

import { execute } from '../commands/execute';
import { defFor } from '../model/registry';
import { adjustableFields, resolveParam } from '../model/sliders';
import { fieldLabel } from '../model/types';
import { useStore } from '../state/store';
import { Dialog } from './Dialog';
import { SliderPanel } from './SliderPanel';

export function SliderDialog() {
  const sliders = useStore((s) => s.sliders);
  const elements = useStore((s) => s.elements);
  const sliderElementId = useStore((s) => s.sliderElementId);
  const closeDialog = useStore((s) => s.closeDialog);

  const runCommand = (id: string, args: unknown) => {
    const result = execute(id, args, { store: useStore, source: 'user' });
    if (!result.ok) useStore.getState().setStatus(result.message);
  };

  const target = sliderElementId === null ? undefined : elements.find((e) => e.id === sliderElementId);
  const fields = target ? adjustableFields(target.kind) : [];

  return (
    <Dialog
      title={target ? `Sliders for ${defFor(target.kind)?.label ?? 'element'}` : 'Sliders'}
      onClose={closeDialog}
      actions={
        <>
          <button type="button" onClick={closeDialog}>
            Close
          </button>
        </>
      }
    >
      {target && (
        <section className="slider-options">
          {fields.length === 0 ? (
            <p className="hint">This element has no adjustable parameters.</p>
          ) : (
            fields.map((field, editItem) => {
              // The checkbox is keyed on the field the slider actually drives,
              // like SliderPanel: resolveParam prefers the caption over the
              // editItem index, so a corpus slider whose index drifted still
              // shares a checkbox with a dialog-created one instead of showing
              // as unchecked and duplicating on check.
              const existing = sliders.find(
                (x) =>
                  x.elementId === target.id &&
                  resolveParam(target.kind, x.editItem, x.text)?.name === field.name,
              );
              return (
                <label key={field.name} className="field">
                  <input
                    type="checkbox"
                    checked={existing !== undefined}
                    onChange={(e) => {
                      if (e.target.checked) {
                        runCommand('slider.add', {
                          elementId: target.id,
                          editItem,
                          caption: fieldLabel(target, field),
                        });
                      } else if (existing) {
                        runCommand('slider.remove', { sliderId: existing.id });
                      }
                    }}
                  />
                  <span>{fieldLabel(target, field)}</span>
                </label>
              );
            })
          )}
        </section>
      )}
      {!target && sliders.length === 0 ? (
        <p className="hint">This circuit has no sliders.</p>
      ) : (
        <SliderPanel elementId={target?.id} />
      )}
    </Dialog>
  );
}
