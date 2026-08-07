/** Pure touch-gesture recognition for the canvas. No DOM, no React: a
 *  `TouchGesture` is fed `{id, x, y}` events with an injectable clock and
 *  returns plain `GestureAction` objects. The component owns the `setTimeout`
 *  timers and hands them back through `timerFired`, which validates them
 *  against the live gesture, so a timer that fired after the finger lifted is
 *  inert. */

/** How long a single finger must stay down before element moves may apply, so
 *  a tap never drags a switch (MouseManager.java:383-386). */
export const DRAG_DELAY_MS = 150;
/** How long a still finger takes to become the context menu (MouseManager.java:140). */
export const LONG_PRESS_MS = 500;
/** Two taps closer together than this are one double-tap (MouseManager.java:136). */
export const DOUBLE_TAP_MS = 300;
/** Travel beyond this cancels a pending long-press and disqualifies a
 *  double-tap. Upstream checks no travel, only time; ours is the usual mobile
 *  pattern, so a resting finger's jitter cannot read as a drag. */
export const TAP_MOVE_TOLERANCE = 8;

export type GestureAction =
  | { type: 'primaryDown' }
  | { type: 'dragArmed' }
  | { type: 'longPress' }
  | { type: 'doubleTap' }
  | { type: 'tap' }
  | { type: 'twoFingerStart' }
  | { type: 'twoFingerMove'; midX: number; midY: number; scale: number }
  | { type: 'cancel' };

export type Timer = 'longPress' | 'dragDelay';

interface Finger {
  id: number;
  x: number;
  y: number;
}

export class TouchGesture {
  private now: () => number;
  private fingers = new Map<number, Finger>();
  private primaryId: number | null = null;
  private primaryStart: { x: number; y: number } | null = null;
  private downAt = 0;
  private armed = false;
  private longPressed = false;
  private twoFinger = false;
  private pinchA: number | null = null;
  private pinchB: number | null = null;
  private pinchDist: number | null = null;
  private lastTapAt: number | null = null;
  private lastTapX: number | null = null;
  private lastTapY: number | null = null;

  constructor(now?: () => number) {
    this.now = now ?? (() => performance.now());
  }

  private travel(p: Finger): number {
    return this.primaryStart ? Math.hypot(p.x - this.primaryStart.x, p.y - this.primaryStart.y) : 0;
  }

  private resetSingle(): void {
    this.primaryId = null;
    this.primaryStart = null;
    this.armed = false;
    this.longPressed = false;
  }

  private resetPinch(): void {
    this.twoFinger = false;
    this.pinchA = null;
    this.pinchB = null;
    this.pinchDist = null;
  }

  down(id: number, x: number, y: number): { actions: GestureAction[] } {
    const f: Finger = { id, x, y };
    if (this.fingers.size === 0) {
      this.fingers.set(id, f);
      this.primaryId = id;
      // A snapshot, not the live finger: moves mutate the map entry, and the
      // travel rule needs the original down point.
      this.primaryStart = { x: f.x, y: f.y };
      this.downAt = this.now();
      this.resetPinch();
      return { actions: [{ type: 'primaryDown' }] };
    }
    if (this.fingers.size === 1) {
      // The second finger switches to a pinch and abandons the single-finger
      // gesture: no armed drag may stay armed and no tap may pair with a
      // pre-pinch tap. The component clears its timers on twoFingerStart.
      const a = this.fingers.values().next().value as Finger;
      this.fingers.set(id, f);
      this.twoFinger = true;
      this.pinchA = a.id;
      this.pinchB = id;
      this.pinchDist = Math.hypot(a.x - f.x, a.y - f.y);
      this.armed = false;
      this.longPressed = false;
      this.lastTapAt = null;
      return { actions: [{ type: 'twoFingerStart' }] };
    }
    // A third finger: the pinch keeps using the first two. Track it so its up
    // can be ignored cleanly; its moves are ignored too.
    this.fingers.set(id, f);
    return { actions: [] };
  }

