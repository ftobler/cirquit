/** Modal dialog shell shared by every menubar dialog: a fixed backdrop, a
 *  centred panel, and Escape / backdrop / Cancel dismissal. Dialog state lives
 *  in the store so the menubar, App's host and the Ctrl+S path share one home. */

import { useEffect, useRef, type ReactNode } from 'react';
import { useFocusTrap } from './useFocusTrap';
import { claimEscape, ownsEscape, releaseEscape } from './dialogEscape';

interface DialogProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** The button row (OK/Cancel); rendered below the body. */
  actions?: ReactNode;
  /** Extra class on the panel, for a dialog that needs its own width or
   *  layout (Other Options widens to hold its column grid). */
  className?: string;
  /** Takes over Escape while an inline editor inside the dialog owns the key,
   *  so the press cancels that editor instead of closing the dialog (the
   *  Subcircuit Manager's rename row). It has to be an override on this one
   *  listener rather than a handler on the editor: the listener below is on
   *  `window`, above the React root, so a child's `stopPropagation` cannot
   *  reach it, and a handler on the child only fires while focus is still on
   *  that child, which leaves Escape dead once focus moves to the editor's own
   *  buttons or the panel. Routing the single listener through the override
   *  also means exactly one thing happens per press, whenever React gets round
   *  to re-subscribing after the state change. The press only reaches a
   *  dialog holding the newest Escape claim (`dialogEscape.ts`), so stacked
   *  dialogs close top-first instead of all at once. */
  onEscape?: () => void;
}

export function Dialog({ title, onClose, children, actions, className, onEscape }: DialogProps) {
  // Focus management for the modal: moves focus onto the panel when no child
  // autofocuses (a child's `autoFocus` runs first and wins), traps Tab, and
  // returns focus to the opener on close. The trap replaces the old inline
  // Tab wrap, which could not pull focus back in once it had escaped.
  const panelRef = useFocusTrap<HTMLDivElement>({ returnFocus: true });

  // Escape ownership is claimed once per mount, not per handler change:
  // re-claiming on a re-render would lift a stacked-under dialog's claim back
  // above dialogs mounted after it. The freshest handler rides a ref instead,
  // so inline onClose callbacks and SubcircuitManager's toggling rename
  // override stay live without touching the stack.
  const escapeHandler = useRef(onEscape ?? onClose);
  escapeHandler.current = onEscape ?? onClose;

  useEffect(() => {
    const claim = claimEscape(() => escapeHandler.current());
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape' && ownsEscape(claim)) claim.close();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      releaseEscape(claim);
    };
  }, []);

  return (
    <div className="dialog-backdrop" onPointerDown={onClose}>
      <div
        ref={panelRef}
        className={className ? `dialog ${className}` : 'dialog'}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        onPointerDown={(ev) => ev.stopPropagation()}
      >
        <h2>{title}</h2>
        <div className="dialog-body">{children}</div>
        {actions && <div className="dialog-actions">{actions}</div>}
      </div>
    </div>
  );
}
