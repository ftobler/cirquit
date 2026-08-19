/** The element properties dialog, the port of upstream's EditDialog: a modal
 *  over the workspace holding one row per editable property of the element
 *  that was double-clicked or picked from the context menu's Edit... row.
 *  Every row applies live through a store action, so OK only has to close;
 *  Escape and the backdrop do the same, and undo walks the edits back. The
 *  rows themselves come from `ElementFields`, shared with the options panel,
 *  so a field added to a registry def shows up in both. */

import { useEffect, useRef } from 'react';
import type { SimEngine } from '../engine/simulator';
import { defFor } from '../model/registry';
import { useStore } from '../state/store';
import { Dialog } from './Dialog';
import { ElementFields } from './ElementFields';

interface Props {
  engine: SimEngine | null;
}

export function ElementPropertiesDialog({ engine }: Props) {
  const elementProperties = useStore((s) => s.elementProperties);
  const element = useStore((s) => s.elements.find((e) => e.id === s.elementProperties));
  const closeElementProperties = useStore((s) => s.closeElementProperties);
  const def = element ? defFor(element.kind) : undefined;

  // The element can go away under the dialog (an undo of its creation, a
  // circuit loaded from a hash change); the modal must not survive its subject.
  useEffect(() => {
    if (elementProperties !== null && element === undefined) closeElementProperties();
  }, [elementProperties, element, closeElementProperties]);

  // Upstream opens the dialog focused on the first value, so a double-click
  // followed by typing edits it. This effect runs before the shell's focus
  // trap (child effects first), which then sees focus already inside the panel
  // and leaves it alone.
  const fieldsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    fieldsRef.current?.querySelector<HTMLElement>('.field input, .field select')?.focus();
  }, [elementProperties]);

  if (!element || !def) return null;

  return (
    <Dialog
      title={`Edit ${def.label}`}
      onClose={closeElementProperties}
      actions={
        <button type="button" onClick={closeElementProperties}>
          OK
        </button>
      }
    >
      <div className="element-properties" ref={fieldsRef}>
        {def.fields?.length ? (
          <ElementFields element={element} engine={engine} />
        ) : (
          <p className="hint">This element has no editable properties.</p>
        )}
      </div>
    </Dialog>
  );
}