  move(id: number, x: number, y: number): { actions: GestureAction[]; cancelLongPress: boolean } {
    const f = this.fingers.get(id);
    if (!f) return { actions: [], cancelLongPress: false };
    f.x = x;
    f.y = y;
    if (this.twoFinger) {
      if (id !== this.pinchA && id !== this.pinchB) {
        return { actions: [], cancelLongPress: false };
      }
      const a = this.pinchA !== null ? this.fingers.get(this.pinchA) : undefined;
      const b = this.pinchB !== null ? this.fingers.get(this.pinchB) : undefined;
      if (!a || !b) return { actions: [], cancelLongPress: false };
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      // An incremental ratio against the previous distance, so the component
      // multiplies it into its own scale. Clamping is the component's job.
      const scale = this.pinchDist !== null && this.pinchDist > 0 ? dist / this.pinchDist : 1;
      this.pinchDist = dist;
      return {
        actions: [{ type: 'twoFingerMove', midX: (a.x + b.x) / 2, midY: (a.y + b.y) / 2, scale }],
        cancelLongPress: false,
      };
    }
    if (id !== this.primaryId) return { actions: [], cancelLongPress: false };
    // Travel past the tolerance cancels the pending long-press. The drag-delay
    // timer is deliberately NOT cancelled by movement: movement is exactly when
    // the drag should arm.
    return { actions: [], cancelLongPress: this.travel(f) > TAP_MOVE_TOLERANCE && !this.longPressed };
  }

  up(id: number, x: number, y: number): { actions: GestureAction[] } {
    if (this.twoFinger) {
      this.fingers.delete(id);
      if (id === this.pinchA || id === this.pinchB) {
        // Lifting either pinch finger ends the pinch. Forget every finger: the
        // remaining finger must do nothing until its own lift, so the view
        // cannot jump (the leftover is inert).
        this.fingers.clear();
        this.resetPinch();
        this.resetSingle();
        this.lastTapAt = null;
      }
      return { actions: [] };
    }
    if (id !== this.primaryId) return { actions: [] };
    this.fingers.delete(id);
    const held = this.now() - this.downAt;
    const travel = this.primaryStart
      ? Math.hypot(x - this.primaryStart.x, y - this.primaryStart.y)
      : 0;
    const longPressed = this.longPressed;
    this.resetSingle();
    if (longPressed) {
      // The long-press consumed the gesture: the lift is not a tap and must
      // not pair with the next tap.
      this.lastTapAt = null;
      return { actions: [] };
    }
    // A lift is a tap when it is fast (upstream is time-only, so even a quick
    // swipe taps) or when the finger never travelled beyond the tolerance.
    const isTap = held < DRAG_DELAY_MS || travel <= TAP_MOVE_TOLERANCE;
    if (!isTap) {
      // A completed drag: no tap, and reset the double-tap window so a tap
      // that follows a drag cannot pair with the drag's down.
      this.lastTapAt = null;
      return { actions: [] };
    }
    if (
      this.lastTapAt !== null &&
      this.now() - this.lastTapAt < DOUBLE_TAP_MS &&
      this.lastTapX !== null &&
      this.lastTapY !== null &&
      Math.hypot(x - this.lastTapX, y - this.lastTapY) <= TAP_MOVE_TOLERANCE
    ) {
      // One double-tap per pair: a third quick tap starts a fresh window.
      this.lastTapAt = null;
      return { actions: [{ type: 'doubleTap' }] };
    }
    this.lastTapAt = this.now();
    this.lastTapX = x;
    this.lastTapY = y;
    return { actions: [{ type: 'tap' }] };
  }

  cancel(): GestureAction[] {
    const active = this.fingers.size > 0 || this.primaryId !== null || this.twoFinger;
    this.fingers.clear();
    this.resetPinch();
    this.resetSingle();
    this.lastTapAt = null;
    return active ? [{ type: 'cancel' }] : [];
  }

  timerFired(t: Timer): GestureAction[] {
    if (t === 'dragDelay') {
      if (this.twoFinger || this.primaryId === null) return [];
      if (this.armed || this.longPressed) return [];
      if (this.now() - this.downAt < DRAG_DELAY_MS) return [];
      this.armed = true;
      return [{ type: 'dragArmed' }];
    }
    if (this.twoFinger || this.primaryId === null) return [];
    if (this.longPressed) return [];
    if (this.now() - this.downAt < LONG_PRESS_MS) return [];
    const f = this.fingers.get(this.primaryId);
    if (!f) return [];
    if (this.travel(f) > TAP_MOVE_TOLERANCE) return [];
    this.longPressed = true;
    return [{ type: 'longPress' }];
  }
}
