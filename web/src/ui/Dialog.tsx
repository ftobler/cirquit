/** Modal dialog shell shared by every menubar dialog: a fixed backdrop, a
 *  centred panel, and Escape / backdrop / Cancel dismissal. Dialog state lives
 *  in the store so the menubar, App's host and the Ctrl+S path share one home. */

import { useEffect, useRef, type ReactNode } from 'react';

interface DialogProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** The button row (OK/Cancel); rendered below the body. */
  actions?: ReactNode;
  /** Takes over Escape while an inline editor inside the dialog owns the key,
   *  so the press cancels that editor instead of closing the dialog (the
   *  Subcircuit Manager's rename row). It has to be an override on this one
   *  listener rather than a handler on the editor: the listener below is on
   *  `window`, above the React root, so a child's `stopPropagation` cannot
   *  reach it, and a handler on the child only fires while focus is still on
   *  that child, which leaves Escape dead once focus moves to the editor's own
   *  buttons or the panel. Routing the single listener through the override
   *  also means exactly one thing happens per press, whenever React gets round
   *  to re-subscribing after the state change. */
  onEscape?: () => void;
}

export function Dialog({ title, onClose, children, actions, onEscape }: DialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleEscape = onEscape ?? onClose;
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') handleEscape();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, onEscape]);

  // No panel focus on mount: a child's `autoFocus` (the filename boxes, the
  // import textarea) must win, so keystrokes land in the dialog's controls.
  // The Tab trap below only needs the active element to already be inside.

  const onKeyDown = (ev: React.KeyboardEvent) => {
    if (ev.key !== 'Tab') return;
    const root = panelRef.current;
    if (!root) return;
    const focusable = Array.from(
      root.querySelectorAll<HTMLElement>('button, textarea, input, select, [tabindex]:not([tabindex="-1"])'),
    ).filter((el) => !el.hasAttribute('disabled'));
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (ev.shiftKey && document.activeElement === first) {
      ev.preventDefault();
      last.focus();
    } else if (!ev.shiftKey && document.activeElement === last) {
      ev.preventDefault();
      first.focus();
    }
  };

  return (
    <div className="dialog-backdrop" onPointerDown={onClose}>
      <div
        ref={panelRef}
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        onPointerDown={(ev) => ev.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <h2>{title}</h2>
        <div className="dialog-body">{children}</div>
        {actions && <div className="dialog-actions">{actions}</div>}
      </div>
    </div>
  );
}
