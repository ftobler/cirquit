import { describe, expect, it } from 'vitest';
import {
  DRAG_DELAY_MS,
  LONG_PRESS_MS,
  TAP_MOVE_TOLERANCE,
  TouchGesture,
} from './gestures';

// A fake clock: every test advances `t` explicitly, so timers can only fire
// when the test hands them to the recognizer.
let t = 0;
const now = () => t;
const gesture = () => new TouchGesture(now);

describe('tap vs drag, time side', () => {
  it('a lift within the drag delay is a tap, and the later timers are inert', () => {
    const g = gesture();
    t = 0;
    expect(g.down(1, 10, 10).actions).toEqual([{ type: 'primaryDown' }]);
    t = 100;
    expect(g.up(1, 10, 10).actions).toEqual([{ type: 'tap' }]);
    // The component cleared its timers on up; had one fired, the recognizer
    // would reject it.
    t = 600;
    expect(g.timerFired('dragDelay')).toEqual([]);
    expect(g.timerFired('longPress')).toEqual([]);
  });

  it('the dragDelay timer arms the drag at 150ms', () => {
    const g = gesture();
    t = 0;
    g.down(1, 10, 10);
    t = DRAG_DELAY_MS;
    expect(g.timerFired('dragDelay')).toEqual([{ type: 'dragArmed' }]);
  });

  it('movement before the delay never arms the drag early', () => {
    const g = gesture();
    t = 0;
    g.down(1, 10, 10);
    t = 100;
    g.move(1, 30, 30);
    expect(g.timerFired('dragDelay')).toEqual([]);
    t = DRAG_DELAY_MS;
    expect(g.timerFired('dragDelay')).toEqual([{ type: 'dragArmed' }]);
  });
});

describe('tap vs drag, travel side', () => {
  it('a fast swipe within the delay is still a tap', () => {
    const g = gesture();
    t = 0;
    g.down(1, 10, 10);
    t = 100;
    g.move(1, 30, 30);
    expect(g.up(1, 30, 30).actions).toEqual([{ type: 'tap' }]);
  });

  it('jitter within the tolerance does not cancel the long-press', () => {
    const g = gesture();
    t = 0;
    g.down(1, 10, 10);
    t = 200;
    const r = g.move(1, 10 + TAP_MOVE_TOLERANCE / 2, 10);
    expect(r.cancelLongPress).toBe(false);
    t = LONG_PRESS_MS;
    expect(g.timerFired('longPress')).toEqual([{ type: 'longPress' }]);
  });

  it('a slow drag past the tolerance is not a tap', () => {
    const g = gesture();
    t = 0;
    g.down(1, 10, 10);
    t = 200;
    g.move(1, 60, 10);
    expect(g.up(1, 60, 10).actions).toEqual([]);
  });
});

describe('long-press timing', () => {
  it('a still hold to 500ms is a long-press', () => {
    const g = gesture();
    t = 0;
    g.down(1, 10, 10);
    t = LONG_PRESS_MS;
    expect(g.timerFired('longPress')).toEqual([{ type: 'longPress' }]);
  });

  it('movement beyond the tolerance cancels the long-press', () => {
    const g = gesture();
    t = 0;
    g.down(1, 10, 10);
    t = 200;
    const r = g.move(1, 30, 10);
    expect(r.cancelLongPress).toBe(true);
    t = LONG_PRESS_MS;
    expect(g.timerFired('longPress')).toEqual([]);
  });

  it('an up after a long-press is not a tap', () => {
    const g = gesture();
    t = 0;
    g.down(1, 10, 10);
    t = LONG_PRESS_MS;
    g.timerFired('longPress');
    t = 600;
    expect(g.up(1, 10, 10).actions).toEqual([]);
  });
});

describe('two-finger start', () => {
  it('a second finger cancels the pending long-press and drag timers', () => {
    const g = gesture();
    t = 0;
    g.down(1, 10, 10);
    t = 100;
    expect(g.down(2, 110, 10).actions).toEqual([{ type: 'twoFingerStart' }]);
    t = LONG_PRESS_MS;
    expect(g.timerFired('longPress')).toEqual([]);
    expect(g.timerFired('dragDelay')).toEqual([]);
  });
});

