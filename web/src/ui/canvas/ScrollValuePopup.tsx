/**
 * The mouse-wheel value stepper shown over a resistor, capacitor or inductor.
 * A tiny fixed popover at the cursor listing five E12 candidates around the
 * selection; the wheel moves the selection, mouse-out or Escape commits,
 * right-click reverts. Mirrors upstream's `ScrollValuePopup`
 * (ScrollValuePopup.java): five labels, the current value centred, the slot
 * the session opened on underlined.
 */

import { useEffect, useLayoutEffect, useRef } from 'react';
import { defFor } from '../../model/registry';
import { selectionIndex, wheelPixels, type ScrollValueSession } from '../../model/scrollValue';
import { formatValue } from '../../render/draw';

const LABEL_COUNT = 5;

interface Props {
  session: ScrollValueSession;
  x: number;
  y: number;
  /** A wheel tick on the popover; delta is normalized pixels. */
  onStep: (deltaY: number) => void;
  /** Keep the current selection and close (mouse-out, Escape). */
  onClose: () => void;
  /** Restore the opening value and close (right-click). */
  onRevert: () => void;
}

export function ScrollValuePopup({ session, x, y, onStep, onClose, onRevert }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  // Position the popup up and to the left of the cursor, upstream's
  // `x - offsetWidth/4, y - 7*offsetHeight/12`, so the pointer sits over it
  // and mouse-out keeps working. Measured before paint, like the context menu.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    el.style.left = `${Math.max(4, x - w / 4)}px`;
    el.style.top = `${Math.max(4, y - (h * 7) / 12)}px`;
  }, [x, y]);

  // Escape commits, same as mouse-out. The window keydown listener is needed
  // because the popover never takes keyboard focus.
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const onWheel = (ev: React.WheelEvent) => {
    ev.stopPropagation();
    onStep(wheelPixels(ev.deltaY, ev.deltaMode));
  };

  const onPointerDown = (ev: React.PointerEvent) => {
    // Left and middle keep the selection; right-click reverts to the opening
    // value (ScrollValuePopup.java:171-176). The context menu must not open.
    if (ev.button === 2) onRevert();
    else onClose();
  };

  const def = defFor(session.kind);
  const name = def?.fields?.[0]?.label ?? session.param;
  const sel = selectionIndex(session);
  const centre = (LABEL_COUNT - 1) / 2;
  const slots = Array.from({ length: LABEL_COUNT }, (_, i) => {
    const idx = sel + i - centre;
    const cls = [
      'scroll-value-slot',
      i === centre ? 'selected' : i === centre - 1 || i === centre + 1 ? 'off1' : 'off2',
      idx === session.index ? 'current' : '',
    ]
      .filter(Boolean)
      .join(' ');
    return {
      cls,
      text: idx >= 0 && idx < session.values.length ? formatValue(session.values[idx]) : '---',
    };
  });

  return (
    <div
      ref={ref}
      className="scroll-value-popup"
      style={{ left: x, top: y }}
      onWheel={onWheel}
      onPointerLeave={onClose}
      onPointerDown={onPointerDown}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="scroll-value-name">{name}</div>
      {slots.map((slot, i) => (
        <div key={i} className={slot.cls}>
          {slot.text}
        </div>
      ))}
    </div>
  );
}
