/** Circuit-level sliders (`38` Adjustable lines) as a modal, the home that
 *  replaced the deleted options drawer. Renders the same rows SliderPanel
 *  draws; a later feature wires create/remove into this dialog. */

import { useStore } from '../state/store';
import { Dialog } from './Dialog';
import { SliderPanel } from './SliderPanel';

export function SliderDialog() {
  const sliders = useStore((s) => s.sliders);
  const closeDialog = useStore((s) => s.closeDialog);

  return (
    <Dialog
      title="Sliders"
      onClose={closeDialog}
      actions={
        <>
          <button type="button" onClick={closeDialog}>
            Close
          </button>
        </>
      }
    >
      {sliders.length === 0 ? (
        <p className="hint">This circuit has no sliders.</p>
      ) : (
        <SliderPanel />
      )}
    </Dialog>
  );
}