describe('pinch scale math', () => {
  it('emits incremental ratios and midpoints', () => {
    const g = gesture();
    t = 0;
    g.down(1, 0, 0);
    g.down(2, 100, 0);
    t = 200;

    const first = g.move(2, 125, 0);
    expect(first.actions).toEqual([{ type: 'twoFingerMove', midX: 62.5, midY: 0, scale: 1.25 }]);

    const second = g.move(2, 62.5, 0);
    expect(second.actions).toEqual([{ type: 'twoFingerMove', midX: 31.25, midY: 0, scale: 0.5 }]);

    // The ratios are incremental, so they multiply to the total: 100 -> 62.5.
    expect(1.25 * 0.5).toBeCloseTo(0.625);
  });

  it('ignores a third finger: the pinch keeps using the first two', () => {
    const g = gesture();
    t = 0;
    g.down(1, 0, 0);
    g.down(2, 100, 0);
    expect(g.down(3, 200, 0).actions).toEqual([]);
    t = 200;

    expect(g.move(2, 125, 0).actions).toEqual([
      { type: 'twoFingerMove', midX: 62.5, midY: 0, scale: 1.25 },
    ]);
    // The third finger's moves do not disturb the pinch.
    expect(g.move(3, 500, 500).actions).toEqual([]);
    // Finger 1 still drives the ratio.
    expect(g.move(1, 62.5, 0).actions).toEqual([
      { type: 'twoFingerMove', midX: 93.75, midY: 0, scale: 0.5 },
    ]);
  });
});

describe('double-tap', () => {
  it('two quick taps on the same spot are one double-tap', () => {
    const g = gesture();
    t = 0;
    g.down(1, 10, 10);
    t = 100;
    expect(g.up(1, 10, 10).actions).toEqual([{ type: 'tap' }]);
    t = 150;
    g.down(1, 12, 12);
    t = 250;
    expect(g.up(1, 12, 12).actions).toEqual([{ type: 'doubleTap' }]);
  });

  it('two taps more than 300ms apart are two taps', () => {
    const g = gesture();
    t = 0;
    g.down(1, 10, 10);
    t = 100;
    expect(g.up(1, 10, 10).actions).toEqual([{ type: 'tap' }]);
    // 400ms after the first tap's up: outside the double-tap window.
    t = 500;
    g.down(1, 10, 10);
    t = 600;
    expect(g.up(1, 10, 10).actions).toEqual([{ type: 'tap' }]);
  });

  it('a double-tap needs the taps within travel tolerance of each other', () => {
    const g = gesture();
    t = 0;
    g.down(1, 10, 10);
    t = 100;
    g.up(1, 10, 10);
    t = 150;
    g.down(1, 40, 10);
    t = 250;
    expect(g.up(1, 40, 10).actions).toEqual([{ type: 'tap' }]);
  });
});

describe('lifting one finger mid-pinch', () => {
  it('ends the pinch and leaves the leftover finger inert', () => {
    const g = gesture();
    t = 0;
    g.down(1, 0, 0);
    g.down(2, 100, 0);
    t = 200;
    expect(g.up(2, 100, 0).actions).toEqual([]);

    // Finger 1's moves produce nothing while it stays down.
    expect(g.move(1, 50, 0).actions).toEqual([]);
    expect(g.move(1, 200, 200).actions).toEqual([]);

    // Lifting it is a clean reset, not a tap.
    expect(g.up(1, 200, 200).actions).toEqual([]);
  });
});

describe('timer hygiene', () => {
  it('an up before the timers fire leaves them inert', () => {
    const g = gesture();
    t = 0;
    g.down(1, 10, 10);
    t = 100;
    g.up(1, 10, 10);
    t = 600;
    expect(g.timerFired('longPress')).toEqual([]);
    expect(g.timerFired('dragDelay')).toEqual([]);
  });

  it('a cancel clears the gesture and leaves the timers inert', () => {
    const g = gesture();
    t = 0;
    g.down(1, 10, 10);
    t = 100;
    expect(g.cancel()).toEqual([{ type: 'cancel' }]);
    t = 600;
    expect(g.timerFired('longPress')).toEqual([]);
    expect(g.timerFired('dragDelay')).toEqual([]);
    // A fresh gesture after a cancel starts clean.
    t = 700;
    expect(g.down(2, 0, 0).actions).toEqual([{ type: 'primaryDown' }]);
  });

  it('a completed drag resets the double-tap window', () => {
    const g = gesture();
    t = 0;
    g.down(1, 10, 10);
    t = 200;
    g.move(1, 60, 10);
    g.up(1, 60, 10);
    // A quick tap right after the drag must not pair with it.
    t = 300;
    g.down(1, 10, 10);
    t = 400;
    expect(g.up(1, 10, 10).actions).toEqual([{ type: 'tap' }]);
  });
});
